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
import { yearOf } from '../dist/dates.js';
import { httpGet } from '../dist/http.js';
import { RateLimiter } from '../dist/ratelimit.js';
import { registryEventType } from '../dist/registry.js';
import { arxivIdFromUrl, buildArxivQuery, parseArxivAtom } from '../dist/sources/arxiv.js';
import { crossrefSearchUrl, parseCrossrefSearch, parseCrossrefWork } from '../dist/sources/crossref.js';
import { isOriginalPma, parse510k, parsePma, searchClearances } from '../dist/sources/openfda.js';
import { buildPubmedTerm, parseESearch, parseESummary } from '../dist/sources/pubmed.js';
import { parseSearch, parseSummary, parseSummaryRecords } from '../dist/sources/wikipedia.js';

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
  // Returns an array even for a single-DOI lookup: every registry lookup in
  // this server returns all matches, so callers never have to remember which
  // ones return one and which return many.
  const records = parseCrossrefWork({
    message: {
      DOI: '10.1126/scitranslmed.aad9398',
      title: ['Supervised autonomous robotic soft tissue surgery'],
      type: 'journal-article',
      issued: { 'date-parts': [[2016, 5, 4]] },
      author: [],
    },
  });
  assert.ok(Array.isArray(records));
  assert.equal(records.length, 1);
  assert.equal(records[0].registry, 'crossref');
  assert.equal(records[0].work_type, 'journal-article');
  assert.equal(registryEventType(records[0]).confidence, 'definitive');

  const preprint = parseCrossrefWork({
    message: { DOI: '10.0/x', title: ['A preprint'], type: 'posted-content', author: [] },
  });
  assert.equal(registryEventType(preprint[0]).confidence, 'inferred');

  assert.deepEqual(parseCrossrefWork({}), [], 'an empty response is an empty list, not undefined');
});

test('registry lookups return every match, never a chosen one', async () => {
  // A device family often has several clearances. Returning the first would
  // hide the siblings that show the caller there was a choice to make, and
  // choosing among them is Claude's judgement, not the server's (§2).
  const { records } = parse510k({
    meta: { results: { total: 3 } },
    results: [
      { k_number: 'K931783', device_name: 'AESOP', decision_date: '1993-11-22', date_received: '1993-04-09' },
      { k_number: 'K952230', device_name: 'AESOP 1000', decision_date: '1995-10-13' },
      { k_number: 'K963126', device_name: 'AESOP 2000', decision_date: '1997-02-10', date_received: '1996-08-05' },
    ],
  });
  assert.equal(records.length, 3, 'all three, in response order');
  assert.deepEqual(records.map((r) => r.submission_number), ['K931783', 'K952230', 'K963126']);

  // Crossref search results likewise come back whole.
  const works = parseCrossrefWork({
    message: {
      items: [
        { DOI: '10.0/a', title: ['A'], type: 'journal-article', author: [] },
        { DOI: '10.0/b', title: ['B'], type: 'journal-article', author: [] },
      ],
    },
  });
  assert.equal(works.length, 2);
});

