/**
 * Workflow behaviour with a real (test) Temporal server and scripted activities.
 *
 * @remarks
 * Proves the State + Safety claims without a model and without an API key: stale approvals,
 * degraded mode and coming back from it, escalation on silence, durable verification.
 * The time-skipping server jumps over timers (the 5-minute approval timeout, the verify delay),
 * so these tests run in seconds.
 *
 * @packageDocumentation
 */

import { fileURLToPath } from 'node:url';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ActionOutcome,
  AGENT_TASK_QUEUE,
  type AgentState,
  type AgentVersion,
  type Incident,
  LLM_TASK_QUEUE,
  type LlmStepResult,
  type VerifiedFix,
} from '../src/shared/types.js';
import type * as realActivities from '../src/worker/activities/index.js';
import {
  decisionSignal,
  getStateQuery,
  incidentWorkflow,
} from '../src/worker/workflow/incident.js';

/** The real activity signatures, so the fakes below must match them. */
type Activities = typeof realActivities;

/** One test Temporal server for the whole file. */
let env: TestWorkflowEnvironment;
beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger('WARN') });
  // Downloads Temporal's time-skipping test server on first run.
  env = await TestWorkflowEnvironment.createTimeSkipping();
});
afterAll(async () => {
  await env?.teardown();
});

/** The incident every test starts. */
const incident: Incident = {
  id: 'INC-T',
  tenantId: 'acme',
  service: 'checkout-api',
  title: 'checkout-api: error rate above 5%',
  severity: 'SEV1',
  triggeredAt: '2026-09-29T03:00:00Z',
};

/** The model and effort every test incident is pinned to when it starts. */
const pinned: AgentVersion = { model: 'model-at-start', effort: 'low' };

/** A valid proposal: roll checkout-api back, citing E2 (the deploys in the fake brief). */
const rollbackProposal = {
  summary: 'v2.4.1 broke coupon pricing.',
  hypotheses: [{ cause: 'Bad deploy v2.4.1', confidence: 'high', evidence_ids: ['E2'] }],
  next_step: {
    kind: 'action',
    rationale: 'Errors started right after the deploy.',
    action: {
      action_id: 'rollback_deploy',
      service: 'checkout-api',
      from_version: 'v2.4.1',
      to_version: 'v2.4.0',
    },
  },
};

/** A valid suggestion with no action (what the model says after someone already fixed it). */
const investigateProposal = {
  summary: 'Someone already rolled back.',
  hypotheses: [
    { cause: 'Recovered after manual rollback', confidence: 'medium', evidence_ids: ['E2'] },
  ],
  next_step: { kind: 'investigate', rationale: 'Watch error rate for 10 minutes.', action: null },
};

/** The second fix when there are two causes: restart checkout-api to release leaked connections. */
const restartProposal = {
  summary: 'The rollback fixed the coupon errors; the pool is still full.',
  hypotheses: [
    { cause: 'ReportExportJob leaks DB connections', confidence: 'high', evidence_ids: ['E2'] },
  ],
  next_step: {
    kind: 'action',
    rationale: 'A restart releases the leaked connections.',
    action: {
      action_id: 'restart_service',
      service: 'checkout-api',
      from_version: null,
      to_version: null,
    },
  },
};

/**
 * A scripted "model": each call answers with the next proposal. It also records every transcript
 * it received and the model it was asked to run, so tests can check both.
 *
 * @param proposals - The `propose_next_step` inputs to return, in order.
 */
function scriptedModel(...proposals: object[]) {
  const seen: unknown[][] = [];
  const agents: (AgentVersion | undefined)[] = [];
  const llmStep = async (
    _tenant: string,
    messages: unknown[],
    agent?: AgentVersion,
  ): Promise<LlmStepResult> => {
    seen.push(structuredClone(messages));
    agents.push(agent);
    const input = proposals[seen.length - 1];
    if (!input) throw ApplicationFailure.nonRetryable('script exhausted');
    return {
      content: [
        { type: 'tool_use', id: `toolu_${seen.length}`, name: 'propose_next_step', input },
      ] as LlmStepResult['content'],
      stopReason: 'tool_use',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 },
    };
  };
  return { llmStep, seen, agents };
}

