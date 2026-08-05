/**
 * Phase 3 source adapters (CODEX_SPEC.md §10.3).
 *
 * ## What these tests do and do not establish
 *
 * The adapters were written from each API's published schema but could not be
 * checked against a live response, because every upstream host is blocked by
 * this environment's egress policy (see README, "Unverified assumptions").
 *
 * So the tests below fall into two groups, and the distinction is load-bearing:
 *
 *   - **Logic tests** feed synthetic payloads shaped the way the documentation
 *     describes. They prove the adapter does the right thing *given* that
 *     shape — a PMA supplement is never reported as an original approval, a
 *     404 is an empty answer rather than a fault. They prove nothing about
 *     whether the field names are correct.
 *
 *   - **Fixture tests** replay real recorded responses and are the only thing
 *     that can confirm the field names. They skip, loudly, until someone runs
 *     `npm run record-fixtures` from a network-capable machine. Phase 3 is not
 *     finished until they run.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FakeClock } from '../dist/clock.js';
import { httpGet } from '../dist/http.js';
import { RateLimiter } from '../dist/ratelimit.js';
import { registryEventType } from '../dist/registry.js';
import { arxivIdFromUrl, buildArxivQuery, parseArxivAtom } from '../dist/sources/arxiv.js';
import { crossrefSearchUrl, parseCrossrefSearch, parseCrossrefWork } from '../dist/sources/crossref.js';
import { isOriginalPma, parse510k, parsePma, searchClearances } from '../dist/sources/openfda.js';
import { buildPubmedTerm, parseESearch, parseESummary } from '../dist/sources/pubmed.js';
import { parseSummary } from '../dist/sources/wikipedia.js';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Fixtures are stored under the extension matching their payload — arXiv's
 * Atom feed is `.xml`, everything else `.json` — so look for either.
 */
function fixture(name) {
  for (const ext of ['json', 'xml']) {
    const file = path.join(fixturesDir, `${name}.${ext}`);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  return undefined;
}

/** Skip with an explanation rather than silently passing on missing fixtures. */
function needsFixture(name, t) {
  const raw = fixture(name);
  if (raw === undefined) {
    t.skip(`fixture "${name}" not recorded — run: npm run record-fixtures -- --only=${name}`);
    return undefined;
  }
  return raw;
}

const stubFetch = (status, body, contentType = 'application/json') => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { 'content-type': contentType } });
  };
  fn.calls = calls;
  return fn;
};

// ---------------------------------------------------------------------------
// http layer
// ---------------------------------------------------------------------------

test('httpGet classifies failures instead of throwing', async () => {
  const limiter = new RateLimiter({ clock: new FakeClock(0) });

  const notFound = await httpGet('https://api.crossref.org/x', {}, { fetch: stubFetch(404, 'nope'), limiter });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.kind, 'http');
  assert.equal(notFound.status, 404);

  // 401 and 403 are kept apart: only the first proves a credential is needed.
  const unauthenticated = await httpGet('https://api.crossref.org/x', {}, { fetch: stubFetch(401, ''), limiter });
  assert.equal(unauthenticated.kind, 'unauthenticated');

  const forbidden = await httpGet('https://api.crossref.org/x', {}, { fetch: stubFetch(403, ''), limiter });
  assert.equal(forbidden.kind, 'forbidden', 'a 403 can be a quota or IP block, not a missing key');

  const exploded = await httpGet(
    'https://api.crossref.org/x',
    {},
    {
      fetch: async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
      limiter,
    },
  );
  assert.equal(exploded.ok, false);
  assert.equal(exploded.kind, 'network');
  assert.match(exploded.error, /ENOTFOUND/);
});

test('httpGet truncates long error bodies', async () => {
  const limiter = new RateLimiter({ clock: new FakeClock(0) });
  const result = await httpGet('https://api.crossref.org/x', {}, { fetch: stubFetch(500, 'x'.repeat(50_000)), limiter });
  assert.ok(result.error.length < 500, 'an HTML error page must not flood the model context');
});

test('httpGet sends a descriptive User-Agent', async () => {
  // arXiv and Wikimedia both throttle generic agents.
  const limiter = new RateLimiter({ clock: new FakeClock(0) });
  const fetch = stubFetch(200, '{}');
  await httpGet('https://api.crossref.org/x', {}, { fetch, limiter });
  assert.match(fetch.calls[0].init.headers['User-Agent'], /frontier-mcp/);
});

