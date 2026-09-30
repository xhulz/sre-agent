/**
 * First-party data: what PagerDuty itself knows (ownership, on-call, past incidents).
 *
 * @remarks
 * This data lives on our side, so the agent reads it directly, not through MCP (MCP is for the
 * customer's third-party tools). This file is the client for it: the data itself is the fake
 * directory in `world/pagerduty-directory.ts`, plus the fixes the agent learned (`memory.ts`). In
 * production, the import becomes a query to PagerDuty's own database (services, schedules,
 * escalation policies, incident history), always filtered by tenant first.
 *
 * @packageDocumentation
 */

import type { Ownership, PastIncident } from '../../shared/types.js';
import { PAGERDUTY_DIRECTORY } from '../../world/pagerduty-directory.js';
import { type LearnedFix, learnedFixes } from './memory.js';

/** Words too common in incident titles to say anything about similarity. */
const STOPWORDS = new Set(['with', 'from', 'after', 'above', 'during', 'error', 'errors', 'rate']);

/**
 * Who owns the service and who is on call.
 *
 * @param tenantId - The tenant. Lookups never cross tenants.
 * @param service - The incident's service.
 * @returns The ownership record, or `null` if the service is unknown.
 */
export function getOwnership(tenantId: string, service: string): Ownership | null {
  return PAGERDUTY_DIRECTORY[tenantId]?.ownership[service] ?? null;
}

/**
 * Memory retrieval: past incidents that look like this one (seeded postmortems plus the fixes
 * the agent learned).
 *
 * @remarks
 * Deliberately simple: same tenant only, same service scores 2, plus one point per shared keyword
 * with the incident title; a match needs a score of at least 2; ties go to the most recent. Noise
 * is kept down by what gets saved (only verified fixes, repeats merged) and by a small limit. At
 * scale this would add embeddings and weight by how often a fix worked. The model is told that past
 * incidents are hints, to confirm with fresh data (see the system prompt).
 *
 * @param tenantId - The tenant. Memory never crosses tenants.
 * @param service - The incident's service.
 * @param signals - Text describing the incident (today: its title).
 * @param limit - How many to return at most.
 * @returns The most similar past incidents, best first.
 */
export function findSimilarIncidents(
  tenantId: string,
  service: string,
  signals: string,
  limit = 3,
): PastIncident[] {
  const wanted = keywords(signals);
  const candidates = [
    ...(PAGERDUTY_DIRECTORY[tenantId]?.pastIncidents ?? []),
    ...learnedFixes(tenantId).map(fromMemory),
  ];
  return candidates
    .map((inc) => ({ inc, score: similarity(inc, service, wanted) }))
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score || b.inc.resolvedAt.localeCompare(a.inc.resolvedAt))
    .slice(0, limit)
    .map((s) => s.inc);
}

/**
 * A learned fix, shaped like a past incident so both are searched and shown the same way.
 *
 * @remarks
 * With several actions, each is numbered with the check after it, e.g.
 * `(1) rollback_deploy … : error_rate is still 8.1 … (2) restart_service … : Recovered.`
 *
 * @param f - The learned fix.
 */
function fromMemory(f: LearnedFix): PastIncident {
  return {
    id: f.incidentIds.at(-1) ?? f.key,
    service: f.service,
    title: f.title,
    rootCause: numbered(f.actions.map((a) => a.rootCause)),
    resolution: numbered(
      f.actions.map((a) => `${a.action}, approved by ${a.approvedBy}: ${a.verification}`),
    ),
    resolvedAt: f.lastResolvedAt,
    timesWorked: f.timesWorked,
  };
}

/**
 * One item as is; several as `(1) … (2) …`.
 *
 * @param items - The items, in order.
 */
function numbered(items: string[]): string {
  if (items.length === 1) return items[0] ?? '';
  return items.map((item, i) => `(${i + 1}) ${item}`).join(' ');
}

/**
 * How much a past incident looks like this one: 2 for the same service, plus 1 per shared keyword.
 *
 * @param inc - The past incident.
 * @param service - This incident's service.
 * @param wanted - This incident's keywords.
 */
function similarity(inc: PastIncident, service: string, wanted: Set<string>): number {
  const shared = [...keywords(`${inc.title} ${inc.rootCause}`)].filter((w) => wanted.has(w));
  return (inc.service === service ? 2 : 0) + shared.length;
}

/**
 * Splits text into lowercase keywords (longer than 3 letters, no stopwords).
 *
 * @param text - Any text, e.g. an incident title.
 * @returns The set of keywords.
 */
function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9.-]+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
  );
}
