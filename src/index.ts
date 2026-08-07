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
import type { VerifyClaimOutput } from './verify/verify.js';
import { checkAbandonment } from './abandonment.js';
import { clusterFrontier } from './cluster.js';
import { OCCUPANCY_CHANNELS, findIncumbents } from './occupancy.js';
import type { OccupancyChannel } from './occupancy.js';
import { RFS_TTL_DAYS, fetchRfs, freshness } from './sources/ycombinator.js';
import type { RfsResult } from './sources/ycombinator.js';
import { SnapshotStore } from './snapshot.js';
import { searchLiterature } from './search.js';
import { verifyClaim } from './verify/verify.js';
import { disconfirmSuperlative } from './verify/superlative.js';
import { claimId } from './claim.js';
import { EVENT_TYPES } from './types.js';
import type { Claim, EventType } from './types.js';
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
  registerVerifyClaim(server);
  registerDisconfirmSuperlative(server);
  registerClusterFrontier(server);
  registerSnapshotTools(server);
  registerFindIncumbents(server);
  registerCheckAbandonment(server);
  registerFetchYcRfs(server);
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
 * §5's three snapshot tools.
 *
 * `tool_version` is filled from the server rather than taken from the caller.
 * A snapshot records which build produced it, and a caller able to state that
 * itself could sign a result with a version that never ran — which would
 * defeat the reproducibility the snapshot exists to provide (§4).
 */
function registerSnapshotTools(server: McpServer): void {
  const store = () => new SnapshotStore();

  server.registerTool(
    'save_snapshot',
    {
      title: 'Save snapshot',
      description:
        'Freeze a completed timeline as a citable artifact. The id is the content hash of the payload — ' +
        'it is derived, never supplied, so it always describes what is actually stored. Written to ' +
        '~/.frontier/snapshots/{id}.json.',
      inputSchema: {
        query: z.string().min(1).describe('The field or question this snapshot answers.'),
        components: z.array(z.unknown()).default([]),
        claims: z.array(z.unknown()).default([]),
        verifications: z.array(z.unknown()).default([]),
        frontier: z.array(z.unknown()).default([]),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        const { id, path: file, snapshot } = await store().save({
          query: input.query,
          tool_version: TOOL_VERSION,
          components: input.components as never,
          claims: input.claims as never,
          verifications: input.verifications as never,
          frontier: input.frontier as never,
        });
        return textResult({
          id,
          path: file,
          created_at: snapshot.created_at,
          tool_version: snapshot.tool_version,
          counts: {
            components: snapshot.components.length,
            claims: snapshot.claims.length,
            verifications: snapshot.verifications.length,
            frontier: snapshot.frontier.length,
          },
        });
      } catch (err) {
        return errorResult(`save_snapshot failed: ${describe(err)}`);
      }
    },
  );

  server.registerTool(
    'load_snapshot',
    {
      title: 'Load snapshot',
      description:
        'Load a snapshot, verifying its content hash first. Unlike a cache read, a corrupt or modified ' +
        'snapshot is a hard failure rather than a miss: a snapshot whose bytes no longer match its ' +
        'address must not be cited, and returning it quietly would break the only guarantee it offers.',
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        const result = await store().read(id);
        if (!result.ok) {
          return errorResult(`load_snapshot failed integrity check: ${result.failure.detail}`, {
            reason: result.failure.reason,
            verified: false,
            ...(result.failure.expected_id === undefined ? {} : { expected_id: result.failure.expected_id }),
            ...(result.failure.computed_id === undefined ? {} : { computed_id: result.failure.computed_id }),
          });
        }
        return textResult({ ...result.snapshot, verified: true });
      } catch (err) {
        return errorResult(`load_snapshot failed: ${describe(err)}`);
      }
    },
  );

  server.registerTool(
    'list_snapshots',
    {
      title: 'List snapshots',
      description:
        'List saved snapshots, newest first, verifying each. Entries that fail their integrity check are ' +
        'reported under `unreadable` rather than omitted — a corrupt snapshot you can see is useful, one ' +
        'silently dropped is not.',
      inputSchema: { query: z.string().optional().describe('Case-insensitive substring filter on the query.') },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ query }) => {
      try {
        const listed = await store().list(query);
        return textResult({
          snapshots: listed.snapshots,
          unreadable: listed.unreadable,
          ...(listed.unreadable.length === 0
            ? {}
            : {
                warning:
                  `${listed.unreadable.length} snapshot(s) failed their integrity check and are listed under ` +
                  '`unreadable`. They must not be cited.',
              }),
        });
      } catch (err) {
        return errorResult(`list_snapshots failed: ${describe(err)}`, { snapshots: [] });
      }
    },
  );
}

