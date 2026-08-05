/**
 * Server smoke test (CODEX_SPEC.md §10.1).
 *
 * Spawns the built server as a real subprocess and talks to it with a real MCP
 * client over stdio. This is the offline stand-in for "confirm it appears in a
 * client": if the handshake, tool listing, and tool calls all succeed here,
 * they will succeed in Claude Desktop.
 *
 * Requires `npm run build` first. Makes no network calls, and points
 * FRONTIER_HOME at a temp directory so it never touches the real user cache.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entryPoint = path.join(repoRoot, 'dist', 'index.js');

const EXPECTED_TOOLS = ['cache_status', 'clear_cache', 'ping', 'search_literature'];

/** Connect a client to a freshly spawned server with an isolated home. */
async function withClient(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'frontier-smoke-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPoint],
    cwd: repoRoot,
    env: { ...process.env, FRONTIER_HOME: home },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'frontier-smoke-test', version: '0.0.0' });

  await client.connect(transport);
  try {
    return await fn(client, home);
  } finally {
    await client.close();
    await fs.rm(home, { recursive: true, force: true });
  }
}

const payloadOf = (result) => JSON.parse(result.content[0].text);

test('server completes the stdio handshake and reports its identity', async () => {
  await withClient(async (client) => {
    const info = client.getServerVersion();
    assert.equal(info?.name, 'frontier');
    assert.match(info?.version ?? '', /^\d+\.\d+\.\d+/);

    // Tools capability must be advertised, or a client will never call listTools.
    assert.ok(client.getServerCapabilities()?.tools, 'server should advertise tools capability');
  });
});

test('every tool is listed with a usable schema', async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);

    for (const tool of tools) {
      assert.ok(tool.description, `${tool.name} needs a description for the model to pick it`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} schema should be an object`);
    }

    const ping = tools.find((t) => t.name === 'ping');
    assert.ok(!ping.inputSchema.required?.includes('echo'), 'echo is optional');
  });
});

test('ping answers with server identity and echoes its argument', async () => {
  await withClient(async (client) => {
    const bare = await client.callTool({ name: 'ping', arguments: {} });
    assert.ok(!bare.isError, 'ping should not error');
    const payload = payloadOf(bare);
    assert.equal(payload.server, 'frontier');
    assert.equal(payload.status, 'ok');
    assert.ok(!Number.isNaN(Date.parse(payload.time)), 'time should be a parseable ISO timestamp');
    assert.equal(payload.echo, undefined, 'no echo argument means no echo field');

    const echoed = await client.callTool({ name: 'ping', arguments: { echo: 'phase-2' } });
    assert.equal(payloadOf(echoed).echo, 'phase-2');
  });
});

test('cache_status works against an empty cache', async () => {
  // A brand-new install has no ~/.frontier at all. Reporting zeroes is correct;
  // erroring because the directory is missing is not.
  await withClient(async (client, home) => {
    const result = await client.callTool({ name: 'cache_status', arguments: {} });
    assert.ok(!result.isError, 'empty cache is not an error');

    const status = payloadOf(result);
    assert.equal(status.home, home, 'FRONTIER_HOME must be honoured');
    assert.equal(status.total_entries, 0);
    assert.equal(status.corrupt_entries, 0);
    assert.deepEqual(
      status.age_distribution.map((b) => b.bucket),
      ['under_1h', 'under_24h', 'under_7d', 'under_30d', 'over_30d'],
    );
  });
});

test('clear_cache is safe on an empty cache and reports what it removed', async () => {
  await withClient(async (client) => {
    const all = await client.callTool({ name: 'clear_cache', arguments: {} });
    assert.ok(!all.isError);
    assert.deepEqual(payloadOf(all), { cleared: 0, namespace: 'all', stats_reset: false });

    const scoped = await client.callTool({ name: 'clear_cache', arguments: { namespace: 'registry' } });
    assert.equal(payloadOf(scoped).namespace, 'registry');
  });
});

test('a bad argument is reported over the protocol, not thrown across it', async () => {
  // §7: never throw across the MCP boundary. A type error in the input must
  // come back as a normal tool result the client can read, not a dropped
  // connection or an unhandled rejection in the server process.
  await withClient(async (client) => {
    const badType = await client.callTool({ name: 'ping', arguments: { echo: 42 } });
    assert.ok(badType.isError, 'invalid input should surface as an error result');
    assert.ok(badType.content[0].text.length > 0, 'error result should explain itself');

    const badEnum = await client.callTool({ name: 'clear_cache', arguments: { namespace: 'not-a-namespace' } });
    assert.ok(badEnum.isError, 'an out-of-range enum should be rejected');

    // The connection must still be usable afterwards.
    const after = await client.callTool({ name: 'ping', arguments: {} });
    assert.ok(!after.isError, 'server should survive rejected calls');
  });
});

test('the server starts without a pre-existing home directory', async () => {
  // §3: no network at import time, and no setup step. A first run must work.
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'frontier-fresh-'));
  const home = path.join(parent, 'never', 'created');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPoint],
    cwd: repoRoot,
    env: { ...process.env, FRONTIER_HOME: home },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'frontier-fresh-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    const status = payloadOf(await client.callTool({ name: 'cache_status', arguments: {} }));
    assert.equal(status.total_entries, 0);
  } finally {
    await client.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});
