/**
 * Activities: everything that talks to the outside world (PagerDuty data, MCP, Claude).
 *
 * @remarks
 * The workflow calls these. Temporal records each result, retries failures with the timeouts and
 * retry policies set in `workflow/proxies.ts`, and after a crash replays completed results instead of
 * calling again. That is why a finished Claude call is never paid for twice.
 * Activities run as normal Node code (not in the workflow sandbox), so they can do I/O.
 *
 * @packageDocumentation
 */

import type Anthropic from '@anthropic-ai/sdk';
import { ApplicationFailure, Context } from '@temporalio/activity';
import type {
  ActionOutcome,
  ActionRequest,
  AgentVersion,
  Evidence,
  Incident,
  LlmStepResult,
  RecoveryCheck,
  ToolCallResult,
  VerifiedFix,
} from '../../shared/types.js';
import { PROPOSE_TOOL } from '../rules/prompt.js';
import { blockedBy } from './kill-switch.js';
import { callClaude, isRetryable } from './llm.js';
import { callMcpTool, listReadOnlyTools, READ_ONLY_TOOLS } from './mcp-pool.js';
import { saveFix } from './memory.js';
import { findSimilarIncidents, getOwnership } from './pagerduty.js';

/** Evidence before the workflow numbers it (ids are assigned in the workflow, deterministically). */
type NewEvidence = Omit<Evidence, 'id'>;

/**
 * The brief: the fixed first pass, before the model does anything.
 *
 * @remarks
 * Four sources, in parallel, no LLM:
 * - first-party (read directly): ownership/on-call and similar past incidents (memory: seeded
 *   postmortems plus fixes the agent learned);
 * - third-party (via MCP): active alerts and recent deploys.
 *
 * "What is broken?" and "what changed?" are the first two questions of any incident, so we always
 * ask them. The responder gets facts in about a second, even if the model is down. One failing
 * source never blocks the others: it becomes an evidence item marked unavailable.
 *
 * @param incident - The incident that fired.
 * @returns Four evidence items, in a fixed order.
 */
export async function gatherBaseContext(incident: Incident): Promise<NewEvidence[]> {
  const { tenantId, service, title } = incident;
  return Promise.all([
    readFirstParty(`Ownership and on-call for ${service}`, () =>
      describeOwnership(tenantId, service),
    ),
    readFirstParty('Similar past incidents (this tenant only)', () =>
      describePastIncidents(tenantId, service, title),
    ),
    readThirdParty(tenantId, 'Active alerts', 'get_active_alerts'),
    readThirdParty(tenantId, 'Recent deploys (all services)', 'list_recent_deploys'),
  ]);
}

/**
 * One Claude call. Runs on the LLM task queue, which has a small concurrency limit.
 *
 * @remarks
 * - **Heartbeat:** while waiting for the model, it tells Temporal "still alive" every 5 seconds.
 *   If the worker dies, the heartbeats stop and Temporal retries the call on another worker after
 *   the heartbeat timeout (20s), instead of waiting for the 4-minute call timeout. The timeout says
 *   how long a call may take; the heartbeat says how long we accept no news from the worker.
 * - **Tools:** the read-only MCP tools (sorted) plus `propose_next_step`. Same list on every call.
 * - **Errors:** an MCP failure while listing the tools is an ordinary error, so Temporal retries
 *   it. Claude's errors are sorted by {@link askClaude}.
 *
 * @param tenantId - Selects the tenant's MCP tools.
 * @param messages - The full transcript, owned by the workflow.
 * @param agent - The model and effort the incident is pinned to (see `IncidentWorkflowInput`).
 * @returns The assistant content (unchanged), the stop reason and the token usage.
 */
export async function llmStep(
  tenantId: string,
  messages: Anthropic.Beta.BetaMessageParam[],
  agent: AgentVersion | undefined,
): Promise<LlmStepResult> {
  const ctx = Context.current();
  const beat = setInterval(() => ctx.heartbeat(), 5_000);
  try {
    const tools = await modelTools(tenantId);
    const res = await askClaude(tools, messages, agent);
    return {
      content: res.content,
      stopReason: res.stop_reason,
      usage: {
        inputTokens: res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0),
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      },
    };
  } finally {
    clearInterval(beat);
  }
}

