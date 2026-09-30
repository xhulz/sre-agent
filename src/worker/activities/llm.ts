/**
 * Thin wrapper around the Claude API.
 *
 * @remarks
 * Retries are owned by Temporal, not by the SDK (`maxRetries: 0`). Otherwise the two retry layers
 * multiply: 3 Temporal attempts x 3 SDK attempts = 9 calls, and a long wait before degrading.
 *
 * @packageDocumentation
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../shared/config.js';
import type { AgentVersion } from '../../shared/types.js';
import { SYSTEM_PROMPT } from '../rules/prompt.js';

/** The SDK client, created on first use so a worker without a key still starts (and degrades). */
let client: Anthropic | null = null;

/**
 * One call to Claude with the frozen system prompt.
 *
 * @remarks
 * - `fallbacks: 'default'`: if a safety classifier declines, the API re-runs the request on a
 *   fallback model inside the same call (beta).
 * - `thinking: adaptive + summarized`: thinking is always on for this model; `summarized` makes it
 *   readable, which is what the timeline shows as the agent's reasoning.
 * - `model` and `output_config.effort`: pinned per incident when it starts (`ANTHROPIC_MODEL`,
 *   `AGENT_EFFORT`). Latency vs quality at 3am is a deliberate knob.
 * - `cache_control`: the prefix (system prompt, tools, earlier turns) is cached, so each step of
 *   the loop only pays full price for the new part.
 * - Non-streaming with a 3-minute timeout: answers here are short; the activity heartbeats while it
 *   waits, so a dead worker is still detected quickly.
 *
 * @param tools - The read-only MCP tools plus `propose_next_step`, in a stable order.
 * @param messages - The full, append-only transcript.
 * @param agent - The incident's model and effort. Missing only for incidents started before they
 *   were pinned: those use the current settings.
 * @returns The raw API message.
 */
export async function callClaude(
  tools: Anthropic.Beta.BetaToolUnion[],
  messages: Anthropic.Beta.BetaMessageParam[],
  agent: AgentVersion | undefined,
): Promise<Anthropic.Beta.BetaMessage> {
  const { model, effort } = agent ?? config.agent;
  return anthropic().beta.messages.create({
    model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort },
    cache_control: { type: 'ephemeral' },
    system: SYSTEM_PROMPT,
    tools,
    messages,
  });
}

/**
 * Tells whether an error is worth retrying.
 *
 * @remarks
 * Only rate limits (429), provider errors (5xx) and network errors can succeed on a second try.
 * A missing key or a bad request will fail the same way every time, so they fail fast and the
 * workflow degrades right away instead of after several useless attempts.
 *
 * @param err - Whatever the SDK threw.
 * @returns True if Temporal should retry the activity.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.RateLimitError) return true;
  return err instanceof Anthropic.APIError && typeof err.status === 'number' && err.status >= 500;
}

/** The SDK client (created on first use). */
function anthropic(): Anthropic {
  client ??= new Anthropic({ maxRetries: 0, timeout: 180_000 });
  return client;
}
