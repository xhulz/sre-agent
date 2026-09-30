/**
 * Step 2, investigate: Claude reads with read-only tools, then proposes one next step, which the
 * policy checks before any human sees it.
 *
 * @remarks
 * Each Claude call and each tool call is its own activity, so a crash in the middle only redoes
 * the step that was running. Runs in Temporal's sandbox, like everything in `workflow/`.
 *
 * @packageDocumentation
 */

import { uuid4 } from '@temporalio/workflow';
import type { LlmStepResult, Proposal, ToolCallResult } from '../../shared/types.js';
import { validateProposal } from '../rules/policy.js';
import { FEEDBACK, PROPOSE_TOOL_NAME } from '../rules/prompt.js';
import { callTool, llmStep } from './proxies.js';
import {
  addEvidence,
  degrade,
  failureMessage,
  type IncidentRun,
  isResolved,
  note,
  type ToolResult,
} from './run.js';

/** Claude calls per investigation round. A budget, so the model can't wander forever. */
const MAX_STEPS = 8;

/** A tool call the model made. */
type ToolUse = Extract<LlmStepResult['content'][number], { type: 'tool_use' }>;

/** A valid proposal, and the id of the `propose_next_step` call that made it. */
interface Found {
  toolUseId: string;
  proposal: Proposal;
}

/** What one model turn led to. */
type TurnResult =
  | { kind: 'proposal'; found: Found }
  | { kind: 'degraded' }
  | { kind: 'continue'; results: ToolResult[] };

/** The limits of one investigation round. */
interface RoundBudget {
  /** Whether the model was already nudged for ending a turn without a proposal. */
  nudged: boolean;
  /** Proposals the policy blocked this round. */
  policyRejections: number;
}

/**
 * One investigation round: Claude reads with tools until it makes a valid proposal.
 *
 * @remarks
 * The model's corner cases keep the transcript valid (every `tool_use` gets a `tool_result`):
 * - no tool call → one nudge, then degrade;
 * - reads and a proposal in the same turn → run the reads, ignore that proposal (it was made
 *   before seeing the data it asked for);
 * - a proposal blocked by policy → the model reads the errors and gets one more try.
 *
 * @param run - The incident.
 * @returns The valid proposal, or `null` if it degraded or the incident was resolved meanwhile.
 */
export async function investigate(run: IncidentRun): Promise<Found | null> {
  const budget: RoundBudget = { nudged: false, policyRejections: 0 };
  for (let step = 0; step < MAX_STEPS && !isResolved(run); step++) {
    const res = await askModel(run);
    if (!res) return null;
    const toolUses = res.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      if (!nudge(run, budget)) return null;
      continue;
    }
    const turn = await handleToolUses(run, toolUses, budget);
    if (turn.kind === 'proposal') return turn.found;
    if (turn.kind === 'degraded') return null;
    run.messages.push({ role: 'user', content: turn.results });
  }
  if (!isResolved(run)) degrade(run, `no valid proposal after ${MAX_STEPS} steps`);
  return null;
}

/**
 * One Claude call: counts tokens, appends the answer to the transcript, shows the reasoning.
 *
 * @param run - The incident.
 * @returns The answer, or `null` if the agent degraded (model down, refusal, cut-off output).
 */
async function askModel(run: IncidentRun): Promise<LlmStepResult | null> {
  let res: LlmStepResult;
  try {
    // The model and effort the incident started with, even if the settings changed since.
    res = await llmStep(run.incident.tenantId, run.messages, run.settings.agent);
  } catch (err) {
    // Reached after the retries, or at once for errors that retrying can't fix (no key).
    degrade(run, `the model step failed (${failureMessage(err)})`);
    return null;
  }
  countUsage(run, res);
  // Append the assistant turn exactly as received (thinking blocks included).
  run.messages.push({ role: 'assistant', content: res.content });
  if (res.stopReason === 'refusal') {
    degrade(run, 'the model declined to answer');
    return null;
  }
  if (res.stopReason === 'max_tokens') {
    degrade(run, 'the model output was cut off');
    return null;
  }
  showReasoning(run, res);
  return res;
}

/**
 * Adds a model call's tokens to the incident's usage (shown as tokens and cost on the page).
 *
 * @param run - The incident.
 * @param res - The model's answer.
 */
function countUsage(run: IncidentRun, res: LlmStepResult): void {
  const usage = run.state.usage;
  usage.llmCalls++;
  usage.inputTokens += res.usage.inputTokens;
  usage.outputTokens += res.usage.outputTokens;
  usage.cacheReadTokens += res.usage.cacheReadTokens;
}

/**
 * The model's (summarized) reasoning becomes the grey lines of the timeline.
 *
 * @param run - The incident.
 * @param res - The model's answer.
 */
function showReasoning(run: IncidentRun, res: LlmStepResult): void {
  for (const block of res.content) {
    if (block.type === 'thinking' && block.thinking.trim()) {
      note(run, 'agent', 'thinking', clip(block.thinking));
    }
    if (block.type === 'text' && block.text.trim())
      note(run, 'agent', 'thinking', clip(block.text));
  }
}

