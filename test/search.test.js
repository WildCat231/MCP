/**
 * Phase 4: search_literature (CODEX_SPEC.md §5, §10.4).
 *
 * Driven by a stub fetch and a FakeClock, so window arithmetic is exact and
 * the widening ladder is observed rather than inferred.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { RateLimiter } from '../dist/ratelimit.js';
import {
  WINDOW_LADDER_MONTHS,
  anchoringWarning,
  deduplicate,
  normalizeTitle,
  searchLiterature,
  windowFor,
} from '../dist/search.js';

const NOW = Date.parse('2026-08-05T00:00:00Z');

/** Routes by hostname so one stub can serve all three sources. */
function router(handlers) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const host = new URL(url).hostname;
    const handler = handlers[host];
    if (handler === undefined) return new Response('{}', { status: 200 });
    const { status = 200, body = '{}' } = handler(url) ?? {};
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

const crossrefBody = (n, prefix = 'p') =>
  JSON.stringify({
    message: {
      'total-results': n,
      items: Array.from({ length: n }, (_, i) => ({
        DOI: `10.0/${prefix}${i}`,
        title: [`${prefix} paper ${i}`],
        type: 'journal-article',
        issued: { 'date-parts': [[2026, 6, 1]] },
        author: [],
      })),
    },
  });

const emptyArxiv = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';
const emptyPubmed = JSON.stringify({ esearchresult: { idlist: [], count: '0' } });

/**
 * A clock frozen at NOW whose sleeps resolve immediately, and a limiter with
 * effectively no limit.
 *
 * Throttling is covered in ratelimit.test.js; here it would only deadlock —
 * the arXiv bucket blocks for 3s between requests, and a FakeClock nobody
 * advances never delivers that sleep. Widening through four windows makes
 * twelve requests, so the real limits would dominate every assertion.
 */
const frozenClock = { now: () => NOW, sleep: async () => {} };

function deps(fetch) {
  return {
    fetch,
    limiter: new RateLimiter({
      clock: frozenClock,
      limits: {},
      fallback: { capacity: Number.MAX_SAFE_INTEGER, refillPerSecond: Number.MAX_SAFE_INTEGER },
    }),
    clock: frozenClock,
  };
}

// ---------------------------------------------------------------------------
// context anchoring
// ---------------------------------------------------------------------------

test('a single generic term warns rather than refusing', async () => {
  // §5: return a warning field. Not an error — the caller may know something
  // we do not, and refusing would substitute our judgement for Claude's (§2).
  const warning = anchoringWarning(['robotics']);
  assert.ok(warning);
  assert.match(warning, /generic/);
  assert.match(warning, /unrelated discipline/);
});

test('a single non-generic term still warns about missing context', async () => {
  // "Transformer" is the canonical case: a real term with a completely
  // different meaning in another field.
  const warning = anchoringWarning(['transformer']);
  assert.ok(warning);
  assert.match(warning, /nothing constrains the field context/);
});

test('multiple terms are anchored and produce no warning', async () => {
  assert.equal(anchoringWarning(['transformer', 'attention mechanism']), undefined);
  assert.equal(anchoringWarning(['surgical robotics', 'anastomosis']), undefined);
});

test('a multi-word single term counts as anchored', async () => {
  assert.equal(anchoringWarning(['smart tissue autonomous robot']), undefined);
});

test('empty terms are reported, not silently searched', async () => {
  assert.match(anchoringWarning([]), /No search terms/);
  assert.match(anchoringWarning(['  ']), /No search terms/);
});

test('an empty term list returns no results and says why', async () => {
  const result = await searchLiterature({ terms: ['   '] }, {}, deps(router({})));
  assert.deepEqual(result.results, []);
  assert.match(result.warning, /No search terms/);
});

// ---------------------------------------------------------------------------
// adaptive window
// ---------------------------------------------------------------------------

test('the ladder starts at 6 months and tops out at 60', async () => {
  assert.deepEqual([...WINDOW_LADDER_MONTHS], [6, 12, 24, 60]);
});

test('windowFor computes a window ending now', async () => {
  const window = windowFor(6, new Date(NOW));
  assert.equal(window.to, '2026-08-05');
  assert.equal(window.from, '2026-02-05');
});