/**
 * A read tool call requested by the model.
 *
 * @remarks
 * The read-only allowlist is enforced here, in code, not in the prompt. A request for any other
 * tool (for example an action tool) is answered with an error the model can read; it never runs.
 *
 * @param tenantId - The tenant (selects the MCP connection).
 * @param name - The tool the model asked for.
 * @param input - The arguments the model wrote.
 * @returns The tool output, or a refusal.
 */
export async function callTool(
  tenantId: string,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!READ_ONLY_TOOLS.has(name)) {
    return { ok: false, text: `Tool "${name}" is not available to the agent.` };
  }
  return callMcpTool(tenantId, name, input);
}

/**
 * Runs an approved action on the customer's infrastructure (through MCP).
 *
 * @remarks
 * Only the workflow calls this, and only after a human approved the proposal. First, our own
 * **kill switch** (see `kill-switch.ts`): checked here, at the last moment, so a switch turned on
 * while the proposal waited still stops it. Then two protections travel with the call and are
 * enforced by the server:
 * - the **idempotency key** (`workflowId:proposalId`): a Temporal retry after a crash returns
 *   `already_executed` instead of rolling back twice;
 * - the **precondition** (`from_version`): if someone changed the service since the proposal, the
 *   rollback refuses with `precondition_failed` and nothing changes.
 *
 * @param tenantId - The tenant.
 * @param action - The validated, approved action.
 * @param idempotencyKey - Unique per proposal.
 * @param approvedBy - The human who approved it (recorded in the deploy history).
 * @returns What happened.
 */
export async function executeAction(
  tenantId: string,
  action: ActionRequest,
  idempotencyKey: string,
  approvedBy: string,
): Promise<ActionOutcome> {
  const blocked = blockedBy(tenantId, action.actionId);
  if (blocked) return { status: 'blocked', detail: `Not run: ${blocked}.` };
  const { tool, args } = actionToolCall(action, idempotencyKey, approvedBy);
  const r = await callMcpTool(tenantId, tool, args);
  if (!r.ok) return { status: 'failed', detail: r.text };
  return JSON.parse(r.text) as ActionOutcome;
}

/**
 * Did the action work? Checked by code against a threshold from the catalog.
 *
 * @remarks
 * The model does not decide whether the fix worked; the data does. The workflow waits
 * `verifyDelay` (a durable timer) before calling this, to let the metric settle.
 *
 * @param tenantId - The tenant.
 * @param service - The service the action ran on.
 * @param verify - Metric and threshold, from the catalog.
 * @returns Whether it recovered, and a sentence for the timeline and the model.
 */
export async function verifyRecovery(
  tenantId: string,
  service: string,
  verify: { metric: string; below: number },
): Promise<RecoveryCheck> {
  const r = await callMcpTool(tenantId, 'get_metrics', { service, metric: verify.metric });
  const value = parseMetricValue(r.text);
  if (!r.ok || value === null) {
    return { recovered: false, detail: `Could not read ${verify.metric}: ${r.text}` };
  }
  if (value < verify.below) {
    return {
      recovered: true,
      detail: `${service} ${verify.metric} is ${value} (below ${verify.below}). Recovered.`,
    };
  }
  return {
    recovered: false,
    detail: `${service} ${verify.metric} is still ${value} (needs to be below ${verify.below}).`,
  };
}

/**
 * Saves a fix that worked to the tenant's memory, so the next similar incident starts with it.
 *
 * @remarks
 * The workflow calls this only after `verifyRecovery` said it recovered: memory holds outcomes
 * that code checked, not the model's guesses. Idempotent by incident id (see `memory.ts`).
 *
 * @param tenantId - The tenant (memory never crosses tenants).
 * @param fix - What was wrong, what ran, and the verification.
 * @returns How many incidents this fix has now resolved (for the timeline).
 */
export async function rememberFix(tenantId: string, fix: VerifiedFix): Promise<number> {
  return saveFix(tenantId, fix).timesWorked;
}

// ---- Helpers ----

/**
 * Reads first-party data; a failure becomes an "unavailable" item instead of failing the brief.
 *
 * @param label - What the item is, for the model and the page.
 * @param read - Produces the item's text.
 */
async function readFirstParty(label: string, read: () => string): Promise<NewEvidence> {
  try {
    return { source: 'pagerduty', label, content: read(), ok: true };
  } catch (err) {
    return { source: 'pagerduty', label, content: errorText(err), ok: false };
  }
}

/**
 * Calls a third-party MCP tool with no arguments; a failure becomes an "unavailable" item.
 *
 * @param tenantId - The tenant.
 * @param label - What the item is.
 * @param tool - The read tool.
 */
