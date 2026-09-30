/**
 * Memory: only verified fixes (the whole path), repeats merged, per tenant, found by the next
 * similar incident.
 *
 * @packageDocumentation
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionTaken, VerifiedFix } from '../src/shared/types.js';
import { forgetFixes, learnedFixes, saveFix } from '../src/worker/activities/memory.js';
import { findSimilarIncidents } from '../src/worker/activities/pagerduty.js';

/** A fresh, empty memory directory for each test. */
beforeEach(() => {
  process.env.MEMORY_DIR = mkdtempSync(join(tmpdir(), 'memory-'));
});

/** The rollback, and what the check said after it. */
function rollback(verification: string): ActionTaken {
  return {
    actionId: 'rollback_deploy',
    action: 'rollback_deploy on checkout-api (v2.4.1 -> v2.4.0)',
    rootCause: 'Bad deploy v2.4.1',
    approvedBy: 'ana',
    verification,
  };
}

/** The restart that fixed the second cause (two-causes scenario). */
const restart: ActionTaken = {
  actionId: 'restart_service',
  action: 'restart_service on checkout-api',
  rootCause: 'ReportExportJob leaks DB connections',
  approvedBy: 'ana',
  verification: 'checkout-api error_rate is 0.3 (below 1). Recovered.',
};

/** The fix the agent verified on the bad-deploy scenario: one rollback. */
function fix(incidentId: string): VerifiedFix {
  return {
    incidentId,
    service: 'checkout-api',
    title: 'checkout-api: error rate above 5%',
    actions: [rollback('checkout-api error_rate is 0.3 (below 1). Recovered.')],
  };
}

describe('memory', () => {
  it('the next similar incident starts with the verified fix, first in the list', () => {
    saveFix('acme', fix('INC-1'));
    const similar = findSimilarIncidents(
      'acme',
      'checkout-api',
      'checkout-api: error rate above 5%',
    );
    expect(similar[0]?.id).toBe('INC-1');
    expect(similar[0]?.timesWorked).toBe(1);
    expect(similar[0]?.resolution).toContain('Recovered');
  });

  it('the same fix working again merges into one entry (no copies filling the brief)', () => {
    saveFix('acme', fix('INC-1'));
    saveFix('acme', fix('INC-2'));
    const fixes = learnedFixes('acme');
    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.timesWorked).toBe(2);
    expect(fixes[0]?.incidentIds).toEqual(['INC-1', 'INC-2']);
  });

  it('two causes: the whole path is saved in order, with the check after each step', () => {
    const rollbackNotEnough = rollback(
      'checkout-api error_rate is still 8.1 (needs to be below 1).',
    );
    saveFix('acme', fix('INC-1'));
    saveFix('acme', { ...fix('INC-2'), actions: [rollbackNotEnough, restart] });

    // A different path is a different entry: "rollback alone" stays as it was.
    expect(learnedFixes('acme').map((f) => f.key)).toEqual([
      'checkout-api:rollback_deploy',
      'checkout-api:rollback_deploy+restart_service',
    ]);
    const similar = findSimilarIncidents(
      'acme',
      'checkout-api',
      'checkout-api: error rate above 5%',
    );
    const path = similar.find((p) => p.id === 'INC-2');
    expect(path?.rootCause).toBe('(1) Bad deploy v2.4.1 (2) ReportExportJob leaks DB connections');
    expect(path?.resolution).toMatch(
      /^\(1\) rollback_deploy.*still 8\.1.*\(2\) restart_service.*Recovered/,
    );
  });

  it('idempotent: a retry for the same incident counts once', () => {
    saveFix('acme', fix('INC-1'));
    saveFix('acme', fix('INC-1'));
    expect(learnedFixes('acme')[0]?.timesWorked).toBe(1);
  });

  it('never crosses tenants', () => {
    saveFix('acme', fix('INC-1'));
    expect(learnedFixes('globex')).toEqual([]);
    const similar = findSimilarIncidents(
      'globex',
      'checkout-api',
      'checkout-api: error rate above 5%',
    );
    expect(similar.some((p) => p.timesWorked)).toBe(false);
  });

  it('forget clears it (npm run reset, and before the eval)', () => {
    saveFix('acme', fix('INC-1'));
    forgetFixes('acme');
    expect(learnedFixes('acme')).toEqual([]);
  });
});
