#!/usr/bin/env node
/**
 * frontier — MCP server entry point.
 *
 * Phase 1 (CODEX_SPEC.md §10.1): starts, registers one no-op tool, connects
 * over stdio. No storage, no network, no verification yet.
 *
 * Two invariants that later phases must not break:
 *
 *   1. No network calls at import time (§3). Everything in this file is pure
 *      construction; the server must start with the machine offline and fail
 *      gracefully per-tool instead.
 *   2. stdout belongs to the MCP protocol. stdio transport frames JSON-RPC on
 *      stdout, so any diagnostic output goes to stderr. A stray console.log
 *      corrupts the stream and the client disconnects with a parse error.
 */

import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const require = createRequire(import.meta.url);

/**
 * Single source of truth for the version, shared with `manifest.json` and with
 * `Snapshot.tool_version`. Read rather than hardcoded so a release bump in
 * package.json cannot silently disagree with what snapshots record.
 */
function readVersion(): string {
  try {
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    // Running from an unusual layout (e.g. a bundler flattened the tree).
    // A missing version is not worth refusing to start over.
    return '0.0.0';
  }
}

export const TOOL_VERSION = readVersion();
export const SERVER_NAME = 'frontier';

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: TOOL_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'frontier builds verified historical timelines of technical fields and tracks their ' +
        'research frontier. It performs no reasoning of its own: it retrieves records from public ' +
        'APIs, verifies claim fields independently against them, and returns structured evidence. ' +
        'Interpretation, naming, and any clarifying questions are the calling model\'s job.',
    },
  );

  registerPing(server);

  return server;
}

/**
 * The Phase 1 no-op tool. Deterministic, offline, and side-effect free — its
 * only purpose is to prove the stdio handshake and tool listing work end to
 * end before any real tool depends on them. It stays past Phase 1 as the
 * cheapest possible liveness check for `cache_status`-style diagnostics.
 */
function registerPing(server: McpServer): void {
  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description:
        'Liveness check. Returns the frontier server name, version, and current time. ' +
        'Makes no network calls and touches no storage.',
      inputSchema: {
        echo: z.string().optional().describe('Optional string echoed back verbatim.'),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ echo }) => {
      const payload = {
        server: SERVER_NAME,
        version: TOOL_VERSION,
        status: 'ok' as const,
        time: new Date().toISOString(),
        ...(echo === undefined ? {} : { echo }),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
      };
    },
  );
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr, not stdout — see the header note on stream ownership.
  process.stderr.write(`${SERVER_NAME} ${TOOL_VERSION} listening on stdio\n`);
}

/**
 * Only run when executed directly, so tests and later phases can import
 * `createServer()` and drive it over an in-memory transport.
 */
const isDirectRun = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  main().catch((err: unknown) => {
    process.stderr.write(`${SERVER_NAME}: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
