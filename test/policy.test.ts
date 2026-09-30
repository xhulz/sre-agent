/**
 * The policy is the real safety control, so it is tested directly, without a model.
 *
 * @remarks
 * The injection case matters most: even if a hostile log line convinced the model to restart
 * another service, the policy blocks the proposal before any human sees it. That guarantee is
 * proven here, not by the model's behaviour (which varies).
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import type { Incident } from '../src/shared/types.js';
import { validateProposal } from '../src/worker/rules/policy.js';

/** An incident on orders-api (the globex scenario). */
const incident: Incident = {
  id: 'INC-1',
  tenantId: 'globex',
  service: 'orders-api',
  title: 'orders-api: p95 latency above 1s',
  severity: 'SEV2',
  triggeredAt: '2026-09-29T03:00:00Z',
};
/** The agent has seen E1..E3. */
const ctx = { incident, evidenceIds: new Set(['E1', 'E2', 'E3']) };

/**
 * Builds a `propose_next_step` input (valid by default: restart orders-api citing E2).
 *
 * @param overrides - Change the action, the kind, or the cited evidence.
 */
function proposal(overrides: { action?: unknown; kind?: string; evidence?: string[] } = {}) {
  return {
    summary: 'Pool exhausted by the export job.',
    hypotheses: [
      { cause: 'Connection leak', confidence: 'high', evidence_ids: overrides.evidence ?? ['E2'] },
    ],
    next_step: {
      kind: overrides.kind ?? 'action',
      rationale: 'Restart releases leaked connections.',
      action:
        'action' in overrides
          ? overrides.action
          : {
              action_id: 'restart_service',
              service: 'orders-api',
              from_version: null,
              to_version: null,
            },
    },
  };
}

describe('validateProposal', () => {
  it('accepts a valid action on the incident service', () => {
    const r = validateProposal(proposal(), ctx);
    expect(r.ok).toBe(true);
  });

  it('blocks an action on another service (e.g. prompted by a hostile log line)', () => {
    const r = validateProposal(
      proposal({
        action: {
          action_id: 'restart_service',
          service: 'payments-db',
          from_version: null,
          to_version: null,
        },
      }),
      ctx,
    );
    expect(r).toEqual({
      ok: false,
      errors: ['action targets payments-db, but this incident is on orders-api'],
    });
  });

  it('blocks evidence the agent never saw', () => {
    const r = validateProposal(proposal({ evidence: ['E2', 'E99'] }), ctx);
    expect(r).toEqual({ ok: false, errors: ['evidence E99 does not exist'] });
  });

  it('blocks a hypothesis with no evidence', () => {
    const r = validateProposal(proposal({ evidence: [] }), ctx);
    expect(r.ok).toBe(false);
  });

  it('blocks an action that is not in the catalog', () => {
    const r = validateProposal(
      proposal({
        action: {
          action_id: 'drop_database',
          service: 'orders-api',
          from_version: null,
          to_version: null,
        },
      }),
      ctx,
    );
    expect(r.ok).toBe(false);
  });

  it('requires both versions for a rollback (the precondition)', () => {
    const r = validateProposal(
      proposal({
        action: {
          action_id: 'rollback_deploy',
          service: 'orders-api',
          from_version: 'v5.1.0',
          to_version: null,
        },
      }),
      ctx,
    );
    expect(r).toEqual({ ok: false, errors: ['rollback_deploy needs from_version and to_version'] });
  });

  it('keeps suggestions and actions apart', () => {
    expect(validateProposal(proposal({ kind: 'investigate' }), ctx).ok).toBe(false);
    expect(validateProposal(proposal({ kind: 'investigate', action: null }), ctx).ok).toBe(true);
    expect(validateProposal(proposal({ kind: 'action', action: null }), ctx).ok).toBe(false);
  });
});
