/**
 * Snapshot integrity (CODEX_SPEC.md §4).
 *
 * The point of these tests is the contrast with cache.test.js: identical
 * on-disk corruption that a cache read reports as a plain `miss` must be a
 * loud, named failure here.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Cache } from '../dist/cache.js';
import { FakeClock } from '../dist/clock.js';
import { SnapshotIntegrityError, SnapshotStore, snapshotId } from '../dist/snapshot.js';

const payload = (overrides = {}) => ({
  query: 'surgical robotics',
  tool_version: '0.1.0',
  components: [{ id: 'c1', name: 'manipulators' }],
  claims: [
    {
      id: 'claim-1',
      entity: 'AESOP',
      event_type: 'regulatory_clearance',
      date: '1994-03-01',
      date_precision: 'day',
      description: 'AESOP received FDA 510(k) clearance.',
    },
  ],
  verifications: [],
  frontier: [],
  ...overrides,
});

async function withStore(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'frontier-snap-'));
  try {
    let tick = 0;
    const store = new SnapshotStore({
      home,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    });
    return await fn({ store, home });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

test('a saved snapshot round-trips and verifies', async () => {
  await withStore(async ({ store }) => {
    const { id, snapshot } = await store.save(payload());
    assert.match(id, /^[0-9a-f]{64}$/);

    const read = await store.read(id);
    assert.equal(read.ok, true);
    assert.equal(read.verified, true);
    assert.deepEqual(read.snapshot, snapshot);
  });
});

test('the id is the content address, and the caller cannot assert one', async () => {
  await withStore(async ({ store }) => {
    // A supplied id is ignored: the address is derived from the content.
    const { id, snapshot } = await store.save({ ...payload(), id: 'i-decree-this-id' });
    assert.notEqual(id, 'i-decree-this-id');

    const { id: _drop, ...rest } = snapshot;
    assert.equal(snapshotId(rest), id, 'stored id must equal the hash of the rest');
  });
});

test('different content produces a different address', async () => {
  await withStore(async ({ store }) => {
    const a = await store.save(payload());
    const b = await store.save(payload({ query: 'solid-state batteries' }));
    assert.notEqual(a.id, b.id);
  });
});

test('created_at is part of the address', async () => {
  // Two runs finding the same thing on different days are different citable
  // artifacts, because the date is part of what is being cited.
  await withStore(async ({ store }) => {
    const first = await store.save(payload());
    const second = await store.save(payload());
    assert.notEqual(first.id, second.id, 'the injected clock advances between saves');
  });
});

test('a tampered snapshot fails the checksum instead of loading', async () => {
  await withStore(async ({ store }) => {
    const { id, path: file } = await store.save(payload());

    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
    onDisk.claims[0].date = '1993-01-01'; // the kind of edit that matters
    await fs.writeFile(file, JSON.stringify(onDisk, null, 2));

    const read = await store.read(id);
    assert.equal(read.ok, false);
    assert.equal(read.failure.reason, 'checksum_mismatch');
    assert.equal(read.failure.expected_id, id);
    assert.notEqual(read.failure.computed_id, id);
    assert.match(read.failure.detail, /must not be cited/);
  });
});

test('a truncated snapshot is unreadable, never a partial result', async () => {
  await withStore(async ({ store }) => {
    const { id, path: file } = await store.save(payload());
    const text = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, text.slice(0, Math.floor(text.length / 2)));

    const read = await store.read(id);
    assert.equal(read.ok, false);
    assert.equal(read.failure.reason, 'unreadable');
  });
});

test('a snapshot renamed on disk is reported as misfiled', async () => {
  await withStore(async ({ store }) => {
    const { id, path: file, snapshot } = await store.save(payload());
    const wrongName = path.join(path.dirname(file), 'a'.repeat(64) + '.json');
    await fs.rename(file, wrongName);

    const read = await store.read('a'.repeat(64));
    assert.equal(read.ok, false);
    assert.equal(read.failure.reason, 'misfiled');
    assert.equal(read.failure.expected_id, snapshot.id);
    assert.equal(id, snapshot.id);
  });
});

test('a missing snapshot is not_found — distinct from corrupt', async () => {
  await withStore(async ({ store }) => {
    const read = await store.read('b'.repeat(64));
    assert.equal(read.ok, false);
    assert.equal(read.failure.reason, 'not_found');
  });
});

test('load throws on any integrity failure', async () => {
  await withStore(async ({ store }) => {
    const { id, path: file } = await store.save(payload());
    await fs.writeFile(file, '{"id":"x"}');

    await assert.rejects(() => store.load(id), (err) => {
      assert.ok(err instanceof SnapshotIntegrityError);
      assert.equal(err.reason, 'malformed');
      return true;
    });
  });
});

test('cache reads and snapshot reads treat identical corruption differently', async () => {
  // This is the semantic distinction stated in snapshot.ts, asserted directly:
  // the same byte-level damage is a shrug in one store and an alarm in the other.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'frontier-contrast-'));
  try {
    const cache = await Cache.open({ home, clock: new FakeClock(0) });
    await cache.set('registry', 'check_registry', { q: 'AESOP' }, { records: [] });

    const store = new SnapshotStore({ home });
    const { id, path: snapFile } = await store.save(payload());

    // Corrupt both, identically.
    const { requestKey } = await import('../dist/hash.js');
    const key = requestKey('check_registry', { q: 'AESOP' });
    const cacheFile = path.join(home, 'cache', 'registry', key.slice(0, 2), `${key}.json`);
    for (const file of [cacheFile, snapFile]) await fs.writeFile(file, '{ truncated');

    const cacheRead = await cache.get('registry', 'check_registry', { q: 'AESOP' });
    assert.equal(cacheRead.outcome, 'miss', 'cache: disposable, so a miss');

    const snapshotRead = await store.read(id);
    assert.equal(snapshotRead.ok, false, 'snapshot: citable, so a failure');
    assert.equal(snapshotRead.failure.reason, 'unreadable');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('list verifies every entry and surfaces the bad ones instead of hiding them', async () => {
  await withStore(async ({ store }) => {
    const good = await store.save(payload());
    const bad = await store.save(payload({ query: 'railway signalling' }));
    await fs.writeFile(bad.path, '{"id":"nope"}');

    const { snapshots, unreadable } = await store.list();
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].id, good.id);
    assert.equal(snapshots[0].verified, true);
    assert.equal(snapshots[0].counts.claims, 1);

    assert.equal(unreadable.length, 1, 'a corrupt snapshot is reported, not omitted');
    assert.equal(unreadable[0].reason, 'malformed');
  });
});

test('list filters by query and returns newest first', async () => {
  await withStore(async ({ store }) => {
    await store.save(payload({ query: 'surgical robotics' }));
    await store.save(payload({ query: 'solid-state batteries' }));
    const newest = await store.save(payload({ query: 'surgical robotics again' }));

    const all = await store.list();
    assert.equal(all.snapshots.length, 3);
    assert.equal(all.snapshots[0].id, newest.id, 'newest first');

    const filtered = await store.list('surgical');
    assert.deepEqual(filtered.snapshots.map((s) => s.query).sort(), [
      'surgical robotics',
      'surgical robotics again',
    ]);
  });
});

test('verifyAll re-checks the whole store', async () => {
  await withStore(async ({ store }) => {
    await store.save(payload());
    const bad = await store.save(payload({ query: 'other' }));
    await fs.writeFile(bad.path, 'not json at all');

    const report = await store.verifyAll();
    assert.equal(report.checked, 2);
    assert.equal(report.verified, 1);
    assert.equal(report.failures.length, 1);
  });
});
