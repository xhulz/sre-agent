/**
 * A real MCP server standing in for the customer's third-party stack (Datadog, Grafana, GitHub,
 * CI…): alerts, metrics, logs, deploys, and two infrastructure actions.
 *
 * @remarks
 * The protocol is real (MCP over stdio); the data behind it is the fake world
 * (`data/world/<tenant>.json`). One process per tenant: the tenant comes from the `TENANT_ID`
 * environment variable, so it is part of the connection, never an argument the model can choose.
 * Adding a new integration for a tenant = registering another MCP server like this one.
 *
 * The world is read from disk on every call, so changes made by others (a manual rollback on the
 * web page) are always visible. A scenario can take a backend down (`sourcesDown`): its tools then
 * fail, like a real vendor outage.
 *
 * @packageDocumentation
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  activeAlerts,
  isDown,
  type Metric,
  metric,
  readWorld,
  recentLogs,
  restartService,
  rollbackDeploy,
  type Source,
  writeWorld,
} from '../world/world-store.js';

/** What a tool returns: one text block, maybe flagged as an error (the client sees `ok: false`). */
type ToolResult = { content: { type: 'text'; text: string }[]; isError: boolean };

/** Serves the tenant given by `TENANT_ID` over stdio (stdout is the JSON-RPC channel). */
async function main(): Promise<void> {
  const tenantId = process.env.TENANT_ID;
  if (!tenantId) throw new Error('TENANT_ID is required');
  await buildServer(tenantId).connect(new StdioServerTransport());
  // stdout is the JSON-RPC channel: diagnostics go to stderr.
  console.error(`observability MCP server up (tenant ${tenantId})`);
}

/**
 * Creates the MCP server for one tenant, with all its tools.
 *
 * @remarks
 * Read tools carry `readOnlyHint`, actions carry `destructiveHint`. These are only hints for
 * clients: our agent does not trust them (the server is third-party) and uses its own allowlist.
 *
 * @param tenantId - The tenant this process serves.
 * @returns The server, not yet connected.
 */
