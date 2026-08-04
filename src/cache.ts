/**
 * TTL cache over the filesystem JSON store.
 *
 * Spec reference: CODEX_SPEC.md §7.
 *
 * Two design points that are easy to get wrong:
 *
 *  1. **Expired entries are kept, not deleted.** §7 requires that when every
 *     network call fails, the server serves from cache and marks the result
 *     `stale: true`. That is only possible if expiry means "do not return this
 *     as fresh", not "erase this". `get()` reports `fresh` / `stale` / `miss`
 *     and lets the caller decide; only `clear()` and `prune()` actually delete.
 *
 *  2. **A miss and a failure are different.** An empty result that came from a
 *     timeout must never look like an empty result that came from a genuinely
 *     empty field. The cache surfaces the distinction; the tools carry it in
 *     `ToolEnvelope.error` / `stale`.
 */

import path from 'node:path';

import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import { requestKey } from './hash.js';
import { cacheDir as defaultCacheDir, statsFile as defaultStatsFile, frontierHome } from './paths.js';
import { listJson, readJson, removeDir, removeJson, writeJson } from './store.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type CacheNamespace = 'registry' | 'literature' | 'verification';

export const CACHE_NAMESPACES: readonly CacheNamespace[] = ['registry', 'literature', 'verification'] as const;

/**
 * TTLs from §7. The spread is about how fast the underlying truth moves:
 * a cleared 510(k) from 1994 will not change, so 30 days is conservative;
 * literature search results shift daily as new papers land; a verification
 * result is a derived judgement over sources that may themselves have been
 * re-cached, so it expires sooner than the registry data under it.
 */
export const CACHE_TTL_MS: Record<CacheNamespace, number> = {
  registry: 30 * DAY,
  literature: 24 * HOUR,
  verification: 7 * DAY,
};

export interface CacheEntry<T> {
  key: string;
  namespace: CacheNamespace;
  /** Tool that produced this value, for per-tool hit-rate reporting. */
  tool: string;
  /** ISO timestamps, for human inspection of the cache directory. */
  created_at: string;
  expires_at: string;
  /** Epoch millis — what the code actually compares, no date parsing on read. */
  created_ms: number;
  expires_ms: number;
  value: T;
}

export type CacheOutcome = 'fresh' | 'stale' | 'miss';

export interface CacheLookup<T> {
  outcome: CacheOutcome;
  value?: T;
  /** Age in ms at lookup time. Present for `fresh` and `stale`. */
  age_ms?: number;
  /** Set when an entry existed but could not be parsed; counted as a miss. */
  corrupt?: boolean;
}

export interface ToolStats {
  hits: number;
  stale_hits: number;
  misses: number;
  writes: number;
}

interface StatsDocument {
  version: 1;
  tools: Record<string, ToolStats>;
}

export interface CacheStatus {
  home: string;
  total_entries: number;
  /** Entries whose TTL has not expired. */
  fresh_entries: number;
  stale_entries: number;
  entries_by_namespace: Record<CacheNamespace, number>;
  age_distribution: { bucket: string; count: number }[];
  hit_rate_by_tool: Record<string, ToolStats & { hit_rate: number | null }>;
  /** Entries that could not be parsed; they are reported, not hidden. */
  corrupt_entries: number;
}

/** Age buckets for `cache_status`. Chosen to straddle the three TTLs. */
const AGE_BUCKETS: { bucket: string; max: number }[] = [
  { bucket: 'under_1h', max: HOUR },
  { bucket: 'under_24h', max: DAY },
  { bucket: 'under_7d', max: 7 * DAY },
  { bucket: 'under_30d', max: 30 * DAY },
  { bucket: 'over_30d', max: Infinity },
];

function emptyStats(): ToolStats {
  return { hits: 0, stale_hits: 0, misses: 0, writes: 0 };
}

export interface CacheOptions {
  home?: string;
  clock?: Clock;
  /** Per-namespace TTL overrides, for tests and for future tuning. */
  ttl?: Partial<Record<CacheNamespace, number>>;
}

export class Cache {
  readonly #home: string;
  readonly #dir: string;
  readonly #statsPath: string;
  readonly #clock: Clock;
  readonly #ttl: Record<CacheNamespace, number>;
  #stats: StatsDocument;

  private constructor(home: string, clock: Clock, ttl: Record<CacheNamespace, number>, stats: StatsDocument) {
    this.#home = home;
    this.#dir = defaultCacheDir(home);
    this.#statsPath = defaultStatsFile(home);
    this.#clock = clock;
    this.#ttl = ttl;
    this.#stats = stats;
  }

  /** Loads persisted hit-rate counters. Never touches the network. */
  static async open(options: CacheOptions = {}): Promise<Cache> {
    const home = options.home ?? frontierHome();
    const clock = options.clock ?? systemClock;
    const ttl = { ...CACHE_TTL_MS, ...options.ttl };

    const loaded = await readJson<StatsDocument>(defaultStatsFile(home));
    const stats: StatsDocument =
      loaded.value !== undefined && loaded.value.version === 1 && typeof loaded.value.tools === 'object'
        ? loaded.value
        : { version: 1, tools: {} };

    return new Cache(home, clock, ttl, stats);
  }

  get home(): string {
    return this.#home;
  }

  ttlFor(namespace: CacheNamespace): number {
    return this.#ttl[namespace];
  }

  /**
   * Entry path. Sharded by the first two characters of the key so a cache with
   * tens of thousands of entries does not put them all in one directory, which
   * makes enumeration slow on every major filesystem.
   */
  #pathFor(namespace: CacheNamespace, key: string): string {
    return path.join(this.#dir, namespace, key.slice(0, 2), `${key}.json`);
  }

