/**
 * Phase 1 smoke test (CODEX_SPEC.md §10.1).
 *
 * Spawns the built server as a real subprocess and talks to it with a real MCP
 * client over stdio. This is the offline stand-in for "confirm it appears in a
 * client": if the handshake, tool listing, and a tool call all succeed here,
 * they will succeed in Claude Desktop.
 *
 * Requires `npm run build` first. Makes no network calls.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entryPoint = path.join(repoRoot, 'dist', 'index.js');

/** Connect a client to a freshly spawned server, run `fn`, always tear down. */
async function withClient(fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPoint],
    cwd: repoRoot,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'frontier-smoke-test', version: '0.0.0' });

  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test('server completes the stdio handshake and reports its identity', async () => {
  await withClient(async (client) => {
    const info = client.getServerVersion();
    assert.equal(info?.name, 'frontier');
    assert.match(info?.version ?? '', /^\d+\.\d+\.\d+/);

    // Tools capability must be advertised, or a client will never call listTools.
    assert.ok(client.getServerCapabilities()?.tools, 'server should advertise tools capability');
  });
});

test('ping is listed with a usable schema', async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1, 'phase 1 registers exactly one tool');

    const ping = tools[0];
    assert.equal(ping.name, 'ping');
    assert.ok(ping.description, 'tool needs a description for the model to pick it');
    assert.equal(ping.inputSchema.type, 'object');
    // `echo` is optional, so an empty call must be valid.
    assert.ok(!ping.inputSchema.required?.includes('echo'));
  });
});

test('ping answers with server identity and echoes its argument', async () => {
  await withClient(async (client) => {
    const bare = await client.callTool({ name: 'ping', arguments: {} });
    assert.ok(!bare.isError, 'ping should not error');
    const payload = JSON.parse(bare.content[0].text);
    assert.equal(payload.server, 'frontier');
    assert.equal(payload.status, 'ok');
    assert.ok(!Number.isNaN(Date.parse(payload.time)), 'time should be a parseable ISO timestamp');
    assert.equal(payload.echo, undefined, 'no echo argument means no echo field');

    const echoed = await client.callTool({ name: 'ping', arguments: { echo: 'phase-1' } });
    assert.equal(JSON.parse(echoed.content[0].text).echo, 'phase-1');
  });
});

test('a bad argument is reported over the protocol, not thrown across it', async () => {
  // §7: never throw across the MCP boundary. A type error in the input must
  // come back as a normal tool result the client can read, not a dropped
  // connection or an unhandled rejection in the server process.
  await withClient(async (client) => {
    const result = await client.callTool({ name: 'ping', arguments: { echo: 42 } });
    assert.ok(result.isError, 'invalid input should surface as an error result');
    assert.ok(result.content[0].text.length > 0, 'error result should explain itself');

    // The connection must still be usable afterwards.
    const after = await client.callTool({ name: 'ping', arguments: {} });
    assert.ok(!after.isError, 'server should survive a rejected call');
  });
});