/**
 * The model ended its turn without calling any tool: nudge it once; the second time, degrade.
 *
 * @param run - The incident.
 * @param budget - The round's limits.
 * @returns False if the agent degraded.
 */
function nudge(run: IncidentRun, budget: RoundBudget): boolean {
  if (budget.nudged) {
    degrade(run, 'the model stopped without a proposal');
    return false;
  }
  budget.nudged = true;
  run.messages.push({ role: 'user', content: FEEDBACK.nudge });
  return true;
}

/**
 * Runs the reads the model asked for, then deals with its proposal, if it made exactly one and
 * asked for no reads in the same turn.
 *
 * @param run - The incident.
 * @param toolUses - The tool calls of this turn.
 * @param budget - The round's limits.
 */
async function handleToolUses(
  run: IncidentRun,
  toolUses: ToolUse[],
  budget: RoundBudget,
): Promise<TurnResult> {
  const reads = toolUses.filter((t) => t.name !== PROPOSE_TOOL_NAME);
  const proposals = toolUses.filter((t) => t.name === PROPOSE_TOOL_NAME);
  const results = await runReads(run, reads);
  // Several proposals at once, or a proposal made before seeing the data it just asked for.
  if (proposals.length > 1 || (proposals.length === 1 && reads.length > 0)) {
    return { kind: 'continue', results: [...results, ...proposals.map(ignoredProposal)] };
  }
  const [proposal] = proposals;
  if (!proposal) return { kind: 'continue', results };
  return checkProposal(run, proposal, budget);
}

/**
 * Runs the reads in parallel. Each result becomes evidence, numbered in the order the model
 * asked (stable on replay). A failed source becomes "unavailable" evidence, not a crash.
 *
 * @param run - The incident.
 * @param reads - The read tool calls.
 * @returns The answers, one per call.
 */
async function runReads(run: IncidentRun, reads: ToolUse[]): Promise<ToolResult[]> {
  const outcomes = await Promise.all(
    reads.map(async (call) => ({ call, result: await readTool(run, call) })),
  );
  return outcomes.map(({ call, result }) => recordRead(run, call, result));
}

/**
 * One read tool call, as an activity. A failure is an answer, not an exception.
 *
 * @param run - The incident.
 * @param call - The tool call.
 */
function readTool(run: IncidentRun, call: ToolUse): Promise<ToolCallResult> {
  return callTool(run.incident.tenantId, call.name, call.input as Record<string, unknown>).catch(
    (err: unknown): ToolCallResult => ({
      ok: false,
      text: `Source unavailable: ${failureMessage(err)}`,
    }),
  );
}

/**
 * Stores a read's result as evidence, logs it, and builds the answer the model reads.
 *
 * @param run - The incident.
 * @param call - The tool call.
 * @param result - What the tool returned.
 */
function recordRead(run: IncidentRun, call: ToolUse, result: ToolCallResult): ToolResult {
  const label = `${call.name} ${JSON.stringify(call.input)}`;
  const evidence = addEvidence(run, {
    source: 'observability',
    label,
    content: result.text,
    ok: result.ok,
  });
  note(run, 'agent', 'tool', `${label}${result.ok ? '' : ' (failed)'}`, [evidence.id]);
  return {
    type: 'tool_result',
    tool_use_id: call.id,
    content: `[${evidence.id}] ${result.text}`,
    is_error: !result.ok,
  };
}

/**
 * The answer to a proposal that is not considered.
 *
 * @param call - The `propose_next_step` call.
 */
function ignoredProposal(call: ToolUse): ToolResult {
  return {
    type: 'tool_result',
    tool_use_id: call.id,
    content: FEEDBACK.proposalIgnored,
    is_error: true,
  };
}

/**
 * Runs the policy on a proposal. Valid: it gets an id. Blocked: the model reads why and gets one
 * more try; blocked twice, the agent degrades.
 *
 * @param run - The incident.
 * @param call - The `propose_next_step` call.
 * @param budget - The round's limits.
 */
function checkProposal(run: IncidentRun, call: ToolUse, budget: RoundBudget): TurnResult {
  const check = validateProposal(call.input, {
    incident: run.incident,
    evidenceIds: new Set(run.state.evidence.map((e) => e.id)),
  });
  if (check.ok) {
    // The tool_result for this call is added later, with what the human and the world said.
    const proposal = { ...check.proposal, id: uuid4(), createdAt: new Date().toISOString() };
    return { kind: 'proposal', found: { toolUseId: call.id, proposal } };
  }
  budget.policyRejections++;
  note(run, 'system', 'policy', `Proposal blocked by policy: ${check.errors.join('; ')}`);
  if (budget.policyRejections > 1) {
    degrade(run, 'the model kept proposing steps that break policy');
    return { kind: 'degraded' };
  }
  const blocked: ToolResult = {
    type: 'tool_result',
    tool_use_id: call.id,
    content: FEEDBACK.policyBlocked(check.errors),
    is_error: true,
  };
  return { kind: 'continue', results: [blocked] };
}

/**
 * Shortens long text for the timeline.
 *
 * @param text - The text.
 * @param max - Maximum length.
 */
function clip(text: string, max = 700): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
