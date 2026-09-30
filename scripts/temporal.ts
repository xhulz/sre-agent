/**
 * `npm run temporal`: a local Temporal server, with nothing to install.
 *
 * @remarks
 * Temporal's TypeScript SDK downloads the Temporal CLI on first use (about 150 MB, cached in the
 * system temp directory) and runs its dev server: state in `data/temporal.db`, so incidents survive
 * a restart; gRPC on the port of `TEMPORAL_ADDRESS` (7233); the UI on that port + 1000 (8233).
 * The helper is named for tests (`TestWorkflowEnvironment`), but here it is simply that dev server.
 *
 * `npm run dev` starts this script first. On SIGINT, SIGTERM or SIGHUP (terminal closed) it stops
 * the server it started: exiting without that would leave the server running on its own.
 *
 * @packageDocumentation
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { config } from '../src/shared/config.js';

/** Starts the server, says so, and stops it on a stop signal. */
async function main(): Promise<void> {
  mkdirSync(dirname(config.temporalDbFile), { recursive: true });
  const port = Number(config.temporalAddress.split(':').at(-1));
  const env = await TestWorkflowEnvironment.createLocal({
    server: { dbFilename: config.temporalDbFile, port, ui: true },
  });
  console.error(`temporal up: ${config.temporalAddress}, UI http://localhost:${port + 1000}`);
  await stopSignal();
  await env.teardown();
  process.exit(0);
}

/** Resolves on the first stop signal, keeping the process alive until then. */
function stopSignal(): Promise<void> {
  return new Promise((resolve) => {
    // Signal listeners don't keep Node running; this timer does, until a signal arrives.
    const keepAlive = setInterval(() => undefined, 60_000);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(signal, () => {
        clearInterval(keepAlive);
        resolve();
      });
    }
  });
}

await main();
