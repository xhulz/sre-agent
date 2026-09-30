/**
 * The fake "customer infrastructure": the only fake part of the system.
 *
 * @remarks
 * One JSON file per tenant (`data/world/<tenant>.json`), shared by the MCP server (reads and
 * actions) and the web server (demo buttons). Metrics, alerts and logs are derived from the state,
 * not stored, so the world reacts to actions: roll back a bad version and the errors drop, which
 * is what lets the agent verify its own fix.
 *
 * @packageDocumentation
 */

import { config } from '../shared/config.js';
import { readJsonFile, tenantFile, writeJsonFile } from '../shared/json-file.js';
import type { ActionOutcome } from '../shared/types.js';

/** One service of the customer. */
export interface ServiceState {
  name: string;
  /** The version running now. */
  currentVersion: string;
  /** Versions that break the service (the scenario's bug). */
  badVersions: string[];
  /** True while connections leak; a restart clears it. */
  connectionLeak: boolean;
  /** What holds the leaked connections (shown in the logs). */
  leakedBy?: string;
  /** Size of the DB connection pool. */
  maxDbConnections: number;
  /**
   * True while an external dependency (e.g. the payment provider) is failing. Errors and latency
   * stay high whatever we do to this service: neither a rollback nor a restart clears it.
   */
  externalOutage?: boolean;
}

/** One entry of the deploy history (newest first in {@link WorldState.deploys}). */
export interface Deploy {
  service: string;
  version: string;
  previousVersion: string;
  /** ISO timestamp. */
  at: string;
  /** Who deployed: CI, a person, or the agent (with the approver's name). */
  author: string;
  /** What changed. */
  change: string;
}

/** Everything the fake world knows about one tenant. */
export interface WorldState {
  tenantId: string;
  services: Record<string, ServiceState>;
  deploys: Deploy[];
  /** Static log lines per service (noise, red herrings, hostile text). */
  logs: Record<string, string[]>;
  /** Idempotency keys of actions already executed, with their outcome. */
  executed: Record<string, ActionOutcome>;
  /** Backends that are down (a vendor outage): the tools that read them fail. */
  sourcesDown?: Source[];
}

/** The customer's observability backends. Alerts come from the metrics backend. */
export type Source = 'metrics' | 'logs' | 'deploys';

/** Metrics the MCP server can report. */
export type Metric = 'error_rate' | 'latency_p95_ms' | 'db_connections';

/** What is wrong with a service right now. The first that applies wins. */
type Condition = 'bad_deploy' | 'connection_leak' | 'external_outage' | 'healthy';

/** The error rate (%) and p95 latency (ms) each condition produces. */
const SYMPTOMS: Record<Condition, { error_rate: number; latency_p95_ms: number }> = {
  bad_deploy: { error_rate: 12.4, latency_p95_ms: 1850 },
  connection_leak: { error_rate: 8.1, latency_p95_ms: 2400 },
  external_outage: { error_rate: 6.3, latency_p95_ms: 3400 },
  healthy: { error_rate: 0.3, latency_p95_ms: 180 },
};

// ---- Storage ----

/**
 * Reads a tenant's world from disk (fresh on every call, so changes by others are visible).
 *
 * @param tenantId - The tenant.
 * @throws If the world was never seeded.
 */
export function readWorld(tenantId: string): WorldState {
  const world = readJsonFile<WorldState | null>(tenantFile(config.worldDir, tenantId), null);
  if (!world) throw new Error(`no world for tenant ${tenantId}: run npm run reset`);
  return world;
}

/**
 * Saves a tenant's world (atomic write).
 *
 * @param world - The world to save.
 */
export function writeWorld(world: WorldState): void {
  writeJsonFile(tenantFile(config.worldDir, world.tenantId), world);
}

// ---- Derived signals ----

/**
 * Whether a backend is down in this world. The MCP server answers its tools with an error then,
 * like a real vendor outage.
 *
 * @param world - The world.
 * @param source - The backend.
 */
export function isDown(world: WorldState, source: Source): boolean {
  return world.sourcesDown?.includes(source) ?? false;
}

/**
 * Current value of a metric, derived from the state: what is wrong with the service decides its
 * numbers (see {@link SYMPTOMS}).
 *
 * @param world - The world.
 * @param serviceName - The service.
 * @param m - Which metric.
 */
export function metric(world: WorldState, serviceName: string, m: Metric): number {
  const s = getService(world, serviceName);
  if (m === 'db_connections') return s.connectionLeak ? s.maxDbConnections : 35;
  return SYMPTOMS[conditionOf(s)][m];
}

/**
 * Alerts that fire right now, from fixed thresholds (errors above 5%, p95 above 1s, pool full).
 * This is what the customer's monitoring would send to PagerDuty.
 *
 * @param world - The world.
 * @returns One line per alert, all services.
 */
export function activeAlerts(world: WorldState): string[] {
  return Object.keys(world.services)
    .sort()
    .flatMap((name) => alertsFor(world, name));
}

/**
 * Recent log lines: the scenario's static lines plus error lines derived from the state
 * (a stack trace while a bad version runs, pool timeouts while connections leak).
 *
 * @param world - The world.
 * @param serviceName - The service.
 */
