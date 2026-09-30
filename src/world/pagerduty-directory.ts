/**
 * PagerDuty's own data for the demo tenants: who owns each service, who is on call, and past
 * incidents (postmortem summaries). The fake stand-in for PagerDuty's database.
 *
 * @remarks
 * Seed data, like the scenarios: it never changes while the demo runs, so it lives in the code
 * (versioned and type-checked), not in `data/` (runtime state, gitignored). INC-1042 (acme) and
 * INC-311 (globex) match the demo scenarios on purpose; INC-0987 is the "external provider" case.
 * The agent reads it through `worker/activities/pagerduty.ts`, and adds its own verified fixes on
 * top (`memory.ts`).
 *
 * @packageDocumentation
 */

import type { TenantDirectory } from '../shared/types.js';

/** The directory, by tenant. */
export const PAGERDUTY_DIRECTORY: Record<string, TenantDirectory> = {
  acme: {
    ownership: {
      'checkout-api': {
        team: 'Payments',
        primaryOnCall: 'Ana Souza',
        secondaryOnCall: 'Bruno Lima',
        runbook: 'https://runbooks.acme.example/checkout-api',
      },
      'cart-api': {
        team: 'Storefront',
        primaryOnCall: 'Carla Dias',
        secondaryOnCall: 'Diego Reis',
        runbook: 'https://runbooks.acme.example/cart-api',
      },
    },
    pastIncidents: [
      {
        id: 'INC-1042',
        service: 'checkout-api',
        title: 'checkout-api error spike after deploy v2.1.0',
        rootCause: 'Null field in the coupon payload after a pricing change.',
        resolution: 'Rolled back to the previous version; fix shipped next day.',
        resolvedAt: '2026-06-14T03:12:00Z',
      },
      {
        id: 'INC-0987',
        service: 'checkout-api',
        title: 'checkout-api p95 latency from payment provider',
        rootCause: 'Payment provider degradation (external).',
        resolution: 'Waited for provider recovery; no action on our side.',
        resolvedAt: '2026-04-02T22:40:00Z',
      },
    ],
  },
  globex: {
    ownership: {
      'orders-api': {
        team: 'Orders',
        primaryOnCall: 'Eva Martins',
        secondaryOnCall: 'Felipe Costa',
        runbook: 'https://runbooks.globex.example/orders-api',
      },
      'web-frontend': {
        team: 'Web',
        primaryOnCall: 'Gabi Nunes',
        secondaryOnCall: 'Hugo Alves',
        runbook: 'https://runbooks.globex.example/web-frontend',
      },
      'payments-db': {
        team: 'Data Platform',
        primaryOnCall: 'Iara Rocha',
        secondaryOnCall: 'João Pires',
        runbook: 'https://runbooks.globex.example/payments-db',
      },
    },
    pastIncidents: [
      {
        id: 'INC-311',
        service: 'orders-api',
        title: 'orders-api DB connection pool exhausted during nightly export',
        rootCause: 'OrderExportJob held connections for the whole export (connection leak).',
        resolution:
          'Rolling restart of orders-api released the connections. Follow-up: move export to a read replica.',
        resolvedAt: '2026-08-03T02:55:00Z',
      },
    ],
  },
};
