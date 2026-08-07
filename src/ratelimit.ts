/**
 * Token-bucket rate limiter, one bucket per host.
 *
 * Spec reference: CODEX_SPEC.md §7.
 *
 * Per-host rather than global: arXiv's 3-second floor should not throttle
 * Crossref, and a global limiter tuned for arXiv would make everything else
 * unusably slow.
 */

import type { Clock } from './clock.js';
import { systemClock } from './clock.js';

export interface HostLimit {
  /** Maximum tokens held at once — i.e. the largest permitted burst. */
  capacity: number;
  /** Sustained rate. */
  refillPerSecond: number;
}

/**
 * Published limits, with the reasoning kept next to the number because these
 * are exactly the constants a future maintainer will want to tune.
 */
export const HOST_LIMITS: Readonly<Record<string, HostLimit>> = {
  // arXiv's terms ask for >= 3 seconds between requests. Capacity is 1, not 3:
  // any capacity above 1 permits a burst, and a burst is precisely what gets
  // the IP banned. This is the one limit here that is a hard requirement
  // rather than politeness.
  'export.arxiv.org': { capacity: 1, refillPerSecond: 1 / 3 },

  // PubMed E-utilities allow 3 requests/second without an API key.
  'eutils.ncbi.nlm.nih.gov': { capacity: 3, refillPerSecond: 3 },

  // Crossref's public pool has no published hard cap and asks for politeness.
  // 5/s is well inside anything they have ever rate-limited on.
  'api.crossref.org': { capacity: 5, refillPerSecond: 5 },

  // openFDA allows 240 requests/minute per IP without a key — 4/s sustained.
  'api.fda.gov': { capacity: 4, refillPerSecond: 4 },

  // Wikimedia asks for a descriptive User-Agent more than a specific rate;
  // 5/s is conservative for their REST API.
  'en.wikipedia.org': { capacity: 5, refillPerSecond: 5 },

  // PatentsView's documented limit is 45 requests/minute.
  'search.patentsview.org': { capacity: 5, refillPerSecond: 0.75 },

  // GDELT publishes no hard cap but asks callers not to hammer it; an
  // occupancy sweep issues one query per channel, so 2/s is ample.
  'api.gdeltproject.org': { capacity: 2, refillPerSecond: 2 },

  // Algolia's HN index is generous (10k/hour on the public tier) but
  // check_abandonment fires five queries in a row, so it stays modest.
  'hn.algolia.com': { capacity: 5, refillPerSecond: 5 },

  // A plain web page, fetched at most once a week thanks to the cache.
  // Capacity 1 makes an accidental loop harmless.
  'www.ycombinator.com': { capacity: 1, refillPerSecond: 0.5 },
};

/**
 * Applied to any host without an explicit entry. Deliberately strict: an
 * unknown host is one nobody has checked the terms for, so it gets the
 * cautious default rather than a generous one.
 */
export const DEFAULT_HOST_LIMIT: HostLimit = { capacity: 2, refillPerSecond: 1 };

export class TokenBucket {
  readonly #limit: HostLimit;
  readonly #clock: Clock;
  readonly #refillPerMs: number;
  #tokens: number;
  #lastRefill: number;
  /**
   * Tail of the FIFO chain. Acquisitions are serialized per bucket: without
   * this, two concurrent callers both see an empty bucket, both sleep for the
   * same interval, and both take a token when they wake — the exact burst the
   * limiter exists to prevent.
   */
  #tail: Promise<void> = Promise.resolve();

  constructor(limit: HostLimit, clock: Clock = systemClock) {
    this.#limit = limit;
    this.#clock = clock;
    this.#refillPerMs = limit.refillPerSecond / 1000;
    this.#tokens = limit.capacity;
    this.#lastRefill = clock.now();
  }

  /** Tokens currently available, after accounting for elapsed time. */
  get tokens(): number {
    this.#refill();
    return this.#tokens;
  }

  #refill(): void {
    const now = this.#clock.now();
    const elapsed = now - this.#lastRefill;
    if (elapsed <= 0) return;
    this.#lastRefill = now;
    this.#tokens = Math.min(this.#limit.capacity, this.#tokens + elapsed * this.#refillPerMs);
  }

  /** Take a token if one is available right now. Never waits. */
  tryAcquire(): boolean {
    this.#refill();
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return true;
    }
    return false;
  }

  /** Take a token, waiting as long as necessary. FIFO across concurrent callers. */
  async acquire(): Promise<void> {
    const predecessor = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await predecessor;
    try {
      for (;;) {
        this.#refill();
        if (this.#tokens >= 1) {
          this.#tokens -= 1;
          return;
        }
        const deficit = 1 - this.#tokens;
        // Round up: sleeping the exact fractional interval can wake a hair
        // early and spin.
        await this.#clock.sleep(Math.ceil(deficit / this.#refillPerMs));
      }
    } finally {
      release();
    }
  }
}

export class RateLimiter {
  readonly #clock: Clock;
  readonly #limits: Readonly<Record<string, HostLimit>>;
  readonly #fallback: HostLimit;
  readonly #buckets = new Map<string, TokenBucket>();

  constructor(
    options: {
      clock?: Clock;
      limits?: Readonly<Record<string, HostLimit>>;
      fallback?: HostLimit;
    } = {},
  ) {
    this.#clock = options.clock ?? systemClock;
    this.#limits = options.limits ?? HOST_LIMITS;
    this.#fallback = options.fallback ?? DEFAULT_HOST_LIMIT;
  }

  /**
   * Accepts a URL or a bare hostname. A malformed URL falls back to being
   * treated as a hostname rather than throwing — the limiter must never be the
   * thing that fails a request (§7).
   */
  static hostOf(target: string): string {
    try {
      return new URL(target).hostname.toLowerCase();
    } catch {
      return target.toLowerCase();
    }
  }

  bucketFor(target: string): TokenBucket {
    const host = RateLimiter.hostOf(target);
    let bucket = this.#buckets.get(host);
    if (bucket === undefined) {
      bucket = new TokenBucket(this.#limits[host] ?? this.#fallback, this.#clock);
      this.#buckets.set(host, bucket);
    }
    return bucket;
  }

  limitFor(target: string): HostLimit {
    return this.#limits[RateLimiter.hostOf(target)] ?? this.#fallback;
  }

  /** Wait until this host permits another request. */
  async acquire(target: string): Promise<void> {
    await this.bucketFor(target).acquire();
  }

  tryAcquire(target: string): boolean {
    return this.bucketFor(target).tryAcquire();
  }

  /** Current token counts per host that has been used. Diagnostics only. */
  snapshot(): Record<string, { tokens: number; capacity: number; refill_per_second: number }> {
    const out: Record<string, { tokens: number; capacity: number; refill_per_second: number }> = {};
    for (const [host, bucket] of this.#buckets) {
      const limit = this.#limits[host] ?? this.#fallback;
      out[host] = {
        tokens: Number(bucket.tokens.toFixed(4)),
        capacity: limit.capacity,
        refill_per_second: limit.refillPerSecond,
      };
    }
    return out;
  }
}
