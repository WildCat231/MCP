#!/usr/bin/env node
/**
 * frontier — MCP server entry point.
 *
 * Phases 1–2 (CODEX_SPEC.md §10.1–10.2): starts, connects over stdio, and
 * exposes the storage diagnostics. Source adapters and verification are not
 * built yet.
 *
 * Three invariants that later phases must not break:
 *
 *   1. No network calls at import time (§3). Everything at module scope is
 *      pure construction; the server must start with the machine offline and
 *      fail gracefully per-tool instead.
 *   2. stdout belongs to the MCP protocol. stdio transport frames JSON-RPC on
 *      stdout, so any diagnostic output goes to stderr. A stray console.log
 *      corrupts the stream and the client disconnects with a parse error.
 *   3. Never throw across the MCP boundary (§7). Tool handlers catch and
 *      return a structured error.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { Cache, CACHE_NAMESPACES } from './cache.js';
import { REGISTRY_NAMES } from './types.js';
import type { RegistryName } from './types.js';
import type { CacheNamespace } from './cache.js';
import { frontierHome } from './paths.js';
import { checkRegistry } from './registries.js';
import type { CheckRegistryOutput } from './registries.js';
import { searchLiterature } from './search.js';
import type { SearchLiteratureOutput } from './search.js';

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

/**
 * Opened on first use rather than at startup, so an unwritable or missing home
 * directory degrades to a per-tool error instead of preventing the server from
 * connecting at all.
 */
let cachePromise: Promise<Cache> | undefined;

function getCache(): Promise<Cache> {
  cachePromise ??= Cache.open();
  return cachePromise;
}

/** Reset between tests; not used in production. */
export function resetCacheForTesting(): void {
  cachePromise = undefined;
}

function textResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/**
 * §7: a failing tool returns a structured result describing the failure. It
 * does not throw, and it does not return an empty payload that a caller could
 * mistake for "there is genuinely nothing here".
 */
function errorResult(message: string, extra: Record<string, unknown> = {}) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, ...extra }, null, 2) }],
  };
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: TOOL_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'frontier builds verified historical timelines of technical fields and tracks their ' +
        'research frontier. It performs no reasoning of its own: it retrieves records from public ' +
        'APIs, verifies claim fields independently against them, and returns structured evidence. ' +
        "Interpretation, naming, and any clarifying questions are the calling model's job.",
    },
  );

  registerPing(server);
  registerSearchLiterature(server);
  registerCheckRegistry(server);
  registerCacheStatus(server);
  registerClearCache(server);

  return server;
}

