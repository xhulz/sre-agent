/**
 * Step 3, decide: the proposal goes to a human; if approved, the runtime executes it, verifies it
 * with a metric, and remembers the fix.
 *
 * @remarks
 * - A stale approval is caught by the action itself (compare-and-swap), not by this code.
 * - The kill switch is checked by the `executeAction` activity right before the action runs.
 * - Recovery is decided by a metric check in code, after a durable timer. A verified fix is saved
 *   to the tenant's memory with every action that led to it; nothing else is.
 *
 * Runs in Temporal's sandbox, like everything in `workflow/`.
 *
 * @packageDocumentation
 */

import { condition, patched, sleep, workflowInfo } from '@temporalio/workflow';
import type {
  ActionOutcome,
  ActionRequest,
  ActionTaken,
  Decision,
  Proposal,
  RecoveryCheck,
} from '../../shared/types.js';
import { CATALOG } from '../rules/catalog.js';
import { FEEDBACK } from '../rules/prompt.js';
import { executeAction, rememberFix, verifyRecovery } from './proxies.js';
import {
  citedEvidence,
  describeStep,
  failureMessage,
  type IncidentRun,
  isResolved,
  note,
} from './run.js';

/**
 * Shows the proposal, waits for a human, and if approved executes and verifies it.
 *
 * @param run - The incident.
 * @param proposal - The validated proposal.
 * @returns `'resolved'`, or a sentence describing what happened, which the model reads next.
 */
export async function handleProposal(
  run: IncidentRun,
  proposal: Proposal,
): Promise<string | 'resolved'> {
  showProposal(run, proposal);
  const d = await waitForDecision(run);
  if (!d) return 'resolved';
  recordDecision(run, proposal, d);
  if (d.kind === 'reject') return FEEDBACK.rejected(d.reason);
  const action = proposal.nextStep.action;
  if (!action) return FEEDBACK.acknowledged;

  const outcome = await executeApproved(run, action, proposal, d);
  if (outcome.status === 'blocked') return FEEDBACK.blocked(outcome.detail);
  if (outcome.status === 'precondition_failed' || outcome.status === 'failed') {
    return FEEDBACK.notExecuted(outcome.status, outcome.detail);
  }
  const check = await verifyAction(run, action);
  run.actionsTaken.push(actionTaken(proposal, action, d, check));
  if (!check.recovered) return FEEDBACK.notFixed(outcome.detail, check.detail);

  await rememberVerifiedFix(run);
  // Like a PagerDuty incident that auto-resolves when its alert clears.
  run.decisions.resolvedBy ??= {
    proposalId: proposal.id,
    kind: 'resolve',
    by: 'sre-agent (alert cleared)',
  };
  return 'resolved';
}

/**
 * Puts the proposal on screen and clears any earlier decision.
 *
 * @param run - The incident.
 * @param proposal - The validated proposal.
 */
function showProposal(run: IncidentRun, proposal: Proposal): void {
  run.state.proposal = proposal;
  run.state.status = 'awaiting_approval';
  run.decisions.pending = null;
  note(
    run,
    'agent',
    'proposal',
    `Proposed: ${describeStep(proposal)}. ${proposal.nextStep.rationale}`,
    citedEvidence(proposal),
  );
}

/**
 * Waits for a human, durably (costs nothing, survives restarts). On timeout, escalates once and
 * keeps waiting: escalating adds people, it doesn't take the decision away from anyone. The agent
 * never acts on silence.
 *
 * @param run - The incident.
 * @returns The decision, or `null` if the incident was resolved meanwhile.
 */
async function waitForDecision(run: IncidentRun): Promise<Decision | null> {
  const answered = await condition(() => hasAnswer(run), run.settings.approvalTimeout);
  if (!answered) {
    note(
      run,
      'system',
      'status',
      `No answer in ${run.settings.approvalTimeout}: escalated, also paging the secondary on-call (simulated). Anyone on the incident can still decide.`,
    );
    await condition(() => hasAnswer(run));
  }
  return isResolved(run) ? null : run.decisions.pending;
}

/**
 * Whether a human answered the proposal or closed the incident.
 *
 * @param run - The incident.
 */
