/**
 * `npm run web`: the responder's surface ("one responder on one surface" in the brief).
 *
 * @remarks
 * A thin HTTP layer over the Temporal client. It holds no state of its own: it starts an incident
 * (workflow start), reads its state (query) and sends a human decision (signal). If this server
 * dies, nothing is lost. In the real product, the "start" would come from a consumer of
 * PagerDuty's `incident.triggered` event instead of a button.
 *
 * Plain `node:http` on purpose: a route table is all a handful of routes needs.
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  type WorkflowHandle,
} from '@temporalio/client';
import { config } from '../shared/config.js';
import {
  AGENT_TASK_QUEUE,
  type AgentState,
  type Decision,
  type IncidentWorkflowInput,
} from '../shared/types.js';
import {
  type KillSwitch,
  readKillSwitch,
  setKillSwitch,
} from '../worker/activities/kill-switch.js';
import { CATALOG } from '../worker/rules/catalog.js';
import {
  decisionSignal,
  getStateQuery,
  type incidentWorkflow,
} from '../worker/workflow/incident.js';
import { isScenarioId, SCENARIOS, startScenario } from '../world/scenarios.js';
import { readWorld, writeWorld } from '../world/world-store.js';

/** What a handler answers: JSON, or the page itself. */
type Reply = { status: number; json: unknown } | { status: number; html: Buffer };

/** What a handler receives. */
interface RouteRequest {
  client: Client;
  /** Named groups of the route's path pattern, URL-decoded. */
  params: Record<string, string>;
  /** The JSON body (`{}` when empty). */
  body: Record<string, unknown>;
}

/** One route: method, path pattern, and handler. */
interface Route {
  method: 'GET' | 'POST';
  path: RegExp;
  handle: (req: RouteRequest) => Reply | Promise<Reply>;
}

/** Every route, in one table. */
const ROUTES: Route[] = [
  { method: 'GET', path: /^\/$/, handle: servePage },
  { method: 'GET', path: /^\/api\/scenarios$/, handle: listScenarios },
  { method: 'GET', path: /^\/api\/incidents$/, handle: listIncidents },
  { method: 'POST', path: /^\/api\/incidents$/, handle: startIncident },
  { method: 'GET', path: /^\/api\/incidents\/(?<id>[^/]+)$/, handle: incidentState },
  { method: 'POST', path: /^\/api\/incidents\/(?<id>[^/]+)\/decision$/, handle: sendDecision },
  {
    method: 'POST',
    path: /^\/api\/world\/(?<tenant>[^/]+)\/manual-rollback$/,
    handle: manualRollback,
  },
  { method: 'GET', path: /^\/api\/kill-switch$/, handle: getKillSwitch },
  { method: 'POST', path: /^\/api\/kill-switch$/, handle: toggleKillSwitch },
];

/** The page. Read on every request, so editing it only needs a browser reload. */
const INDEX_HTML = fileURLToPath(new URL('./index.html', import.meta.url));

/** Connects to Temporal (the client reconnects by itself if Temporal restarts) and serves HTTP. */
async function main(): Promise<void> {
  const client = new Client({
    connection: await Connection.connect({ address: config.temporalAddress }),
  });
  createServer((req, res) => void handleRequest(client, req, res)).listen(config.webPort, () =>
    console.error(
      `web up: http://localhost:${config.webPort} (new incidents: ${config.model}, effort ${config.effort})`,
    ),
  );
}

/**
 * Finds the route, runs its handler, and sends the reply. Any error becomes a 500 with its message.
 *
 * @param client - The Temporal client.
 * @param req - The HTTP request.
 * @param res - The HTTP response.
 */
async function handleRequest(
  client: Client,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const match = findRoute(req.method, pathname);
    if (!match) return send(res, { status: 404, json: { error: 'not found' } });
    send(
      res,
      await match.route.handle({ client, params: match.params, body: await readJson(req) }),
    );
  } catch (err) {
    send(res, { status: 500, json: { error: errorText(err) } });
  }
}

// ---- Handlers, in the order of the route table ----

/** `GET /`: the responder's page. */
function servePage(): Reply {
  return { status: 200, html: readFileSync(INDEX_HTML) };
}

/** `GET /api/scenarios`: the scenarios the page can trigger. */
function listScenarios(): Reply {
  const list = Object.entries(SCENARIOS).map(([id, s]) => ({
    id,
    tenantId: s.tenantId,
    description: s.description,
  }));
  return { status: 200, json: list };
}

/**
 * `GET /api/incidents`: the 20 most recent incidents, from Temporal's visibility store (no
 * database of our own).
 */
