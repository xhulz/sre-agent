/**
 * The agent's memory: fixes that worked, per tenant. Written only after code verified the recovery.
 *
 * @remarks
 * What is worth remembering: "this cause, this fix, and the metrics confirmed it worked". Not the
 * model's reasoning, not rejected proposals, not guesses: those are noise, and some are wrong. An
 * incident resolved by hand without verification is not saved either: we don't know what fixed
 * it (in production, the postmortem would add it).
 *
 * A fix is the whole path: every action that ran, in order, with the check after each. With two
 * causes at once, "rollback (still 8.1%), then restart (recovered)" is the truth; saving only the
 * last step would tell the next incident half the story.
 *
 * To keep retrieval free of noise, repeats merge: the same path on the same service is one entry
 * that counts how many times it worked, instead of N copies filling the brief.
 *
 * Saving is idempotent by incident id, so a Temporal retry never counts a fix twice. Memory is
 * first-party (our side, not the customer's) and always per tenant: one file per tenant,
 * `data/memory/<tenant>.json`. Retrieval is `findSimilarIncidents` in `pagerduty.ts`.
 *
 * @packageDocumentation
 */

import { rmSync } from 'node:fs';
import { config } from '../../shared/config.js';
import { readJsonFile, tenantFile, writeJsonFile } from '../../shared/json-file.js';
import type { ActionTaken, VerifiedFix } from '../../shared/types.js';

/** One remembered fix, merged across the incidents it fixed. */
export interface LearnedFix {
  /**
   * The service and the actions in order, e.g. `checkout-api:rollback_deploy+restart_service`.
   * The same path on the same service is one entry.
   */
  key: string;
  service: string;
  /** From the latest incident it fixed. */
  title: string;
  /** What ran, in order, with the check after each. From the latest incident it fixed. */
  actions: ActionTaken[];
  /** How many incidents this fix resolved, each one verified. */
  timesWorked: number;
  /** Every incident it fixed, oldest first (also what makes saving idempotent). */
  incidentIds: string[];
  /** ISO timestamp of the latest one. */
  lastResolvedAt: string;
}

/**
 * Everything the agent learned for one tenant.
 *
 * @param tenantId - The tenant. Memory never crosses tenants.
 * @returns The learned fixes (empty if none yet).
 */
export function learnedFixes(tenantId: string): LearnedFix[] {
  return readJsonFile<LearnedFix[]>(memoryFile(tenantId), []);
}

/**
 * Saves a verified fix, merging it with the same fix on the same service.
 *
 * @remarks
 * Idempotent: if this incident is already counted (a retried activity), nothing changes.
 *
 * @param tenantId - The tenant.
 * @param fix - The fix that code verified.
 * @returns The entry as saved.
 */
export function saveFix(tenantId: string, fix: VerifiedFix): LearnedFix {
  const fixes = learnedFixes(tenantId);
  const key = `${fix.service}:${fix.actions.map((a) => a.actionId).join('+')}`;
  const existing = fixes.find((f) => f.key === key);
  if (existing?.incidentIds.includes(fix.incidentId)) return existing;

  const entry = merge(key, existing, fix);
  writeJsonFile(memoryFile(tenantId), [...fixes.filter((f) => f.key !== key), entry]);
  return entry;
}

/**
 * Deletes a tenant's learned memory (`npm run reset`, and the eval, which must start without it).
 *
 * @param tenantId - The tenant.
 */
export function forgetFixes(tenantId: string): void {
  rmSync(memoryFile(tenantId), { force: true });
}

/**
 * The entry after one more verified fix: the latest details, and one more incident counted.
 *
 * @param key - The service and the actions in order.
 * @param existing - The entry so far, if this fix worked before.
 * @param fix - The new verified fix.
 */
function merge(key: string, existing: LearnedFix | undefined, fix: VerifiedFix): LearnedFix {
  const latest = {
    title: fix.title,
    actions: fix.actions,
    lastResolvedAt: new Date().toISOString(),
  };
  if (!existing) {
    return {
      key,
      service: fix.service,
      ...latest,
      timesWorked: 1,
      incidentIds: [fix.incidentId],
    };
  }
  return {
    ...existing,
    ...latest,
    timesWorked: existing.timesWorked + 1,
    incidentIds: [...existing.incidentIds, fix.incidentId],
  };
}

/**
 * The tenant's memory file.
 *
 * @param tenantId - The tenant.
 */
function memoryFile(tenantId: string): string {
  return tenantFile(config.memoryDir, tenantId);
}
