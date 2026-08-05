/**
 * The single outbound HTTP path.
 *
 * Every network call in this server goes through `httpGet`, so rate limiting,
 * timeouts, and failure classification are applied uniformly rather than
 * re-implemented per adapter.
 *
 * §7: this function never throws. A timeout, a DNS failure, a 500, and a
 * blocked egress proxy all come back as a typed failure, because the caller
 * has to be able to tell "this field is quiet" from "we could not look".
 */

import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import { RateLimiter } from './ratelimit.js';

export type HttpFailureKind =
  /** Request exceeded the deadline. */
  | 'timeout'
  /** DNS, TLS, connection refused, proxy denial. */
  | 'network'
  /** Reached the server; it returned a non-2xx. */
  | 'http'
  /**
   * 401. The service is asking us to authenticate. Unambiguous: a credential
   * is required and ours is missing or invalid.
   */
  | 'unauthenticated'
  /**
   * 403. The service refused the request. NOT the same signal as 401 — a 403
   * can mean an authenticated caller lacks permission, but it can equally mean
   * a quota ban, an IP block, or a geo restriction, none of which a key fixes.
   * Keeping it distinct stops the server telling a rate-limited user to go get
   * an API key.
   */
  | 'forbidden';

export type HttpResult =
  | { ok: true; status: number; body: string; url: string }
  | { ok: false; kind: HttpFailureKind; status?: number; error: string; url: string };

export interface HttpOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpDeps {
  fetch?: typeof globalThis.fetch;
  limiter?: RateLimiter;
  clock?: Clock;
}

/**
 * 20s. Long enough for PubMed under load, short enough that a hung registry
 * does not stall a whole verification. Callers that want to fail faster pass
 * their own.
 */
export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Identifies the client to the APIs we call. arXiv and Wikimedia both ask for
 * a descriptive User-Agent and throttle or block generic ones; sending it
 * everywhere is simpler than tracking which hosts care.
 */
export const USER_AGENT = 'frontier-mcp/0.1 (+https://github.com/WildCat231/MCP)';

const sharedLimiter = new RateLimiter();

export async function httpGet(url: string, options: HttpOptions = {}, deps: HttpDeps = {}): Promise<HttpResult> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const limiter = deps.limiter ?? sharedLimiter;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (typeof doFetch !== 'function') {
    return { ok: false, kind: 'network', error: 'no fetch implementation available', url };
  }

  // Wait for this host's token before starting the clock on the request, so a
  // queued request is not charged for time it spent waiting politely.
  await limiter.acquire(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const response = await doFetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...options.headers },
      signal: controller.signal,
      redirect: 'follow',
    });

    const body = await response.text();

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        kind: response.status === 401 ? 'unauthenticated' : 'forbidden',
        status: response.status,
        // The body often carries the actual reason ("quota exceeded" vs "API
        // key required"), which is the difference between an actionable
        // instruction and a misleading one.
        error: `${response.status} ${response.statusText || (response.status === 401 ? 'Unauthorized' : 'Forbidden')}${
          body === '' ? '' : `: ${body.slice(0, 200)}`
        }`,
        url,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        kind: 'http',
        status: response.status,
        // Truncated: error bodies can be entire HTML pages, and this string
        // ends up in a model's context.
        error: `${response.status} ${response.statusText || 'error'}${body === '' ? '' : `: ${body.slice(0, 200)}`}`,
        url,
      };
    }

    return { ok: true, status: response.status, body, url };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, kind: 'timeout', error: `request exceeded ${timeoutMs}ms`, url };
    }
    return { ok: false, kind: 'network', error: describe(err), url };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/** JSON convenience wrapper. A body that will not parse is a failure, not a null. */
export async function httpGetJson<T>(
  url: string,
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<{ ok: true; value: T } | { ok: false; kind: HttpFailureKind; status?: number; error: string; url: string }> {
  const result = await httpGet(url, options, deps);
  if (!result.ok) return result;
  try {
    return { ok: true, value: JSON.parse(result.body) as T };
  } catch (err) {
    return { ok: false, kind: 'http', status: result.status, error: `malformed JSON: ${describe(err)}`, url };
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? ` (${cause.message})` : '';
    return `${err.message}${causeText}`;
  }
  return String(err);
}

/** Build a URL with query parameters, skipping undefined values. */
export function buildUrl(base: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export { systemClock };
