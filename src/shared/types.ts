/**
 * Shared types: the vocabulary of the whole system.
 *
 * @remarks
 * Used by the workflow, the activities, the web server, the fake world and the eval.
 * This file must stay pure (no Node imports), because the Temporal workflow bundle imports it
 * and workflow code runs in a sandbox with no I/O.
 *
 * @packageDocumentation
 */

import type Anthropic from '@anthropic-ai/sdk';

/** Incident severity, as PagerDuty would report it. */
export type Severity = 'SEV1' | 'SEV2' | 'SEV3';

/**
 * An incident, as PagerDuty creates it. This is the input that starts a workflow.
 *
 * @remarks
 * In the real world it arrives through an `incident.triggered` event; in the demo, through the
 * "Trigger incident" button. `tenantId + id` is the workflow id, which dedupes double deliveries.
 */
export interface Incident {
  /** PagerDuty incident id, e.g. `INC-1234`. */
  id: string;
  /** The customer. Every read and action is scoped to it. */
  tenantId: string;
  /** The service the incident is about. Actions can only target this service. */
  service: string;
  /** Short human title of the incident. */
  title: string;
  /** How bad it is. */
  severity: Severity;
  /** ISO timestamp of when it fired. */
  triggeredAt: string;
}

/**
 * One piece of context the agent saw, with a stable id (`E1`, `E2`, …).
 *
 * @remarks
 * Every hypothesis must cite evidence ids, and code checks the ids exist. It is a cheap defence
 * against an answer that only looks right. Limit: it proves the model saw the data, not that it
 * read it correctly.
 */
export interface Evidence {
  /** `E1`, `E2`, … assigned by the workflow, in a deterministic order. */
  id: string;
  /** First-party (our own PagerDuty data) or third-party (the customer's stack, via MCP). */
  source: 'pagerduty' | 'observability';
  /** What it is, e.g. "Active alerts". */
  label: string;
  /** The data itself, truncated before it reaches the model. */
  content: string;
  /** False when the source failed: the evidence says "unavailable" instead of disappearing. */
  ok: boolean;
}

/** How sure the model is about a hypothesis. */
export type Confidence = 'low' | 'medium' | 'high';

/** A possible root cause, backed by evidence ids. */
export interface Hypothesis {
  /** The cause, in one sentence. */
  cause: string;
  /** How likely the model thinks it is. */
  confidence: Confidence;
  /** The evidence that supports it. Must exist (checked by the policy). */
  evidenceIds: string[];
}

/** The only actions that exist. See `CATALOG` in `worker/rules/catalog.ts`. */
export type ActionId = 'rollback_deploy' | 'restart_service';

/**
 * A concrete action the model proposes.
 *
 * @remarks
 * For a rollback, `fromVersion` is the precondition: the action only runs if the service is still
 * on that version (compare-and-swap). That is what makes a stale approval harmless.
 */
export interface ActionRequest {
  /** Which catalog action. */
  actionId: ActionId;
  /** Target service. Must equal the incident's service (blast radius). */
  service: string;
  /** Version the human saw when approving. `null` for actions that don't need versions. */
  fromVersion: string | null;
  /** Version to go back to. `null` for actions that don't need versions. */
  toVersion: string | null;
}

/**
 * What kind of next step the model proposes.
 * `action` runs something from the catalog after approval; `investigate` tells the human what to
 * check; `escalate` says who to involve and why.
 */
export type NextStepKind = 'action' | 'investigate' | 'escalate';

/** One proposal from the agent: what is happening, why, and the single next step. */
export interface Proposal {
  /** Random id. Every human decision carries it, so a late click on an old proposal is ignored. */
  id: string;
  /** 2-3 sentences for the responder. */
  summary: string;
  /** Most likely cause first. */
  hypotheses: Hypothesis[];
  /** The one step the agent suggests. */
  nextStep: {
    kind: NextStepKind;
    rationale: string;
    /** Set only when `kind` is `action` (checked by the policy). */
    action: ActionRequest | null;
  };
  /** ISO timestamp. */
  createdAt: string;
}

/**
 * What a human can say to a running incident (sent as a Temporal signal).
 * `retry` brings the agent back after it degraded: the human decides, not the agent.
 */
export type DecisionKind = 'approve' | 'reject' | 'resolve' | 'retry';

/** A human decision. Recorded in the timeline, so it is also the audit trail. */
export interface Decision {
  /** The proposal it answers. `null` for `resolve` and `retry`, which don't depend on one. */
  proposalId: string | null;
  /** What the human decided. */
  kind: DecisionKind;
  /** Who decided (the name typed on the page). */
  by: string;
  /** Optional reason. On a reject, the model reads it. */
  reason?: string;
}

/** Where the incident is in its life. Shown as the colored pill on the page. */
export type AgentStatus =
  | 'gathering_context'
  | 'investigating'
  | 'awaiting_approval'
  | 'executing'
  | 'verifying'
  | 'degraded'
  | 'resolved';

/** One line of the timeline: what happened, who did it, and the evidence behind it. */
export interface TimelineEntry {
  /** ISO timestamp (workflow time: deterministic on replay). */
  at: string;
  /** The model, the runtime, or a named human. */
  actor: 'agent' | 'system' | `human:${string}`;
  /** Category, used for styling on the page. */
  kind:
    | 'context'
    | 'thinking'
    | 'tool'
    | 'proposal'
    | 'policy'
    | 'decision'
    | 'action'
    | 'verify'
    | 'memory'
    | 'status';
  /** Human-readable text. */
  text: string;
  /** Evidence this entry refers to (shown as chips). */
  evidenceIds?: string[];
}