export function buildServer(tenantId: string): McpServer {
  const server = new McpServer({ name: 'observability', version: '0.1.0' });

  // ---- Read-only tools (the model may call these) ----
  server.registerTool(
    'get_active_alerts',
    {
      description: 'List alerts currently firing across all services.',
      annotations: { readOnlyHint: true },
    },
    () => getActiveAlerts(tenantId),
  );
  server.registerTool(
    'get_metrics',
    {
      description: 'Current value of one metric for one service.',
      inputSchema: {
        service: z.string().describe('Service name, e.g. checkout-api'),
        metric: z.enum(['error_rate', 'latency_p95_ms', 'db_connections']),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => getMetrics(tenantId, args),
  );
  server.registerTool(
    'search_logs',
    {
      description: 'Recent log lines for one service, optionally filtered by a substring.',
      inputSchema: {
        service: z.string(),
        query: z.string().optional().describe('Case-insensitive substring filter'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => searchLogs(tenantId, args),
  );
  server.registerTool(
    'list_recent_deploys',
    {
      description: 'Recent deploys, newest first. Optionally for one service.',
      inputSchema: { service: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    (args) => listRecentDeploys(tenantId, args),
  );

  // ---- Actions (the agent runtime calls these only after a human approves) ----
  server.registerTool(
    'rollback_deploy',
    {
      description:
        'Roll a service back to a previous version. Fails if the current version is not from_version.',
      inputSchema: {
        service: z.string(),
        from_version: z.string(),
        to_version: z.string(),
        idempotency_key: z.string(),
        requested_by: z.string(),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    (args) => rollback(tenantId, args),
  );
  server.registerTool(
    'restart_service',
    {
      description: 'Rolling restart of every instance of a service.',
      inputSchema: { service: z.string(), idempotency_key: z.string() },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    (args) => restart(tenantId, args),
  );
  return server;
}

// ---- Tool handlers ----

/**
 * `get_active_alerts`.
 *
 * @param tenantId - The tenant.
 */
function getActiveAlerts(tenantId: string): ToolResult {
  const world = readWorld(tenantId);
  if (isDown(world, 'metrics')) return unavailable('metrics');
  const alerts = activeAlerts(world);
  return textResult(alerts.length ? alerts.join('\n') : 'No alerts firing.');
}

/**
 * `get_metrics`.
 *
 * @param tenantId - The tenant.
 * @param args - Service and metric.
 */
function getMetrics(tenantId: string, args: { service: string; metric: Metric }): ToolResult {
  const world = readWorld(tenantId);
  if (isDown(world, 'metrics')) return unavailable('metrics');
  if (!(args.service in world.services))
    return textResult(`Unknown service: ${args.service}`, true);
  const unit = { error_rate: '%', latency_p95_ms: 'ms', db_connections: ' connections' }[
    args.metric
  ];
  return textResult(
    `${args.service} ${args.metric} = ${metric(world, args.service, args.metric)}${unit}`,
  );
}

/**
 * `search_logs`.
 *
 * @param tenantId - The tenant.
 * @param args - Service and an optional substring filter.
 */
function searchLogs(tenantId: string, args: { service: string; query?: string }): ToolResult {
  const world = readWorld(tenantId);
  if (isDown(world, 'logs')) return unavailable('logs');
  if (!(args.service in world.services))
    return textResult(`Unknown service: ${args.service}`, true);
  const query = args.query?.toLowerCase();
  const lines = recentLogs(world, args.service).filter(
    (l) => !query || l.toLowerCase().includes(query),
  );
  return textResult(lines.length ? lines.join('\n') : 'No matching log lines.');
}

/**
 * `list_recent_deploys`.
 *
 * @param tenantId - The tenant.
 * @param args - An optional service filter.
 */
function listRecentDeploys(tenantId: string, args: { service?: string }): ToolResult {
  const world = readWorld(tenantId);
  if (isDown(world, 'deploys')) return unavailable('deploys');
  const deploys = world.deploys
    .filter((d) => !args.service || d.service === args.service)
    .map(
      (d) =>
        `${d.at}  ${d.service} ${d.previousVersion} -> ${d.version}  by ${d.author}  "${d.change}"`,
    );
  return textResult(deploys.length ? deploys.join('\n') : 'No recent deploys.');
}

/**
 * `rollback_deploy`: compare-and-swap on the version, idempotent by key (see `world-store.ts`).
 *
 * @param tenantId - The tenant.
 * @param args - The tool arguments, as the runtime sends them.
 */
function rollback(
  tenantId: string,
  args: {
    service: string;
    from_version: string;
    to_version: string;
    idempotency_key: string;
    requested_by: string;
  },
): ToolResult {
  const world = readWorld(tenantId);
  const outcome = rollbackDeploy(world, {
    service: args.service,
    fromVersion: args.from_version,
    toVersion: args.to_version,
    key: args.idempotency_key,
    by: args.requested_by,
  });
  writeWorld(world);
  return textResult(JSON.stringify(outcome));
}

/**
 * `restart_service`: idempotent by key.
 *
 * @param tenantId - The tenant.
 * @param args - Service and idempotency key.
 */
function restart(tenantId: string, args: { service: string; idempotency_key: string }): ToolResult {
  const world = readWorld(tenantId);
  const outcome = restartService(world, { service: args.service, key: args.idempotency_key });
  writeWorld(world);
  return textResult(JSON.stringify(outcome));
}

/**
 * The answer of a backend that is down: an error, as the vendor's API would give.
 *
 * @param source - The backend.
 */
function unavailable(source: Source): ToolResult {
  return textResult(
    `The ${source} backend is not responding (HTTP 503 from the vendor API).`,
    true,
  );
}

/**
 * A tool result with a single text block.
 *
 * @param text - The text.
 * @param isError - Marks the result as an error.
 */
function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], isError };
}

// Run only when started as a process (the worker spawns this file), not when imported by a test.
if (process.argv[1]?.endsWith('observability-server.ts')) {
  main().catch((e: unknown) => {
    console.error('fatal:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
