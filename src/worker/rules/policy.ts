/**
 * The policy: deterministic checks on what the model proposes. The model proposes, code decides.
 *
 * @remarks
 * This is the real safety control, not the prompt. Even if the model is fooled (for example by a
 * hostile log line), a proposal that targets another service or cites evidence that doesn't
 * exist never reaches the human. Pure module: it runs inside the workflow, so its result is
 * recorded and replayed exactly. Proven by `test/policy.test.ts`.
 *
 * @packageDocumentation
 */

import { z } from 'zod';
import type { Incident, Proposal } from '../../shared/types.js';
import { CATALOG } from './catalog.js';

/**
 * Shape of the `propose_next_step` tool input, snake_case as the model writes it.
 *
 * @remarks
 * The tool is declared `strict` on the API side, so the shape is usually right already. We parse
 * again anyway: never trust model output, and this also covers a fallback model or a future
 * schema change.
 */
const ProposalInput = z.object({
  summary: z.string().min(1),
  hypotheses: z
    .array(
      z.object({
        cause: z.string().min(1),
        confidence: z.enum(['low', 'medium', 'high']),
        evidence_ids: z.array(z.string()),
      }),
    )
    .min(1),
  next_step: z.object({
    kind: z.enum(['action', 'investigate', 'escalate']),
    rationale: z.string().min(1),
    action: z
      .object({
        action_id: z.enum(['rollback_deploy', 'restart_service']),
        service: z.string(),
        from_version: z.string().nullable(),
        to_version: z.string().nullable(),
      })
      .nullable(),
  }),
});

/** The proposal as the model wrote it (after the shape check). */
type RawProposal = z.infer<typeof ProposalInput>;

/** The action part of a raw proposal. */
type RawAction = NonNullable<RawProposal['next_step']['action']>;

/** Either a clean proposal (without id/time, which the workflow adds) or the list of problems. */
export type PolicyResult =
  | { ok: true; proposal: Omit<Proposal, 'id' | 'createdAt'> }
  | { ok: false; errors: string[] };

/**
 * Checks a proposal before any human sees it.
 *
 * @remarks
 * Checks, in order:
 * 1. Shape (zod).
 * 2. Every hypothesis cites at least one evidence id, and every id exists.
 * 3. An `action` proposal has an action; a suggestion (`investigate`/`escalate`) has none.
 * 4. Blast radius: the action targets the incident's service only.
 * 5. A rollback has both versions, and they differ (the compare-and-swap precondition).
 *
 * All errors are collected (not just the first), so the model can fix everything in one retry.
 *
 * @param input - The raw `propose_next_step` input from the model.
 * @param ctx - The incident and the ids of the evidence the agent has actually seen.
 * @returns The normalized proposal, or the errors that the model will read.
 */
export function validateProposal(
  input: unknown,
  ctx: { incident: Incident; evidenceIds: ReadonlySet<string> },
): PolicyResult {
  const parsed = ProposalInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  const errors = [
    ...checkEvidence(parsed.data, ctx.evidenceIds),
    ...checkNextStep(parsed.data, ctx.incident),
  ];
  if (errors.length) return { ok: false, errors };
  return { ok: true, proposal: normalize(parsed.data) };
}

/**
 * Check 2: every claim points at evidence the agent actually saw.
 *
 * @param p - The proposal.
 * @param evidenceIds - Ids of the evidence gathered so far.
 */
function checkEvidence(p: RawProposal, evidenceIds: ReadonlySet<string>): string[] {
  return p.hypotheses.flatMap((h) => [
    ...(h.evidence_ids.length === 0 ? [`hypothesis "${h.cause}" cites no evidence`] : []),
    ...h.evidence_ids
      .filter((id) => !evidenceIds.has(id))
      .map((id) => `evidence ${id} does not exist`),
  ]);
}

/**
 * Checks 3 to 5: the next step is either a well-formed action on the incident's service, or a
 * suggestion with no action.
 *
 * @param p - The proposal.
 * @param incident - The incident.
 */
function checkNextStep(p: RawProposal, incident: Incident): string[] {
  const { kind, action } = p.next_step;
  if (kind !== 'action') return action ? [`kind is "${kind}" but an action was given`] : [];
  if (!action) return ['kind is "action" but no action was given'];
  return [...checkBlastRadius(action, incident), ...checkVersions(action)];
}

/**
 * Check 4, blast radius: an incident on service X can only act on service X.
 *
 * @param action - The proposed action.
 * @param incident - The incident.
 */
function checkBlastRadius(action: RawAction, incident: Incident): string[] {
  if (action.service === incident.service) return [];
  return [`action targets ${action.service}, but this incident is on ${incident.service}`];
}

/**
 * Check 5: a rollback names both versions (the compare-and-swap precondition), and they differ.
 *
 * @param action - The proposed action.
 */
function checkVersions(action: RawAction): string[] {
  const entry = CATALOG[action.action_id];
  if (!entry.needsVersions) return [];
  if (!action.from_version || !action.to_version) {
    return [`${entry.id} needs from_version and to_version`];
  }
  if (action.from_version === action.to_version)
    return ['from_version and to_version are the same'];
  return [];
}

/**
 * Converts to camelCase: the rest of the system never sees the model's raw shape.
 *
 * @param p - The valid proposal.
 */
function normalize(p: RawProposal): Omit<Proposal, 'id' | 'createdAt'> {
  const action = p.next_step.action;
  return {
    summary: p.summary,
    hypotheses: p.hypotheses.map((h) => ({
      cause: h.cause,
      confidence: h.confidence,
      evidenceIds: h.evidence_ids,
    })),
    nextStep: {
      kind: p.next_step.kind,
      rationale: p.next_step.rationale,
      action: action
        ? {
            actionId: action.action_id,
            service: action.service,
            fromVersion: action.from_version,
            toVersion: action.to_version,
          }
        : null,
    },
  };
}