/** Token usage for one incident. Shown on the page as tokens and estimated cost. */
export interface Usage {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/**
 * Everything the page needs to show one incident. Returned by the `getState` query.
 *
 * @remarks
 * It lives inside the workflow, so it survives crashes: after a restart Temporal replays the
 * workflow and rebuilds exactly this object.
 */
export interface AgentState {
  incident: Incident;
  status: AgentStatus;
  /** The deterministic context brief (no LLM). Still valid when the agent degrades. */
  brief: string | null;
  evidence: Evidence[];
  timeline: TimelineEntry[];
  /** The current proposal, if any. */
  proposal: Proposal | null;
  /** How many proposals the agent has made so far. */
  round: number;
  usage: Usage;
  /** The model and effort this incident runs on (`null`: started before they were pinned). */
  agent: AgentVersion | null;
  /** Why the agent stopped, when `status` is `degraded`. */
  degradedReason: string | null;
}

/** Task queue for the workflow and the light activities (PagerDuty data, MCP reads, actions). */
export const AGENT_TASK_QUEUE = 'sre-agent';

/**
 * Task queue for Claude calls only.
 *
 * @remarks
 * A separate queue lets the worker cap LLM concurrency. During a burst (a region outage), calls
 * wait in Temporal instead of all hitting the provider at once: that is the backpressure.
 */
export const LLM_TASK_QUEUE = 'sre-agent-llm';

/** Input of the incident workflow. */
export interface IncidentWorkflowInput {
  incident: Incident;
  /** Settings, passed in because workflow code cannot read environment variables. */
  config: {
    /** How long to wait for a human before escalating, e.g. '5 minutes'. */
    approvalTimeout: string;
    /** How long to wait after an action before checking recovery, e.g. '15 seconds'. */
    verifyDelay: string;
    /**
     * The model and effort, fixed for the whole incident: a model change reaches new incidents
     * only, never one halfway through. Missing for incidents started before this existed: they
     * use the worker's current settings.
     */
    agent?: AgentVersion;
  };
}

/** How hard the model thinks: latency and cost vs quality. */
export type Effort = Anthropic.Beta.BetaOutputConfig['effort'];

/** Which model runs an incident, and how hard it thinks. */
export interface AgentVersion {
  /** Claude model id, e.g. `claude-opus-5-5`. */
  model: string;
  effort: Effort;
}

// ---- Activity contracts ----

/** Result of one Claude call (the `llmStep` activity). */
export interface LlmStepResult {
  /** Raw assistant content blocks. Appended to the transcript unchanged (thinking included). */
  content: Anthropic.Beta.BetaContentBlock[];
  /** Why the model stopped: `tool_use`, `end_turn`, `refusal`, `max_tokens`, … */
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

/** Result of one MCP tool call, flattened to text. */
export interface ToolCallResult {
  /** False when the tool reported an error. */
  ok: boolean;
  /** The tool output, truncated. */
  text: string;
}

/**
 * What happened when an approved action ran.
 * `already_executed` means a retry hit the idempotency key; `precondition_failed` means the world
 * changed since the proposal (compare-and-swap refused); `blocked` means a kill switch was on. In
 * those three cases nothing new happened.
 */
export type ActionOutcome =
  | { status: 'executed'; detail: string }
  | { status: 'already_executed'; detail: string }
  | { status: 'precondition_failed'; detail: string }
  | { status: 'blocked'; detail: string }
  | { status: 'failed'; detail: string };

/** One action that ran during an incident, and what the check said right after it. */
export interface ActionTaken {
  actionId: ActionId;
  /** What ran, e.g. `rollback_deploy on checkout-api (v2.4.1 -> v2.4.0)`. */
  action: string;
  /** What the agent believed the cause was: the proposal's top hypothesis. */
  rootCause: string;
  /** Who approved it. */
  approvedBy: string;
  /** The check after it, e.g. `checkout-api error_rate is 0.3 (below 1). Recovered.` */
  verification: string;
}

/**
 * A fix that worked, sent to memory. Only created after code verified the recovery, so memory
 * holds outcomes, not guesses.
 */
export interface VerifiedFix {
  incidentId: string;
  service: string;
  /** The incident title (retrieval matches on it). */
  title: string;
  /**
   * Every action that ran, in order. The last one recovered the service. Any before it did not
   * recover it alone (two causes at once need two fixes), and their checks say so.
   */
  actions: ActionTaken[];
}

/** Result of the post-action check. Decided by code against a threshold, not by the model. */
export interface RecoveryCheck {
  recovered: boolean;
  detail: string;
}

// ---- First-party data (PagerDuty's own) ----

/** Who owns a service and who is on call right now. Not a ticket: the service directory. */
export interface Ownership {
  team: string;
  primaryOnCall: string;
  secondaryOnCall: string;
  runbook: string;
}

/** A resolved incident from the past, with what caused it and what fixed it (like a postmortem summary). */
export interface PastIncident {
  id: string;
  service: string;
  title: string;
  rootCause: string;
  resolution: string;
  resolvedAt: string;
  /** Only for fixes the agent learned: how many incidents this fix resolved, each one verified. */
  timesWorked?: number;
}

/** Everything PagerDuty knows about one tenant. */
export interface TenantDirectory {
  ownership: Record<string, Ownership>;
  pastIncidents: PastIncident[];
}
