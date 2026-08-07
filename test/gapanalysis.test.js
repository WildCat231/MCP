/**
 * find_incumbents, check_abandonment and fetch_yc_rfs.
 *
 * The load-bearing tests here are about interpretability rather than
 * retrieval: that a zero from a broken channel is never reported as absence,
 * that a stale RFS is never served as current, and that a parse failure is
 * never reported as an empty result.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SIGNAL_TERMS,
  checkAbandonment,
  classify,
  extractStatedReason,
} from '../dist/abandonment.js';
import { OCCUPANCY_CHANNELS, findIncumbents } from '../dist/occupancy.js';
import { RateLimiter } from '../dist/ratelimit.js';
import { parseGdelt, parseSeenDate } from '../dist/sources/gdelt.js';
import { parseHackerNews } from '../dist/sources/hackernews.js';
import {
  RFS_MAX_STALE_DAYS,
  RFS_TTL_DAYS,
  extractBatch,
  freshness,
  parseRfsPage,
} from '../dist/sources/ycombinator.js';

const NOT_FOUND = '{"error":{"code":"NOT_FOUND"}}';

const gdeltBody = (titles) =>
  JSON.stringify({
    articles: titles.map((title, i) => ({
      title,
      url: `https://news.example/${i}`,
      domain: 'news.example',
      seendate: `2026010${(i % 9) + 1}T120000Z`,
    })),
  });

const hnBody = (items) =>
  JSON.stringify({
    nbHits: items.length,
    hits: items.map((item, i) => ({
      objectID: `${1000 + i}`,
      title: typeof item === 'string' ? item : item.title,
      url: `https://hn.example/${i}`,
      author: 'someone',
      points: 10,
      created_at: '2026-01-02T00:00:00Z',
      ...(typeof item === 'string' ? {} : { story_text: item.text }),
    })),
  });

const crossrefBody = (n) =>
  JSON.stringify({
    message: {
      'total-results': n,
      items: Array.from({ length: n }, (_, i) => ({
        DOI: `10.0/x${i}`,
        title: [`Paper ${i}`],
        type: 'journal-article',
        issued: { 'date-parts': [[2026, 1, 1]] },
        author: [],
      })),
    },
  });

/** Route by host and by whether the query mentions the control term. */
function deps(handler) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const response = handler(url);
    if (response !== undefined) {
      return new Response(response.body ?? '{}', {
        status: response.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('arxiv')) return new Response('<?xml version="1.0"?><feed/>', { status: 200 });
    if (url.includes('eutils')) return new Response('{"esearchresult":{"idlist":[],"count":"0"}}', { status: 200 });
    if (url.includes('crossref')) return new Response(crossrefBody(0), { status: 200 });
    if (url.includes('gdelt')) return new Response('{"articles":[]}', { status: 200 });
    if (url.includes('algolia')) return new Response(hnBody([]), { status: 200 });
    if (url.includes('wikipedia')) return new Response('{"query":{"search":[]}}', { status: 200 });
    return new Response(NOT_FOUND, { status: 404 });
  };
  fetch.calls = calls;
  return {
    fetch,
    limiter: new RateLimiter({
      clock: { now: () => Date.parse('2026-08-05T00:00:00Z'), sleep: async () => {} },
      limits: {},
      fallback: { capacity: Number.MAX_SAFE_INTEGER, refillPerSecond: Number.MAX_SAFE_INTEGER },
    }),
  };
}

// ---------------------------------------------------------------------------
// find_incumbents: the control is the point
// ---------------------------------------------------------------------------

test('control_terms is required, and its absence refuses the sweep rather than running it', async () => {
  // Running anyway would produce a number nobody could interpret, which is
  // exactly the misreading this tool exists to prevent.
  const d = deps(() => undefined);
  const result = await findIncumbents({ idea_terms: ['widget'], control_terms: [] }, {}, d);

  assert.match(result.error, /control_terms is required/);
  assert.match(result.flag, /no zero from this sweep could be interpreted/);
  assert.equal(d.fetch.calls.length, 0, 'nothing should be searched without a control');
});

