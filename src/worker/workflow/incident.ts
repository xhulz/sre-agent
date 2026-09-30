/**
 * The incident, as a durable Temporal workflow: brief → investigate → propose → human decides →
 * execute → verify → resolve. This is the file the worker loads (`workflowsPath`).
 *
 * @remarks
 * Everything in `workflow/` is deterministic orchestration and runs in Temporal's sandbox.
 * Anything that touches the outside world (PagerDuty data, MCP, Claude) is an activity
 * (`activities/`). Temporal records every activity result; if the worker dies at any point,
 * Temporal replays this code with the recorded results and it continues exactly where it was.
 * That is why:
 * - this folder must not do I/O, read the clock directly, or use random numbers (Temporal provides
 *   deterministic versions: `new Date()` and `uuid4()` are safe here);
 * - changing this code while incidents are open needs care (versioning), because replay must take
 *   the same decisions.
 *
 * How to read it: {@link incidentWorkflow} is the whole story in five lines. This file holds the
 * setup and the loop; `investigate.ts` is step 2 and `decide.ts` is step 3.
 *
 * @packageDocumentation
 */

import { condition, defineQuery, defineSignal, setHandler } from '@temporalio/workflow';
import type { AgentState, Decision, IncidentWorkflowInput } from '../../shared/types.js';
import { FEEDBACK, renderEvidence, renderFirstMessage } from '../rules/prompt.js';
import { handleProposal } from './decide.js';
import { investigate } from './investigate.js';
import { gatherBaseContext } from './proxies.js';
import {
  addEvidence,
  degrade,
  type IncidentRun,
  isResolved,
  note,
  startRun,
  type ToolResult,
} from './run.js';

/**
 * The only way a human talks to a running incident: approve, reject, resolve, or retry.
 *
 * @remarks
 * Temporal applies signals one at a time, so two people clicking at once can't race: the first
 * valid decision wins and the other is ignored and logged.
 */
export const decisionSignal = defineSignal<[Decision]>('decision');

/** Read-only view of the incident, for the page. Answered by the worker from workflow memory. */
export const getStateQuery = defineQuery<AgentState>('getState');

/** Proposals per incident before handing over to the human. */
const MAX_ROUNDS = 4;

/**
 * One incident, from trigger to resolution.
 *
 * @remarks
 * 1. **Brief first:** fixed context without the model, visible in about a second.
 * 2. **Investigate:** Claude calls read-only tools, then `propose_next_step`.
 * 3. **Policy:** code checks the proposal (catalog, target, evidence) before a human sees it.
 * 4. **Wait for a human:** on timeout, escalate once and keep waiting. Silence is not approval.
 * 5. **Execute:** kill switch, compare-and-swap precondition, idempotency key.
 * 6. **Verify:** durable timer, then a metric check in code. Recovered → saved to memory → resolved.
 *
 * Whatever happens (rejection, stale approval, action not fixing it) goes back to Claude as the
 * answer to its `propose_next_step` call, so re-investigating is just continuing the conversation.
 * If the model is unavailable, the workflow degrades: the brief stays and a human drives; the human
 * can bring the agent back later with a `retry`.
 *
 * The workflow id is `tenant:incident`, so a duplicate trigger is refused by Temporal.
 *
 * @param input - The incident and its settings.
 * @returns The final state, once resolved.
 */
export async function incidentWorkflow(input: IncidentWorkflowInput): Promise<AgentState> {
  const run = startRun(input);
  listenToHumans(run);
  await buildBrief(run);
  await investigateUntilResolved(run);
  return finish(run);
}

// ---- Setup: how humans reach the incident ----

/**
 * Registers the query (the page reads the state) and the signal (a human decides).
 *
 * @param run - The incident.
 */
function listenToHumans(run: IncidentRun): void {
  setHandler(getStateQuery, () => run.state);
  setHandler(decisionSignal, (d) => onDecision(run, d));
}

/**
 * Applies one human decision.
 *
 * @param run - The incident.
 * @param d - The decision.
 */
function onDecision(run: IncidentRun, d: Decision): void {
  // A human can always close the incident, whatever the agent is doing.
  if (d.kind === 'resolve') run.decisions.resolvedBy = d;
  else if (d.kind === 'retry') acceptRetry(run, d);
  else acceptVerdict(run, d);
}

/**
 * A `retry`: only a human brings the agent back, and only after it degraded.
 *
 * @param run - The incident.
 * @param d - The decision.
 */
function acceptRetry(run: IncidentRun, d: Decision): void {
  if (run.state.status === 'degraded') run.decisions.retryBy = d;
  else note(run, `human:${d.by}`, 'decision', 'Ignored "retry": the agent is not degraded.');
}

/**
 * An `approve` or `reject`: valid only for the proposal waiting on screen. A late click on an old
 * proposal must never approve the current one.
 *
 * @param run - The incident.
 * @param d - The decision.
 */
