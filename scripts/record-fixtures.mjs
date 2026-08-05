#!/usr/bin/env node
/**
 * Record real API responses into test/fixtures/.
 *
 * Spec §8: "Record real API responses once, commit them, replay them in
 * tests." This script is the "once". It is the ONLY thing in this repository
 * that is expected to touch the network, and it is never run by `npm test`.
 *
 * ## Raw capture is the invariant
 *
 * What lands in test/fixtures/ is the upstream response body, byte for byte —
 * `response.text()` written straight to disk with no re-serialization, no
 * pretty-printing, and no trailing newline. Normalization is exactly what the
 * fixture exists to test, so a fixture that had been through a parser would
 * test the parser against its own output and pass no matter how wrong it was.
 *
 * Concretely, this script imports only URL builders (`clearanceSearchUrl`,
 * `arxivUrl`, …), the rate limiter, and the credential headers. It must never
 * import a `parse*` or `to*` function from src/sources/ — `test/recorder.test.js`
 * enforces that.
 *
 * Error responses are recorded too, where a fixture sets `allowError`: an
 * openFDA 404 NOT_FOUND body and whatever PatentsView says about credentials
 * are both evidence, and both are things the adapters must handle.
 *
 * The recorded queries are chosen to cover the golden set (§8): the AESOP
 * 510(k) and ROBODOC PMA records that the clearance-vs-approval distinction
 * turns on, plus one representative query per literature source.
 *
 *   node scripts/record-fixtures.mjs             # record everything missing
 *   node scripts/record-fixtures.mjs --force     # re-record even if present
 *   node scripts/record-fixtures.mjs --only=openfda-aesop-510k
 *   node scripts/record-fixtures.mjs --list
 *
 * Behind an HTTPS proxy, Node's built-in fetch ignores HTTPS_PROXY unless you
 * run with NODE_USE_ENV_PROXY=1 (Node >= 22.21).
 *
 * Rate limits are respected: the script sleeps between requests to the same
 * host using the same limits as the server.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'test', 'fixtures');
const dist = (name) => import(path.join(repoRoot, 'dist', name));

const { arxivUrl } = await dist('sources/arxiv.js');
const { crossrefSearchUrl, crossrefDoiUrl } = await dist('sources/crossref.js');
const { esearchUrl, esummaryUrl } = await dist('sources/pubmed.js');
const { clearanceSearchUrl, approvalSearchUrl, clearanceByNumberUrl, OPENFDA_PMA_ENDPOINT } = await dist('sources/openfda.js');
const { summaryUrl, searchUrl: wikipediaSearchUrl } = await dist('sources/wikipedia.js');
const { patentsviewUrl } = await dist('sources/patentsview.js');
const { HOST_LIMITS, DEFAULT_HOST_LIMIT, RateLimiter } = await dist('ratelimit.js');
const { USER_AGENT } = await dist('http.js');
const { credentialHeaders } = await dist('credentials.js');

/**
 * Each fixture pairs a filename with the exact URL that produced it, so a
 * future maintainer can tell what a recording is of without guessing.
 */