export function recentLogs(world: WorldState, serviceName: string): string[] {
  const s = getService(world, serviceName);
  const lines = [...(world.logs[serviceName] ?? [])];
  if (s.badVersions.includes(s.currentVersion)) {
    lines.push(
      `ERROR [${s.currentVersion}] NullPointerException at PriceCalculator.applyCoupon(PriceCalculator.java:88)`,
      `ERROR [${s.currentVersion}] POST /checkout 500 - coupon.discount is null`,
    );
  }
  if (s.connectionLeak) {
    lines.push(
      'ERROR HikariPool-1 - Connection is not available, request timed out after 30000ms',
      `WARN  HikariPool-1 - Apparent connection leak detected (connection held > 60s by ${s.leakedBy ?? 'unknown'})`,
    );
  }
  return lines;
}

// ---- Actions (called only through the MCP server, only after human approval) ----

/**
 * Rolls a service back, as a compare-and-swap.
 *
 * @remarks
 * Blue/green: traffic goes back to the previous version's instances, which were never stopped.
 * Nothing restarts, so a connection leak stays until a restart (see the catalog).
 *
 * "Roll back from `fromVersion`": if the service is no longer on that version (someone fixed it
 * by hand while the proposal waited), it refuses with `precondition_failed` and changes nothing.
 * That is how a stale approval becomes harmless. It also refuses a target version that was never
 * deployed on the service.
 *
 * @param world - The world (changed on success).
 * @param args - Service, versions, idempotency key, and who asked.
 * @returns What happened.
 */
export function rollbackDeploy(
  world: WorldState,
  args: { service: string; fromVersion: string; toVersion: string; key: string; by: string },
): ActionOutcome {
  return once(world, args.key, () => {
    const s = world.services[args.service];
    if (!s) return { status: 'failed', detail: `unknown service ${args.service}` };
    if (s.currentVersion !== args.fromVersion) {
      return {
        status: 'precondition_failed',
        detail: `${args.service} is now on ${s.currentVersion}, not ${args.fromVersion}. Someone else changed it.`,
      };
    }
    if (!wasDeployed(world, args.service, args.toVersion)) {
      return {
        status: 'failed',
        detail: `${args.toVersion} was never deployed on ${args.service}`,
      };
    }
    s.currentVersion = args.toVersion;
    world.deploys.unshift({
      service: args.service,
      version: args.toVersion,
      previousVersion: args.fromVersion,
      at: new Date().toISOString(),
      author: args.by,
      change: `rollback ${args.fromVersion} -> ${args.toVersion}`,
    });
    return {
      status: 'executed',
      detail: `${args.service} rolled back ${args.fromVersion} -> ${args.toVersion}`,
    };
  });
}

/**
 * Rolling restart of a service: releases leaked connections.
 *
 * @param world - The world (changed on success).
 * @param args - Service and idempotency key.
 * @returns What happened.
 */
export function restartService(
  world: WorldState,
  args: { service: string; key: string },
): ActionOutcome {
  return once(world, args.key, () => {
    const s = world.services[args.service];
    if (!s) return { status: 'failed', detail: `unknown service ${args.service}` };
    s.connectionLeak = false;
    return { status: 'executed', detail: `${args.service} restarted (rolling, all instances)` };
  });
}

// ---- Helpers ----

/**
 * The alerts of one service.
 *
 * @param world - The world.
 * @param name - The service.
 */
function alertsFor(world: WorldState, name: string): string[] {
  const s = getService(world, name);
  const errors = metric(world, name, 'error_rate');
  const latency = metric(world, name, 'latency_p95_ms');
  const conns = metric(world, name, 'db_connections');
  const alerts: string[] = [];
  if (errors > 5) alerts.push(`[critical] ${name}: error rate ${errors}% (threshold 5%)`);
  if (latency > 1000) alerts.push(`[warning] ${name}: p95 latency ${latency}ms (threshold 1000ms)`);
  if (conns >= s.maxDbConnections) {
    alerts.push(
      `[critical] ${name}: DB connection pool exhausted (${conns}/${s.maxDbConnections})`,
    );
  }
  return alerts;
}

/**
 * Runs an action at most once per idempotency key.
 *
 * @remarks
 * If Temporal retries `executeAction` (for example the worker died after the action ran but
 * before the result was recorded), the second call finds the key and returns `already_executed`:
 * the service is never rolled back twice. Only successful runs are remembered, so a failed attempt
 * can be retried.
 *
 * @param world - The world (changed).
 * @param key - The idempotency key (`workflowId:proposalId`).
 * @param run - The action itself.
 */
function once(world: WorldState, key: string, run: () => ActionOutcome): ActionOutcome {
  const previous = world.executed[key];
  if (previous) return { status: 'already_executed', detail: previous.detail };
  const outcome = run();
  if (outcome.status === 'executed') world.executed[key] = outcome;
  return outcome;
}

/**
 * Whether a version ever ran on a service (as a deploy or as the version before one).
 *
 * @param world - The world.
 * @param service - The service.
 * @param version - The version.
 */
function wasDeployed(world: WorldState, service: string, version: string): boolean {
  return world.deploys.some(
    (d) => d.service === service && (d.version === version || d.previousVersion === version),
  );
}

/**
 * Looks up a service or throws.
 *
 * @param world - The world.
 * @param name - Service name.
 */
function getService(world: WorldState, name: string): ServiceState {
  const s = world.services[name];
  if (!s) throw new Error(`unknown service: ${name}`);
  return s;
}

/**
 * What is wrong with a service: a bad version, a connection leak, a failing dependency, or nothing.
 *
 * @param s - The service.
 */
function conditionOf(s: ServiceState): Condition {
  if (s.badVersions.includes(s.currentVersion)) return 'bad_deploy';
  if (s.connectionLeak) return 'connection_leak';
  if (s.externalOutage) return 'external_outage';
  return 'healthy';
}
