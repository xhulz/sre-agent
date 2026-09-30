/**
 * The state of one incident while its workflow runs ({@link IncidentRun}), and the small helpers
 * every step uses to change it.
 *
 * @remarks
 * Every function in `workflow/` receives the run explicitly: no function reaches for hidden state.
 * Like everything in this folder, this runs in Temporal's sandbox: deterministic, no I/O
 * (`new Date()` is Temporal's replay-safe clock here).
 *
 * @packageDocumentation
 */

import type Anthropic from '@anthropic-ai/sdk';
import { ActivityFailure } from '@temporalio/workflow';
import type {
  ActionTaken,
  AgentState,
  Decision,
  Evidence,
  Incident,
  IncidentWorkflowInput,
  Proposal,
  TimelineEntry,
} from '../../shared/types.js';

/** One message of the Claude transcript. */
export type MessageParam = Anthropic.Beta.BetaMessageParam;

/** The answer to one tool call, as the model reads it. */
export type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

/** Everything one incident carries while the workflow runs. */
export interface IncidentRun {
  incident: Incident;
  /** Timing, and the model the incident is pinned to (workflow code can't read settings itself). */
  settings: IncidentWorkflowInput['config'];
  /** What the page sees: the query answers with this. */
  state: AgentState;
  /** The Claude transcript. Append-only: never edit or reorder what is already there. */
  messages: MessageParam[];
  /** Actions that ran, in order, with the check after each: what memory saves on recovery. */
  actionsTaken: ActionTaken[];
  /** Set by the signal handler (and by a verified fix); the workflow waits on them. */
  decisions: {
    /** An approve or reject for the proposal on screen. */
    pending: Decision | null;
    /** Who closed the incident: a human, or the agent after a verified fix. */
    resolvedBy: Decision | null;
    /** A human asking the degraded agent to try again. */
    retryBy: Decision | null;
  };
}

/**
 * The initial state of an incident.
 *
 * @param input - The incident and its settings.
 */
export function startRun({ incident, config }: IncidentWorkflowInput): IncidentRun {
  return {
    incident,
    settings: config,
    state: {
      incident,
      status: 'gathering_context',
      brief: null,
      evidence: [],
      timeline: [],
      proposal: null,
      round: 0,
      usage: { llmCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      agent: config.agent ?? null,
      degradedReason: null,
    },
    messages: [],
    actionsTaken: [],
    decisions: { pending: null, resolvedBy: null, retryBy: null },
  };
}

/**
 * Adds a line to the timeline (also the audit trail).
 *
 * @param run - The incident.
 * @param actor - Who did it: the model, the runtime, or a named human.
 * @param kind - Category, for the page.
 * @param text - What happened.
 * @param evidenceIds - Evidence this line refers to.
 */
export function note(
  run: IncidentRun,
  actor: TimelineEntry['actor'],
  kind: TimelineEntry['kind'],
  text: string,
  evidenceIds?: string[],
): void {
  run.state.timeline.push({
    at: new Date().toISOString(),
    actor,
    kind,
    text,
    ...(evidenceIds ? { evidenceIds } : {}),
  });
}

/**
 * Stores one piece of evidence and gives it the next id (`E1`, `E2`, …).
 * Ids are assigned here, in a fixed order, so they are the same on every replay.
 *
 * @param run - The incident.
 * @param e - The evidence without an id.
 * @returns The stored evidence, with its id.
 */
export function addEvidence(run: IncidentRun, e: Omit<Evidence, 'id'>): Evidence {
  const evidence = { ...e, id: `E${run.state.evidence.length + 1}` };
  run.state.evidence.push(evidence);
  return evidence;
}

/**
 * Stops the agent and hands the incident to the human. The brief stays valid.
 *
 * @param run - The incident.
 * @param reason - Why, shown on the page.
 */
export function degrade(run: IncidentRun, reason: string): void {
  run.state.status = 'degraded';
  run.state.degradedReason = reason;
  note(
    run,
    'system',
    'status',
    `Degraded: ${reason}. The context brief (the evidence gathered so far) is still valid. A human takes it from here.`,
  );
}

/**
 * Whether someone (a human, or the agent after a verified fix) closed the incident.
 *
 * @param run - The incident.
 */
export function isResolved(run: IncidentRun): boolean {
  return run.decisions.resolvedBy !== null;
}

/**
 * The proposal's next step in words, e.g. `rollback_deploy on checkout-api (v2.4.1 -> v2.4.0)`.
 *
 * @param proposal - The proposal.
 */
export function describeStep(proposal: Proposal): string {
  const { kind, action } = proposal.nextStep;
  if (!action) return kind;
  const versions = action.fromVersion ? ` (${action.fromVersion} -> ${action.toVersion})` : '';
  return `${action.actionId} on ${action.service}${versions}`;
}

/**
 * Every evidence id the proposal's hypotheses cite, once each.
 *
 * @param proposal - The proposal.
 */
export function citedEvidence(proposal: Proposal): string[] {
  return [...new Set(proposal.hypotheses.flatMap((h) => h.evidenceIds))];
}

/**
 * The useful message of a failure. Activity errors arrive wrapped in an `ActivityFailure`.
 *
 * @param err - What was thrown.
 */
export function failureMessage(err: unknown): string {
  if (err instanceof ActivityFailure && err.cause) return err.cause.message;
  return err instanceof Error ? err.message : String(err);
}
