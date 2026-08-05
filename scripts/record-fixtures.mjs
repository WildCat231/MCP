#!/usr/bin/env node
/**
 * Record real API responses into test/fixtures/.
 *
 * Spec §8: "Record real API responses once, commit them, replay them in
 * tests." This script is the "once". It is the ONLY thing in this repository
 * that is expected to touch the network, and it is never run by `npm test`.
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

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'test', 'fixtures');
const dist = (name) => import(path.join(repoRoot, 'dist', name));

const { arxivUrl } = await dist('sources/arxiv.js');
const { crossrefSearchUrl, crossrefDoiUrl } = await dist('sources/crossref.js');
const { esearchUrl, esummaryUrl } = await dist('sources/pubmed.js');
const { clearanceSearchUrl, approvalSearchUrl } = await dist('sources/openfda.js');
const { summaryUrl } = await dist('sources/wikipedia.js');
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
    name: 'openfda-aesop-510k',
    note: 'AESOP 510(k) — the clearance half of the ROBODOC/AESOP conflation case.',
    url: () => clearanceSearchUrl({ query: 'AESOP', limit: 10 }),
  },
  {
    name: 'openfda-computer-motion-510k',
    note: 'All Computer Motion clearances, to see AESOP in the context of its siblings.',
    url: () => clearanceSearchUrl({ query: 'COMPUTER MOTION', limit: 25 }),
  },
  {
    name: 'openfda-robodoc-pma',
    note: 'ROBODOC PMA — the approval half. Must be a separate record with a separate date.',
    url: () => approvalSearchUrl({ query: 'ROBODOC', limit: 10 }),
  },
  {
    name: 'openfda-davinci-pma',
    note: 'da Vinci PMA, golden-set entry (expected 2000-07).',
    url: () => approvalSearchUrl({ query: 'DA VINCI', limit: 10 }),
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
    name: 'wikipedia-robodoc',
    note: 'Entity aliases and redirect resolution.',
    url: () => summaryUrl('ROBODOC'),
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

async function record(fixture) {
  const file = path.join(fixturesDir, `${fixture.name}.json`);
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
    console.error(`FAIL     ${fixture.name}: ${err.message}`);
    return 'failed';
  }

  if (!response.ok && !fixture.allowError) {
    console.error(`FAIL     ${fixture.name}: HTTP ${response.status}`);
    return 'failed';
  }

  await fs.mkdir(fixturesDir, { recursive: true });
  await fs.writeFile(file, body.endsWith('\n') ? body : `${body}\n`);
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
        // No request headers are stored: the PatentsView recording would
        // otherwise carry the API key into the repository.
      },
      null,
      2,
    )}\n`,
  );

  console.log(`recorded ${fixture.name} (HTTP ${response.status}, ${body.length} bytes)`);

  // Space out same-host requests beyond what the bucket already enforces.
  await sleep(Math.ceil(1000 / limit.refillPerSecond));
  return 'recorded';
}

const selected = only === undefined ? FIXTURES : FIXTURES.filter((f) => f.name === only);
if (selected.length === 0) {
  console.error(`No fixture named "${only}". Run with --list to see the available names.`);
  process.exit(1);
}

const tally = { recorded: 0, skipped: 0, failed: 0 };
for (const fixture of selected) {
  tally[await record(fixture)] += 1;
}

console.log(`\n${tally.recorded} recorded, ${tally.skipped} skipped, ${tally.failed} failed`);
process.exit(tally.failed > 0 ? 1 : 0);