test('a zero with a passing control is real evidence of absence', async () => {
  // Control finds things, idea does not: the channel works.
  const d = deps((url) =>
    url.includes('crossref') && url.includes('surgical')
      ? { body: crossrefBody(5) }
      : url.includes('crossref')
        ? { body: crossrefBody(0) }
        : undefined,
  );

  const result = await findIncumbents(
    { idea_terms: ['nonexistent widget'], control_terms: ['surgical robot'], channels: ['literature'] },
    {},
    d,
  );

  const channel = result.channels[0];
  assert.equal(channel.idea_hits, 0);
  assert.ok(channel.control_hits > 0);
  assert.equal(channel.control_passed, true);
  assert.equal(channel.interpretable, true);
  assert.match(channel.verdict, /the channel works, so this zero is real evidence/);
  assert.match(result.flag, /APPARENTLY UNOCCUPIED/);
  assert.match(result.flag, /not proof of absence in the world/);
});

test('a zero with a FAILING control is reported as meaningless, not as absence', async () => {
  // The failure mode the whole tool is built around: everything returns
  // nothing, including the thing we know exists.
  const d = deps((url) => (url.includes('crossref') ? { status: 503, body: 'down' } : undefined));

  const result = await findIncumbents(
    { idea_terms: ['nonexistent widget'], control_terms: ['surgical robot'], channels: ['literature'] },
    {},
    d,
  );

  const channel = result.channels[0];
  assert.equal(channel.idea_hits, 0);
  assert.equal(channel.control_passed, false);
  assert.equal(channel.interpretable, false);
  assert.match(result.flag, /NOT INTERPRETABLE/);
  assert.match(result.flag, /it is no evidence at all/);
  assert.ok(!/UNOCCUPIED/.test(result.flag), 'a broken sweep must never read as unoccupied');
});

test('control verdicts are per channel, because failures are rarely global', async () => {
  // Literature works; patents are credential-blocked. One zero is meaningful
  // and the other is not, in the same sweep.
  const d = deps((url) => {
    if (url.includes('crossref')) return { body: url.includes('surgical') ? crossrefBody(4) : crossrefBody(0) };
    if (url.includes('patentsview')) return { status: 401, body: '{"error":"API key required"}' };
    return undefined;
  });

  const result = await findIncumbents(
    { idea_terms: ['nonexistent widget'], control_terms: ['surgical robot'], channels: ['literature', 'patents'] },
    {},
    d,
  );

  const byChannel = Object.fromEntries(result.channels.map((c) => [c.channel, c]));
  assert.equal(byChannel.literature.interpretable, true);
  assert.equal(byChannel.patents.interpretable, false);

  assert.deepEqual(result.occupancy.empty_and_interpretable, ['literature']);
  assert.deepEqual(result.occupancy.uninterpretable, ['patents']);
  assert.match(result.flag, /PARTIAL/);
  assert.match(result.flag, /zeros in patents are not interpretable/);
});

test('occupancy stands even when the control fails, because a broken channel invents nothing', async () => {
  const d = deps((url) => (url.includes('crossref') ? { body: crossrefBody(3) } : undefined));
  const result = await findIncumbents(
    { idea_terms: ['widget'], control_terms: ['zzz nothing zzz'], channels: ['literature'] },
    {},
    d,
  );

  assert.equal(result.channels[0].idea_hits, 3);
  assert.match(result.flag, /OCCUPIED/);
  assert.match(result.channels[0].verdict, /Occupancy stands regardless of the control/);
});

test('the control runs through the same code path as the idea', async () => {
  // A control that exercised a simpler path would prove nothing about the path
  // that produced the zero.
  const d = deps(() => undefined);
  await findIncumbents(
    { idea_terms: ['alpha idea'], control_terms: ['beta control'], channels: ['news'] },
    {},
    d,
  );

  const gdeltCalls = d.fetch.calls.filter((u) => u.includes('gdelt'));
  assert.equal(gdeltCalls.length, 2, 'one call for the idea, one for the control');
  assert.ok(gdeltCalls.some((u) => u.includes('alpha')));
  assert.ok(gdeltCalls.some((u) => u.includes('beta')));
});

test('every channel is swept by default and LinkedIn is not among them', async () => {
  assert.deepEqual([...OCCUPANCY_CHANNELS], [
    'literature',
    'patents',
    'companies',
    'consortia',
    'regulators',
    'news',
  ]);
  assert.ok(!OCCUPANCY_CHANNELS.includes('linkedin'));

  const d = deps(() => undefined);
  const result = await findIncumbents({ idea_terms: ['x'], control_terms: ['y'] }, {}, d);
  assert.equal(result.channels.length, 6);
  assert.match(result.warning, /No LinkedIn channel by design/);
  assert.match(result.warning, /terms prohibit scraping/);
});

