/**
 * Phase 2: cache layer with TTLs (CODEX_SPEC.md §7).
 *
 * Every test drives a FakeClock, so TTL behaviour is asserted without the
 * suite waiting and without the result depending on machine load. All state
 * goes to a temp FRONTIER_HOME — never the real user cache.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Cache, CACHE_TTL_MS } from '../dist/cache.js';
import { FakeClock } from '../dist/clock.js';
import { requestKey } from '../dist/hash.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

async function withCache(fn, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'frontier-cache-'));
  const clock = new FakeClock(options.start ?? Date.parse('2026-01-01T00:00:00Z'));
  try {
    const cache = await Cache.open({ home, clock, ...(options.ttl ? { ttl: options.ttl } : {}) });
    return await fn({ cache, clock, home });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

test('a value survives a round trip and reports as fresh', async () => {
  await withCache(async ({ cache }) => {
    const request = { registry: 'openfda_device', query: 'AESOP' };
    assert.equal((await cache.get('registry', 'check_registry', request)).outcome, 'miss');

    await cache.set('registry', 'check_registry', request, { records: [1, 2, 3] });

    const hit = await cache.get('registry', 'check_registry', request);
    assert.equal(hit.outcome, 'fresh');
    assert.deepEqual(hit.value, { records: [1, 2, 3] });
    assert.equal(hit.age_ms, 0);
  });
});

test('keys normalize over property order, so equal requests share an entry', async () => {
  // Two requests built by different code paths must hit the same entry, or the
  // cache silently never hits. §7: "keyed on the normalized request".
  assert.equal(
    requestKey('check_registry', { a: 1, b: { c: 2, d: 3 } }),
    requestKey('check_registry', { b: { d: 3, c: 2 }, a: 1 }),
  );
  // An absent property and an explicitly-undefined one are the same request.
  assert.equal(requestKey('t', { a: 1 }), requestKey('t', { a: 1, b: undefined }));
  // The tool name is part of the key, so structurally identical arguments to
  // different tools cannot collide.
  assert.notEqual(requestKey('check_registry', { q: 1 }), requestKey('search_literature', { q: 1 }));

  await withCache(async ({ cache }) => {
    await cache.set('literature', 'search_literature', { terms: ['a'], max: 5 }, 'stored');
    const hit = await cache.get('literature', 'search_literature', { max: 5, terms: ['a'] });
    assert.equal(hit.outcome, 'fresh');
    assert.equal(hit.value, 'stored');
  });
});

test('array order still matters', async () => {
  // Key order is not meaningful; element order is. Collapsing them would make
  // two genuinely different literature queries share a cache entry.
  assert.notEqual(requestKey('t', { terms: ['a', 'b'] }), requestKey('t', { terms: ['b', 'a'] }));
});

test('entries expire at their namespace TTL, not before', async () => {
  await withCache(async ({ cache, clock }) => {
    await cache.set('literature', 'search_literature', { q: 1 }, 'v');

    await clock.advance(CACHE_TTL_MS.literature - 1);
    assert.equal((await cache.get('literature', 'search_literature', { q: 1 })).outcome, 'fresh');

    await clock.advance(1);
    assert.equal((await cache.get('literature', 'search_literature', { q: 1 })).outcome, 'stale');
  });
});

test('the three namespaces carry the TTLs the spec sets', async () => {
  await withCache(async ({ cache }) => {
    assert.equal(cache.ttlFor('registry'), 30 * DAY);
    assert.equal(cache.ttlFor('literature'), 24 * HOUR);
    assert.equal(cache.ttlFor('verification'), 7 * DAY);
  });
});

test('expired entries are retained and served as stale, for offline mode', async () => {
  // §7: "if all network calls fail, serve from cache and mark results stale".
  // That is only possible if expiry does not delete.
  await withCache(async ({ cache, clock }) => {
    await cache.set('registry', 'check_registry', { q: 'ROBODOC' }, { records: ['pma'] });
    await clock.advance(60 * DAY);

    const stale = await cache.get('registry', 'check_registry', { q: 'ROBODOC' });
    assert.equal(stale.outcome, 'stale');
    assert.deepEqual(stale.value, { records: ['pma'] }, 'stale entries must still carry their value');
    assert.equal(stale.age_ms, 60 * DAY);
  });
});

test('prune deletes expired entries and keeps fresh ones', async () => {
  await withCache(async ({ cache, clock }) => {
    await cache.set('literature', 'search_literature', { q: 'old' }, 1);
    await clock.advance(2 * DAY);
    await cache.set('literature', 'search_literature', { q: 'new' }, 2);

    assert.equal(await cache.prune(), 1);
    assert.equal((await cache.get('literature', 'search_literature', { q: 'old' })).outcome, 'miss');
    assert.equal((await cache.get('literature', 'search_literature', { q: 'new' })).outcome, 'fresh');
  });
});

test('a corrupt entry reads as a miss instead of throwing', async () => {
  // A cache is disposable; a truncated file must not take down a tool call.
  await withCache(async ({ cache, home }) => {
    const request = { q: 'x' };
    await cache.set('registry', 'check_registry', request, 'v');

    const key = requestKey('check_registry', request);
    const file = path.join(home, 'cache', 'registry', key.slice(0, 2), `${key}.json`);
    await fs.writeFile(file, '{ this is not json');

    const lookup = await cache.get('registry', 'check_registry', request);
    assert.equal(lookup.outcome, 'miss');
    assert.equal(lookup.corrupt, true);
  });
});

test('clear removes one namespace or everything', async () => {
  await withCache(async ({ cache }) => {
    await cache.set('registry', 'check_registry', { q: 1 }, 'a');
    await cache.set('literature', 'search_literature', { q: 2 }, 'b');
    await cache.set('verification', 'verify_claim', { q: 3 }, 'c');

    assert.equal(await cache.clear('literature'), 1);
    assert.equal((await cache.get('literature', 'search_literature', { q: 2 })).outcome, 'miss');
    assert.equal((await cache.get('registry', 'check_registry', { q: 1 })).outcome, 'fresh');

    assert.equal(await cache.clear(), 2);
    assert.equal((await cache.get('verification', 'verify_claim', { q: 3 })).outcome, 'miss');
  });
});

test('status reports counts, freshness, age distribution and per-tool hit rate', async () => {
  await withCache(async ({ cache, clock }) => {
    await cache.set('registry', 'check_registry', { q: 1 }, 'a');
    await cache.set('literature', 'search_literature', { q: 2 }, 'b');

    await clock.advance(2 * DAY); // literature expired, registry still fresh

    await cache.get('registry', 'check_registry', { q: 1 }); // hit
    await cache.get('registry', 'check_registry', { q: 9 }); // miss
    await cache.get('literature', 'search_literature', { q: 2 }); // stale hit

    const status = await cache.status();
    assert.equal(status.total_entries, 2);
    assert.equal(status.fresh_entries, 1);
    assert.equal(status.stale_entries, 1);
    assert.equal(status.entries_by_namespace.registry, 1);
    assert.equal(status.entries_by_namespace.literature, 1);
    assert.equal(status.corrupt_entries, 0);

    const under7d = status.age_distribution.find((b) => b.bucket === 'under_7d');
    assert.equal(under7d.count, 2, 'both entries are 2 days old');

    const registryStats = status.hit_rate_by_tool.check_registry;
    assert.equal(registryStats.hits, 1);
    assert.equal(registryStats.misses, 1);
    assert.equal(registryStats.writes, 1);
    assert.equal(registryStats.hit_rate, 0.5);

    const literatureStats = status.hit_rate_by_tool.search_literature;
    assert.equal(literatureStats.stale_hits, 1);
    assert.equal(literatureStats.hits, 0, 'a stale read is not a hit');
  });
});

test('hit-rate counters persist across a reopen', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'frontier-cache-'));
  try {
    const clock = new FakeClock(0);
    const first = await Cache.open({ home, clock });
    await first.set('registry', 'check_registry', { q: 1 }, 'a');
    await first.get('registry', 'check_registry', { q: 1 });

    const second = await Cache.open({ home, clock });
    const status = await second.status();
    assert.equal(status.hit_rate_by_tool.check_registry.hits, 1);
    assert.equal(status.hit_rate_by_tool.check_registry.writes, 1);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('a tool with no lookups has a null hit rate, not zero', async () => {
  // 0% would read as "this tool always misses", which is a different claim.
  await withCache(async ({ cache }) => {
    await cache.set('registry', 'check_registry', { q: 1 }, 'a');
    const status = await cache.status();
    assert.equal(status.hit_rate_by_tool.check_registry.hit_rate, null);
  });
});

test('writes are atomic — no partial file is ever visible', async () => {
  await withCache(async ({ cache, home }) => {
    await cache.set('registry', 'check_registry', { q: 1 }, { big: 'x'.repeat(100_000) });

    const namespaceDir = path.join(home, 'cache', 'registry');
    const shards = await fs.readdir(namespaceDir);
    const files = await fs.readdir(path.join(namespaceDir, shards[0]));
    assert.equal(files.length, 1, 'no temp file should be left behind');
    assert.ok(files[0].endsWith('.json'));

    const parsed = JSON.parse(await fs.readFile(path.join(namespaceDir, shards[0], files[0]), 'utf8'));
    assert.equal(parsed.value.big.length, 100_000);
  });
});
