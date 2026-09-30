/**
 * Every setting in one place, read from the environment (`npm run dev` loads `.env` first).
 *
 * @remarks
 * Getters, not constants: each value is read when it is used, so `.env` loaded at startup and
 * tests that point a directory elsewhere both take effect. Defaults match `.env.example`.
 *
 * The workflow can't read settings (its sandbox has no `process`), so its settings travel in the
 * workflow input instead: timing, and the model the incident is pinned to (see `web/server.ts`).
 *
 * @packageDocumentation
 */

import { fileURLToPath } from 'node:url';
import type { LogLevel } from '@temporalio/worker';
import type { AgentVersion, Effort } from './types.js';

/** The project root. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The `data/` directory at the project root (gitignored). */
const DATA_DIR = `${ROOT}data/`;

export const config = {
  /** Temporal frontend address. */
  get temporalAddress(): string {
    return env('TEMPORAL_ADDRESS', 'localhost:7233');
  },
  /** Temporal's own log level in the worker. WARN keeps the demo readable. */
  get temporalLogLevel(): LogLevel {
    return env('TEMPORAL_LOG_LEVEL', 'WARN') as LogLevel;
  },
  /** Port of the responder's page. */
  get webPort(): number {
    return Number(env('WEB_PORT', '3000'));
  },
  /** How long a proposal waits for a human before the secondary on-call is paged. */
  get approvalTimeout(): string {
    return env('APPROVAL_TIMEOUT', '5 minutes');
  },
  /** How long after an action the runtime waits before checking the metric. */
  get verifyDelay(): string {
    return env('VERIFY_DELAY', '15 seconds');
  },
  /** Claude model id. A model upgrade is a config change that the eval can gate. */
  get model(): string {
    return env('ANTHROPIC_MODEL', 'claude-opus-5-5');
  },
  /** Latency vs quality, chosen on purpose. `medium`: at 3am a fast good answer wins. */
  get effort(): Effort {
    return env('AGENT_EFFORT', 'medium') as Effort;
  },
  /** The model and effort a new incident is pinned to, for its whole life. */
  get agent(): AgentVersion {
    return { model: this.model, effort: this.effort };
  },
  /** Max Claude calls running at once per worker: the backpressure knob. */
  get llmConcurrency(): number {
    return Number(env('LLM_CONCURRENCY', '4'));
  },
  /** Whether the Anthropic SDK will find credentials. Without them the agent degrades. */
  get hasModelCredentials(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  },
  /** The fake world, one JSON file per tenant. */
  get worldDir(): string {
    return env('WORLD_DIR', `${DATA_DIR}world/`);
  },
  /** The agent's learned memory, one JSON file per tenant. */
  get memoryDir(): string {
    return env('MEMORY_DIR', `${DATA_DIR}memory/`);
  },
  /** The kill switch file. */
  get killSwitchFile(): string {
    return env('KILL_SWITCH_FILE', `${DATA_DIR}kill-switch.json`);
  },
};

/**
 * Loads `.env` from the project root, if there is one. Variables already set in the shell win:
 * `ANTHROPIC_API_KEY= npm run dev` starts without a key (degraded-mode demo), and
 * `ANTHROPIC_MODEL=<candidate> npm run eval` measures another model, without editing the file.
 */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile(`${ROOT}.env`);
  } catch {
    // No .env: use the shell environment.
  }
}

/**
 * One environment variable, or its default when unset or empty.
 *
 * @param name - Variable name.
 * @param fallback - Default value.
 */
function env(name: string, fallback: string): string {
  return process.env[name] || fallback;
}