function registerSearchLiterature(server: McpServer): void {
  server.registerTool(
    'search_literature',
    {
      title: 'Search literature',
      description:
        'Search arXiv, PubMed, and Crossref for recent papers. Terms are ANDed, so pass several ' +
        'to anchor the field context — a bare component name will return results from unrelated ' +
        'disciplines. If no date window is given, one is chosen adaptively (6 -> 12 -> 24 -> 60 ' +
        'months) and returned as window_used; read it, because the same result count means very ' +
        'different things over 6 months and over 5 years.',
      inputSchema: {
        terms: z
          .array(z.string())
          .min(1)
          .describe('Search terms, ANDed. Pass 2+ to anchor the field context.'),
        sources: z
          .array(z.enum(['arxiv', 'pubmed', 'crossref']))
          .optional()
          .describe('Which sources to query. Defaults to all three.'),
        from: z.string().optional().describe('ISO date lower bound. Supplying this disables the adaptive window.'),
        to: z.string().optional().describe('ISO date upper bound.'),
        max_per_source: z.number().int().positive().max(100).optional().describe('Default 25.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      try {
        const cache = await getCache().catch(() => undefined);
        // Built with omission rather than explicit undefined so the cache key
        // is identical whether an optional argument was absent or passed as
        // undefined.
        const request = {
          terms: input.terms,
          ...(input.sources === undefined ? {} : { sources: input.sources }),
          ...(input.from === undefined ? {} : { from: input.from }),
          ...(input.to === undefined ? {} : { to: input.to }),
          ...(input.max_per_source === undefined ? {} : { max_per_source: input.max_per_source }),
        };

        if (cache !== undefined) {
          const hit = await cache.get<SearchLiteratureOutput>('literature', 'search_literature', request);
          if (hit.outcome === 'fresh' && hit.value !== undefined) {
            return textResult({ ...hit.value, cache_hit: true });
          }
        }

        const result = await searchLiterature(request);

        // Only cache a clean run. Caching a partial result would let one
        // timeout look like a quiet field for the next 24 hours.
        if (cache !== undefined && result.errors === undefined) {
          await cache.set('literature', 'search_literature', request, result);
        }
        return textResult({ ...result, cache_hit: false });
      } catch (err) {
        return errorResult(`search_literature failed: ${describe(err)}`, { results: [] });
      }
    },
  );
}

function registerCheckRegistry(server: McpServer): void {
  server.registerTool(
    'check_registry',
    {
      title: 'Check registry',
      description:
        'Primary-source lookup. Try this before falling back to general literature search: for any ' +
        'regulatory claim, openFDA settles clearance-vs-approval definitively, because 510(k) and PMA ' +
        'are separate databases with separate dates — and this tool queries BOTH and returns both, so ' +
        'the distinction is visible without knowing which to ask for. Returns every match, never a ' +
        'chosen one. Always read `truncated`: a truncated result set shows that records exist but ' +
        'cannot establish which is earliest, and absence from it is not absence from the registry.',
      inputSchema: {
        registry: z
          .enum(REGISTRY_NAMES as unknown as [RegistryName, ...RegistryName[]])
          .describe('Which registry to query.'),
        query: z
          .string()
          .min(1)
          .describe('Device name, DOI, K number, article title, or patent text depending on the registry.'),
        filters: z.record(z.string()).optional().describe('Registry-specific field:value narrowing.'),
        limit: z.number().int().positive().max(100).optional().describe('Default 25.'),
        sort: z
          .string()
          .optional()
          .describe('openFDA only, e.g. "decision_date:asc". Required before making any ordering claim.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      try {
        const request = {
          registry: input.registry,
          query: input.query,
          ...(input.filters === undefined ? {} : { filters: input.filters }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.sort === undefined ? {} : { sort: input.sort }),
        };

        const cache = await getCache().catch(() => undefined);
        if (cache !== undefined) {
          const hit = await cache.get<CheckRegistryOutput>('registry', 'check_registry', request);
          if (hit.outcome === 'fresh' && hit.value !== undefined) {
            return textResult({ ...hit.value, cache_hit: true });
          }
        }

        const result = await checkRegistry(request);

        // A failed lookup must not be cached for 30 days as though it were an
        // absence — that is the same error as reading a timeout as a quiet field.
        if (cache !== undefined && result.error === undefined) {
          await cache.set('registry', 'check_registry', request, result);
        }
        return textResult({ ...result, cache_hit: false });
      } catch (err) {
        return errorResult(`check_registry failed: ${describe(err)}`, { records: [] });
      }
    },
  );
}

/**
 * The Phase 1 no-op tool. Deterministic, offline, and side-effect free — its
 * only purpose is to prove the stdio handshake and tool listing work end to
 * end. It stays as the cheapest possible liveness check.
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
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ echo }) =>
      textResult({
        server: SERVER_NAME,
        version: TOOL_VERSION,
        status: 'ok',
        home: frontierHome(),
        time: new Date().toISOString(),
        ...(echo === undefined ? {} : { echo }),
      }),
  );
}

function registerCacheStatus(server: McpServer): void {
  server.registerTool(
    'cache_status',
    {
      title: 'Cache status',
      description:
        'Diagnostics for the on-disk cache: entry counts by namespace, freshness, age ' +
        'distribution, and hit rate by tool. Makes no network calls.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const cache = await getCache();
        return textResult(await cache.status());
      } catch (err) {
        return errorResult(`cache_status failed: ${describe(err)}`, { home: frontierHome() });
      }
    },
  );
}

function registerClearCache(server: McpServer): void {
  server.registerTool(
    'clear_cache',
    {
      title: 'Clear cache',
      description:
        'Delete cached entries. Without a namespace, clears everything. Hit-rate counters are ' +
        'kept unless reset_stats is set, since they describe behaviour over time rather than ' +
        'current contents.',
      inputSchema: {
        namespace: z
          .enum(CACHE_NAMESPACES as unknown as [CacheNamespace, ...CacheNamespace[]])
          .optional()
          .describe('Limit the clear to one namespace. Omit to clear all.'),
        reset_stats: z.boolean().optional().describe('Also zero the per-tool hit-rate counters.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ namespace, reset_stats }) => {
      try {
        const cache = await getCache();
        const removed = await cache.clear(namespace, reset_stats ?? false);
        return textResult({
          cleared: removed,
          namespace: namespace ?? 'all',
          stats_reset: reset_stats ?? false,
        });
      } catch (err) {
        return errorResult(`clear_cache failed: ${describe(err)}`, { home: frontierHome() });
      }
    },
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr, not stdout — see the header note on stream ownership.
  process.stderr.write(`${SERVER_NAME} ${TOOL_VERSION} listening on stdio (home: ${frontierHome()})\n`);
}

/**
 * Only run when executed directly, so tests and later phases can import
 * `createServer()` and drive it over an in-memory transport.
 *
 * `pathToFileURL` rather than string-concatenating `file://`: on Windows,
 * `process.argv[1]` is a drive path with backslashes, which never equals
 * `import.meta.url` under naive concatenation — the server would import
 * cleanly and then exit without ever starting.
 */
const entryArg = process.argv[1];
const isDirectRun = entryArg !== undefined && import.meta.url === pathToFileURL(entryArg).href;

if (isDirectRun) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `${SERVER_NAME}: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