// ---------------------------------------------------------------------------
// openFDA — the clearance/approval distinction
// ---------------------------------------------------------------------------

test('510(k) rows become clearances and PMA rows become approvals', async () => {
  const clearances = parse510k({
    meta: { results: { total: 1 } },
    results: [{ k_number: 'K931861', device_name: 'AESOP', applicant: 'COMPUTER MOTION INC', decision_date: '1994-03-01', date_received: '1993-06-15' }],
  });
  assert.equal(clearances.records.length, 1);
  assert.equal(clearances.records[0].submission_type, '510k');
  assert.equal(registryEventType(clearances.records[0]).event_type, 'regulatory_clearance');

  const approvals = parsePma({
    results: [{ pma_number: 'P050041', trade_name: 'ROBODOC', decision_date: '2008-08-08' }],
  });
  assert.equal(approvals.records[0].submission_type, 'pma_original');
  assert.equal(registryEventType(approvals.records[0]).event_type, 'regulatory_approval');
});

test('both openFDA date fields survive normalization', async () => {
  // The received/decision gap is evidence, not noise — see registry.ts.
  const { records } = parse510k({
    results: [{ k_number: 'K931861', device_name: 'AESOP', decision_date: '19940301', date_received: '19930615' }],
  });
  assert.equal(records[0].decision_date, '1994-03-01', 'compact openFDA dates parse');
  assert.equal(records[0].received_date, '1993-06-15');
  assert.equal(records[0].date, records[0].decision_date);
});

test('a PMA supplement is never reported as an original approval', async () => {
  assert.equal(isOriginalPma(undefined), true);
  assert.equal(isOriginalPma(''), true);
  assert.equal(isOriginalPma('000'), true);
  assert.equal(isOriginalPma('S000'), true);
  assert.equal(isOriginalPma('S012'), false);

  const { records } = parsePma({
    results: [{ pma_number: 'P000001', supplement_number: 'S012', trade_name: 'da Vinci', decision_date: '2005-01-01' }],
  });
  assert.equal(records[0].submission_type, 'pma_supplement');
  assert.equal(records[0].submission_number, 'P000001/S012');
  assert.match(registryEventType(records[0]).reason, /not a first approval/);
});

test('openFDA NOT_FOUND is an empty answer, not an error', async () => {
  // §7: an empty result that means "nothing here" must be distinguishable from
  // one that means "we could not look".
  const parsed = parse510k({ error: { code: 'NOT_FOUND', message: 'No matches found!' } });
  assert.deepEqual(parsed.records, []);
  assert.equal(parsed.total, 0);
  assert.equal(parsed.error, undefined);

  const broken = parse510k({ error: { code: 'SERVER_ERROR', message: 'boom' } });
  assert.equal(broken.error, 'boom');

  const viaHttp = await searchClearances(
    { query: 'zzz' },
    {},
    { fetch: stubFetch(404, '{"error":{"code":"NOT_FOUND"}}'), limiter: new RateLimiter({ clock: new FakeClock(0) }) },
  );
  assert.deepEqual(viaHttp.records, []);
  assert.equal(viaHttp.error, undefined, 'a 404 from openFDA means zero matches');
});

// ---------------------------------------------------------------------------
// literature adapters
// ---------------------------------------------------------------------------

test('arXiv queries are anchored, not bare terms', async () => {
  // §5 context anchoring: "transformer" alone must not reach power engineering.
  const query = buildArxivQuery(['machine learning', 'transformer']);
  assert.equal(query, 'all:"machine learning" AND all:transformer');
  assert.ok(query.includes(' AND '), 'terms are ANDed, never ORed');
});

test('arXiv version suffixes are stripped so v1 and v2 deduplicate', async () => {
  assert.equal(arxivIdFromUrl('http://arxiv.org/abs/2301.12345v2'), '2301.12345');
  assert.equal(arxivIdFromUrl('http://arxiv.org/abs/2301.12345'), '2301.12345');
});

