/**
 * The activities, as the workflow sees them: which task queue, how long each call may take, and
 * how many times Temporal retries it. All timeouts and retry policies live here.
 *
 * @remarks
 * This is the only file in `workflow/` that mentions `activities/`, and only as a type: the code
 * of the activities never enters the workflow sandbox. The lint enforces that for the rest of the
 * folder (see `biome.json`).
 *
 * @packageDocumentation
 */

import { proxyActivities } from '@temporalio/workflow';
import { LLM_TASK_QUEUE } from '../../shared/types.js';
import type * as activities from '../activities/index.js';

/**
 * Light activities: PagerDuty data, MCP reads, actions, verification, memory.
 * 30s per attempt, 3 attempts. Retrying an action is safe thanks to its idempotency key.
 */
export const { gatherBaseContext, callTool, executeAction, verifyRecovery, rememberFix } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: '30 seconds',
    retry: { maximumAttempts: 3 },
  });

/**
 * The Claude call, on its own task queue (capped concurrency = backpressure in a burst).
 *
 * @remarks
 * - `startToCloseTimeout` 4 minutes: a slow model answer may legitimately take minutes.
 * - `heartbeatTimeout` 20 seconds: a dead worker must not. The activity heartbeats every 5s, so a
 *   crashed worker is detected in ~20s instead of 4 minutes (found in our own crash demo).
 * - `maximumAttempts` 3: without a cap Temporal retries forever and degraded mode never happens.
 */
export const { llmStep } = proxyActivities<typeof activities>({
  taskQueue: LLM_TASK_QUEUE,
  startToCloseTimeout: '4 minutes',
  heartbeatTimeout: '20 seconds',
  retry: { maximumAttempts: 3, initialInterval: '2 seconds', backoffCoefficient: 2 },
});
