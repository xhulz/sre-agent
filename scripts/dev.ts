/**
 * `npm run dev`: starts Temporal, then the worker, then the web page, each one only after the
 * previous one is ready. Loads `.env` if present.
 *
 * @remarks
 * Nothing to install besides Node: Temporal comes from its SDK (`scripts/temporal.ts`).
 *
 * Keys, for the demo: `[w]` crashes or restarts the worker, `[t]` stops or restarts Temporal,
 * `[q]` quits. The worker crash is real: SIGKILL, with no chance to clean up, and Temporal replays
 * its incidents. Temporal is stopped rather than killed (see {@link toggle}); its state is in
 * `data/temporal.db`, so open incidents survive.
 *
 * @packageDocumentation
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Connection } from '@temporalio/client';
import { config, loadDotEnv } from '../src/shared/config.js';

/** The three processes this script manages. */
type Name = 'temporal' | 'worker' | 'web';

/** What the script tracks while it runs. */
interface Supervisor {
  /** Processes started by this script (not an already-running Temporal). */
  running: Map<Name, ChildProcess>;
  /** True once we are shutting down, so exits are not reported as crashes. */
  quitting: boolean;
}

/** Project root (paths below are relative to it). */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** How to start each process. */
const COMMANDS: Record<Name, [string, string[]]> = {
  temporal: [process.execPath, ['--import', 'tsx', 'scripts/temporal.ts']],
  worker: [process.execPath, ['--import', 'tsx', 'src/worker/worker.ts']],
  web: [process.execPath, ['--import', 'tsx', 'src/web/server.ts']],
};

/** The line each process prints when it is ready. */
const READY_LINE: Record<Name, string> = {
  temporal: 'temporal up',
  worker: 'worker up',
  web: 'web up',
};

/** Terminal color of each process's log prefix. */
const COLOR: Record<Name, string> = { temporal: '35', worker: '36', web: '32' };

/** Loads `.env`, starts the three processes in order, then listens to the demo keys. */
async function main(): Promise<void> {
  loadDotEnv();
  const sup: Supervisor = { running: new Map(), quitting: false };
  process.on('SIGINT', () => void quit(sup));
  process.on('SIGTERM', () => void quit(sup));
  try {
    say('starting Temporal… (the first run downloads it once, about 150 MB)');
    await startTemporal(sup);
    say('starting the worker…');
    await start(sup, 'worker');
    say('starting the web page…');
    await start(sup, 'web');
  } catch (err) {
    say(`startup failed: ${err instanceof Error ? err.message : String(err)}`);
    await quit(sup, 1);
  }
  say(`ready.  Web: http://localhost:${config.webPort}   Temporal UI: http://localhost:8233`);
  listenToKeys(sup);
}

/**
 * Starts Temporal, unless one already answers at `TEMPORAL_ADDRESS`: then it is reused and `[t]`
 * won't control it.
 *
 * @param sup - The supervisor.
 */
async function startTemporal(sup: Supervisor): Promise<void> {
  if (await temporalRunning()) {
    say(
      `Temporal is already running at ${config.temporalAddress}: using it ([t] will not control it).`,
    );
    return;
  }
  await start(sup, 'temporal');
}

/**
 * Spawns a process, prefixes its output, and resolves when its ready line appears.
 *
 * @param sup - The supervisor.
 * @param name - Which process.
 * @returns Resolves when ready; rejects if it exits first.
 */
function start(sup: Supervisor, name: Name): Promise<void> {
  const [cmd, args] = COMMANDS[name];
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  sup.running.set(name, child);
  const ready = READY_LINE[name];
  return new Promise((resolve, reject) => {
    pipeOutput(name, child, (line) => {
      if (line.includes(ready)) resolve();
    });
    child.on('error', reject); // it could not start at all
    child.on('exit', (code, signal) => {
      sup.running.delete(name);
      if (!sup.quitting) reportExit(name, signal ?? `exit ${code}`);
      reject(new Error(`${name} exited before it was ready`));
    });
  });
}

/**
 * Prints a child's output with a colored prefix, line by line.
 *
 * @param name - Which process (the prefix).
 * @param child - The process.
 * @param onLine - Called with every line (to spot the ready line).
 */
function pipeOutput(name: Name, child: ChildProcess, onLine: (line: string) => void): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => {
      console.log(`\x1b[${COLOR[name]}m[${name}]\x1b[0m ${line}`);
      onLine(line);
    });
  }
}

/**
 * Tells the user a process stopped, and how to get it back.
 *
 * @param name - Which process.
 * @param how - The signal or exit code.
 */
function reportExit(name: Name, how: string): void {
  const hint = name === 'web' ? 'Restart npm run dev.' : `Press [${name[0]}] to start it again.`;
  say(`${name} stopped (${how}). ${hint}`);
}

/**
 * The demo keys. Only in a real terminal: raw mode reads one key at a time, so Ctrl+C arrives
 * as `\u0003` and is handled here.
 *
 * @param sup - The supervisor.
 */
function listenToKeys(sup: Supervisor): void {
  if (!process.stdin.isTTY) return;
  say('keys:  [w] crash/restart worker   [t] stop/restart Temporal   [q] quit');
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key: string) => {
    if (key === 'q' || key === '\u0003') void quit(sup);
    else if (key === 'w') toggle(sup, 'worker');
    else if (key === 't') toggle(sup, 'temporal');
  });
}

/**
 * Demo key: stop the process if it runs, start it if it doesn't.
 *
 * @remarks
 * The worker is crashed for real (SIGKILL, no clean shutdown). Temporal gets SIGTERM instead: its
 * script must stop the server it started, and a SIGKILL would leave that server running alone.
 *
 * @param sup - The supervisor.
 * @param name - The worker or Temporal.
 */
function toggle(sup: Supervisor, name: 'worker' | 'temporal'): void {
  const child = sup.running.get(name);
  if (child && name === 'worker') {
    say('crashing the worker (SIGKILL, no clean shutdown)…');
    child.kill('SIGKILL');
    return;
  }
  if (child) {
    say('stopping Temporal…');
    child.kill('SIGTERM');
    return;
  }
  say(`starting the ${name}…`);
  (name === 'temporal' ? startTemporal(sup) : start(sup, name))
    .then(() => say(`${name} is back.`))
    .catch((err: unknown) => say(`${name} failed: ${err instanceof Error ? err.message : err}`));
}

/**
 * Stops everything in reverse order (web, worker, Temporal): gracefully first, by force after 5s.
 *
 * @param sup - The supervisor.
 * @param code - Exit code.
 */
async function quit(sup: Supervisor, code = 0): Promise<never> {
  if (!sup.quitting) {
    sup.quitting = true;
    say('stopping everything…');
    for (const name of ['web', 'worker', 'temporal'] as const) {
      const child = sup.running.get(name);
      if (!child) continue;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(5000).then(() => child.kill('SIGKILL'))]);
    }
  }
  process.exit(code);
}

/** Whether a Temporal server already answers at `TEMPORAL_ADDRESS`. */
async function temporalRunning(): Promise<boolean> {
  try {
    const connection = await Connection.connect({
      address: config.temporalAddress,
      connectTimeout: '1 second',
    });
    await connection.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Prints a message from this script.
 *
 * @param text - The message.
 */
function say(text: string): void {
  console.log(`\x1b[1m[dev]\x1b[0m ${text}`);
}

/**
 * Waits.
 *
 * @param ms - Milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