/**
 * Fake activities: a two-item brief, reads that return nothing, an action that works, and a
 * verification that sees recovery. Tests override the parts they care about.
 *
 * @param overrides - Activities to replace.
 */
function baseActivities(overrides: Partial<Activities> = {}): Partial<Activities> {
  return {
    gatherBaseContext: async () => [
      { source: 'pagerduty', label: 'Ownership', content: 'Team: Payments', ok: true },
      {
        source: 'observability',
        label: 'Recent deploys',
        content: 'checkout-api v2.4.0 -> v2.4.1',
        ok: true,
      },
    ],
    callTool: async () => ({ ok: true, text: 'n/a' }),
    executeAction: async (): Promise<ActionOutcome> => ({
      status: 'executed',
      detail: 'rolled back',
    }),
    verifyRecovery: async () => ({
      recovered: true,
      detail: 'error_rate 0.3 (below 1). Recovered.',
    }),
    rememberFix: async () => 1,
    ...overrides,
  };
}

/**
 * Starts the two workers (agent queue and LLM queue) against the test server and runs the test
 * body while they are up.
 *
 * @param activities - Activities for the agent queue.
 * @param llmStep - The fake model, on the LLM queue.
 * @param body - The test, given a fresh workflow id.
 */
async function run(
  activities: Partial<Activities>,
  llmStep: Activities['llmStep'],
  body: (workflowId: string) => Promise<void>,
): Promise<void> {
  const agent = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: AGENT_TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL('../src/worker/workflow/incident.ts', import.meta.url)),
    activities,
  });
  const llm = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: LLM_TASK_QUEUE,
    activities: { llmStep },
  });
  const workflowId = `test-${Math.random().toString(36).slice(2)}`;
  await agent.runUntil(llm.runUntil(body(workflowId)));
}

/**
 * Starts the incident workflow with a 5-minute approval timeout and a 15-second verify delay.
 *
 * @param workflowId - A fresh id.
 */
function start(workflowId: string) {
  return env.client.workflow.start(incidentWorkflow, {
    taskQueue: AGENT_TASK_QUEUE,
    workflowId,
    args: [
      {
        incident,
        config: { approvalTimeout: '5 minutes', verifyDelay: '15 seconds', agent: pinned },
      },
    ],
  });
}

/**
 * Polls the workflow state (query) until `done` returns true, or fails after ~10 seconds.
 *
 * @param workflowId - The workflow.
 * @param done - The condition to wait for.
 */
