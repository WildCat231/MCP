/**
 * Phase 5: check_registry (CODEX_SPEC.md §5, §10.5).
 *
 * The truncation tests are the important ones. Everything else here is
 * plumbing; truncation is the failure that already happened once in this
 * project, silently, and produced a wrong date in the golden set.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { clearCredentialRejections } from '../dist/credentials.js';
import { RateLimiter } from '../dist/ratelimit.js';
import { checkRegistry } from '../dist/registries.js';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(fixturesDir, `${name}.json`), 'utf8');

const frozenClock = { now: () => Date.parse('2026-08-05T00:00:00Z'), sleep: async () => {} };

function deps(handlers) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    for (const [pattern, respond] of Object.entries(handlers)) {
      if (url.includes(pattern)) {
        const { status = 200, body = '{}' } = respond(url) ?? {};
        return new Response(body, { status, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('{}', { status: 200 });
  };
  fetch.calls = calls;
  return {
    fetch,
    limiter: new RateLimiter({
      clock: frozenClock,
      limits: {},
      fallback: { capacity: Number.MAX_SAFE_INTEGER, refillPerSecond: Number.MAX_SAFE_INTEGER },
    }),
  };
}

// ---------------------------------------------------------------------------
// truncation — the failure that already happened
// ---------------------------------------------------------------------------

test('a truncated result set is flagged and refuses to support ordering claims', async () => {
  // Real numbers from the da Vinci recording: 115 matches, 25 returned, in
  // openFDA's default unspecified order, with the oldest record absent.
  // Reading "earliest clearance" off that page gave 2001-03-02 when the true
  // answer is unknown.
  const d = deps({
    '510k.json': () => ({ body: fixture('openfda-davinci-510k') }),
    'pma.json': () => ({ status: 404, body: fixture('openfda-davinci-pma') }),
  });

  const result = await checkRegistry({ registry: 'openfda_device', query: 'DA VINCI' }, {}, d);

  assert.equal(result.truncated, true);
  assert.equal(result.returned, 25);
  assert.equal(result.total_matches, 115);
  assert.match(result.warning, /Truncated: 25 of 115/);
  assert.match(result.warning, /does NOT establish which is earliest/);
  assert.match(result.warning, /unspecified/, 'the ordering caveat must be explicit');
  assert.match(result.warning, /Re-query with an explicit sort/);
});

test('a complete result set is not flagged', async () => {
  // ROBODOC: 2 of 2. Here an ordering claim IS supportable.
  const d = deps({
    '510k.json': () => ({ body: fixture('openfda-robodoc-510k') }),
    'pma.json': () => ({ status: 404, body: fixture('openfda-robodoc-pma') }),
  });

  const result = await checkRegistry({ registry: 'openfda_device', query: 'ROBODOC' }, {}, d);
  assert.equal(result.truncated, false);
  assert.equal(result.returned, 2);
  assert.equal(result.total_matches, 2);
  assert.ok(!/Truncated/.test(result.warning ?? ''));
});

test('a sorted truncated set says so, and drops the re-query advice', async () => {
  const d = deps({
    '510k.json': () => ({ body: fixture('openfda-davinci-510k') }),
    'pma.json': () => ({ status: 404, body: fixture('openfda-davinci-pma') }),
  });

  const result = await checkRegistry(
    { registry: 'openfda_device', query: 'DA VINCI', sort: 'decision_date:asc' },
    {},
    d,
  );
  assert.match(result.warning, /\(sorted\)/);
  assert.ok(!/Re-query with an explicit sort/.test(result.warning));
  assert.ok(d.fetch.calls.some((u) => u.includes('sort=decision_date')));
});

// ---------------------------------------------------------------------------
// openFDA queries both databases
// ---------------------------------------------------------------------------

test('openFDA is queried on both endpoints, and the finding is stated', async () => {
  // The clearance/approval distinction is invisible if the caller has to know
  // which database to ask. Both, always.
  const d = deps({
    '510k.json': () => ({ body: fixture('openfda-robodoc-510k') }),
    'pma.json': () => ({ status: 404, body: fixture('openfda-robodoc-pma') }),
  });

  const result = await checkRegistry({ registry: 'openfda_device', query: 'ROBODOC' }, {}, d);

  assert.ok(d.fetch.calls.some((u) => u.includes('510k.json')));
  assert.ok(d.fetch.calls.some((u) => u.includes('pma.json')));
  assert.equal(result.registry_url.length, 2);

  assert.match(result.warning, /CLEARED, not APPROVED/);

  const bySource = Object.fromEntries(result.breakdown.map((b) => [b.source, b]));
  assert.equal(bySource['510k'].returned, 2);
  assert.equal(bySource.pma.returned, 0);
});

test('a failed sub-query is never reported as an absence', async () => {
  // §7 in its most consequential form here: "ROBODOC has no PMA" and "the PMA
  // query timed out" must never look alike, because the first is a finding.
  const d = deps({
    '510k.json': () => ({ body: fixture('openfda-robodoc-510k') }),
    'pma.json': () => ({ status: 503, body: 'upstream down' }),
  });

  const result = await checkRegistry({ registry: 'openfda_device', query: 'ROBODOC' }, {}, d);

  assert.match(result.warning, /pma query failed/i);
  assert.match(result.warning, /NOT evidence of absence/);
  assert.ok(!/CLEARED, not APPROVED/.test(result.warning), 'no verdict may be drawn from a failed query');

  const pma = result.breakdown.find((b) => b.source === 'pma');
  assert.ok(pma.error.includes('503'));
});

test('an exact K number is resolved as an identifier, not a search', async () => {
  const d = deps({ '510k.json': () => ({ body: fixture('openfda-k931783') }) });
  const result = await checkRegistry({ registry: 'openfda_device', query: 'K931783' }, {}, d);

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].submission_number, 'K931783');
  assert.equal(result.records[0].decision_date, '1993-11-22');
  assert.equal(result.truncated, false);
  assert.ok(!d.fetch.calls.some((u) => u.includes('pma.json')), 'a K number is a 510(k) identifier');
});

// ---------------------------------------------------------------------------
// wikipedia
// ---------------------------------------------------------------------------

test('a disambiguation page yields no records and offers candidates instead', async () => {
  // "Robodoc" returns HTTP 200 and is a disambiguation page. Zero records is
  // correct; guessing another casing is not.
  const d = deps({
    '/page/summary/': () => ({ body: fixture('wikipedia-robodoc') }),
    '/w/api.php': () => ({ body: fixture('wikipedia-robodoc-search') }),
  });

  const result = await checkRegistry({ registry: 'wikipedia', query: 'Robodoc' }, {}, d);

  assert.deepEqual(result.records, []);
  assert.deepEqual(result.candidates, ['Robotic surgery']);
  assert.match(result.warning, /disambiguation/);
  assert.match(result.warning, /Robotic surgery/);
  assert.match(result.warning, /finding about tertiary coverage/);
});

test('a resolved Wikipedia article still warns that it corroborates nothing', async () => {
  const body = JSON.stringify({
    type: 'standard',
    pageid: 42,
    title: 'Robotic surgery',
    titles: { canonical: 'Robotic surgery' },
    extract: 'Robotic surgery uses robotic systems.',
    timestamp: '2026-01-02T00:00:00Z',
  });
  const d = deps({ '/page/summary/': () => ({ body }) });

  const result = await checkRegistry({ registry: 'wikipedia', query: 'Robotic surgery' }, {}, d);
  assert.equal(result.records.length, 1);
  assert.match(result.warning, /tertiary source/);
  assert.match(result.warning, /never sufficient to corroborate on its own/);
});

// ---------------------------------------------------------------------------
// crossref and patentsview
// ---------------------------------------------------------------------------

test('a DOI is looked up directly rather than searched', async () => {
  const d = deps({ '/works/': () => ({ body: fixture('crossref-star-2016') }) });
  const result = await checkRegistry(
    { registry: 'crossref', query: '10.1126/scitranslmed.aad9398' },
    {},
    d,
  );

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].doi, '10.1126/scitranslmed.aad9398');
  assert.equal(result.truncated, false);
  assert.ok(d.fetch.calls[0].includes('works/10.1126'), 'resolved by identifier');
});

test('a DOI URL is accepted as well as a bare DOI', async () => {
  const d = deps({ '/works/': () => ({ body: fixture('crossref-star-2016') }) });
  const result = await checkRegistry(
    { registry: 'crossref', query: 'https://doi.org/10.1126/scitranslmed.aad9398' },
    {},
    d,
  );
  assert.equal(result.records.length, 1);
});

test('patentsview degrades to a skip without failing the lookup', async () => {
  clearCredentialRejections();
  const previous = process.env.PATENTSVIEW_API_KEY;
  delete process.env.PATENTSVIEW_API_KEY;
  try {
    const d = deps({ 'patentsview.org': () => ({ status: 401, body: '{"error":"API key required"}' }) });
    const result = await checkRegistry({ registry: 'patentsview', query: 'surgical robot' }, {}, d);

    assert.deepEqual(result.records, []);
    assert.equal(result.error, undefined, 'a credential gap is not a lookup failure');
    assert.equal(result.availability.available, false);
    assert.match(result.warning, /PATENTSVIEW_API_KEY/);
  } finally {
    if (previous !== undefined) process.env.PATENTSVIEW_API_KEY = previous;
    clearCredentialRejections();
  }
});

// ---------------------------------------------------------------------------
// general contract
// ---------------------------------------------------------------------------

test('an empty query is rejected without a network call', async () => {
  const d = deps({});
  const result = await checkRegistry({ registry: 'openfda_device', query: '   ' }, {}, d);
  assert.equal(result.error, 'Empty query.');
  assert.equal(d.fetch.calls.length, 0);
});

test('every registry returns the same envelope shape', async () => {
  // A caller should not need per-registry branching to read a result.
  const d = deps({
    '510k.json': () => ({ status: 404, body: '{"error":{"code":"NOT_FOUND"}}' }),
    'pma.json': () => ({ status: 404, body: '{"error":{"code":"NOT_FOUND"}}' }),
    'crossref.org': () => ({ body: '{"message":{"items":[],"total-results":0}}' }),
    'wikipedia.org': () => ({ status: 404, body: '{}' }),
    'patentsview.org': () => ({ body: '{"patents":[],"total_hits":0}' }),
  });

  for (const registry of ['openfda_device', 'crossref', 'wikipedia', 'patentsview']) {
    const result = await checkRegistry({ registry, query: 'nothing at all' }, {}, d);
    assert.equal(result.registry, registry);
    assert.ok(Array.isArray(result.records), `${registry}: records must be an array`);
    assert.ok(Array.isArray(result.registry_url), `${registry}: registry_url must be an array`);
    assert.equal(typeof result.returned, 'number');
    assert.equal(typeof result.truncated, 'boolean');
    assert.equal(result.returned, result.records.length);
  }
});
