/**
 * The kill switch: stops the agent's actions for one tenant, or one action for every tenant.
 *
 * @remarks
 * For the recursive case ("the agent made an incident worse"): containment must be one step, take
 * effect at once, and not need a deploy. Two levels, because the two failures are different:
 * - **tenant**: something went wrong for one customer. The agent still investigates and proposes
 *   there, but no action runs;
 * - **action**: the action itself is suspect (for example, rollback has a bug). Off for everyone.
 *
 * The runtime checks it right before an approved action runs (`executeAction`), not when the
 * proposal is made: a switch turned on while a proposal waits for approval must still stop it.
 * Reading it is I/O, so it happens in an activity, never in the workflow.
 *
 * It fails closed: if the file exists but can't be read, every action is blocked.
 *
 * Stored as a small JSON file (`data/kill-switch.json`) that the worker and the web server share.
 * It is first-party state (our side, not the customer's world). In production it would be a
 * config service with its own audit log.
 *
 * @packageDocumentation
 */

import { z } from 'zod';
import { config } from '../../shared/config.js';
import { readJsonFile, writeJsonFile } from '../../shared/json-file.js';

/** What is switched off. No file means nothing is. */
const KillSwitchFile = z.object({
  /** Tenants with every agent action off. */
  tenants: z.array(z.string()).default([]),
  /** Actions off for every tenant. */
  actions: z.array(z.string()).default([]),
});

/** The switch state: which tenants and which actions are off. */
export type KillSwitch = z.infer<typeof KillSwitchFile>;

/**
 * Tells whether an action may run for a tenant right now.
 *
 * @param tenantId - The tenant.
 * @param actionId - The action about to run.
 * @returns Why it is blocked, or `null` if it may run.
 */
export function blockedBy(tenantId: string, actionId: string): string | null {
  let ks: KillSwitch;
  try {
    ks = readKillSwitch();
  } catch {
    // Fail closed: when we can't tell whether actions are allowed, they are not.
    return 'the kill switch file is unreadable, so every action is blocked';
  }
  if (ks.tenants.includes(tenantId)) return `the kill switch is on for tenant ${tenantId}`;
  if (ks.actions.includes(actionId)) return `the kill switch is on for ${actionId}`;
  return null;
}

/**
 * Reads the switch state, fresh on every call (a change takes effect at once).
 *
 * @returns What is off. A missing file means nothing is.
 * @throws If the file exists but is not valid. Callers that decide whether to act must fail closed.
 */
export function readKillSwitch(): KillSwitch {
  return KillSwitchFile.parse(readJsonFile(config.killSwitchFile, {}));
}

/**
 * Turns a switch on or off.
 *
 * @param target - A tenant, an action, or both.
 * @param on - True to stop actions, false to allow them again.
 * @returns The new state.
 */
export function setKillSwitch(
  target: { tenant?: string; action?: string },
  on: boolean,
): KillSwitch {
  const ks = readKillSwitch();
  const next: KillSwitch = {
    tenants: toggle(ks.tenants, target.tenant, on),
    actions: toggle(ks.actions, target.action, on),
  };
  writeJsonFile(config.killSwitchFile, next);
  return next;
}

/**
 * Adds or removes one value, keeping the list free of duplicates.
 *
 * @param list - The current list.
 * @param value - The value, or `undefined` to leave the list as it is.
 * @param on - Add (true) or remove (false).
 */
function toggle(list: string[], value: string | undefined, on: boolean): string[] {
  if (!value) return list;
  return on ? [...new Set([...list, value])] : list.filter((v) => v !== value);
}
