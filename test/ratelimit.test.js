/**
 * Phase 2: token-bucket rate limiting (CODEX_SPEC.md §7).
 *
 * Driven entirely by FakeClock, so asserting arXiv's 3-second floor costs no
 * wall-clock time and cannot flake under load.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeClock } from '../dist/clock.js';
import { DEFAULT_HOST_LIMIT, HOST_LIMITS, RateLimiter, TokenBucket } from '../dist/ratelimit.js';

const ARXIV = 'https://export.arxiv.org/api/query?search_query=all:robot';

/** Let already-resolved promise chains settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a fresh bucket permits a burst up to capacity, then blocks', async () => {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 }, clock);

  assert.equal(bucket.tryAcquire(), true);
  assert.equal(bucket.tryAcquire(), true);
  assert.equal(bucket.tryAcquire(), true);
  assert.equal(bucket.tryAcquire(), false, 'capacity exhausted');

  await clock.advance(1000);
  assert.equal(bucket.tryAcquire(), true, 'one token refilled after a second');
});

test('refill is capped at capacity — idle time does not bank a burst', async () => {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1 }, clock);
  bucket.tryAcquire();
  bucket.tryAcquire();

  await clock.advance(60_000);
  assert.equal(bucket.tokens, 2, 'a minute idle still yields only `capacity` tokens');
});

test('arXiv requests are spaced at least 3 seconds apart', async () => {
  // The one hard limit in HOST_LIMITS: arXiv's terms require >= 3s between
  // requests, and violating it gets the IP banned mid-development.
  const clock = new FakeClock(0);
  const limiter = new RateLimiter({ clock });
  const acquiredAt = [];

  const requests = [0, 1, 2, 3].map(async () => {
    await limiter.acquire(ARXIV);
    acquiredAt.push(clock.now());
  });

  await settle();
  assert.deepEqual(acquiredAt, [0], 'the first request goes out immediately');

  await clock.advance(10_000);
  await Promise.all(requests);

  assert.deepEqual(acquiredAt, [0, 3000, 6000, 9000]);
  for (let i = 1; i < acquiredAt.length; i += 1) {
    assert.ok(acquiredAt[i] - acquiredAt[i - 1] >= 3000, 'no pair closer than 3s');
  }
});

test('arXiv capacity is 1, so no burst is possible even from a cold start', async () => {
  // Capacity > 1 on this host would permit exactly the burst the limit forbids.
  assert.equal(HOST_LIMITS['export.arxiv.org'].capacity, 1);

  const clock = new FakeClock(0);
  const limiter = new RateLimiter({ clock });
  assert.equal(limiter.tryAcquire(ARXIV), true);
  assert.equal(limiter.tryAcquire(ARXIV), false, 'second immediate request must wait');
});

test('concurrent acquisitions are serialized FIFO, not released together', async () => {
  // Without a per-bucket queue, concurrent callers all observe an empty bucket,
  // all sleep the same interval, and all wake and take a token at once.
  const clock = new FakeClock(0);
  const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 }, clock);
  const order = [];

  const waiters = ['a', 'b', 'c'].map(async (label) => {
    await bucket.acquire();
    order.push({ label, at: clock.now() });
  });

  await settle();
  assert.deepEqual(order.map((o) => o.label), ['a'], 'only the first proceeds immediately');

  await clock.advance(5000);
  await Promise.all(waiters);

  assert.deepEqual(order.map((o) => o.label), ['a', 'b', 'c'], 'FIFO order preserved');
  assert.deepEqual(order.map((o) => o.at), [0, 1000, 2000], 'one per second, not all at once');
});

test('buckets are per host — a slow host does not throttle a fast one', async () => {
  const clock = new FakeClock(0);
  const limiter = new RateLimiter({ clock });

  assert.equal(limiter.tryAcquire(ARXIV), true);
  assert.equal(limiter.tryAcquire(ARXIV), false, 'arXiv is now blocked');

  // Crossref should be entirely unaffected.
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.tryAcquire('https://api.crossref.org/works?query=robot'), true);
  }
});

test('unknown hosts get the strict default limit', async () => {
  const clock = new FakeClock(0);
  const limiter = new RateLimiter({ clock });
  const limit = limiter.limitFor('https://example.invalid/some/path');
  assert.deepEqual(limit, DEFAULT_HOST_LIMIT);
});

test('a malformed target is treated as a hostname rather than throwing', async () => {
  // §7: the limiter must never be the thing that fails a request.
  const clock = new FakeClock(0);
  const limiter = new RateLimiter({ clock });
  assert.equal(RateLimiter.hostOf('export.arxiv.org'), 'export.arxiv.org');
  assert.equal(RateLimiter.hostOf('not a url'), 'not a url');
  await limiter.acquire('not a url'); // must resolve, not throw
});

test('host matching ignores scheme, port, path and case', async () => {
  assert.equal(RateLimiter.hostOf('https://EXPORT.ArXiv.org:443/api/query?x=1'), 'export.arxiv.org');
});

test('snapshot reports live token counts per used host', async () => {
  const clock = new FakeClock(0);
  const limiter = new RateLimiter({ clock });
  limiter.tryAcquire(ARXIV);

  const snapshot = limiter.snapshot();
  assert.equal(snapshot['export.arxiv.org'].capacity, 1);
  assert.equal(snapshot['export.arxiv.org'].tokens, 0);
  assert.equal(snapshot['api.crossref.org'], undefined, 'unused hosts are absent');
});