test('an active field stops at the first window', async () => {
  // 25 results at 6 months means the field is busy; widening would bury it in
  // older work.
  const fetch = router({
    'api.crossref.org': () => ({ body: crossrefBody(25) }),
    'export.arxiv.org': () => ({ body: emptyArxiv }),
    'eutils.ncbi.nlm.nih.gov': () => ({ body: emptyPubmed }),
  });

  const result = await searchLiterature({ terms: ['surgical robotics', 'autonomy'] }, {}, deps(fetch));
  assert.equal(result.windows_tried.length, 1, 'no widening needed');
  assert.equal(result.windows_tried[0].months, 6);
  assert.equal(result.window_used.from, '2026-02-05');
  assert.equal(result.window_adaptive, true);
  assert.equal(result.counts_by_source.crossref, 25);
});

test('a quiet field widens through the whole ladder', async () => {
  // Railway signalling, not machine learning. §8 cold-field requirement: the
  // result must honestly report low activity, not fabricate significance.
  const fetch = router({
    'api.crossref.org': () => ({ body: crossrefBody(0) }),
    'export.arxiv.org': () => ({ body: emptyArxiv }),
    'eutils.ncbi.nlm.nih.gov': () => ({ body: emptyPubmed }),
  });

  const result = await searchLiterature({ terms: ['railway signalling', 'interlocking'] }, {}, deps(fetch));
  assert.deepEqual(result.windows_tried.map((w) => w.months), [6, 12, 24, 60]);
  assert.equal(result.window_used.from, '2021-08-05', 'ended at the 60-month ceiling');
  assert.deepEqual(result.results, []);
  assert.match(result.warning, /genuinely quiet/);
  assert.equal(result.errors, undefined, 'a quiet field is not a failing one');
});

test('window_used is always returned, so a trickle is distinguishable from a firehose', async () => {
  // The whole reason the field exists: 3 papers over 6 months and 3 papers
  // over 5 years are completely different claims about a field.
  const fetch = router({
    'api.crossref.org': () => ({ body: crossrefBody(3) }),
    'export.arxiv.org': () => ({ body: emptyArxiv }),
    'eutils.ncbi.nlm.nih.gov': () => ({ body: emptyPubmed }),
  });

  const result = await searchLiterature({ terms: ['a', 'b'] }, {}, deps(fetch));
  assert.ok(result.window_used.from);
  assert.ok(result.window_used.to);
  assert.equal(result.results.length, 3);
  assert.equal(result.window_used.from, '2021-08-05', 'widened all the way for only 3 results');
});

test('an explicit window is honoured and never widened', async () => {
  const fetch = router({
    'api.crossref.org': () => ({ body: crossrefBody(1) }),
    'export.arxiv.org': () => ({ body: emptyArxiv }),
    'eutils.ncbi.nlm.nih.gov': () => ({ body: emptyPubmed }),
  });

  const result = await searchLiterature(
    { terms: ['a', 'b'], from: '2015-01-01', to: '2016-01-01' },
    {},
    deps(fetch),
  );
  assert.equal(result.window_adaptive, false);
  assert.deepEqual(result.window_used, { from: '2015-01-01', to: '2016-01-01' });
  assert.equal(result.windows_tried.length, 1, 'the caller asked a specific question');
});

// ---------------------------------------------------------------------------
// deduplication
// ---------------------------------------------------------------------------

test('papers are deduplicated by DOI first', async () => {
  const { papers, removed } = deduplicate([
    { id: 'a', doi: '10.0/x', title: 'One title', authors: [], published: '2024', url: 'u', source: 'crossref', source_id: 'a' },
    { id: 'b', doi: '10.0/X', title: 'A completely different title', authors: [], published: '2024', url: 'u', source: 'pubmed', source_id: 'b' },
  ]);
  assert.equal(papers.length, 1, 'DOI match wins regardless of title');
  assert.equal(removed, 1);
});

test('papers without a DOI fall back to normalized title', async () => {
  // arXiv preprints often have no DOI, which is exactly when cross-source
  // duplicates appear.
  const { papers, removed } = deduplicate([
    { id: 'a', title: 'Supervised Autonomous Robotic Soft Tissue Surgery', authors: [], published: '2016', url: 'u', source: 'arxiv', source_id: 'a' },
    { id: 'b', title: 'supervised autonomous robotic soft-tissue surgery!', authors: [], published: '2016', url: 'u', source: 'crossref', source_id: 'b' },
  ]);
  assert.equal(papers.length, 1);
  assert.equal(removed, 1);
});

