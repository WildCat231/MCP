/**
 * Phase 6: verify_claim (CODEX_SPEC.md §6.1–§6.5, §10.6).
 *
 * The golden set is run against the real verifier here, with the recorded
 * openFDA fixtures standing in for the network. §10.6 makes the ROBODOC
 * negative case the gate for the whole phase.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { claimId } from '../dist/claim.js';
import { RateLimiter } from '../dist/ratelimit.js';
import {
  INDEPENDENCE_FLOOR,
  registrableDomain,
  scoreIndependence,
  sharedAncestors,
} from '../dist/verify/independence.js';
import { parseSuperlative } from '../dist/verify/superlative.js';
import { verifyClaim, worstStatus } from '../dist/verify/verify.js';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(fixturesDir, `${name}.json`), 'utf8');
const golden = JSON.parse(fs.readFileSync(path.join(fixturesDir, '..', 'golden', 'surgical_robotics.json'), 'utf8'));

const NOT_FOUND = '{"error":{"code":"NOT_FOUND","message":"No matches found!"}}';
const EMPTY_ARXIV = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';
const EMPTY_PUBMED = '{"esearchresult":{"idlist":[],"count":"0"}}';
const EMPTY_CROSSREF = '{"message":{"items":[],"total-results":0}}';

function deps(handlers = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    for (const [pattern, respond] of Object.entries(handlers)) {
      if (url.includes(pattern)) {
        const { status = 200, body = '{}' } = respond(url) ?? {};
        return new Response(body, { status, headers: { 'content-type': 'application/json' } });
      }
    }
    // Default: everything quiet. Quiet is a valid answer; a throw is not.
    if (url.includes('arxiv')) return new Response(EMPTY_ARXIV, { status: 200 });
    if (url.includes('eutils')) return new Response(EMPTY_PUBMED, { status: 200 });
    if (url.includes('crossref')) return new Response(EMPTY_CROSSREF, { status: 200 });
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

const withId = (claim) => ({ ...claim, id: claimId(claim) });

// ---------------------------------------------------------------------------
// §6.4 independence
// ---------------------------------------------------------------------------

const source = (url, tier) => ({
  url,
  title: url,
  tier,
  retrieved_at: '2026-08-05T00:00:00Z',
  supports: [{ field: 'date', value: '1993' }],
});

test('registrable domain collapses subdomains but not distinct sites', async () => {
  assert.equal(registrableDomain('https://api.fda.gov/device/510k.json'), 'fda.gov');
  assert.equal(registrableDomain('https://www.accessdata.fda.gov/x'), 'fda.gov');
  assert.equal(registrableDomain('https://doi.org/10.0/x'), 'doi.org');
  assert.equal(registrableDomain('https://sub.example.co.uk/a'), 'example.co.uk');
});

test('a single source scores zero — there is nothing to be independent of', async () => {
  const result = scoreIndependence({ sources: [source('https://api.fda.gov/a', 'primary')] });
  assert.equal(result.score, 0);
  assert.equal(result.corroboration_eligible, false);
  assert.match(result.reason, /Single source/);
});

test('same-domain sources score zero on domain diversity', async () => {
  // Three documents from one publisher are one publisher's decision.
  const result = scoreIndependence({
    sources: [
      source('https://api.fda.gov/a', 'primary'),
      source('https://api.fda.gov/b', 'primary'),
      source('https://api.fda.gov/c', 'primary'),
    ],
  });
  assert.equal(result.domain_component, 0);
  assert.ok(result.score < INDEPENDENCE_FLOOR);
  assert.equal(result.corroboration_eligible, false);
  assert.match(result.reason, /one publisher/);
});

test('two tertiary blogs do not corroborate anything', async () => {
  // §6.4, stated outright.
  const result = scoreIndependence({
    sources: [source('https://blog-one.example/a', 'tertiary'), source('https://blog-two.example/b', 'tertiary')],
  });
  assert.equal(result.has_primary_or_peer_reviewed, false);
  assert.equal(result.corroboration_eligible, false);
  assert.match(result.reason, /tertiary agreement cannot corroborate/);
});

test('a primary plus a peer-reviewed source on separate domains corroborates', async () => {
  const result = scoreIndependence({
    sources: [source('https://api.fda.gov/a', 'primary'), source('https://doi.org/10.0/x', 'secondary')],
  });
  assert.equal(result.domain_component, 1);
  assert.equal(result.tier_component, 0.5);
  assert.ok(result.score >= INDEPENDENCE_FLOOR);
  assert.equal(result.corroboration_eligible, true);
});

test('shared citation ancestors discount the score', async () => {
  const sources = [
    source('https://a.example/1', 'primary'),
    source('https://b.example/2', 'secondary'),
    source('https://c.example/3', 'secondary'),
  ];
  const references = new Map([
    ['https://a.example/1', ['10.0/ancestor']],
    ['https://b.example/2', ['10.0/ancestor']],
    ['https://c.example/3', ['10.0/other']],
  ]);

  const undiscounted = scoreIndependence({ sources });
  const discounted = scoreIndependence({ sources, references });

  assert.deepEqual(discounted.shared_ancestors, ['10.0/ancestor']);
  assert.equal(discounted.discount_applied, true);
  assert.ok(discounted.score < undiscounted.score, 'a common ancestor reduces independence');
  assert.match(discounted.reason, /common origin/);
});

test('absent reference data is not treated as absence of shared ancestors', async () => {
  // We cannot distinguish "cites nothing in common" from "we do not know".
  assert.deepEqual(sharedAncestors([source('https://a.example/1', 'primary')], undefined), []);
  const result = scoreIndependence({ sources: [source('https://a.example/1', 'primary'), source('https://b.example/2', 'secondary')] });
  assert.equal(result.discount_applied, false);
});

// ---------------------------------------------------------------------------
// §6.3 superlative parsing
// ---------------------------------------------------------------------------

test('the superlative category is built with the entity removed', async () => {
  // Searching the category WITH the entity just rediscovers the claimant.
  const parsed = parseSuperlative('first FDA-approved surgical robot', 'ROBODOC');
  assert.equal(parsed.ordinal, 'first');
  assert.ok(!parsed.category.includes('robodoc'));
  assert.ok(parsed.terms.includes('surgical'));
  assert.ok(parsed.terms.includes('robot'));
});

test('an entity embedded in the superlative is stripped', async () => {
  const parsed = parseSuperlative('the first ROBODOC-style orthopaedic system', 'ROBODOC');
  assert.ok(!parsed.category.includes('robodoc'));
});

test('a superlative that reduces to nothing is reported, not silently passed', async () => {
  const parsed = parseSuperlative('the first', 'ROBODOC');
  assert.equal(parsed.terms.length, 0);
});

// ---------------------------------------------------------------------------
// §6.5 severity
// ---------------------------------------------------------------------------

test('overall takes the most severe field status', async () => {
  assert.equal(worstStatus(['corroborated', 'single_source']), 'single_source');
  assert.equal(worstStatus(['corroborated', 'unverified']), 'unverified');
  assert.equal(worstStatus(['contested', 'unverified']), 'contested');
  assert.equal(worstStatus(['refuted', 'contested', 'corroborated']), 'refuted');
  assert.equal(worstStatus([]), 'unverified');
});

// ---------------------------------------------------------------------------
// §6.1 / §6.2 against recorded fixtures
// ---------------------------------------------------------------------------

test('AESOP verifies against its primary record, field by field', async () => {
  const entry = golden.entries.find((e) => e.id === 'aesop-510k-clearance');
  const result = await verifyClaim(
    { claim: withId(entry.claim) },
    {},
    deps({ '510k.json': () => ({ body: fixture('openfda-k931783') }) }),
  );

  assert.deepEqual(result.registries_queried, ['openfda_device']);
  assert.equal(result.fields.event_type.status, 'single_source');
  assert.deepEqual(
    result.fields.date.attested_values.map((v) => v.value),
    ['1993-11-22'],
  );
  assert.equal(result.fields.date.attested_values[0].max_tier, 'primary');
  assert.equal(result.overall, 'single_source', 'one registry record is one source, however primary');
});

test('the 1994 AESOP date is refuted, not merely unverified', async () => {
  // §4's distinction: something WAS attested, and it was not this.
  const entry = golden.refuted.find((e) => e.id === 'aesop-510k-clearance-1994');
  const result = await verifyClaim(
    { claim: withId(entry.claim) },
    {},
    deps({ '510k.json': () => ({ body: fixture('openfda-k931783') }) }),
  );

  assert.equal(result.fields.date.status, 'refuted');
  assert.notEqual(result.fields.date.status, 'unverified');
  assert.equal(result.fields.event_type.status, 'single_source', 'right about what, wrong about when');
  assert.equal(result.overall, 'refuted');
});

test('fields are verified independently — a right entity does not carry a wrong event type', async () => {
  // §6.2's whole purpose. ROBODOC is real and 2008 is real, but the event was
  // a clearance, so an approval claim must fail on event_type alone.
  const claim = withId({
    entity: 'ROBODOC',
    event_type: 'regulatory_approval',
    date: '2008-08-06',
    date_precision: 'day',
    registry: 'openfda_device',
    registry_id: 'K072629',
    description: 'ROBODOC received FDA premarket approval.',
  });

  const result = await verifyClaim(
    { claim },
    {},
    deps({
      '510k.json': () => ({ body: fixture('openfda-robodoc-510k') }),
      'pma.json': () => ({ status: 404, body: fixture('openfda-robodoc-pma') }),
    }),
  );

  assert.equal(result.anchored, true, 'anchored to K072629, so its sibling clearance is not a rival date');
  assert.equal(result.fields.date.status, 'single_source', 'the date checks out');
  assert.equal(result.fields.event_type.status, 'refuted', 'the event type does not');
  assert.equal(result.overall, 'refuted');
  assert.deepEqual(
    result.fields.event_type.attested_values.map((v) => v.value),
    ['regulatory_clearance'],
  );
});

test('the entity-ambiguity trap is caught by the applicant, not the device name', async () => {
  // K935999 is laparoscopic, surgical, named DaVinci and dated 1994 — but its
  // applicant is Da Vinci Medical, Inc., not Intuitive Surgical.
  const entry = golden.adversarial[0];
  const result = await verifyClaim(
    { claim: withId(entry.claim) },
    {},
    deps({ '510k.json': () => ({ body: fixture('openfda-davinci-510k-earliest') }) }),
  );

  // The applicant is the discriminator, and it comes back in entity_candidates
  // rather than as an attested entity value — see recordToSource.
  const applicants = result.entity_candidates.map((c) => c.applicant);
  assert.ok(applicants.some((a) => /Da Vinci Medical/i.test(a ?? '')), 'the real applicant must be visible');
  assert.ok(applicants.some((a) => /Intuitive/i.test(a ?? '')), 'and the one it is confused with');
  assert.ok(applicants.some((a) => /Nova/i.test(a ?? '')), 'and the dental curing light company');

  assert.match(result.warning, /distinct applicants/, 'the ambiguity must be stated, not left to be noticed');
  assert.equal(
    result.fields.entity.status,
    'contested',
    'several entities match the name; the server surfaces that rather than picking one (§2)',
  );
});

test('a registry outage is never reported as an absence', async () => {
  const claim = withId({
    entity: 'ROBODOC',
    event_type: 'regulatory_clearance',
    date: '2008-08-06',
    date_precision: 'day',
    description: 'x',
  });

  const result = await verifyClaim(
    { claim },
    {},
    deps({ '510k.json': () => ({ status: 503, body: 'down' }), 'pma.json': () => ({ status: 503, body: 'down' }) }),
  );

  assert.equal(result.fields.event_type.status, 'unverified');
  assert.notEqual(result.fields.event_type.status, 'refuted', 'an outage disproves nothing');
  assert.match(result.warning, /NOT evidence of absence|not "claim disproved"/);
});

test('nothing found is flagged, never dropped', async () => {
  // §6.5: "Never drop a node for failing verification."
  const claim = withId({
    entity: 'Nonexistent Device 9000',
    event_type: 'regulatory_clearance',
    date: '1999',
    date_precision: 'year',
    description: 'x',
  });

  const result = await verifyClaim({ claim }, {}, deps());
  assert.equal(result.overall, 'unverified');
  assert.ok(result.claim_id, 'the claim is still returned, identified');
  assert.match(result.warning, /not "claim disproved"/);
});

// ---------------------------------------------------------------------------
// §10.6 gate: the ROBODOC negative case
// ---------------------------------------------------------------------------

test('GATE: the ROBODOC negative case does not come back corroborated', async (t) => {
  // §8: "If it returns corroborated, verification is not working and no other
  // feature matters." §10.6 blocks the phase on this.
  const negative = golden.negative;
  const result = await verifyClaim(
    { claim: withId(negative.claim) },
    {},
    deps({
      '510k.json': () => ({ body: fixture('openfda-robodoc-510k') }),
      'pma.json': () => ({ status: 404, body: fixture('openfda-robodoc-pma') }),
    }),
  );

  assert.notEqual(result.overall, 'corroborated');
  assert.equal(result.overall, 'refuted', 'stronger than the contested §8 asks for — no PMA exists at all');
  assert.equal(result.fields.event_type.status, 'refuted');

  t.diagnostic(`overall=${result.overall} event_type=${result.fields.event_type.status}`);
});

test('GATE: the superlative triggers an adversarial search and surfaces rivals', async () => {
  const negative = golden.negative;
  const result = await verifyClaim(
    { claim: withId(negative.claim) },
    {},
    deps({
      // The category search — "surgical robot" with ROBODOC removed — reaches
      // the wider clearance set, where AESOP lives.
      '510k.json': () => ({ body: fixture('openfda-computer-motion-510k') }),
      'pma.json': () => ({ status: 404, body: NOT_FOUND }),
    }),
  );

  assert.ok(result.superlative_detail, 'a superlative must trigger disconfirmation');
  assert.ok(!result.superlative_detail.parsed.category.includes('robodoc'), 'entity removed from the query');

  const claimants = result.superlative_detail.competing_claimants;
  assert.ok(claimants.length > 0, 'rival claimants must surface');
  assert.equal(result.fields.superlative.status, 'contested', '§6.3: any rival makes it contested, full stop');
  assert.ok(
    claimants.some((c) => /computer motion/i.test(c.entity)),
    'AESOP\'s applicant should appear among the rivals',
  );

  // Earliest first: the strongest threat to a "first" claim leads.
  const dates = claimants.map((c) => c.date ?? '9999');
  assert.deepEqual([...dates].sort(), dates);
});

test('a claim without a superlative skips disconfirmation entirely', async () => {
  const entry = golden.entries.find((e) => e.id === 'aesop-510k-clearance');
  const result = await verifyClaim(
    { claim: withId(entry.claim) },
    {},
    deps({ '510k.json': () => ({ body: fixture('openfda-k931783') }) }),
  );
  assert.equal(result.superlative_detail, undefined);
  assert.equal(result.fields.superlative, undefined);
});

// ---------------------------------------------------------------------------
// Phase boundaries and determinism
// ---------------------------------------------------------------------------

test('conflation is declared not-implemented rather than reported as false', async () => {
  // §6.6 is Phase 7. Reporting suspected:false as if a check had run would be
  // a quiet lie about what was tested.
  const entry = golden.entries.find((e) => e.id === 'aesop-510k-clearance');
  const result = await verifyClaim(
    { claim: withId(entry.claim) },
    {},
    deps({ '510k.json': () => ({ body: fixture('openfda-k931783') }) }),
  );
  assert.equal(result.conflation.suspected, false);
  assert.match(result.warning, /Conflation detection \(§6\.6\) is not implemented/);
});

test('verification is deterministic across repeated runs', async () => {
  // §8 determinism requirement, against fixtures.
  const entry = golden.entries.find((e) => e.id === 'aesop-510k-clearance');
  // Timestamps are inherently per-run and appear on every nested Source too,
  // so they are stripped recursively; §8's requirement is that the FINDINGS be
  // byte-identical, not that the clock stand still.
  const stripTimestamps = (value) =>
    JSON.stringify(value, (key, v) => (key === 'retrieved_at' ? null : v));

  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    const result = await verifyClaim(
      { claim: withId(entry.claim) },
      {},
      deps({ '510k.json': () => ({ body: fixture('openfda-k931783') }) }),
    );
    runs.push(stripTimestamps(result));
  }
  assert.equal(new Set(runs).size, 1, 'three runs must be byte-identical');
});
