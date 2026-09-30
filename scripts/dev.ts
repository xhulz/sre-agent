/**
 * `npm run dev`: starts Temporal, then the worker, then the web page, each one only after the
 * previous one is ready. Loads `.env` if present.
 *
 * @remarks
 * Keys, for the demo: `[w]` crashes or restarts the worker, `[t]` crashes or restarts Temporal,
 * `[q]` quits. A crash here is real: the process gets SIGKILL, with no chance to clean up. That is
 * how the demo shows that incidents survive a worker crash (Temporal replays them) and a Temporal
 * crash (its state is in `data/temporal.db`).
 *
 * @packageDocumentation
 */

import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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

/** How to start each process. Temporal keeps its state on disk, so it survives restarts. */
const COMMANDS: Record<Name, [string, string[]]> = {
  temporal: [
    'temporal',
    ['server', 'start-dev', '--db-filename', 'data/temporal.db', '--log-level', 'warn'],
  ],
  worker: [process.execPath, ['--import', 'tsx', 'src/worker/worker.ts']],
  web: [process.execPath, ['--import', 'tsx', 'src/web/server.ts']],
};

/** The line each process prints when it is ready. Temporal is checked with a health call instead. */
const READY_LINE: Record<Name, string | null> = {
  temporal: null,
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
    say('starting Temporal…');
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
 * Starts Temporal and waits until it is healthy (up to 30s).
 * If one is already running, it is reused and `[t]` won't control it.
 *
 * @param sup - The supervisor.
 */
async function startTemporal(sup: Supervisor): Promise<void> {
  if (await temporalHealthy()) {
    say(
      `Temporal is already running at ${config.temporalAddress}: using it ([t] will not control it).`,
    );
    return;
  }
  await requireTemporalCli();
  mkdirSync(`${ROOT}data`, { recursive: true });
  // No ready line: this resolves at once. Readiness is the health check below.
  void start(sup, 'temporal');
  for (let i = 0; i < 60; i++) {
    if (await temporalHealthy()) return;
    if (!sup.running.has('temporal')) throw new Error('Temporal exited while starting (see above)');
    await sleep(500);
  }
  throw new Error('Temporal did not become healthy in 30s');
}

/**
 * Fails with install instructions when the Temporal CLI is missing (the first thing a new
 * machine hits).
 */
async function requireTemporalCli(): Promise<void> {
  try {
    await promisify(execFile)('temporal', ['--version']);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    throw new Error(
      'the Temporal CLI was not found. Install it (macOS: brew install temporal; other systems: https://docs.temporal.io/cli), then run npm run dev again.',
    );
  }
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
      if (ready && line.includes(ready)) resolve();
    });
    child.on('error', reject); // it could not start at all
    child.on('exit', (code, signal) => {
      sup.running.delete(name);
      if (!sup.quitting) reportExit(name, signal ?? `exit ${code}`);
      reject(new Error(`${name} exited before it was ready`));
    });
    if (!ready) resolve();
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
  say('keys:  [w] crash/restart worker   [t] crash/restart Temporal   [q] quit');
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key: string) => {
    if (key === 'q' || key === '\u0003') void quit(sup);
    else if (key === 'w') toggle(sup, 'worker');
    else if (key === 't') toggle(sup, 'temporal');
  });
}

/**
 * Demo key: crash the process if it runs (SIGKILL, no clean shutdown), start it if it doesn't.
 *
 * @param sup - The supervisor.
 * @param name - The worker or Temporal.
 */
function toggle(sup: Supervisor, name: 'worker' | 'temporal'): void {
  const child = sup.running.get(name);
  if (child) {
    say(`crashing the ${name} (SIGKILL, no clean shutdown)…`);
    child.kill('SIGKILL');
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

/** Asks the Temporal CLI whether the server answers (`SERVING`). */
async function temporalHealthy(): Promise<boolean> {
  try {
    const { stdout } = await promisify(execFile)('temporal', [
      'operator',
      'cluster',
      'health',
      '--address',
      config.temporalAddress,
    ]);
    return stdout.includes('SERVING');
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