test('channels that are merely weak say so without being dropped', async () => {
  const d = deps(() => undefined);
  const result = await findIncumbents(
    { idea_terms: ['x'], control_terms: ['y'], channels: ['companies', 'consortia', 'regulators'] },
    {},
    d,
  );

  const byChannel = Object.fromEntries(result.channels.map((c) => [c.channel, c]));
  assert.match(byChannel.companies.warning, /over-indexes English-language software startups/);
  assert.match(byChannel.consortia.warning, /tertiary/);
  assert.match(byChannel.regulators.warning, /US medical devices only/);
});

// ---------------------------------------------------------------------------
// check_abandonment
// ---------------------------------------------------------------------------

test('shutdown, pivot, acquisition, deprecation and wind-down are each classified', async () => {
  assert.equal(classify('Acme shuts down its robotics arm')?.signal, 'shutdown');
  assert.equal(classify('Acme pivots to enterprise software')?.signal, 'pivot');
  assert.equal(classify('Acme acquired by MegaCorp')?.signal, 'acquisition');
  assert.equal(classify('Acme API is now deprecated')?.signal, 'deprecation');
  assert.equal(classify('Acme lays off half its staff')?.signal, 'wind_down');
  assert.equal(classify('Acme raises a Series B'), undefined, 'good news is not abandonment');
});

test('the classification names the word that caused it', async () => {
  // A caller reading "classified as a pivot" must be able to see why.
  const classified = classify('Acme pivoting to defence contracts');
  assert.equal(classified.signal, 'pivot');
  assert.match(classified.matched, /pivoting/i);
});

test('stated reasons are extracted verbatim, and only when a reason is stated', async () => {
  const withReason = extractStatedReason(
    'Acme is shutting down. The company cited an inability to reach unit economics at scale.',
  );
  assert.match(withReason, /cited an inability to reach unit economics/);

  // No causal connective: returning the first sentence would invent an
  // attribution the source never made.
  assert.equal(extractStatedReason('Acme is shutting down. It had 40 employees.'), undefined);
  assert.equal(extractStatedReason(undefined), undefined);
});

test('a reason is never paraphrased', async () => {
  const source = 'Acme shut down because the regulatory pathway proved longer than its runway.';
  assert.equal(extractStatedReason(source), source, 'returned exactly as written');
});

test('hits carry their signal, source and reason, newest first', async () => {
  const d = deps((url) => {
    if (url.includes('gdelt')) {
      return {
        body: gdeltBody([
          'Acme Robotics shuts down after failing to secure Series B funding',
          'Acme Robotics raises a round',
        ]),
      };
    }
    if (url.includes('algolia')) {
      return { body: hnBody([{ title: 'Acme is winding down', text: 'We are winding down because the market never materialised.' }]) };
    }
    return undefined;
  });

  const result = await checkAbandonment({ entity_terms: ['Acme Robotics'] }, {}, d);

  assert.ok(result.hits.length > 0);
  assert.ok(result.signals_found.includes('shutdown'));
  assert.ok(!result.hits.some((h) => /raises a round/.test(h.title)), 'unrelated news is filtered out');

  const reasoned = result.reasons.find((r) => /never materialised|Series B/.test(r.reason));
  assert.ok(reasoned, 'a stated reason should be surfaced');
  assert.match(result.flag, /Someone has been here before/);
});

test('absence is reported as a WEAK negative, unlike absence of incumbents', async () => {
  // Launches are announced and failures are not; the asymmetry is stated
  // rather than left to be inferred.
  const d = deps(() => undefined);
  const result = await checkAbandonment({ entity_terms: ['Acme'] }, {}, d);

  assert.deepEqual(result.hits, []);
  assert.match(result.flag, /WEAK negative/);
  assert.match(result.flag, /launches are announced and failures are not/);
});

test('total search failure is not reported as nothing-abandoned', async () => {
  const d = deps(() => ({ status: 503, body: 'down' }));
  const result = await checkAbandonment({ entity_terms: ['Acme'] }, {}, d);

  assert.match(result.flag, /NOT INTERPRETABLE/);
  assert.match(result.flag, /nothing was looked at/);
  assert.ok(result.errors);
});

test('every signal is searched and the queries are reported', async () => {
  const d = deps(() => undefined);
  const result = await checkAbandonment({ entity_terms: ['Acme'] }, {}, d);

  assert.deepEqual(
    result.searched.map((s) => s.signal).sort(),
    Object.keys(SIGNAL_TERMS).sort(),
  );
  for (const search of result.searched) {
    assert.ok(search.query.includes('Acme'), 'the entity is in every query');
  }
  assert.match(result.warning, /never summarized/);
});