test('a single arXiv entry parses the same as many', async () => {
  // fast-xml-parser collapses a lone repeated element into a scalar unless
  // told otherwise; that difference has broken many Atom parsers.
  const entry = (id, title) => `
    <entry>
      <id>http://arxiv.org/abs/${id}v1</id>
      <title>${title}</title>
      <summary>An abstract.</summary>
      <published>2023-01-29T00:00:00Z</published>
      <author><name>A. Researcher</name></author>
    </entry>`;
  const feed = (entries) =>
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;

  const one = parseArxivAtom(feed(entry('2301.00001', 'Only paper')));
  assert.equal(one.papers.length, 1);
  assert.equal(one.papers[0].source_id, '2301.00001');
  assert.equal(one.papers[0].published, '2023-01-29');
  assert.deepEqual(one.papers[0].authors, ['A. Researcher']);

  const many = parseArxivAtom(feed(entry('2301.00001', 'First') + entry('2301.00002', 'Second')));
  assert.equal(many.papers.length, 2);
});

test('malformed Atom returns an error, never a partial list', async () => {
  const result = parseArxivAtom('<html>gateway timeout</html>');
  assert.deepEqual(result.papers, []);
  assert.ok(result.error);
});

test('Crossref items normalize, preferring the earliest publication date', async () => {
  const { papers } = parseCrossrefSearch({
    message: {
      'total-results': 1,
      items: [
        {
          DOI: '10.1126/SciTranslMed.aad9398',
          title: ['Supervised autonomous robotic soft tissue surgery'],
          'container-title': ['Science Translational Medicine'],
          author: [{ given: 'Azad', family: 'Shademan' }],
          issued: { 'date-parts': [[2016, 5, 4]] },
          'published-online': { 'date-parts': [[2016, 5, 3]] },
          type: 'journal-article',
          abstract: '<jats:p>We demonstrate <jats:italic>in vivo</jats:italic> suturing.</jats:p>',
        },
      ],
    },
  });

  assert.equal(papers.length, 1);
  assert.equal(papers[0].doi, '10.1126/scitranslmed.aad9398', 'DOIs are lowercased for dedup');
  assert.equal(papers[0].id, papers[0].doi);
  assert.equal(papers[0].published, '2016-05-03', 'earliest of issued/online');
  assert.deepEqual(papers[0].authors, ['Azad Shademan']);
  assert.equal(papers[0].abstract, 'We demonstrate in vivo suturing.', 'JATS markup stripped');
});

test('a Crossref work becomes a primary record typed by work type', async () => {
  const record = parseCrossrefWork({
    message: {
      DOI: '10.1126/scitranslmed.aad9398',
      title: ['Supervised autonomous robotic soft tissue surgery'],
      type: 'journal-article',
      issued: { 'date-parts': [[2016, 5, 4]] },
      author: [],
    },
  });
  assert.equal(record.registry, 'crossref');
  assert.equal(record.work_type, 'journal-article');
  assert.equal(registryEventType(record).confidence, 'definitive');

  const preprint = parseCrossrefWork({
    message: { DOI: '10.0/x', title: ['A preprint'], type: 'posted-content', author: [] },
  });
  assert.equal(registryEventType(preprint).confidence, 'inferred');
});

test('Crossref search URLs carry date filters and a contact address', async () => {
  const url = crossrefSearchUrl({ terms: ['surgical robotics'], from: '2020-01-01', to: '2024-01-01', rows: 10 });
  assert.ok(url.includes('from-pub-date%3A2020-01-01'));
  assert.ok(url.includes('until-pub-date%3A2024-01-01'));
  assert.ok(url.includes('mailto='), 'Crossref asks callers to identify themselves');
});

test('PubMed esearch and esummary parse, and prefer the electronic date', async () => {
  const { pmids, total } = parseESearch({ esearchresult: { idlist: ['27306664'], count: '1' } });
  assert.deepEqual(pmids, ['27306664']);
  assert.equal(total, 1);

  const papers = parseESummary({
    result: {
      uids: ['27306664'],
      27306664: {
        uid: '27306664',
        title: 'Supervised autonomous robotic soft tissue surgery',
        pubdate: '2016 May',
        epubdate: '2016 May 4',
        fulljournalname: 'Science Translational Medicine',
        authors: [
          { name: 'Shademan A', authtype: 'Author' },
          { name: 'The STAR Collaboration', authtype: 'CollectiveName' },
        ],
        articleids: [{ idtype: 'doi', value: '10.1126/scitranslmed.aad9398' }],
      },
    },
  });

  assert.equal(papers.length, 1);
  assert.equal(papers[0].published, '2016-05-04', 'epubdate precedes pubdate');
  assert.deepEqual(papers[0].authors, ['Shademan A'], 'collective author entries are not people');
  assert.equal(papers[0].id, '10.1126/scitranslmed.aad9398', 'DOI is the cross-source key');
});

