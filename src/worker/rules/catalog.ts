/**
 * The action catalog: the only actions that exist.
 *
 * @remarks
 * The model can propose these; code checks the proposal (`policy.ts`); a human approves; the
 * runtime executes. Actions are added here by us, never discovered from an MCP server, even if
 * a server exposes more tools. Pure module: the workflow imports it.
 *
 * @packageDocumentation
 */

import type { ActionId } from '../../shared/types.js';

/** Everything the runtime needs to know about one action. */
export interface CatalogEntry {
  /** Stable id, also the MCP tool name. */
  id: ActionId;
  /** What the model reads in its system prompt. */
  description: string;
  /** Rollback needs both versions: `from_version` is the compare-and-swap precondition. */
  needsVersions: boolean;
  /**
   * How the runtime checks that the action worked: a metric and a threshold.
   * Code decides recovery, not the model.
   */
  verify: { metric: 'error_rate'; below: number };
}

/**
 * The catalog. Deliberately small: two reversible actions.
 *
 * @remarks
 * Prefer the smallest reversible step. Anything bigger (failover, scaling a database) would be
 * added here with its own precondition and verification before the model could ever propose it.
 *
 * The two actions don't overlap, and the descriptions say so: a rollback changes which code runs
 * without restarting anything; a restart gives fresh processes on the same code. So the check
 * after each one says which one worked. (Found by the eval: when the description didn't say a
 * rollback doesn't restart, the model assumed it did, and reasoned from that.)
 */
export const CATALOG: Record<ActionId, CatalogEntry> = {
  rollback_deploy: {
    id: 'rollback_deploy',
    description:
      "Send the incident service's traffic back to its previous version (blue/green: the previous version's instances are still running). It changes which code runs; it does not restart anything. from_version = version running now, to_version = the version before it.",
    needsVersions: true,
    verify: { metric: 'error_rate', below: 1 },
  },
  restart_service: {
    id: 'restart_service',
    description:
      'Rolling restart of every instance of the incident service: fresh processes, same code. Releases leaked resources (connections, memory).',
    needsVersions: false,
    verify: { metric: 'error_rate', below: 1 },
  },
};