async function listIncidents({ client }: RouteRequest): Promise<Reply> {
  const items: { workflowId: string; status: string; startTime: string }[] = [];
  for await (const wf of client.workflow.list({ query: `WorkflowType = 'incidentWorkflow'` })) {
    items.push({
      workflowId: wf.workflowId,
      status: wf.status.name,
      startTime: wf.startTime.toISOString(),
    });
    if (items.length >= 20) break;
  }
  return { status: 200, json: items };
}

/**
 * `POST /api/incidents`: re-seeds the scenario's world, then starts the workflow.
 *
 * @remarks
 * The workflow id is `tenant:incident`. A duplicate trigger (event queues deliver at least once)
 * is refused twice over: we check before touching the world (so a duplicate doesn't reset the
 * world under a running incident), and Temporal itself refuses a second start with the same id.
 */
async function startIncident({ client, body }: RouteRequest): Promise<Reply> {
  const scenario = String(body.scenario ?? '');
  if (!isScenarioId(scenario)) return badRequest(`unknown scenario ${scenario}`);
  const id = typeof body.incidentId === 'string' ? body.incidentId : newIncidentId();
  const workflowId = `${SCENARIOS[scenario].tenantId}:${id}`;
  if (await isRunning(client, workflowId)) return alreadyRunning(workflowId);

  const incident = { ...startScenario(scenario), id };
  try {
    await client.workflow.start<typeof incidentWorkflow>('incidentWorkflow', {
      taskQueue: AGENT_TASK_QUEUE,
      workflowId,
      args: [{ incident, config: workflowSettings() }],
    });
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) return alreadyRunning(workflowId);
    throw err;
  }
  return { status: 201, json: { workflowId } };
}

/**
 * `GET /api/incidents/:id`: the incident's state, plus the kill switch (so the page can warn
 * before a human approves an action that would be blocked; `null` = unreadable = all blocked).
 */
async function incidentState(req: RouteRequest): Promise<Reply> {
  const handle = req.client.workflow.getHandle(param(req, 'id'));
  const { status } = await handle.describe();
  const state = await readAgentState(handle, status.name);
  return {
    status: 200,
    json: { ...state, workflowStatus: status.name, killSwitch: killSwitchOrNull() },
  };
}

/**
 * `POST /api/incidents/:id/decision`: a human decision, sent as a signal. The workflow decides
 * whether it is still valid (proposal id, status).
 */
async function sendDecision(req: RouteRequest): Promise<Reply> {
  const decision = parseDecision(req.body);
  if (!decision) return badRequest('bad kind');
  await req.client.workflow.getHandle(param(req, 'id')).signal(decisionSignal, decision);
  return { status: 202, json: { ok: true } };
}

/**
 * `POST /api/world/:tenant/manual-rollback`: demo control. A human fixes things by hand, outside
 * the agent, while a proposal waits.
 *
 * @remarks
 * Used to show the stale approval: after this, approving the agent's rollback fails its
 * compare-and-swap precondition and nothing changes. It only undoes a broken version, so a second
 * click can't flip the service back to it.
 */
function manualRollback(req: RouteRequest): Reply {
  const service = String(req.body.service ?? '');
  const world = readWorld(param(req, 'tenant'));
  const s = world.services[service];
  const last = world.deploys.find((d) => d.service === service);
  if (!s || !last || last.version !== s.currentVersion) return badRequest('nothing to roll back');
  if (!s.badVersions.includes(s.currentVersion)) {
    return {
      status: 409,
      json: { error: `${service} is already on a healthy version (${s.currentVersion}).` },
    };
  }
  s.currentVersion = last.previousVersion;
  world.deploys.unshift({
    service,
    version: last.previousVersion,
    previousVersion: last.version,
    at: new Date().toISOString(),
    author: `${String(req.body.by || 'responder')} (manual, outside the agent)`,
    change: `rollback ${last.version} -> ${last.previousVersion}`,
  });
  writeWorld(world);
  return { status: 200, json: { service, version: s.currentVersion } };
}

/** `GET /api/kill-switch`: what is switched off. */
function getKillSwitch(): Reply {
  return { status: 200, json: readKillSwitch() };
}

/**
 * `POST /api/kill-switch`: turns a switch on or off. Body: `{ tenant?, action?, on }`.
 *
 * @remarks
 * In production this is an admin control with its own permissions and audit log. Here it is a
 * button on the page, so the demo can show containment.
 */