function hasAnswer(run: IncidentRun): boolean {
  return run.decisions.pending !== null || isResolved(run);
}

/**
 * Logs the decision in the timeline (the audit trail): who, what, which proposal, which evidence.
 *
 * @param run - The incident.
 * @param proposal - The proposal decided on.
 * @param d - The decision.
 */
function recordDecision(run: IncidentRun, proposal: Proposal, d: Decision): void {
  const verb = d.kind === 'approve' ? 'Approved' : 'Rejected';
  note(
    run,
    `human:${d.by}`,
    'decision',
    `${verb} proposal ${proposal.id.slice(0, 8)}${d.reason ? `: ${d.reason}` : ''}`,
    citedEvidence(proposal),
  );
}

/**
 * Runs the approved action. The idempotency key is unique per proposal, so a retried activity can
 * never run the same action twice. An error becomes a `failed` outcome.
 *
 * @param run - The incident.
 * @param action - The approved action.
 * @param proposal - Its proposal (for the idempotency key).
 * @param d - The approval (who approved it).
 */
async function executeApproved(
  run: IncidentRun,
  action: ActionRequest,
  proposal: Proposal,
  d: Decision,
): Promise<ActionOutcome> {
  run.state.status = 'executing';
  const key = `${workflowInfo().workflowId}:${proposal.id}`;
  const outcome = await executeAction(run.incident.tenantId, action, key, d.by).catch(
    (err: unknown): ActionOutcome => ({ status: 'failed', detail: failureMessage(err) }),
  );
  note(
    run,
    'system',
    'action',
    `${action.actionId} on ${action.service}: ${outcome.status}. ${outcome.detail}`,
  );
  return outcome;
}

/**
 * Waits (durable timer: survives a worker restart), then checks the catalog's metric.
 *
 * @param run - The incident.
 * @param action - The action that ran.
 */
async function verifyAction(run: IncidentRun, action: ActionRequest): Promise<RecoveryCheck> {
  run.state.status = 'verifying';
  const rule = CATALOG[action.actionId].verify;
  note(
    run,
    'system',
    'verify',
    `Waiting ${run.settings.verifyDelay}, then checking ${rule.metric}.`,
  );
  await sleep(run.settings.verifyDelay);
  const check = await verifyRecovery(run.incident.tenantId, action.service, rule);
  note(run, 'system', 'verify', check.detail);
  return check;
}

/**
 * One action that ran, with what the check said after it (for memory).
 *
 * @param proposal - Its proposal (the step in words, and the cause the agent believed).
 * @param action - The action.
 * @param d - The approval.
 * @param check - The verification after it.
 */
function actionTaken(
  proposal: Proposal,
  action: ActionRequest,
  d: Decision,
  check: RecoveryCheck,
): ActionTaken {
  return {
    actionId: action.actionId,
    action: describeStep(proposal),
    rootCause: proposal.hypotheses[0]?.cause ?? proposal.summary,
    approvedBy: d.by,
    verification: check.detail,
  };
}

/**
 * Memory: only a fix that code verified is worth remembering, with every action that led to it
 * (two causes at once need two fixes). Failing to save must not block the resolution, so a
 * failure is only noted.
 *
 * @remarks
 * `patched`: incidents that finished before this step existed replay without it (they never
 * called this activity). This is how workflow code changes while incidents are open.
 *
 * @param run - The incident, after its last action recovered the service.
 */
async function rememberVerifiedFix(run: IncidentRun): Promise<void> {
  if (!patched('remember-verified-fixes')) return;
  const path = run.actionsTaken.map((a) => a.action).join(', then ');
  try {
    const times = await rememberFix(run.incident.tenantId, {
      incidentId: run.incident.id,
      service: run.incident.service,
      title: run.incident.title,
      actions: run.actionsTaken,
    });
    note(
      run,
      'system',
      'memory',
      `Saved to memory: ${path} fixed it (verified${times > 1 ? `, ${times} times now` : ''}). The next similar incident starts with this.`,
    );
  } catch (err) {
    note(run, 'system', 'memory', `Could not save to memory: ${failureMessage(err)}`);
  }
}