function registerFindIncumbents(server: McpServer): void {
  server.registerTool(
    'find_incumbents',
    {
      title: 'Find incumbents',
      description:
        'Occupancy sweep across literature, patents, companies, consortia, regulators and news — is anyone ' +
        'already doing this? control_terms is REQUIRED and must name a category you already know is occupied: ' +
        'it runs through the same channels, and where it comes back empty that channel is broken, so the ' +
        "idea's zero there means nothing. Read the `flag` field first; it says in one sentence whether the " +
        'zeros can be believed. No LinkedIn channel — no API exposes it and its terms prohibit scraping.',
      inputSchema: {
        idea_terms: z.array(z.string()).min(1).describe('Terms describing the idea. ANDed.'),
        control_terms: z
          .array(z.string())
          .min(1)
          .describe('A category known to be occupied, e.g. ["surgical robot"]. Makes zeros interpretable.'),
        channels: z
          .array(z.enum(OCCUPANCY_CHANNELS as unknown as [OccupancyChannel, ...OccupancyChannel[]]))
          .optional(),
        max_per_channel: z.number().int().positive().max(50).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      try {
        return textResult(
          await findIncumbents({
            idea_terms: input.idea_terms,
            control_terms: input.control_terms,
            ...(input.channels === undefined ? {} : { channels: input.channels }),
            ...(input.max_per_channel === undefined ? {} : { max_per_channel: input.max_per_channel }),
          }),
        );
      } catch (err) {
        return errorResult(`find_incumbents failed: ${describe(err)}`, { channels: [] });
      }
    },
  );
}

function registerCheckAbandonment(server: McpServer): void {
  server.registerTool(
    'check_abandonment',
    {
      title: 'Check abandonment',
      description:
        'Search news and Hacker News for pivots, shutdowns, acquisitions, deprecations and wind-downs ' +
        'affecting an entity, returning stated reasons verbatim where a source gives one. This is the ' +
        'signal no registry records: an empty gap and a graveyard look identical from an occupancy sweep ' +
        'and mean opposite things. Note that absence here is a WEAK negative — launches get announced and ' +
        'failures do not.',
      inputSchema: {
        entity_terms: z.array(z.string()).min(1).describe('Company, product or project names. ANDed.'),
        signals: z
          .array(z.enum(['shutdown', 'pivot', 'acquisition', 'deprecation', 'wind_down']))
          .optional()
          .describe('Restrict to particular signals. Defaults to all five.'),
        max_per_signal: z.number().int().positive().max(50).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      try {
        return textResult(
          await checkAbandonment({
            entity_terms: input.entity_terms,
            ...(input.signals === undefined ? {} : { signals: input.signals }),
            ...(input.max_per_signal === undefined ? {} : { max_per_signal: input.max_per_signal }),
          }),
        );
      } catch (err) {
        return errorResult(`check_abandonment failed: ${describe(err)}`, { hits: [] });
      }
    },
  );
}

function registerFetchYcRfs(server: McpServer): void {
  server.registerTool(
    'fetch_yc_rfs',
    {
      title: 'Fetch YC Requests for Startups',
      description:
        "Fetch and parse Y Combinator's current Requests for Startups, cached for 7 days. The RFS turns over " +
        'every few months, so a stale copy is worse than none: past the TTL a cached copy is returned only ' +
        'with an explicit staleness warning, and past 90 days it is not returned at all. A parse failure is ' +
        'reported as an error, never as an empty list — YC is never asking for nothing.',
      inputSchema: {
        refresh: z.boolean().optional().describe('Bypass the cache and refetch.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ refresh }) => {
      const request = { source: 'yc-rfs' };
      try {
        const cache = await getCache().catch(() => undefined);

        if (cache !== undefined && refresh !== true) {
          const hit = await cache.get<RfsResult>('web', 'fetch_yc_rfs', request);
          if (hit.outcome === 'fresh' && hit.value !== undefined) {
            return textResult({ ...hit.value, cache_hit: true, stale: false });
          }
        }

        const fetched = await fetchRfs();
        if (fetched.error === undefined && fetched.requests.length > 0) {
          const fresh: RfsResult = {
            requests: fetched.requests,
            source_url: fetched.url,
            ...(fetched.batch === undefined ? {} : { batch: fetched.batch }),
            fetched_at: new Date().toISOString(),
          };
          if (cache !== undefined) await cache.set('web', 'fetch_yc_rfs', request, fresh);
          return textResult({ ...fresh, cache_hit: false, stale: false });
        }

        // The live fetch failed. Fall back to cache only within the staleness
        // ceiling, and never silently.
        if (cache !== undefined) {
          const stale = await cache.get<RfsResult>('web', 'fetch_yc_rfs', request);
          if (stale.value !== undefined && stale.age_ms !== undefined) {
            const ageDays = stale.age_ms / 86_400_000;
            const verdict = freshness(ageDays);
            if (verdict.state !== 'expired') {
              return textResult({
                ...stale.value,
                cache_hit: true,
                stale: true,
                age_days: Math.round(ageDays),
                ttl_days: RFS_TTL_DAYS,
                warning: verdict.warning,
                fetch_error: fetched.error,
              });
            }
            return errorResult(verdict.warning ?? 'Cached RFS is too old to return.', {
              requests: [],
              age_days: Math.round(ageDays),
              fetch_error: fetched.error,
            });
          }
        }

        return errorResult(fetched.error ?? 'Could not fetch the RFS page.', { requests: [] });
      } catch (err) {
        return errorResult(`fetch_yc_rfs failed: ${describe(err)}`, { requests: [] });
      }
    },
  );
}

const paperSchema = z.object({
  id: z.string(),
  title: z.string(),
  abstract: z.string().optional(),
  authors: z.array(z.string()).default([]),
  published: z.string().default(''),
  doi: z.string().optional(),
  url: z.string().default(''),
  venue: z.string().optional(),
  source: z.enum(['arxiv', 'pubmed', 'crossref']).default('crossref'),
  source_id: z.string().default(''),
});

function registerClusterFrontier(server: McpServer): void {
  server.registerTool(
    'cluster_frontier',
    {
      title: 'Cluster frontier',
      description:
        'Group recent papers into research themes by TF-IDF cosine similarity. Clusters come back ' +
        'UNNAMED by design: top terms and representative papers are returned as the evidence for naming, ' +
        'and the naming is yours. No model is called and none is downloaded. A corpus below 4 papers is ' +
        'reported as too sparse rather than split into meaningless groups.',
      inputSchema: {
        papers: z.array(paperSchema).describe('Papers to cluster, typically from search_literature.'),
        component: z.string().min(1).describe('The decomposed component these papers belong to.'),
        top_terms: z.number().int().positive().max(50).optional(),
        representatives: z.number().int().positive().max(20).optional(),
        threshold: z.number().min(0).max(1).optional().describe('Cosine merge threshold. Default 0.18.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return textResult(
          clusterFrontier({
            papers: input.papers as never,
            component: input.component,
            ...(input.top_terms === undefined ? {} : { top_terms: input.top_terms }),
            ...(input.representatives === undefined ? {} : { representatives: input.representatives }),
            ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
          }),
        );
      } catch (err) {
        return errorResult(`cluster_frontier failed: ${describe(err)}`, { clusters: [] });
      }
    },
  );
}

/** Shared input shape for the two claim-taking tools. */
const claimSchema = {
  entity: z.string().min(1),
  entity_aliases: z.array(z.string()).optional(),
  event_type: z.enum(EVENT_TYPES as unknown as [EventType, ...EventType[]]),
  date: z.string().describe('ISO 8601, may be partial: "1993" | "1993-11" | "1993-11-04".'),
  date_precision: z.enum(['year', 'month', 'day']),
  superlative: z.string().nullable().optional(),
  description: z.string().default(''),
  component: z.string().optional(),
  registry: z
    .enum(REGISTRY_NAMES as unknown as [RegistryName, ...RegistryName[]])
    .optional()
    .describe('Registry the record id belongs to. Required alongside registry_id.'),
  registry_id: z
    .string()
    .optional()
    .describe('Primary record id (K number, PMA number, DOI, patent number). The canonical anchor once known.'),
};

/** Build a Claim, deriving `id` rather than trusting a supplied one. */
function toClaim(input: Record<string, unknown>): Claim {
  const partial = {
    entity: input['entity'] as string,
    event_type: input['event_type'] as EventType,
    date: input['date'] as string,
    ...(input['registry'] === undefined ? {} : { registry: input['registry'] as RegistryName }),
    ...(input['registry_id'] === undefined ? {} : { registry_id: input['registry_id'] as string }),
  };
  return {
    ...partial,
    id: claimId(partial),
    date_precision: input['date_precision'] as Claim['date_precision'],
    description: (input['description'] as string) ?? '',
    ...(input['entity_aliases'] === undefined ? {} : { entity_aliases: input['entity_aliases'] as string[] }),
    ...(input['superlative'] === undefined ? {} : { superlative: input['superlative'] as string | null }),
    ...(input['component'] === undefined ? {} : { component: input['component'] as string }),
  };
}

function registerVerifyClaim(server: McpServer): void {
  server.registerTool(
    'verify_claim',
    {
      title: 'Verify claim',
      description:
        'Verify a milestone claim against primary sources. Each field — entity, event type, date — is ' +
        'verified INDEPENDENTLY, because a claim can be right about what happened and wrong about when, ' +
        'or name a real entity and a real date under the wrong event type. Registries are consulted first; ' +
        'for regulatory claims openFDA settles clearance-vs-approval outright. A superlative triggers an ' +
        'adversarial search for rival claimants, and any that surface make it contested. Nothing is ever ' +
        'dropped for failing verification — an unverified claim is returned flagged.',
      inputSchema: {
        claim: z.object(claimSchema),
        depth: z.enum(['fast', 'thorough']).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ claim, depth }) => {
      try {
        const built = toClaim(claim as unknown as Record<string, unknown>);
        const request = { claim: built, ...(depth === undefined ? {} : { depth }) };

        const cache = await getCache().catch(() => undefined);
        if (cache !== undefined) {
          const hit = await cache.get<VerifyClaimOutput>('verification', 'verify_claim', request);
          if (hit.outcome === 'fresh' && hit.value !== undefined) {
            return textResult({ ...hit.value, cache_hit: true });
          }
        }

        const result = await verifyClaim(request);
        if (cache !== undefined && result.error === undefined) {
          await cache.set('verification', 'verify_claim', request, result);
        }
        return textResult(result);
      } catch (err) {
        return errorResult(`verify_claim failed: ${describe(err)}`);
      }
    },
  );
}

function registerDisconfirmSuperlative(server: McpServer): void {
  server.registerTool(
    'disconfirm_superlative',
    {
      title: 'Disconfirm superlative',
      description:
        'Adversarial search for a superlative claim. A source saying "X was first" does not rule out Y, so ' +
        'this queries the superlative CATEGORY with the entity removed and returns every rival claimant it ' +
        'finds. Called automatically by verify_claim when a claim carries a superlative. Competing claimants ' +
        'are returned unranked: the disagreement is the finding, and resolving it is the caller\'s job.',
      inputSchema: { claim: z.object(claimSchema) },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ claim }) => {
      try {
        return textResult(await disconfirmSuperlative(toClaim(claim as unknown as Record<string, unknown>)));
      } catch (err) {
        return errorResult(`disconfirm_superlative failed: ${describe(err)}`, { competing_claimants: [] });
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