const FIXTURES = [
  {
    name: 'openfda-k931783',
    note: 'AESOP K931783 by exact K number. The golden set asserts received 1993-04-09 and decision 1993-11-22 — both in 1993, which is what falsified the cross-year hypothesis. This fixture is the evidence for that assertion.',
    url: () => clearanceByNumberUrl('K931783'),
  },
  {
    name: 'openfda-k963126-cross-year',
    note: 'The cross-year control: received 1996, decided 1997. One record whose dates really do straddle a year boundary, so the verifier must report the decision date WITHOUT flagging conflation. Promotes golden future_cases.cross-year-fda-processing to an asserted entry.',
    url: () => clearanceByNumberUrl('K963126'),
  },
  {
    name: 'openfda-aesop-510k',
    note: 'AESOP by device name — all matches, to see K931783 alongside its siblings.',
    url: () => clearanceSearchUrl({ query: 'AESOP', limit: 10 }),
  },
  {
    name: 'openfda-computer-motion-510k',
    note: 'All Computer Motion clearances, to see AESOP in the context of its siblings.',
    url: () => clearanceSearchUrl({ query: 'COMPUTER MOTION', limit: 25 }),
  },
  {
    // CONTROL 1. Proves the PMA endpoint is reachable and returns records at
    // all, with no search clause to get wrong. If this 404s, every other PMA
    // result is uninterpretable.
    name: 'openfda-pma-smoke',
    note: 'CONTROL: PMA endpoint with no search clause. Proves the endpoint works before any PMA absence is believed.',
    url: () => `${OPENFDA_PMA_ENDPOINT}?limit=5`,
    allowError: true,
  },
  {
    // CONTROL 2. Proves the search syntax works on THIS endpoint, using a date
    // range that must match every record. Deliberately free of any device
    // name, so it cannot fail for domain reasons.
    name: 'openfda-pma-syntax-control',
    note: 'CONTROL: PMA search over a date range matching everything. Proves search syntax on the PMA endpoint independently of any device name.',
    url: () => `${OPENFDA_PMA_ENDPOINT}?limit=5&search=decision_date:[19760101+TO+20301231]`,
    allowError: true,
  },
  {
    name: 'openfda-robodoc-pma',
    note: 'ROBODOC PMA. Previously 404. With the controls above, a 404 here becomes evidence of absence rather than an unexplained failure.',
    url: () => approvalSearchUrl({ query: 'ROBODOC', limit: 10 }),
    // openFDA answers "no matches" with 404, so an error body IS the result.
    allowError: true,
  },
  {
    name: 'openfda-davinci-pma',
    note: 'da Vinci PMA, spec §8 expects regulatory_approval 2000-07. Previously 404. If absent here but present in 510k below, the golden row states the wrong event type.',
    url: () => approvalSearchUrl({ query: 'DA VINCI', limit: 10 }),
    allowError: true,
  },
  {
    // The decisive pair. If these devices appear in the 510(k) database with
    // the dates the golden set attributes to a PMA, they were cleared, not
    // approved — the same event-type error the system exists to catch, sitting
    // inside its own golden set.
    name: 'openfda-davinci-510k',
    note: 'DECISIVE: da Vinci in the 510(k) database. A 2000-07 clearance here means spec §8 mislabels a clearance as an approval.',
    url: () => clearanceSearchUrl({ query: 'DA VINCI', limit: 25 }),
    allowError: true,
  },
  {
    name: 'openfda-robodoc-510k',
    note: 'DECISIVE: ROBODOC in the 510(k) database. A 2008 clearance here means the golden ROBODOC PMA row mislabels a clearance as an approval.',
    url: () => clearanceSearchUrl({ query: 'ROBODOC', limit: 25 }),
    allowError: true,
  },
  {
    name: 'openfda-not-found',
    note: 'A query with no matches — openFDA answers 404 with a NOT_FOUND body, not an empty list.',
    url: () => clearanceSearchUrl({ query: 'zzzzznotadevicezzzzz', limit: 5 }),
    allowError: true,
  },
  {
    name: 'crossref-star-2016',
    note: 'STAR supervised autonomous anastomosis, Sci Transl Med 2016 (golden set).',
    url: () => crossrefDoiUrl('10.1126/scitranslmed.aad9398'),
  },
  {
    name: 'crossref-surgical-robotics-search',
    note: 'Representative multi-term literature search.',
    url: () => crossrefSearchUrl({ terms: ['surgical robotics', 'autonomous'], rows: 10 }),
  },
  {
    name: 'arxiv-surgical-robotics',
    note: 'Representative Atom feed — the only XML response in the set.',
    url: () => arxivUrl({ terms: ['surgical robotics', 'autonomous suturing'], maxResults: 10 }),
    accept: 'application/atom+xml',
  },
  {
    name: 'pubmed-esearch-star',
    note: 'esearch step: PMIDs only.',
    url: () => esearchUrl({ terms: ['smart tissue autonomous robot'], retmax: 10 }),
  },
  {
    name: 'pubmed-esummary-star',
    note: 'esummary step. PMIDs are pinned so the fixture stays stable across re-records.',
    url: () => esummaryUrl(['27306664', '35171654']),
  },
  {
    // Previously 404 while wikipedia-disambiguation ("Mercury") returned 200,
    // so the endpoint is fine and the title is wrong: Wikipedia titles are
    // case-sensitive after the first character, and all-caps "ROBODOC" is not
    // the article name. Recording the search response too, rather than
    // guessing the correct casing, so the resolution is evidence.
    name: 'wikipedia-robodoc-search',
    note: 'Resolves the real article title for ROBODOC regardless of casing. Record this first; it tells you what wikipedia-robodoc should ask for.',
    url: () => wikipediaSearchUrl('ROBODOC surgical robot', 5),
    allowError: true,
  },
  {
    name: 'wikipedia-robodoc',
    note: 'Entity aliases and redirect resolution. Sentence case, per Wikipedia title convention. If this 404s, use the title from wikipedia-robodoc-search.',
    url: () => summaryUrl('Robodoc'),
    allowError: true,
  },
  {
    name: 'wikipedia-disambiguation',
    note: 'An ambiguous entity — must be recognizable as a disambiguation page (§8 adversarial inputs).',
    url: () => summaryUrl('Mercury'),
  },
  {
    name: 'patentsview-surgical-robot',
    note: 'Records whatever the endpoint says about credentials — including a 401/403 body.',
    url: () => patentsviewUrl({ text: 'surgical robot', limit: 10 }),
    registry: 'patentsview',
    allowError: true,
  },
];