  async get<T>(namespace: CacheNamespace, tool: string, request: unknown): Promise<CacheLookup<T>> {
    const key = requestKey(tool, request);
    const result = await readJson<CacheEntry<T>>(this.#pathFor(namespace, key));

    if (result.corrupt === true) {
      await this.#record(tool, 'misses');
      return { outcome: 'miss', corrupt: true };
    }
    const entry = result.value;
    if (entry === undefined) {
      await this.#record(tool, 'misses');
      return { outcome: 'miss' };
    }

    const now = this.#clock.now();
    const age = now - entry.created_ms;

    if (now < entry.expires_ms) {
      await this.#record(tool, 'hits');
      return { outcome: 'fresh', value: entry.value, age_ms: age };
    }

    // Expired but retained — this is the offline fallback path (§7).
    await this.#record(tool, 'stale_hits');
    return { outcome: 'stale', value: entry.value, age_ms: age };
  }

  async set<T>(namespace: CacheNamespace, tool: string, request: unknown, value: T): Promise<CacheEntry<T>> {
    const key = requestKey(tool, request);
    const now = this.#clock.now();
    const expires = now + this.#ttl[namespace];

    const entry: CacheEntry<T> = {
      key,
      namespace,
      tool,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(expires).toISOString(),
      created_ms: now,
      expires_ms: expires,
      value,
    };

    await writeJson(this.#pathFor(namespace, key), entry);
    await this.#record(tool, 'writes');
    return entry;
  }

  async delete(namespace: CacheNamespace, tool: string, request: unknown): Promise<boolean> {
    return removeJson(this.#pathFor(namespace, requestKey(tool, request)));
  }

  /**
   * Drop entries. Without a namespace, drops the whole cache. Returns the
   * number of entries removed. Hit-rate counters survive unless
   * `resetStats` is set — they describe the server's behaviour over time, not
   * the contents of the directory.
   */
  async clear(namespace?: CacheNamespace, resetStats = false): Promise<number> {
    let removed: number;
    if (namespace === undefined) {
      removed = (await listJson(this.#dir)).length;
      await removeDir(this.#dir);
    } else {
      const dir = path.join(this.#dir, namespace);
      removed = (await listJson(dir)).length;
      await removeDir(dir);
    }
    if (resetStats) {
      this.#stats = { version: 1, tools: {} };
      await this.#persistStats();
    }
    return removed;
  }

  /** Delete only entries past their TTL. Nothing calls this automatically. */
  async prune(): Promise<number> {
    const now = this.#clock.now();
    let removed = 0;
    for (const file of await listJson(this.#dir)) {
      const result = await readJson<CacheEntry<unknown>>(file);
      const entry = result.value;
      if (result.corrupt === true || entry === undefined || now >= entry.expires_ms) {
        if (await removeJson(file)) removed += 1;
      }
    }
    return removed;
  }

  /** §5 `cache_status`: entry counts, age distribution, hit rate by tool. */
  async status(): Promise<CacheStatus> {
    const now = this.#clock.now();
    const byNamespace: Record<CacheNamespace, number> = { registry: 0, literature: 0, verification: 0 };
    const buckets = new Map<string, number>(AGE_BUCKETS.map((b) => [b.bucket, 0]));

    let total = 0;
    let fresh = 0;
    let stale = 0;
    let corrupt = 0;

    for (const file of await listJson(this.#dir)) {
      const result = await readJson<CacheEntry<unknown>>(file);
      const entry = result.value;
      if (entry === undefined) {
        corrupt += 1;
        continue;
      }
      total += 1;
      if (byNamespace[entry.namespace] !== undefined) byNamespace[entry.namespace] += 1;
      if (now < entry.expires_ms) fresh += 1;
      else stale += 1;

      const age = now - entry.created_ms;
      const bucket = AGE_BUCKETS.find((b) => age < b.max) ?? AGE_BUCKETS[AGE_BUCKETS.length - 1];
      if (bucket !== undefined) buckets.set(bucket.bucket, (buckets.get(bucket.bucket) ?? 0) + 1);
    }

    const hitRates: CacheStatus['hit_rate_by_tool'] = {};
    for (const [tool, stats] of Object.entries(this.#stats.tools)) {
      const lookups = stats.hits + stats.stale_hits + stats.misses;
      hitRates[tool] = {
        ...stats,
        // null rather than 0 when nothing was ever looked up: a tool with no
        // lookups has no hit rate, and reporting 0% would read as "always missing".
        hit_rate: lookups === 0 ? null : Number((stats.hits / lookups).toFixed(4)),
      };
    }

    return {
      home: this.#home,
      total_entries: total,
      fresh_entries: fresh,
      stale_entries: stale,
      entries_by_namespace: byNamespace,
      age_distribution: AGE_BUCKETS.map((b) => ({ bucket: b.bucket, count: buckets.get(b.bucket) ?? 0 })),
      hit_rate_by_tool: hitRates,
      corrupt_entries: corrupt,
    };
  }

  async #record(tool: string, field: keyof ToolStats): Promise<void> {
    const current = this.#stats.tools[tool] ?? emptyStats();
    current[field] += 1;
    this.#stats.tools[tool] = current;
    await this.#persistStats();
  }

  async #persistStats(): Promise<void> {
    try {
      await writeJson(this.#statsPath, this.#stats);
    } catch {
      // Diagnostics must never break a tool call. Losing a counter is
      // acceptable; failing a verification because the stats file is on a full
      // disk is not.
    }
  }
}
