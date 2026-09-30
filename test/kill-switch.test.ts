/**
 * The kill switch: containment for the recursive case ("the agent made it worse").
 *
 * @remarks
 * Checks the two levels (tenant, action), that it fails closed, and that `executeAction` really
 * checks it before touching anything (a blocked action returns before any MCP call).
 *
 * @packageDocumentation
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { executeAction } from '../src/worker/activities/index.js';
import { blockedBy, readKillSwitch, setKillSwitch } from '../src/worker/activities/kill-switch.js';

/** A fresh, empty switch file location for each test. */
beforeEach(() => {
  process.env.KILL_SWITCH_FILE = join(mkdtempSync(join(tmpdir(), 'kill-switch-')), 'ks.json');
});

describe('kill switch', () => {
  it('no file: nothing is blocked', () => {
    expect(readKillSwitch()).toEqual({ tenants: [], actions: [] });
    expect(blockedBy('acme', 'rollback_deploy')).toBeNull();
  });

  it('tenant switch: every action of that tenant is blocked, other tenants are not', () => {
    setKillSwitch({ tenant: 'acme' }, true);
    expect(blockedBy('acme', 'rollback_deploy')).toContain('tenant acme');
    expect(blockedBy('acme', 'restart_service')).toContain('tenant acme');
    expect(blockedBy('globex', 'restart_service')).toBeNull();
  });

  it('action switch: that action is blocked for every tenant', () => {
    setKillSwitch({ action: 'rollback_deploy' }, true);
    expect(blockedBy('acme', 'rollback_deploy')).toContain('rollback_deploy');
    expect(blockedBy('globex', 'rollback_deploy')).toContain('rollback_deploy');
    expect(blockedBy('acme', 'restart_service')).toBeNull();
  });

  it('turning it off allows actions again', () => {
    setKillSwitch({ tenant: 'acme' }, true);
    setKillSwitch({ tenant: 'acme' }, false);
    expect(blockedBy('acme', 'rollback_deploy')).toBeNull();
  });

  it('fails closed: an unreadable switch file blocks every action', () => {
    writeFileSync(process.env.KILL_SWITCH_FILE!, '{ not json');
    expect(blockedBy('acme', 'rollback_deploy')).toContain('unreadable');
  });

  it('executeAction checks it first: nothing runs', async () => {
    setKillSwitch({ tenant: 'acme' }, true);
    const outcome = await executeAction(
      'acme',
      {
        actionId: 'rollback_deploy',
        service: 'checkout-api',
        fromVersion: 'v2.4.1',
        toVersion: 'v2.4.0',
      },
      'test-key',
      'ana',
    );
    expect(outcome.status).toBe('blocked');
  });
});