function toggleKillSwitch({ body }: RouteRequest): Reply {
  const tenant = typeof body.tenant === 'string' ? body.tenant : undefined;
  const action = typeof body.action === 'string' ? body.action : undefined;
  if (typeof body.on !== 'boolean' || (!tenant && !action)) {
    return badRequest('expected { tenant?, action?, on: boolean }');
  }
  if (tenant && !/^[a-z0-9-]+$/.test(tenant)) return badRequest('bad tenant');
  if (action && !(action in CATALOG)) return badRequest(`unknown action ${action}`);
  return { status: 200, json: setKillSwitch({ tenant, action }, body.on) };
}

// ---- Helpers ----

/**
 * The route for a method and path, with its named path parameters.
 *
 * @param method - HTTP method.
 * @param pathname - URL path.
 */
function findRoute(
  method: string | undefined,
  pathname: string,
): { route: Route; params: Record<string, string> } | null {
  for (const route of ROUTES) {
    const match = route.method === method ? route.path.exec(pathname) : null;
    if (!match) continue;
    const params = Object.fromEntries(
      Object.entries(match.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]),
    );
    return { route, params };
  }
  return null;
}

/**
 * A path parameter that the route pattern guarantees.
 *
 * @param req - The request.
 * @param name - The parameter.
 */
function param(req: RouteRequest, name: string): string {
  const value = req.params[name];
  if (!value) throw new Error(`missing path parameter ${name}`);
  return value;
}

/**
 * The agent's state: a query (answered by a worker, which rebuilds it from the recorded history),
 * or, for a finished incident with no worker up, its result.
 *
 * @param handle - The workflow.
 * @param status - Its Temporal status.
 * @throws A clear "worker offline" error for an open incident with no worker (the page keeps the
 * last screen and shows a red status line).
 */
async function readAgentState(handle: WorkflowHandle, status: string): Promise<AgentState> {
  try {
    return await handle.query(getStateQuery);
  } catch (err) {
    if (status === 'COMPLETED') return (await handle.result()) as AgentState;
    throw new Error(
      `Worker offline (${errorText(err)}). The incident state is safe in Temporal; start the worker and it continues from where it stopped.`,
    );
  }
}

/** The kill switch, or `null` if its file is unreadable (the runtime then blocks everything). */
function killSwitchOrNull(): KillSwitch | null {
  try {
    return readKillSwitch();
  } catch {
    return null;
  }
}

/**
 * A decision from the request body, or `null` if its kind is unknown.
 *
 * @param body - `{ proposalId?, kind, by?, reason? }`.
 */
function parseDecision(body: Record<string, unknown>): Decision | null {
  const kind = body.kind as Decision['kind'];
  if (!['approve', 'reject', 'resolve', 'retry'].includes(kind)) return null;
  return {
    proposalId: typeof body.proposalId === 'string' ? body.proposalId : null,
    kind,
    by: String(body.by || 'responder'),
    ...(typeof body.reason === 'string' && body.reason ? { reason: body.reason } : {}),
  };
}

/**
 * Whether a workflow with this id is running.
 *
 * @param client - The Temporal client.
 * @param workflowId - `tenant:incident`.
 */
async function isRunning(client: Client, workflowId: string): Promise<boolean> {
  try {
    return (await client.workflow.getHandle(workflowId).describe()).status.name === 'RUNNING';
  } catch {
    return false; // not found
  }
}

/**
 * Settings passed into each workflow (workflow code can't read them itself): timing, and the
 * model and effort, pinned for the incident's whole life.
 */
function workflowSettings(): IncidentWorkflowInput['config'] {
  return {
    approvalTimeout: config.approvalTimeout,
    verifyDelay: config.verifyDelay,
    agent: config.agent,
  };
}

/** A random demo incident id, like `INC-4821`. */
function newIncidentId(): string {
  return `INC-${1000 + Math.floor(Math.random() * 9000)}`;
}

/**
 * A 400 reply.
 *
 * @param error - What was wrong.
 */
function badRequest(error: string): Reply {
  return { status: 400, json: { error } };
}

/**
 * A 409 reply for a duplicate trigger.
 *
 * @param workflowId - The incident already running.
 */
function alreadyRunning(workflowId: string): Reply {
  return { status: 409, json: { error: `${workflowId} is already running`, workflowId } };
}

/**
 * Reads a JSON request body.
 *
 * @param req - The request.
 * @returns The parsed body, or `{}` when empty.
 */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

/**
 * Sends a reply.
 *
 * @param res - The response.
 * @param reply - Status, and JSON or HTML.
 */
function send(res: ServerResponse, reply: Reply): void {
  if ('html' in reply) {
    res.writeHead(reply.status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(reply.html);
    return;
  }
  res.writeHead(reply.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(reply.json));
}

/**
 * Turns anything thrown into a message.
 *
 * @param err - The thrown value.
 */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

await main();
