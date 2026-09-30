/**
 * The MCP server, in-process: a backend that is down makes its tools fail, the others still answer.
 *
 * @packageDocumentation
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/mcp-server/observability-server.js';
import { startScenario } from '../src/world/scenarios.js';

/** A fresh world directory, seeded with the metrics-down scenario (globex). */
beforeEach(() => {
  process.env.WORLD_DIR = mkdtempSync(join(tmpdir(), 'world-'));
  startScenario('metrics-down');
});

/** A client connected to the globex server over an in-memory transport. */
async function connect(): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer('globex').connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

/**
 * Calls a tool and returns whether it failed and its text.
 *
 * @param client - The connected client.
 * @param name - The tool.
 * @param args - Its arguments.
 */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  const [first] = r.content as { type: string; text: string }[];
  return { isError: r.isError === true, text: first?.text ?? '' };
}

describe('observability MCP server', () => {
  it('metrics backend down: alerts and metrics fail, logs and deploys still answer', async () => {
    const client = await connect();
    const metrics = await call(client, 'get_metrics', {
      service: 'orders-api',
      metric: 'error_rate',
    });
    expect(metrics).toEqual({ isError: true, text: expect.stringContaining('metrics backend') });
    expect((await call(client, 'get_active_alerts')).isError).toBe(true);

    const logs = await call(client, 'search_logs', { service: 'orders-api' });
    expect(logs.isError).toBe(false);
    expect(logs.text).toContain('504');
    expect((await call(client, 'list_recent_deploys')).isError).toBe(false);
    await client.close();
  });
});