function acceptVerdict(run: IncidentRun, d: Decision): void {
  const current = run.state.proposal?.id;
  if (run.state.status === 'awaiting_approval' && d.proposalId === current) {
    run.decisions.pending = d;
    return;
  }
  // The timeline is the audit trail: say exactly why (a double click is not an old proposal).
  const why =
    d.proposalId === current ? 'this proposal was already decided' : 'it was for an older proposal';
  note(run, `human:${d.by}`, 'decision', `Ignored "${d.kind}": ${why}.`);
}

// ---- 1. Brief first: deterministic context, no LLM, visible in seconds ----

/**
 * Gathers the fixed context, numbers it (`E1`, `E2`, …), and starts the transcript with it.
 *
 * @param run - The incident.
 */
async function buildBrief(run: IncidentRun): Promise<void> {
  for (const e of await gatherBaseContext(run.incident)) addEvidence(run, e);
  const { evidence } = run.state;
  run.state.brief = evidence.map(renderEvidence).join('\n\n');
  const unavailable = evidence.filter((e) => !e.ok).length;
  note(
    run,
    'system',
    'context',
    `Context brief ready: ${evidence.length} items${unavailable ? `, ${unavailable} source(s) unavailable` : ''}.`,
    evidence.map((e) => e.id),
  );
  run.messages.push({ role: 'user', content: renderFirstMessage(run.incident, evidence) });
}

// ---- The loop: rounds of investigate (step 2) → decide (step 3) ----

/**
 * Runs rounds until the incident is resolved. When the agent degrades (model down, out of
 * budget), a human drives: they resolve it, or bring the agent back with a retry.
 *
 * @param run - The incident.
 */
async function investigateUntilResolved(run: IncidentRun): Promise<void> {
  while (!isResolved(run)) {
    await runRounds(run);
    if (isResolved(run)) return;
    await waitForHumanWhileDegraded(run);
  }
}

/**
 * Up to {@link MAX_ROUNDS} proposals. Each outcome goes back to the model as the answer to its
 * proposal, so the next round starts from what happened.
 *
 * @param run - The incident.
 */
async function runRounds(run: IncidentRun): Promise<void> {
  for (let round = 0; round < MAX_ROUNDS && !isResolved(run); round++) {
    run.state.round++;
    run.state.status = 'investigating';
    const found = await investigate(run);
    if (!found) return; // degraded, or resolved meanwhile
    const outcome = await handleProposal(run, found.proposal);
    if (outcome === 'resolved') return;
    answerProposal(run, found.toolUseId, outcome);
  }
  if (!isResolved(run)) degrade(run, `reached ${MAX_ROUNDS} proposals without recovery`);
}

/**
 * Answers the `propose_next_step` call with what happened, so the transcript stays valid.
 *
 * @param run - The incident.
 * @param toolUseId - The proposal's tool call.
 * @param outcome - What happened, for the model.
 */
function answerProposal(run: IncidentRun, toolUseId: string, outcome: string): void {
  run.messages.push({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: outcome }],
  });
}

/**
 * Degraded: waits for a human to resolve the incident or to bring the agent back.
 *
 * @param run - The incident.
 */
async function waitForHumanWhileDegraded(run: IncidentRun): Promise<void> {
  await condition(() => isResolved(run) || run.decisions.retryBy !== null);
  const retry = run.decisions.retryBy;
  if (retry && !isResolved(run)) resume(run, retry);
}

/**
 * The human brought the agent back: continue the same conversation.
 *
 * @remarks
 * Any tool call left open when we degraded gets an answer ("not run"), so the transcript stays
 * valid, and the model is told it was away and that things may have changed. The agent then gets
 * a fresh budget of rounds.
 *
 * @param run - The incident.
 * @param d - The human's `retry` decision (for the audit trail).
 */
function resume(run: IncidentRun, d: Decision): void {
  run.decisions.retryBy = null;
  note(run, `human:${d.by}`, 'decision', 'Asked the agent to try again.');
  run.state.status = 'investigating';
  run.state.degradedReason = null;
  const notRun = openToolCalls(run).map(
    (id): ToolResult => ({
      type: 'tool_result',
      tool_use_id: id,
      content: FEEDBACK.notRun,
      is_error: true,
    }),
  );
  run.messages.push({
    role: 'user',
    content: [...notRun, { type: 'text', text: FEEDBACK.resumed }],
  });
}

/**
 * Ids of the tool calls in the last assistant turn, if the transcript ended there.
 *
 * @param run - The incident.
 */
function openToolCalls(run: IncidentRun): string[] {
  const last = run.messages.at(-1);
  if (last?.role !== 'assistant' || !Array.isArray(last.content)) return [];
  return last.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []));
}

// ---- The end ----

/**
 * Closes the incident and returns its final state (also the workflow's result).
 *
 * @param run - The incident.
 */
function finish(run: IncidentRun): AgentState {
  const by = run.decisions.resolvedBy?.by ?? 'unknown';
  run.state.status = 'resolved';
  const actor = by.startsWith('sre-agent') ? 'system' : (`human:${by}` as const);
  note(run, actor, 'status', `Incident resolved by ${by}.`);
  return run.state;
}