test('a Wikipedia lookup is plural too, and empty for a disambiguation page', async () => {
  assert.equal(
    parseSummaryRecords({ type: 'disambiguation', pageid: 1, title: 'Mercury' }).length,
    0,
    'an ambiguous entity resolves to nothing, honestly',
  );
  assert.equal(
    parseSummaryRecords({ type: 'standard', pageid: 2, title: 'ROBODOC', titles: { canonical: 'ROBODOC' } }).length,
    1,
  );
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

test('fixture: K931783 confirms the AESOP dates the golden set asserts', async (t) => {
  // The golden set records received 1993-04-09 / decision 1993-11-22 on the
  // maintainer's report. This is the check that turns that into evidence.
  const raw = needsFixture('openfda-k931783', t);
  if (raw === undefined) return;

  const { records, error } = parse510k(JSON.parse(raw));
  assert.equal(error, undefined);
  assert.equal(records.length, 1, 'an exact K number resolves to one record');

  const record = records[0];
  assert.equal(record.submission_number, 'K931783');
  assert.equal(record.submission_type, '510k');
  assert.equal(record.decision_date, '1993-11-22');
  assert.equal(record.received_date, '1993-04-09');
  assert.equal(record.date, '1993-11-22', '`date` carries the decision date');
  assert.equal(record.date_precision, 'day');

  // The finding that falsified the cross-year hypothesis.
  assert.equal(
    yearOf(record.received_date),
    yearOf(record.decision_date),
    'both dates fall in 1993 — there is no year boundary here to explain a bimodal date',
  );
});

test('fixture: K963126 is the genuine cross-year case', async (t) => {
  const raw = needsFixture('openfda-k963126-cross-year', t);
  if (raw === undefined) return;

  const { records } = parse510k(JSON.parse(raw));
  assert.equal(records.length, 1);

  const record = records[0];
  assert.equal(record.submission_number, 'K963126');
  assert.equal(yearOf(record.received_date), 1996);
  assert.equal(yearOf(record.decision_date), 1997);
  assert.notEqual(
    yearOf(record.received_date),
    yearOf(record.decision_date),
    'this is the control: one record, two dates, two calendar years',
  );
  // Still one event. Whatever §6.6 ends up doing, it must not read this as two.
  assert.equal(record.date, record.decision_date);
});

test('fixture: the PMA controls establish whether a PMA 404 means anything', async (t) => {
  // Until these pass, a 404 from a PMA query is uninterpretable: it could be
  // zero matches or a malformed query, and those license opposite conclusions.
  const smoke = needsFixture('openfda-pma-smoke', t);
  if (smoke === undefined) return;
  const syntax = fixture('openfda-pma-syntax-control');

  const smokeParsed = parsePma(JSON.parse(smoke));
  assert.equal(smokeParsed.error, undefined, 'the PMA endpoint itself must work');
  assert.ok(smokeParsed.records.length > 0, 'an unfiltered PMA query must return records');

  for (const record of smokeParsed.records) {
    assert.ok(record.submission_type.startsWith('pma'));
    assert.equal(registryEventType(record).event_type, 'regulatory_approval');
  }

  if (syntax !== undefined) {
    const syntaxParsed = parsePma(JSON.parse(syntax));
    assert.equal(syntaxParsed.error, undefined);
    assert.ok(
      syntaxParsed.records.length > 0,
      'a date range matching everything must return records — if this is empty the PMA search syntax is wrong, not the device',
    );
  }
});

test('fixture: da Vinci was CLEARED, not approved', async (t) => {
  // Settled. The PMA controls proved the query path works, so the NOT_FOUND is
  // a genuine absence rather than a broken query.
  const clearances = needsFixture('openfda-davinci-510k', t);
  if (clearances === undefined) return;

  const cleared = parse510k(JSON.parse(clearances));
  const approved = parsePma(JSON.parse(fixture('openfda-davinci-pma')));

  assert.ok(cleared.records.length > 0, 'present in the 510(k) database');
  assert.equal(approved.records.length, 0, 'absent from PMA');
  assert.equal(approved.error, undefined, 'and absent as a clean NOT_FOUND, not an error');

  for (const record of cleared.records) {
    assert.equal(registryEventType(record).event_type, 'regulatory_clearance');
  }
});

test('fixture: the da Vinci result is truncated, so it cannot establish an earliest date', async (t) => {
  // The trap this nearly walked into. 115 total, 25 returned, openFDA's
  // default ordering unspecified — and the oldest record is not in the page.
  // Taking the minimum of that page silently answers a different question.
  const raw = needsFixture('openfda-davinci-510k', t);
  if (raw === undefined) return;

  const parsed = JSON.parse(raw);
  const total = parsed.meta.results.total;
  const returned = parsed.results.length;

  assert.ok(total > returned, `truncated: ${returned} of ${total}`);
  assert.ok(
    !new URL(JSON.parse(fs.readFileSync(path.join(fixturesDir, 'openfda-davinci-510k.meta.json'), 'utf8')).url)
      .searchParams.has('sort'),
    'and unsorted, which is what makes the truncation dangerous rather than merely partial',
  );

  // The golden set must therefore leave the date open.
  const golden = JSON.parse(
    fs.readFileSync(path.join(fixturesDir, '..', 'golden', 'surgical_robotics.json'), 'utf8'),
  );
  const dispute = golden.disputed.find((d) => d.entry === 'da-vinci-clearance');
  assert.ok(dispute, 'the date must stay disputed while the result set is truncated');
  assert.equal(dispute.field, 'date');
});

test('fixture: da Vinci K002489 is a genuine cross-year record', async (t) => {
  // Received 2000-08-10, decided 2001-03-02. This is the mechanism the AESOP
  // hypothesis predicted and AESOP did not exhibit — it is real, just
  // elsewhere. It is the likeliest origin of a "2000" in secondary sources,
  // though August is still not the July the spec states.
  const raw = needsFixture('openfda-davinci-510k', t);
  if (raw === undefined) return;

  const { records } = parse510k(JSON.parse(raw));
  const k002489 = records.find((r) => r.submission_number === 'K002489');
  assert.ok(k002489, 'K002489 should be in the recorded page');
  assert.equal(k002489.received_date, '2000-08-10');
  assert.equal(k002489.decision_date, '2001-03-02');
  assert.notEqual(yearOf(k002489.received_date), yearOf(k002489.decision_date));
  assert.equal(k002489.date, '2001-03-02', '`date` carries the decision, never the receipt');
});

test('fixture: ROBODOC was CLEARED, not approved — and completely so', async (t) => {
  const clearances = needsFixture('openfda-robodoc-510k', t);
  if (clearances === undefined) return;

  const parsed = JSON.parse(clearances);
  assert.equal(parsed.meta.results.total, parsed.results.length, 'complete: 2 of 2, unlike da Vinci');

  const cleared = parse510k(parsed);
  const approved = parsePma(JSON.parse(fixture('openfda-robodoc-pma')));
  assert.equal(approved.records.length, 0, 'absent from PMA');

  const earliest = cleared.records
    .map((r) => r.date)
    .filter((d) => d !== undefined)
    .sort()[0];
  assert.equal(earliest, '2008-08-06', 'definitive, because the result set is complete');

  const k072629 = cleared.records.find((r) => r.submission_number === 'K072629');
  assert.equal(k072629.decision_date, '2008-08-06');
  assert.equal(registryEventType(k072629).event_type, 'regulatory_clearance');
});

test('fixture: the PMA controls make those absences readable', async (t) => {
  const smoke = needsFixture('openfda-pma-smoke', t);
  if (smoke === undefined) return;

  const parsed = JSON.parse(smoke);
  assert.ok(parsed.meta.results.total > 1000, 'the PMA database is populated');

  const { records, error } = parsePma(parsed);
  assert.equal(error, undefined);
  assert.ok(records.length > 0, 'and the adapter parses real PMA rows');
  for (const record of records) {
    assert.ok(record.submission_type.startsWith('pma'));
    assert.equal(registryEventType(record).event_type, 'regulatory_approval');
  }
});

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

  // Plural, like every registry lookup — this test lagged the change and was
  // reading `.registry` off the array.
  const records = parseCrossrefWork(JSON.parse(raw));
  assert.equal(records.length, 1, 'the STAR 2016 DOI should resolve to one record');

  const record = records[0];
  assert.equal(record.registry, 'crossref');
  assert.equal(record.doi, '10.1126/scitranslmed.aad9398');
  assert.equal(record.work_type, 'journal-article');
  assert.match(record.date ?? '', /^2016/, 'golden set expects 2016');
  assert.ok(record.authors.length > 0, 'author normalization should survive the real payload');
  assert.equal(registryEventType(record).confidence, 'definitive');
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

test('fixture: Robodoc is a disambiguation page and yields no record', async (t) => {
  // Recorded HTTP 200, but type "disambiguation". The adapter returning zero
  // records is correct behaviour, not a failure: an article that describes no
  // single subject attests to nothing. This is the §8 adversarial case.
  const raw = needsFixture('wikipedia-robodoc', t);
  if (raw === undefined) return;

  const parsed = JSON.parse(raw);
  assert.equal(parsed.type, 'disambiguation');
  assert.deepEqual(parseSummaryRecords(parsed), [], 'zero records, honestly');
});

test('fixture: the search resolves ROBODOC to a real article title', async (t) => {
  // Rather than guessing a third casing, the search endpoint was recorded and
  // asked. It resolves to "Robotic surgery" — ROBODOC has no article of its
  // own, which is itself a finding about tertiary coverage.
  const raw = needsFixture('wikipedia-robodoc-search', t);
  if (raw === undefined) return;

  const { titles } = parseSearch(JSON.parse(raw));
  assert.ok(titles.length > 0, 'the search should resolve something');
  assert.ok(titles.includes('Robotic surgery'));

  const resolved = fixture('wikipedia-robotic-surgery');
  if (resolved === undefined) {
    t.diagnostic('wikipedia-robotic-surgery not recorded yet — run the recorder to close the loop');
    return;
  }
  const records = parseSummaryRecords(JSON.parse(resolved));
  assert.equal(records.length, 1, 'the resolved title is a real article');
  assert.equal(records[0].registry, 'wikipedia');
  assert.equal(registryEventType(records[0]).event_type, null, 'and still attests to no event type');
});

