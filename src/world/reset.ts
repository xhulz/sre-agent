/**
 * `npm run reset`: re-seeds every demo tenant and clears what the agent learned, so demos and
 * evals start from the same place.
 *
 * @packageDocumentation
 */

import { forgetFixes } from '../worker/activities/memory.js';
import { SCENARIOS, type ScenarioId, startScenario } from './scenarios.js';

/** Resets each tenant once, with its first scenario: world re-seeded, learned memory cleared. */
function main(): void {
  for (const id of firstScenarioPerTenant()) {
    startScenario(id);
    forgetFixes(SCENARIOS[id].tenantId);
    console.log(`reset ${SCENARIOS[id].tenantId} (${id}): world re-seeded, learned memory cleared`);
  }
}

/**
 * The first scenario listed for each tenant. Several scenarios share a tenant (`acme`), and the
 * default one must win, not whichever comes last.
 */
function firstScenarioPerTenant(): ScenarioId[] {
  const byTenant = new Map<string, ScenarioId>();
  for (const id of Object.keys(SCENARIOS) as ScenarioId[]) {
    if (!byTenant.has(SCENARIOS[id].tenantId)) byTenant.set(SCENARIOS[id].tenantId, id);
  }
  return [...byTenant.values()];
}

main();