test('PubMed terms are ANDed and date-bounded', async () => {
  const term = buildPubmedTerm({ terms: ['smart tissue', 'anastomosis'], from: '2014-01-01', to: '2016-12-31' });
  assert.ok(term.startsWith('"smart tissue" AND anastomosis'));
  assert.ok(term.includes('[Date - Publication]'));
});

test('a Wikipedia disambiguation page yields no record', async () => {
  // §8 adversarial inputs: "Mercury" must not resolve to a confident subject.
  assert.equal(
    parseSummary({ type: 'disambiguation', pageid: 1, title: 'Mercury', extract: 'Mercury may refer to:' }),
    undefined,
  );

  const record = parseSummary({
    type: 'standard',
    pageid: 12345,
    title: 'ROBODOC',
    titles: { canonical: 'ROBODOC' },
    extract: 'x'.repeat(500),
    timestamp: '2025-11-02T09:14:00Z',
  });
  assert.equal(record.page_id, 12345);
  assert.ok(record.extract.length <= 201, '§4: store locators, not extended verbatim text');
  assert.equal(record.revision_date, '2025-11-02');
  assert.equal(registryEventType(record).event_type, null);
});

// ---------------------------------------------------------------------------
// Fixture replay — the only tests that can confirm the field names are right
// ---------------------------------------------------------------------------

test('fixture: openFDA AESOP 510(k)', async (t) => {
  const raw = needsFixture('openfda-aesop-510k', t);
  if (raw === undefined) return;

  const { records, error } = parse510k(JSON.parse(raw));
  assert.equal(error, undefined);
  assert.ok(records.length > 0, 'the recorded response should contain AESOP');

  for (const record of records) {
    assert.equal(record.submission_type, '510k');
    assert.equal(registryEventType(record).event_type, 'regulatory_clearance');
    assert.ok(record.submission_number.length > 0);
  }
});

test('fixture: openFDA ROBODOC PMA', async (t) => {
  const raw = needsFixture('openfda-robodoc-pma', t);
  if (raw === undefined) return;

  const { records } = parsePma(JSON.parse(raw));
  for (const record of records) {
    assert.ok(record.submission_type.startsWith('pma'));
    assert.equal(registryEventType(record).event_type, 'regulatory_approval');
  }
});

test('fixture: arXiv Atom feed', async (t) => {
  const raw = needsFixture('arxiv-surgical-robotics', t);
  if (raw === undefined) return;

  const { papers, error } = parseArxivAtom(raw);
  assert.equal(error, undefined);
  assert.ok(papers.length > 0, 'a real Atom feed should yield papers');
  for (const paper of papers) {
    assert.ok(paper.title.length > 0);
    assert.ok(paper.url.startsWith('http'));
    assert.equal(paper.source, 'arxiv');
    assert.match(paper.published, /^\d{4}/, 'every arXiv entry has a published date');
  }
});

test('fixture: Crossref work lookup', async (t) => {
  const raw = needsFixture('crossref-star-2016', t);
  if (raw === undefined) return;

  const record = parseCrossrefWork(JSON.parse(raw));
  assert.ok(record, 'the STAR 2016 DOI should resolve to a record');
  assert.equal(record.registry, 'crossref');
  assert.match(record.date ?? '', /^2016/, 'golden set expects 2016');
});

test('fixture: PubMed esummary', async (t) => {
  const raw = needsFixture('pubmed-esummary-star', t);
  if (raw === undefined) return;

  const papers = parseESummary(JSON.parse(raw));
  assert.ok(papers.length > 0);
  for (const paper of papers) {
    assert.equal(paper.source, 'pubmed');
    assert.ok(paper.title.length > 0);
  }
});

test('fixture: Wikipedia summary', async (t) => {
  const raw = needsFixture('wikipedia-robodoc', t);
  if (raw === undefined) return;

  const record = parseSummary(JSON.parse(raw));
  assert.ok(record, 'ROBODOC should resolve to an article');
  assert.equal(record.registry, 'wikipedia');
  assert.equal(registryEventType(record).event_type, null);
});
