/**
 * `npm run worker`: the agent process. Hosts the incident workflow and its activities.
 *
 * @remarks
 * Temporal holds the state; the worker does the work. Kill it at any point and start it again:
 * open incidents continue where they were, because Temporal replays each workflow from its
 * recorded history. Several workers can run at once (horizontal scale); Temporal spreads the tasks.
 *
 * @packageDocumentation
 */

import { fileURLToPath } from 'node:url';
import { DefaultLogger, NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { config } from '../shared/config.js';
import { AGENT_TASK_QUEUE, LLM_TASK_QUEUE } from '../shared/types.js';
import * as activities from './activities/index.js';
import { closeAll } from './activities/mcp-pool.js';

/**
 * Starts both workers and runs until the process gets SIGINT or SIGTERM (Temporal handles those
 * and drains the workers), then closes the MCP connections.
 */
async function main(): Promise<void> {
  // WARN by default: the INFO stream (bundling, state changes) hides what matters in a demo.
  Runtime.install({ logger: new DefaultLogger(config.temporalLogLevel) });
  const connection = await NativeConnection.connect({ address: config.temporalAddress });
  const workers = [await createAgentWorker(connection), await createLlmWorker(connection)];
  announce();
  try {
    await Promise.all(workers.map((w) => w.run()));
  } finally {
    await closeAll();
    await connection.close();
  }
}

/**
 * The worker for the workflow code and the light activities.
 *
 * @remarks
 * The workflow file is bundled by Temporal into a sandbox (no I/O allowed), which is what keeps
 * replay deterministic.
 *
 * @param connection - The Temporal connection.
 */
function createAgentWorker(connection: NativeConnection): Promise<Worker> {
  return Worker.create({
    connection,
    taskQueue: AGENT_TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL('./workflow/incident.ts', import.meta.url)),
    activities,
  });
}

/**
 * The worker for Claude calls only, with a concurrency cap: during a burst, calls wait in
 * Temporal instead of all hitting the provider at once.
 *
 * @param connection - The Temporal connection.
 */
function createLlmWorker(connection: NativeConnection): Promise<Worker> {
  return Worker.create({
    connection,
    taskQueue: LLM_TASK_QUEUE,
    activities: { llmStep: activities.llmStep },
    maxConcurrentActivityTaskExecutions: config.llmConcurrency,
  });
}

/** Prints the ready line (`npm run dev` waits for "worker up") and warns if there is no key. */
function announce(): void {
  console.error(
    `worker up: queues ${AGENT_TASK_QUEUE} + ${LLM_TASK_QUEUE} (max ${config.llmConcurrency} concurrent LLM calls)`,
  );
  if (!config.hasModelCredentials) {
    console.error('no ANTHROPIC_API_KEY: incidents will run in degraded mode (context brief only)');
  }
}

await main();