async function readThirdParty(tenantId: string, label: string, tool: string): Promise<NewEvidence> {
  try {
    const r = await callMcpTool(tenantId, tool, {});
    return { source: 'observability', label, content: r.text, ok: r.ok };
  } catch (err) {
    return { source: 'observability', label, content: errorText(err), ok: false };
  }
}

/**
 * Ownership and on-call, as text for the brief.
 *
 * @param tenantId - The tenant.
 * @param service - The incident's service.
 */
function describeOwnership(tenantId: string, service: string): string {
  const o = getOwnership(tenantId, service);
  if (!o) return 'No ownership data for this service.';
  return `Team: ${o.team}\nPrimary on-call: ${o.primaryOnCall}\nSecondary on-call: ${o.secondaryOnCall}\nRunbook: ${o.runbook}`;
}

/**
 * Similar past incidents (seeded postmortems and learned fixes), as text for the brief.
 *
 * @param tenantId - The tenant.
 * @param service - The incident's service.
 * @param title - The incident's title (what retrieval matches on).
 */
function describePastIncidents(tenantId: string, service: string, title: string): string {
  const similar = findSimilarIncidents(tenantId, service, title);
  if (!similar.length) return 'None found.';
  return similar
    .map((p) => {
      const learned = p.timesWorked
        ? ` [learned by the agent: verified fix, worked ${p.timesWorked}x]`
        : '';
      return `${p.id} (${p.resolvedAt.slice(0, 10)}) ${p.title}${learned}\n  Root cause: ${p.rootCause}\n  Resolution: ${p.resolution}`;
    })
    .join('\n');
}

/**
 * The tool list the model sees: the tenant's read-only MCP tools, then `propose_next_step`.
 *
 * @param tenantId - Selects the tenant's MCP connection.
 * @returns The tools, in a stable order.
 */
async function modelTools(tenantId: string): Promise<Anthropic.Beta.BetaToolUnion[]> {
  const mcpTools = await listReadOnlyTools(tenantId);
  return [
    ...mcpTools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: { ...t.inputSchema, $schema: undefined } as Anthropic.Beta.BetaTool.InputSchema,
    })),
    PROPOSE_TOOL,
  ];
}

/**
 * Calls Claude and sorts its errors for Temporal.
 *
 * @remarks
 * Retryable errors (429, 5xx, network) are rethrown so Temporal retries them. Anything else (no
 * key, bad request) is non-retryable: retrying will not help, so the workflow degrades now
 * instead of after useless attempts.
 *
 * @param tools - The tool list.
 * @param messages - The transcript.
 * @param agent - The incident's model and effort.
 */
async function askClaude(
  tools: Anthropic.Beta.BetaToolUnion[],
  messages: Anthropic.Beta.BetaMessageParam[],
  agent: AgentVersion | undefined,
): Promise<Anthropic.Beta.BetaMessage> {
  try {
    return await callClaude(tools, messages, agent);
  } catch (err) {
    if (isRetryable(err)) throw err;
    const text = errorText(err);
    const reason = text.includes('authentication method') ? 'no API key configured' : text;
    throw ApplicationFailure.nonRetryable(reason, 'LlmUnavailable');
  }
}

/**
 * The MCP tool call for an approved action.
 *
 * @param action - The action.
 * @param idempotencyKey - Unique per proposal.
 * @param approvedBy - Who approved it.
 */
function actionToolCall(
  action: ActionRequest,
  idempotencyKey: string,
  approvedBy: string,
): { tool: string; args: Record<string, unknown> } {
  if (action.actionId === 'rollback_deploy') {
    return {
      tool: 'rollback_deploy',
      args: {
        service: action.service,
        from_version: action.fromVersion,
        to_version: action.toVersion,
        idempotency_key: idempotencyKey,
        requested_by: `sre-agent (approved by ${approvedBy})`,
      },
    };
  }
  return {
    tool: 'restart_service',
    args: { service: action.service, idempotency_key: idempotencyKey },
  };
}

/**
 * The number in a metric line like `checkout-api error_rate = 0.3%`.
 *
 * @param text - The `get_metrics` output.
 * @returns The value, or `null` if there is none.
 */
function parseMetricValue(text: string): number | null {
  const match = /=\s*([\d.]+)/.exec(text);
  return match?.[1] ? Number(match[1]) : null;
}

/**
 * Turns anything thrown into a message.
 *
 * @param err - The thrown value.
 */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