const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);

if (args.includes('--list')) {
  for (const fixture of FIXTURES) {
    console.log(`${fixture.name.padEnd(34)} ${fixture.note}`);
  }
  process.exit(0);
}

const limiter = new RateLimiter();

/** Real sleep — this script is allowed to take its time; the test suite is not. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extension follows the payload, not the convention. arXiv returns Atom; a
 * feed stored as `.json` misleads every tool and reader that trusts the
 * suffix.
 */
function extensionFor(fixture) {
  return fixture.accept?.includes('xml') === true ? 'xml' : 'json';
}

async function record(fixture) {
  const file = path.join(fixturesDir, `${fixture.name}.${extensionFor(fixture)}`);
  const meta = path.join(fixturesDir, `${fixture.name}.meta.json`);

  if (!force) {
    try {
      await fs.access(file);
      console.log(`skip     ${fixture.name} (exists; --force to re-record)`);
      return 'skipped';
    } catch {
      // Not recorded yet.
    }
  }

  const url = fixture.url();
  const host = RateLimiter.hostOf(url);
  const limit = HOST_LIMITS[host] ?? DEFAULT_HOST_LIMIT;

  await limiter.acquire(url);

  let response;
  let body;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: fixture.accept ?? 'application/json',
        ...(fixture.registry ? credentialHeaders(fixture.registry) : {}),
      },
      redirect: 'follow',
    });
    body = await response.text();
  } catch (err) {
    // A connection failure is categorically different from an HTTP error: we
    // never reached the service, so nothing at all was learned about the
    // query. Reporting both as "FAIL" invites reading a DNS problem as
    // evidence that a record does not exist. Node buries the real cause one
    // level down, so unwrap it.
    const cause = err.cause instanceof Error ? ` (${err.cause.code ?? err.cause.message})` : '';
    console.error(`UNREACHED ${fixture.name}: connection failed: ${err.message}${cause}`);
    console.error(`          ${url}`);
    console.error('          Nothing was recorded and nothing was learned — retry when the host is reachable.');
    return 'unreached';
  }

  if (!response.ok && !fixture.allowError) {
    // We did reach the service. That is a real answer about this query, even
    // though it is not a success — but this fixture did not opt into
    // recording error bodies, so say what was lost.
    console.error(`HTTPFAIL ${fixture.name}: HTTP ${response.status} ${response.statusText}`);
    console.error(`          ${url}`);
    console.error(`          Body not recorded (set allowError to capture it): ${body.slice(0, 160)}`);
    return 'http_error';
  }

  await fs.mkdir(fixturesDir, { recursive: true });

  // Written byte-for-byte as received: no re-serialization, no pretty-printing,
  // not even a trailing newline. A fixture that has been through a formatter is
  // no longer evidence of what the API actually sent, which is the only reason
  // to record one.
  await fs.writeFile(file, body);

  await fs.writeFile(
    meta,
    `${JSON.stringify(
      {
        name: fixture.name,
        note: fixture.note,
        url,
        status: response.status,
        content_type: response.headers.get('content-type'),
        recorded_at: new Date().toISOString(),
        // Byte count and digest of the file as written, so anyone can confirm
        // the recording was never edited by hand.
        bytes: Buffer.byteLength(body),
        sha256: createHash('sha256').update(body).digest('hex'),
        // No request headers are stored: the PatentsView recording would
        // otherwise carry the API key into the repository.
      },
      null,
      2,
    )}\n`,
  );

  console.log(`recorded ${fixture.name} (HTTP ${response.status}, ${Buffer.byteLength(body)} bytes -> ${path.basename(file)})`);

  // Space out same-host requests beyond what the bucket already enforces.
  await sleep(Math.ceil(1000 / limit.refillPerSecond));
  return 'recorded';
}

const selected = only === undefined ? FIXTURES : FIXTURES.filter((f) => f.name === only);
if (selected.length === 0) {
  console.error(`No fixture named "${only}". Run with --list to see the available names.`);
  process.exit(1);
}

const tally = { recorded: 0, skipped: 0, http_error: 0, unreached: 0 };
for (const fixture of selected) {
  tally[await record(fixture)] += 1;
}

console.log(
  `\n${tally.recorded} recorded, ${tally.skipped} skipped, ` +
    `${tally.http_error} http errors (service answered), ${tally.unreached} unreached (never contacted)`,
);
if (tally.unreached > 0) {
  console.log('\nUnreached fixtures tell you nothing about the query — do not read them as absences.');
}

process.exit(tally.http_error + tally.unreached > 0 ? 1 : 0);
