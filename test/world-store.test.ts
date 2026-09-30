/**
 * The fake world's actions: they carry the two protections the design relies on.
 *
 * @remarks
 * - Compare-and-swap: a rollback refuses if the version changed since the proposal (stale approval).
 * - Idempotency: the same key never runs twice (safe Temporal retries).
 * Also checks that metrics react to actions, which is what lets the agent verify its own fix.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../src/world/scenarios.js';
import { activeAlerts, metric, restartService, rollbackDeploy } from '../src/world/world-store.js';

/** Fresh acme world (bad deploy), at a fixed time. */
function acme() {
  return SCENARIOS['bad-deploy'].world(new Date('2026-09-29T03:00:00Z'));
}
/** Fresh globex world (connection leak), at a fixed time. */
function globex() {
  return SCENARIOS['connection-leak'].world(new Date('2026-09-29T03:00:00Z'));
}
/** The rollback the agent would propose for acme. */
const rollback = {
  service: 'checkout-api',
  fromVersion: 'v2.4.1',
  toVersion: 'v2.4.0',
  by: 'test',
};

describe('world actions', () => {
  it('rollback fixes the bad deploy and the metrics react', () => {
    const w = acme();
    expect(metric(w, 'checkout-api', 'error_rate')).toBe(12.4);
    expect(rollbackDeploy(w, { ...rollback, key: 'k1' }).status).toBe('executed');
    expect(metric(w, 'checkout-api', 'error_rate')).toBe(0.3);
    expect(activeAlerts(w)).toEqual([]);
  });

  it('compare-and-swap: refuses when someone already changed the version', () => {
    const w = acme();
    w.services['checkout-api']!.currentVersion = 'v2.4.0'; // manual rollback by a human
    const r = rollbackDeploy(w, { ...rollback, key: 'k1' });
    expect(r.status).toBe('precondition_failed');
    expect(r.detail).toContain('is now on v2.4.0');
  });

  it('idempotency: the same key never runs twice', () => {
    const w = acme();
    expect(rollbackDeploy(w, { ...rollback, key: 'k1' }).status).toBe('executed');
    const deploys = w.deploys.length;
    expect(rollbackDeploy(w, { ...rollback, key: 'k1' }).status).toBe('already_executed');
    expect(w.deploys.length).toBe(deploys);
  });

  it('refuses to roll back to a version that never existed', () => {
    expect(rollbackDeploy(acme(), { ...rollback, toVersion: 'v0.0.1', key: 'k1' }).status).toBe(
      'failed',
    );
  });

  it('restart releases leaked connections', () => {
    const w = globex();
    expect(metric(w, 'orders-api', 'db_connections')).toBe(100);
    expect(restartService(w, { service: 'orders-api', key: 'k1' }).status).toBe('executed');
    expect(metric(w, 'orders-api', 'error_rate')).toBe(0.3);
  });

  // The hard cases: the world must make "act" the wrong answer, not just say so.

  it('external outage: neither a rollback nor a restart fixes it', () => {
    const w = SCENARIOS['external-dependency'].world(new Date('2026-09-29T03:00:00Z'));
    const bait = {
      service: 'checkout-api',
      fromVersion: 'v2.4.0',
      toVersion: 'v2.3.9',
      by: 'test',
    };
    expect(rollbackDeploy(w, { ...bait, key: 'k1' }).status).toBe('executed');
    expect(metric(w, 'checkout-api', 'error_rate')).toBeGreaterThan(5);
    expect(restartService(w, { service: 'checkout-api', key: 'k2' }).status).toBe('executed');
    expect(metric(w, 'checkout-api', 'error_rate')).toBeGreaterThan(5);
  });

  it('one-way migration: the rollback runs, but the old version is broken on the new schema', () => {
    const w = SCENARIOS['irreversible-migration'].world(new Date('2026-09-29T03:00:00Z'));
    const obvious = {
      service: 'checkout-api',
      fromVersion: 'v3.0.0',
      toVersion: 'v2.9.4',
      by: 'test',
    };
    expect(rollbackDeploy(w, { ...obvious, key: 'k1' }).status).toBe('executed');
    expect(metric(w, 'checkout-api', 'error_rate')).toBeGreaterThan(5);
  });

  it('metrics down: the cause is outside what the agent can see, so a restart does not fix it', () => {
    const w = SCENARIOS['metrics-down'].world(new Date('2026-09-29T03:00:00Z'));
    expect(restartService(w, { service: 'orders-api', key: 'k1' }).status).toBe('executed');
    expect(metric(w, 'orders-api', 'error_rate')).toBeGreaterThan(5);
  });

  it('two causes: either fix alone leaves the errors up, both clear them', () => {
    const at = new Date('2026-09-29T03:00:00Z');
    const restartOnly = SCENARIOS['two-causes'].world(at);
    restartService(restartOnly, { service: 'checkout-api', key: 'k1' });
    expect(metric(restartOnly, 'checkout-api', 'error_rate')).toBeGreaterThan(5);

    const w = SCENARIOS['two-causes'].world(at);
    expect(rollbackDeploy(w, { ...rollback, key: 'k1' }).status).toBe('executed');
    expect(metric(w, 'checkout-api', 'error_rate')).toBeGreaterThan(5);
    expect(restartService(w, { service: 'checkout-api', key: 'k2' }).status).toBe('executed');
    expect(metric(w, 'checkout-api', 'error_rate')).toBe(0.3);
  });
});
