/**
 * Phase 7: conflation detection (CODEX_SPEC.md §6.6).
 *
 * The detector is exercised primarily against ENTITY conflation, because that
 * is the bimodality this data actually contains. The spec anticipated a date
 * case on AESOP; the primary record falsified it, and the negative tests below
 * pin that down so nobody re-adds a rule to make it fire.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { claimId } from '../dist/claim.js';
import { RateLimiter } from '../dist/ratelimit.js';
import {
  ALIAS_DIVERGENCE_MAX,
  ALIAS_DIVERGENCE_MIN,
  DATE_GAP_YEARS,
  MIN_SOURCES_PER_MODE,
  checkAliasDrift,
  checkAttribution,
  checkDates,
  checkEventTypes,
  clusterDates,
  compareTokens,
  detectConflation,
  tokenSimilarity,
} from '../dist/verify/conflation.js';
import { verifyClaim } from '../dist/verify/verify.js';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(fixturesDir, `${name}.json`), 'utf8');
const golden = JSON.parse(fs.readFileSync(path.join(fixturesDir, '..', 'golden', 'surgical_robotics.json'), 'utf8'));

const NOT_FOUND = '{"error":{"code":"NOT_FOUND","message":"No matches found!"}}';

function deps(handlers = {}) {
  const fetch = async (url) => {
    for (const [pattern, respond] of Object.entries(handlers)) {
      if (url.includes(pattern)) {
        const { status = 200, body = '{}' } = respond(url) ?? {};
        return new Response(body, { status, headers: { 'content-type': 'application/json' } });
      }
    }
    if (url.includes('arxiv')) return new Response('<?xml version="1.0"?><feed/>', { status: 200 });
    if (url.includes('eutils')) return new Response('{"esearchresult":{"idlist":[],"count":"0"}}', { status: 200 });
    if (url.includes('crossref')) return new Response('{"message":{"items":[],"total-results":0}}', { status: 200 });
    return new Response(NOT_FOUND, { status: 404 });
  };
  return {
    fetch,
    limiter: new RateLimiter({
      clock: { now: () => Date.parse('2026-08-05T00:00:00Z'), sleep: async () => {} },
      limits: {},
      fallback: { capacity: Number.MAX_SAFE_INTEGER, refillPerSecond: Number.MAX_SAFE_INTEGER },
    }),
  };
}

const value = (v, n) => ({ value: v, source_count: n, max_tier: 'primary' });
const withId = (claim) => ({ ...claim, id: claimId(claim) });

// ---------------------------------------------------------------------------
// The entity case that actually exists in this data
// ---------------------------------------------------------------------------

test('three companies sharing "DA VINCI" is detected as entity conflation', async () => {
  // Two organizations hold two records each; a third holds one. §6.6's shape
  // exactly: >=2 modes, >=2 sources per mode, cleanly separated.
  const check = checkAttribution([
    value('Da Vinci Medical, Inc.', 2),
    value('Intuitive Surgical, Inc.', 2),
    value('Nova/Da Vinci Systems, Inc.', 1),
  ]);

  assert.equal(check.suspected, true);
  assert.equal(check.modes.length, 2, 'the single-record organization is scatter, not a mode');
  assert.deepEqual(check.modes.map((m) => m.value).sort(), [
    'Da Vinci Medical, Inc.',
    'Intuitive Surgical, Inc.',
  ]);
  assert.match(check.reason, /shared name is not a shared entity/);
  assert.match(check.reason, /1 more hold one each/, 'the scatter is still reported');
});

test('device names alone would find nothing — which is why attribution is the key', async () => {
  // "DAVINCI CHOLANGIOGRAM DELIVERY DEVICE" and "INTUITIVE SURGICAL DA VINCI
  // ENDOSCOPIC CONTROL SYSTEM" share almost no tokens. Clustering on names
  // yields singletons and misses a real conflation entirely.
  assert.ok(
    tokenSimilarity('DAVINCI CHOLANGIOGRAM DELIVERY DEVICE', 'INTUITIVE SURGICAL DA VINCI ENDOSCOPIC CONTROL SYSTEM') <
      ALIAS_DIVERGENCE_MIN,
    'name similarity is below the drift band, so alias drift cannot catch this case',
  );

  const byName = checkAliasDrift([
    value('DAVINCI CHOLANGIOGRAM DELIVERY DEVICE', 1),
    value('INTUITIVE SURGICAL DA VINCI ENDOSCOPIC CONTROL SYSTEM', 1),
  ]);
  assert.equal(byName.suspected, false, 'names miss it');

  const byOrg = checkAttribution([value('Da Vinci Medical, Inc.', 2), value('Intuitive Surgical, Inc.', 2)]);
  assert.equal(byOrg.suspected, true, 'attribution catches it');
});

test('END TO END: the unanchored da Vinci claim reports entity conflation', async () => {
  // K935999 is the adversarial golden entry: laparoscopic, surgical, named
  // DaVinci, dated 1994 — and a different company.
  const entry = golden.adversarial[0];
  const result = await verifyClaim(
    { claim: withId(entry.claim) },
    {},
    deps({ '510k.json': () => ({ body: fixture('openfda-davinci-510k-earliest') }) }),
  );

  assert.equal(result.conflation.suspected, true);
  assert.equal(result.conflation.evidence.field, 'entity');
  assert.ok(result.conflation.evidence.modes.length >= 2);

  const orgs = result.conflation.evidence.modes.map((m) => m.value);
  assert.ok(orgs.some((o) => /Da Vinci Medical/i.test(o)));
  assert.ok(orgs.some((o) => /Intuitive/i.test(o)));

  // And it matches what the golden set says should happen.
  assert.equal(entry.expect.conflation.suspected, true);
  assert.equal(entry.expect.conflation.field, 'entity');
});

test('the conflation evidence is evidence, not a question', async () => {
  // §6.6: "Do not ask the clarifying question yourself."
  const entry = golden.adversarial[0];
  const result = await verifyClaim(
    { claim: withId(entry.claim) },
    {},
    deps({ '510k.json': () => ({ body: fixture('openfda-davinci-510k-earliest') }) }),
  );

  const reason = result.conflation.evidence.reason;
  assert.ok(!reason.includes('?'), 'no question is posed to the caller');
  assert.match(reason, /not decided here/, 'and the decision is explicitly deferred');
});

// ---------------------------------------------------------------------------
// The date case the spec expected, which no longer exists
// ---------------------------------------------------------------------------

test('AESOP does NOT report a bimodal date — the registry settled it', async () => {
  // The spec predicted this would fire. K931783 shows received 1993-04-09 and
  // decided 1993-11-22, both within one year. There is no second mode, and a
  // detector tuned to invent one would be wrong.
  const entry = golden.entries.find((e) => e.id === 'aesop-510k-clearance');
  const result = await verifyClaim(
    { claim: withId(entry.claim) },
    {},
    deps({ '510k.json': () => ({ body: fixture('openfda-k931783') }) }),
  );

  assert.equal(result.conflation.suspected, false);
  const dateCheck = result.conflation_checks.find((c) => c.field === 'date');
  assert.equal(dateCheck.suspected, false);
  assert.equal(entry.expect.conflation.suspected, false, 'and the golden set agrees');
});

test('a cross-year record is one event, not two modes', async () => {
  // K963126: received 1996-08-12, decided 1997-04-07. Two dates, one
  // lifecycle. A detector firing here would fire across most of openFDA.
  const control = golden.cross_year_control;
  assert.equal(control.expect.conflation.suspected, false);

  // Only the decision date is ever attested, so there is one value to cluster.
  const check = checkDates([value(control.decision_date, 1)]);
  assert.equal(check.suspected, false);
  assert.match(check.reason, /single cluster/);
});

test('ROBODOC two clearances six years apart are two events, not a conflated one', async () => {
  // 2008-08-06 and 2014-05-27 exceed the 3-year gap, but each is backed by one
  // record. §6.6's >=2-sources-per-mode rule is what stops this false positive.
  const check = checkDates([value('2008-08-06', 1), value('2014-05-27', 1)]);
  assert.equal(check.suspected, false);
  assert.match(check.reason, /Scatter, not conflation/);
});

// ---------------------------------------------------------------------------
// Date detector — synthetic, since the real data no longer exercises it
// ---------------------------------------------------------------------------

test('the date gap threshold is the 3 years the spec specifies', async () => {
  assert.equal(DATE_GAP_YEARS, 3);
  assert.equal(MIN_SOURCES_PER_MODE, 2);
});

test('dates cluster by gap, deterministically', async () => {
  const modes = clusterDates([value('1993', 2), value('1994', 1), value('2008', 2), value('2009', 1)]);
  assert.equal(modes.length, 2);
  assert.equal(modes[0].sources, 3);
  assert.equal(modes[1].sources, 3);

  // Input order must not matter — §8 requires byte-identical repeat runs.
  const reversed = clusterDates([value('2009', 1), value('1994', 1), value('2008', 2), value('1993', 2)]);
  assert.deepEqual(reversed.map((m) => m.minYear), modes.map((m) => m.minYear));
});

test('two tight, well-separated, well-sourced modes are flagged', async () => {
  const check = checkDates([value('1993', 3), value('1993-11', 2), value('2008', 4), value('2008-08', 2)]);
  assert.equal(check.suspected, true);
  assert.equal(check.modes.length, 2);
  assert.match(check.reason, /Bimodal-with-tight-modes/);
});

test('internally loose clumps are scatter, not conflation', async () => {
  // §6.6: "Wide scatter means ordinary source noise." Two clumps that each
  // span several years are scatter with a hole in it, not two tight events.
  const check = checkDates([
    value('1990', 2), value('1991', 2), value('1992', 2),
    value('2005', 2), value('2006', 2), value('2007', 2),
  ]);
  assert.equal(check.suspected, false);
  assert.match(check.reason, /span more than 1 year\(s\) internally/);
});

test('four tight well-sourced modes still count — merging is not limited to two', async () => {
  // §6.6 says ">=2 modes", not "exactly 2". Three or four labels merged under
  // one name is rarer but not different in kind.
  const check = checkDates([value('1990', 2), value('1994', 2), value('2005', 2), value('2009', 2)]);
  assert.equal(check.suspected, true);
  assert.equal(check.modes.length, 4);
});

test('a gap inside the tolerance stays one mode', async () => {
  const check = checkDates([value('1993', 3), value('1995', 3)]);
  assert.equal(check.suspected, false);
  assert.match(check.reason, /single cluster/);
});

// ---------------------------------------------------------------------------
// Alias drift — the STAR case
// ---------------------------------------------------------------------------

test('STAR alias drift sits inside the divergence band and is flagged', async () => {
  // "Smart Tissue Anastomosis Robot" (2014) vs "Smart Tissue Autonomous Robot"
  // (2022): materially different systems whose shared acronym makes sources
  // appear to corroborate each other across a decade.
  const similarity = tokenSimilarity('Smart Tissue Anastomosis Robot', 'Smart Tissue Autonomous Robot');
  assert.ok(similarity > ALIAS_DIVERGENCE_MIN && similarity < ALIAS_DIVERGENCE_MAX, `similarity ${similarity}`);

  const check = checkAliasDrift([
    value('Smart Tissue Anastomosis Robot', 2),
    value('Smart Tissue Autonomous Robot', 2),
  ]);
  assert.equal(check.suspected, true);
  assert.match(check.reason, /entity drift/);
  assert.match(check.reason, /appear to corroborate/);
});

test('the two golden STAR entries are the real-world instance of that drift', async () => {
  const star = golden.entries.filter((e) => e.claim.entity === 'STAR');
  const expansions = star.map((e) => e.claim.entity_aliases[0]);
  const similarity = tokenSimilarity(expansions[0], expansions[1]);
  assert.ok(similarity > ALIAS_DIVERGENCE_MIN && similarity < ALIAS_DIVERGENCE_MAX);

  // Each entry on its own must stay clean — they are two real events, and
  // flagging either individually would be wrong.
  for (const entry of star) assert.equal(entry.expect.conflation.suspected, false);
});

test('near-identical phrasings are not drift', async () => {
  // Punctuation and case differences normalize to one expansion, so there is
  // nothing to compare — which is the correct answer, not a missed detection.
  const check = checkAliasDrift([
    value('Smart Tissue Autonomous Robot', 2),
    value('smart-tissue autonomous robot', 1),
  ]);
  assert.equal(check.suspected, false);
  assert.match(check.reason, /Fewer than two distinct expansions/);

  // A genuinely distinct but near-identical phrasing is also not drift.
  // And one phrase merely being MORE SPECIFIC than another is not drift, even
  // though it scores higher (0.8) than the real STAR drift case (0.6).
  const moreSpecific = compareTokens('Smart Tissue Autonomous Robot', 'Smart Tissue Autonomous Robot system');
  assert.ok(moreSpecific.similarity > ALIAS_DIVERGENCE_MIN);
  assert.equal(moreSpecific.mutually_exclusive, false, 'containment, not divergence');
  assert.equal(
    checkAliasDrift([value('Smart Tissue Autonomous Robot', 2), value('Smart Tissue Autonomous Robot system', 1)])
      .suspected,
    false,
    'similarity alone would have flagged this — mutual exclusivity is what saves it',
  );
});

test('drift requires each phrase to carry a word the other lacks', async () => {
  // The STAR pair does; each names a different function for the same acronym.
  const star = compareTokens('Smart Tissue Anastomosis Robot', 'Smart Tissue Autonomous Robot');
  assert.deepEqual(star.left_only, ['anastomosis']);
  assert.deepEqual(star.right_only, ['autonomous']);
  assert.equal(star.mutually_exclusive, true);
  assert.ok(star.similarity < 0.8, 'and it scores LOWER than the harmless more-specific pair');
});

test('an openFDA-truncated device name is not treated as a different expansion', async () => {
  // openFDA truncates device_name at ~50 chars, so the AESOP record ends
  // "...FOR OPTIMAL POS". Reading that as a materially different expansion of
  // "...for Optimal Positioning" was a false positive with no signal in it.
  const similarity = tokenSimilarity(
    'AESOP (AUTOMATED ENDOSCOPIC SYSTEM FOR OPTIMAL POS',
    'Automated Endoscopic System for Optimal Positioning',
    ['AESOP'],
  );
  assert.ok(similarity > ALIAS_DIVERGENCE_MAX, `truncation must not read as divergence (got ${similarity})`);
});

test('the entity name itself is excluded from expansion comparison', async () => {
  // Whether an expansion repeats the abbreviation it expands says nothing
  // about whether two expansions differ.
  const withAcronym = tokenSimilarity('STAR Smart Tissue Autonomous Robot', 'Smart Tissue Autonomous Robot', ['STAR']);
  assert.equal(withAcronym, 1);
});

test('unrelated names are two entities, not one drifting label', async () => {
  const check = checkAliasDrift([value('Automated Endoscopic System for Optimal Positioning', 2), value('ROBODOC', 2)]);
  assert.equal(check.suspected, false);
});

// ---------------------------------------------------------------------------
// Event type
// ---------------------------------------------------------------------------

test('two well-sourced event types under one label is conflation', async () => {
  // The clearance/approval merge, if sources rather than the registry were
  // supplying the evidence.
  const check = checkEventTypes([value('regulatory_clearance', 3), value('regulatory_approval', 2)]);
  assert.equal(check.suspected, true);
  assert.match(check.reason, /One label is covering two kinds of event/);
});

test('one stray event type is not conflation', async () => {
  const check = checkEventTypes([value('regulatory_clearance', 4), value('regulatory_approval', 1)]);
  assert.equal(check.suspected, false);
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

test('clean checks are still reported, so "checked" differs from "not checked"', async () => {
  const result = detectConflation({ dates: [value('1993', 2)] });
  assert.equal(result.suspected, false);
  assert.deepEqual(
    result.checks.map((c) => c.field).sort(),
    ['date', 'entity', 'entity_aliases', 'event_type'],
  );
  for (const check of result.checks) assert.ok(check.reason, `${check.field} must explain itself`);
});

test('an empty input suspects nothing', async () => {
  const result = detectConflation({});
  assert.equal(result.suspected, false);
  assert.equal(result.evidence, undefined);
});