async function waitFor(workflowId: string, done: (s: AgentState) => boolean): Promise<AgentState> {
  const handle = env.client.workflow.getHandle(workflowId);
  for (let i = 0; i < 100; i++) {
    const s = await handle.query(getStateQuery);
    if (done(s)) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for workflow state');
}

describe('incidentWorkflow', () => {
  it('stale approval: the compare-and-swap fails, nothing changes, the agent re-investigates', async () => {
    const model = scriptedModel(rollbackProposal, investigateProposal);
    const executeAction = async (): Promise<ActionOutcome> => ({
      status: 'precondition_failed',
      detail: 'checkout-api is now on v2.4.0, not v2.4.1. Someone else changed it.',
    });

    await run(baseActivities({ executeAction }), model.llmStep, async (workflowId) => {
      const handle = await start(workflowId);
      const first = await waitFor(workflowId, (s) => s.status === 'awaiting_approval');
      await handle.signal(decisionSignal, {
        proposalId: first.proposal!.id,
        kind: 'approve',
        by: 'ana',
      });

      const second = await waitFor(
        workflowId,
        (s) => s.status === 'awaiting_approval' && s.round === 2,
      );
      expect(second.proposal!.nextStep.kind).toBe('investigate');
      expect(second.timeline.some((t) => t.text.includes('precondition_failed'))).toBe(true);

      // The failure reached the model as the answer to its proposal.
      expect(JSON.stringify(model.seen[1]!.at(-1))).toContain('precondition_failed');

      // An approve for the first proposal arriving late is ignored.
      await handle.signal(decisionSignal, {
        proposalId: first.proposal!.id,
        kind: 'approve',
        by: 'ana',
      });
      await handle.signal(decisionSignal, { proposalId: null, kind: 'resolve', by: 'ana' });
      const final = await handle.result();
      expect(final.status).toBe('resolved');
      expect(final.timeline.some((t) => t.text.includes('older proposal'))).toBe(true);
      // Resolved by hand, nothing verified: nothing is remembered.
      expect(final.timeline.some((t) => t.kind === 'memory')).toBe(false);
    });
  });

  it('kill switch: an approved action is blocked, and the agent is told to propose a non-action step', async () => {
    const model = scriptedModel(rollbackProposal, investigateProposal);
    const executeAction = async (): Promise<ActionOutcome> => ({
      status: 'blocked',
      detail: 'Not run: the kill switch is on for tenant acme.',
    });

    await run(baseActivities({ executeAction }), model.llmStep, async (workflowId) => {
      const handle = await start(workflowId);
      const first = await waitFor(workflowId, (s) => s.status === 'awaiting_approval');
      await handle.signal(decisionSignal, {
        proposalId: first.proposal!.id,
        kind: 'approve',
        by: 'ana',
      });

      const second = await waitFor(
        workflowId,
        (s) => s.status === 'awaiting_approval' && s.round === 2,
      );
      expect(second.proposal!.nextStep.kind).toBe('investigate');
      expect(second.timeline.some((t) => t.text.includes('blocked'))).toBe(true);
      // No verification: nothing ran, so there is nothing to verify.
      expect(second.timeline.some((t) => t.kind === 'verify')).toBe(false);
      expect(JSON.stringify(model.seen[1]!.at(-1))).toContain('kill switch');

      await handle.signal(decisionSignal, { proposalId: null, kind: 'resolve', by: 'ana' });
      expect((await handle.result()).status).toBe('resolved');
    });
  });

  it('the incident keeps the model it started with: every model call carries it', async () => {
    const model = scriptedModel(rollbackProposal, investigateProposal);
    await run(baseActivities(), model.llmStep, async (workflowId) => {
      const handle = await start(workflowId);
      const first = await waitFor(workflowId, (s) => s.status === 'awaiting_approval');
      expect(first.agent).toEqual(pinned); // on the page and in the audit trail
      await handle.signal(decisionSignal, {
        proposalId: first.proposal!.id,
        kind: 'reject',
        by: 'ana',
        reason: 'not yet',
      });
      await waitFor(workflowId, (s) => s.status === 'awaiting_approval' && s.round === 2);
      expect(model.agents).toEqual([pinned, pinned]);
      await handle.signal(decisionSignal, { proposalId: null, kind: 'resolve', by: 'ana' });
      await handle.result();
    });
  });

  it('degraded: no model, the brief is still there and the human resolves', async () => {
    const llmStep = async (): Promise<LlmStepResult> => {
      throw ApplicationFailure.nonRetryable('no API key configured', 'LlmUnavailable');
    };
    await run(baseActivities(), llmStep, async (workflowId) => {
      const handle = await start(workflowId);
      const s = await waitFor(workflowId, (st) => st.status === 'degraded');
      expect(s.degradedReason).toContain('no API key configured');
      expect(s.brief).toContain('[E1]');
      await handle.signal(decisionSignal, { proposalId: null, kind: 'resolve', by: 'ana' });
      expect((await handle.result()).status).toBe('resolved');
    });
  });

  it('degraded, then the human brings the agent back: it continues the same conversation', async () => {
    let modelUp = false;
    const model = scriptedModel(rollbackProposal);
    const llmStep: Activities['llmStep'] = async (tenant, messages) => {
      if (!modelUp)
        throw ApplicationFailure.nonRetryable('no API key configured', 'LlmUnavailable');
      return model.llmStep(tenant, messages);
    };
    await run(baseActivities(), llmStep, async (workflowId) => {
      const handle = await start(workflowId);
      await waitFor(workflowId, (st) => st.status === 'degraded');

      modelUp = true; // the key is back / the provider recovered
      await handle.signal(decisionSignal, { proposalId: null, kind: 'retry', by: 'ana' });
      const s = await waitFor(workflowId, (st) => st.status === 'awaiting_approval');
      expect(s.degradedReason).toBeNull();
      expect(s.proposal!.nextStep.action?.actionId).toBe('rollback_deploy');
      expect(s.timeline.some((t) => t.text.includes('try again'))).toBe(true);
      // The model was told it had been away, in the same conversation.
      expect(JSON.stringify(model.seen[0]!.at(-1))).toContain('You were unavailable');

      await handle.signal(decisionSignal, { proposalId: null, kind: 'resolve', by: 'ana' });
      expect((await handle.result()).status).toBe('resolved');
    });
  });

  it('silence escalates but never acts; approval runs, waits, verifies, remembers and resolves', async () => {
    const model = scriptedModel(rollbackProposal);
    let executed = 0;
    const executeAction = async (): Promise<ActionOutcome> => {
      executed++;
      return { status: 'executed', detail: 'checkout-api rolled back v2.4.1 -> v2.4.0' };
    };
    const remembered: VerifiedFix[] = [];
    const rememberFix = async (_tenant: string, fix: VerifiedFix) => {
      remembered.push(fix);
      return 1;
    };
    await run(baseActivities({ executeAction, rememberFix }), model.llmStep, async (workflowId) => {
      const handle = await start(workflowId);
      const s = await waitFor(workflowId, (st) => st.status === 'awaiting_approval');

      await env.sleep('6 minutes'); // nobody answers
      const escalated = await handle.query(getStateQuery);
      expect(escalated.timeline.some((t) => t.text.includes('escalated'))).toBe(true);
      expect(executed).toBe(0);

      await handle.signal(decisionSignal, {
        proposalId: s.proposal!.id,
        kind: 'approve',
        by: 'ana',
      });
      const final = await handle.result(); // time skipping jumps over the 15s verify delay
      expect(executed).toBe(1);
      expect(final.status).toBe('resolved');
      expect(final.timeline.some((t) => t.text.includes('Recovered'))).toBe(true);

      // Verified, so remembered: once, with the cause, the action and the verification.
      expect(remembered).toHaveLength(1);
      expect(remembered[0]).toMatchObject({
        incidentId: 'INC-T',
        actions: [
          { actionId: 'rollback_deploy', rootCause: 'Bad deploy v2.4.1', approvedBy: 'ana' },
        ],
      });
      expect(remembered[0]?.actions[0]?.verification).toContain('Recovered');
      expect(final.timeline.some((t) => t.text.startsWith('Saved to memory'))).toBe(true);
    });
  });

  it('two causes: the first fix is not enough, the second recovers, memory keeps both in order', async () => {
    const model = scriptedModel(rollbackProposal, restartProposal);
    const checks = [
      { recovered: false, detail: 'checkout-api error_rate is still 8.1 (needs to be below 1).' },
      { recovered: true, detail: 'checkout-api error_rate is 0.3 (below 1). Recovered.' },
    ];
    const verifyRecovery = async () => checks.shift() ?? { recovered: false, detail: 'no check' };
    const remembered: VerifiedFix[] = [];
    const rememberFix = async (_tenant: string, fix: VerifiedFix) => {
      remembered.push(fix);
      return 1;
    };
    await run(
      baseActivities({ verifyRecovery, rememberFix }),
      model.llmStep,
      async (workflowId) => {
        const handle = await start(workflowId);
        const first = await waitFor(workflowId, (s) => s.status === 'awaiting_approval');
        await handle.signal(decisionSignal, {
          proposalId: first.proposal!.id,
          kind: 'approve',
          by: 'ana',
        });
        await env.sleep('20 seconds'); // skips the 15s verify delay (queries don't move the clock)
        const second = await waitFor(
          workflowId,
          (s) => s.status === 'awaiting_approval' && s.round === 2,
        );
        // Not fixed yet: nothing saved, and the model was told why.
        expect(remembered).toHaveLength(0);
        expect(JSON.stringify(model.seen[1]!.at(-1))).toContain('still 8.1');

        await handle.signal(decisionSignal, {
          proposalId: second.proposal!.id,
          kind: 'approve',
          by: 'bruno',
        });
        expect((await handle.result()).status).toBe('resolved');
        expect(remembered).toHaveLength(1);
        expect(remembered[0]?.actions).toMatchObject([
          {
            actionId: 'rollback_deploy',
            approvedBy: 'ana',
            verification: expect.stringContaining('still 8.1'),
          },
          {
            actionId: 'restart_service',
            approvedBy: 'bruno',
            verification: expect.stringContaining('Recovered'),
          },
        ]);
      },
    );
  });
});
