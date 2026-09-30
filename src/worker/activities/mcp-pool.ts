/**
 * MCP client side: one connection per tenant, per worker process.
 *
 * @remarks
 * Third-party data (the customer's monitoring, logs, deploys) is only reached through MCP, as the
 * brief requires. The tenant is baked into the connection (the server process gets `TENANT_ID`),
 * so nothing the model writes can reach another tenant's data: the model never chooses a tenant.
 * In production each tenant's connection would carry that tenant's own credentials.
 *
 * @packageDocumentation
 */

import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config } from '../../shared/config.js';
import type { ToolCallResult } from '../../shared/types.js';

/**
 * The tools the model may call.
 *
 * @remarks
 * The MCP server also exposes action tools. Hiding them from the model's tool list is not a
 * control, because the model can write any tool name. This allowlist, enforced in the `callTool`
 * activity, is the control. We also don't trust the server's `readOnlyHint` annotations: the
 * server is third-party.
 */
export const READ_ONLY_TOOLS = new Set([
  'get_active_alerts',
  'get_metrics',
  'search_logs',
  'list_recent_deploys',
]);

/** Path of the MCP server script, spawned as a child process over stdio. */
const SERVER_PATH = fileURLToPath(
  new URL('../../mcp-server/observability-server.ts', import.meta.url),
);

/** Tool output is cut here, before it enters the transcript (keeps prompts and Temporal payloads small). */
const MAX_RESULT_CHARS = 4000;

/**
 * Open connections, by tenant.
 * Stores the promise, not the client: parallel callers must not spawn duplicate servers.
 */
const pool = new Map<string, Promise<Client>>();

/**
 * The read-only tools of the tenant's MCP server, for the model's tool list.
 *
 * @remarks
 * Sorted by name so the list is identical on every call: the prompt prefix stays byte-stable,
 * which keeps prompt caching working and the transcript valid.
 *
 * @param tenantId - The tenant.
 * @returns The MCP tool definitions the model may see.
 */
export async function listReadOnlyTools(tenantId: string) {
  const { tools } = await (await connect(tenantId)).listTools();
  // Stable order keeps the prompt prefix identical across calls (cache hits, valid transcript).
  return tools
    .filter((t) => READ_ONLY_TOOLS.has(t.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Calls one MCP tool and flattens the answer to text.
 *
 * @remarks
 * No allowlist here on purpose: this function is also used by the runtime for approved actions.
 * The allowlist lives in the `callTool` activity, which is the only path the model can reach.
 *
 * @param tenantId - The tenant (selects the connection).
 * @param name - Tool name.
 * @param args - Tool arguments.
 * @returns `ok` false when the tool reported an error; text truncated to {@link MAX_RESULT_CHARS}.
 */
export async function callMcpTool(
  tenantId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const result = await (await connect(tenantId)).callTool({ name, arguments: args });
  const text = flattenToText(result.content);
  const truncated =
    text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated]` : text;
  return { ok: result.isError !== true, text: truncated };
}

/** Closes every connection (and so every MCP server process). Called when the worker stops. */
export async function closeAll(): Promise<void> {
  const clients = await Promise.allSettled([...pool.values()]);
  pool.clear();
  await Promise.all(
    clients.map((c) => (c.status === 'fulfilled' ? c.value.close() : Promise.resolve())),
  );
}

/**
 * Returns the tenant's MCP client, connecting on first use.
 *
 * @remarks
 * If the connection closes or fails, the entry is removed so the next call reconnects.
 *
 * @param tenantId - The tenant whose stack we are talking to.
 */
function connect(tenantId: string): Promise<Client> {
  const existing = pool.get(tenantId);
  if (existing) return existing;
  const connecting = spawnServer(tenantId);
  connecting.catch(() => pool.delete(tenantId));
  pool.set(tenantId, connecting);
  return connecting;
}

/**
 * Starts the tenant's MCP server process and connects to it over stdio.
 *
 * @remarks
 * The server gets only `TENANT_ID` and where the world lives, plus the SDK's safe default
 * environment: the model provider's API key never reaches the third-party side.
 *
 * @param tenantId - The tenant.
 */
async function spawnServer(tenantId: string): Promise<Client> {
  const env = { TENANT_ID: tenantId, WORLD_DIR: config.worldDir };
  const client = new Client({ name: 'sre-agent', version: '0.1.0' });
  client.onclose = () => pool.delete(tenantId);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', SERVER_PATH],
      env,
    }),
  );
  return client;
}

/**
 * An MCP tool result as plain text: text blocks joined, other block types named.
 *
 * @param content - The result's content blocks.
 */
function flattenToText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c: { type: string; text?: string }) =>
      c.type === 'text' ? (c.text ?? '') : `[${c.type}]`,
    )
    .join('\n');
}