test('title normalization does not stem', async () => {
  // Two genuinely different papers can differ only in a word ending.
  assert.notEqual(normalizeTitle('robotic surgery'), normalizeTitle('robot surgery'));
  assert.equal(normalizeTitle('  A/B: Testing!  '), 'a b testing');
});

test('distinct papers survive deduplication', async () => {
  const { papers, removed } = deduplicate([
    { id: 'a', doi: '10.0/a', title: 'First', authors: [], published: '2024', url: 'u', source: 'crossref', source_id: 'a' },
    { id: 'b', doi: '10.0/b', title: 'Second', authors: [], published: '2024', url: 'u', source: 'crossref', source_id: 'b' },
  ]);
  assert.equal(papers.length, 2);
  assert.equal(removed, 0);
});

// ---------------------------------------------------------------------------
// failure handling — §7
// ---------------------------------------------------------------------------

test('a failing source is reported, never mistaken for an empty field', async () => {
  // The §7 requirement in its sharpest form: "Never return an empty section
  // that looks like 'nothing is happening in this field' when it actually
  // means 'the API timed out.'"
  const fetch = router({
    'api.crossref.org': () => ({ status: 503, body: 'unavailable' }),
    'export.arxiv.org': () => ({ body: emptyArxiv }),
    'eutils.ncbi.nlm.nih.gov': () => ({ body: emptyPubmed }),
  });

  const result = await searchLiterature({ terms: ['a', 'b'] }, {}, deps(fetch));
  assert.ok(result.errors, 'the failure must be surfaced');
  assert.ok(result.errors.crossref.includes('503'));
  assert.match(result.warning, /source\(s\) failed/);
  assert.match(result.warning, /lower bounds/, 'counts must not read as a measure of activity');
  assert.ok(!/genuinely quiet/.test(result.warning), 'a failed search is not a quiet field');
});

test('one source failing does not lose the others', async () => {
  const fetch = router({
    'api.crossref.org': () => ({ body: crossrefBody(4) }),
    'export.arxiv.org': () => ({ status: 500, body: 'boom' }),
    'eutils.ncbi.nlm.nih.gov': () => ({ body: emptyPubmed }),
  });

  const result = await searchLiterature({ terms: ['a', 'b'] }, {}, deps(fetch));
  assert.equal(result.results.length, 4, 'Crossref results survive arXiv failing');
  assert.ok(result.errors.arxiv);
  assert.equal(result.errors.crossref, undefined);
});

test('a connection failure is classified, not thrown', async () => {
  const fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  };
  const result = await searchLiterature({ terms: ['a', 'b'] }, {}, deps(fetch));
  assert.deepEqual(result.results, []);
  assert.ok(result.errors, 'every source failed and every failure is named');
  assert.equal(Object.keys(result.errors).length, 3);
});

// ---------------------------------------------------------------------------
// source selection and ordering
// ---------------------------------------------------------------------------

test('only the requested sources are queried', async () => {
  const fetch = router({ 'api.crossref.org': () => ({ body: crossrefBody(25) }) });
  const result = await searchLiterature({ terms: ['a', 'b'], sources: ['crossref'] }, {}, deps(fetch));

  assert.deepEqual(Object.keys(result.counts_by_source), ['crossref']);
  assert.ok(fetch.calls.every((u) => u.includes('crossref.org')), 'no other host contacted');
});

test('results come back newest first', async () => {
  const body = JSON.stringify({
    message: {
      items: [
        { DOI: '10.0/old', title: ['Older'], type: 'journal-article', issued: { 'date-parts': [[2026, 3, 1]] }, author: [] },
        { DOI: '10.0/new', title: ['Newer'], type: 'journal-article', issued: { 'date-parts': [[2026, 7, 1]] }, author: [] },
      ],
    },
  });
  const fetch = router({ 'api.crossref.org': () => ({ body }) });
  const result = await searchLiterature({ terms: ['a', 'b'], sources: ['crossref'] }, {}, deps(fetch));

  assert.deepEqual(result.results.map((p) => p.title), ['Newer', 'Older']);
});