// ---------------------------------------------------------------------------
// fetch_yc_rfs
// ---------------------------------------------------------------------------

test('a parse failure is an error, never an empty request list', async () => {
  // "YC is asking for nothing" is never true, so zero requests means the
  // extractor broke.
  const result = parseRfsPage('<html><body><p>Something entirely different</p></body></html>');
  assert.deepEqual(result.requests, []);
  assert.ok(result.error);
  assert.match(result.error, /parser failure, not an empty RFS/);

  assert.ok(parseRfsPage('').error, 'an empty body is an error too');
});

test('requests are extracted from the structured data island when present', async () => {
  const html = `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: {
        requests: [
          { title: 'AI agents for real work', description: '<p>We want founders building agents.</p>' },
          { title: 'Robotics for the trades', description: 'Physical labour is underserved.' },
        ],
      },
    },
  })}</script></head><body></body></html>`;

  const { requests, error } = parseRfsPage(html);
  assert.equal(error, undefined);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].title, 'AI agents for real work');
  assert.equal(requests[0].description, 'We want founders building agents.', 'markup is stripped');
});

test('headings are the fallback, and page furniture is not mistaken for a request', async () => {
  const html = `
    <h2>Request for Startups</h2><p>intro</p>
    <h2>New space companies</h2><p>Launch costs are falling.</p>
    <h2>Apply</h2><p>Applications close soon.</p>`;

  const { requests } = parseRfsPage(html);
  const titles = requests.map((r) => r.title);
  assert.ok(titles.includes('New space companies'));
  assert.ok(!titles.includes('Request for Startups'), 'the page heading is not a request');
  assert.ok(!titles.includes('Apply'), 'navigation is not a request');
});

test('a batch label is read from the page, never inferred', async () => {
  assert.equal(extractBatch('<p>For the Summer 2026 batch we want…</p>'), 'Summer 2026');
  assert.equal(extractBatch('<p>No batch mentioned here.</p>'), undefined, 'silence is not a guess');
});

test('freshness: fresh under the TTL, stale up to the ceiling, expired beyond it', async () => {
  assert.equal(freshness(1).state, 'fresh');
  assert.equal(freshness(RFS_TTL_DAYS - 0.1).state, 'fresh');

  const stale = freshness(RFS_TTL_DAYS + 1);
  assert.equal(stale.state, 'stale');
  assert.match(stale.warning, /MUST NOT be presented as their current asks/);

  const expired = freshness(RFS_MAX_STALE_DAYS + 1);
  assert.equal(expired.state, 'expired');
  assert.match(expired.warning, /more misleading than no RFS at all/);
});

test('the staleness ceiling is about one batch cycle', async () => {
  assert.equal(RFS_TTL_DAYS, 7);
  assert.ok(RFS_MAX_STALE_DAYS >= 60 && RFS_MAX_STALE_DAYS <= 180, 'roughly one YC batch');
});

// ---------------------------------------------------------------------------
// the new source adapters
// ---------------------------------------------------------------------------

test('GDELT dates and articles normalize; a malformed payload errors', async () => {
  assert.equal(parseSeenDate('20240115T120000Z'), '2024-01-15');
  assert.equal(parseSeenDate(undefined), undefined);

  const { articles } = parseGdelt(JSON.parse(gdeltBody(['One', 'Two'])));
  assert.equal(articles.length, 2);
  assert.equal(articles[0].domain, 'news.example');

  assert.deepEqual(parseGdelt({}).articles, [], 'GDELT omits the key when nothing matches');
  assert.ok(parseGdelt('not an object').error);
});

test('Hacker News stories normalize, with HTML stripped and text truncated', async () => {
  const { stories, total } = parseHackerNews({
    nbHits: 1,
    hits: [
      {
        objectID: '42',
        title: 'Show HN: our robot',
        url: 'https://example.com/robot',
        author: 'founder',
        points: 100,
        created_at: '2026-02-03T10:00:00Z',
        story_text: '<p>We built this &amp; shipped it.</p>',
      },
    ],
  });

  assert.equal(total, 1);
  assert.equal(stories[0].created, '2026-02-03');
  assert.equal(stories[0].text, 'We built this & shipped it.');
  assert.equal(stories[0].discussion_url, 'https://news.ycombinator.com/item?id=42');
});

test('a self-post with no external link falls back to the discussion URL', async () => {
  const { stories } = parseHackerNews({ hits: [{ objectID: '7', title: 'Ask HN: did anyone try this?' }] });
  assert.equal(stories[0].url, 'https://news.ycombinator.com/item?id=7');
});
