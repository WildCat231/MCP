/**
 * Golden-set contract (CODEX_SPEC.md §8).
 *
 * The verifier does not exist yet (§10.6), so these tests do not run claims
 * through it. What they do is lock the golden set's own shape — above all that
 * every entry states `date_precision` and that the stated precision matches
 * the granularity of its date string.
 *
 * That matters before Phase 6 rather than after: precision is a claim in its
 * own right. A verifier that pads "1985" to "1985-01-01" manufactures a
 * disagreement no source expressed, and one that coarsens da Vinci's "2000-07"
 * to "2000" discards information the sources carry. If the expectations
 * themselves are sloppy about precision, neither error is detectable.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { claimId, claimIdBasis } from '../dist/claim.js';
import { normalizeDate } from '../dist/dates.js';
import { REGISTRY_NAMES } from '../dist/types.js';
import { EVENT_TYPES, STATUS_SEVERITY } from '../dist/types.js';

const goldenPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'golden',
  'surgical_robotics.json',
);
const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));

const PRECISION_PATTERN = {
  year: /^\d{4}$/,
  month: /^\d{4}-\d{2}$/,
  day: /^\d{4}-\d{2}-\d{2}$/,
};

const STATUSES = Object.keys(STATUS_SEVERITY);

/** Every asserted entry: the positives, the refuted set, and the negative. */
function allEntries() {
  return [...golden.entries, ...golden.refuted, golden.negative];
}

/** Field expectations that carry a status, for the §6.5 severity check. */
const STATUS_FIELDS = ['date', 'event_type', 'superlative'];

/** Assert a date string and its declared precision agree. */
function assertPrecision(date, precision, label) {
  assert.ok(precision !== undefined, `${label}: date_precision is missing`);
  assert.ok(
    Object.prototype.hasOwnProperty.call(PRECISION_PATTERN, precision),
    `${label}: "${precision}" is not a valid precision`,
  );
  assert.match(date, PRECISION_PATTERN[precision], `${label}: "${date}" is not ${precision} precision`);

  // Cross-check against the parser the pipeline will actually use, so the
  // fixture and the implementation cannot drift apart.
  const parsed = normalizeDate(date);
  assert.ok(parsed !== undefined, `${label}: "${date}" does not parse`);
  assert.equal(parsed.precision, precision, `${label}: normalizeDate disagrees about precision`);
  assert.equal(parsed.date, date, `${label}: normalizeDate rewrites the date`);
}

test('the golden set covers every row the spec lists, plus the negative', async () => {
  assert.equal(golden.entries.length, 7, '§8 lists seven positive rows');
  assert.ok(golden.negative, 'the negative case is required, not optional');

  const ids = allEntries().map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'entry ids must be unique');
});

test('every claim declares a date_precision that matches its date', async () => {
  for (const entry of allEntries()) {
    assertPrecision(entry.claim.date, entry.claim.date_precision, `claim ${entry.id}`);
  }
});

test('every expected date mode carries its own precision, and it matches', async () => {
  // Precision is per-mode, not per-field. A contested date can hold modes of
  // different granularity — da Vinci's registry mode is a day while the
  // disputed spec mode is a month — and a single field-level precision would
  // either invent precision for the coarse mode or discard it from the fine
  // one.
  for (const entry of allEntries()) {
    const expected = entry.expect.date;
    assert.ok(expected, `${entry.id}: expect.date is required`);
    assert.ok(expected.precision !== undefined, `${entry.id}: expect.date.precision is required`);

    for (const mode of expected.modes ?? []) {
      assert.equal(typeof mode, 'object', `${entry.id}: modes must be {value, precision}`);
      assertPrecision(mode.value, mode.precision, `${entry.id} mode "${mode.value}"`);
    }
  }
});

test('the declared field precision is one of the modes actual precisions', async () => {
  for (const entry of allEntries()) {
    const expected = entry.expect.date;
    const modes = expected.modes ?? [];
    if (modes.length === 0) continue;
    assert.ok(
      modes.some((m) => m.precision === expected.precision),
      `${entry.id}: field precision ${expected.precision} matches no mode`,
    );
  }
});

test('expected precision is never finer than the claim states', async () => {
  // A verifier may legitimately coarsen (sources disagreed below year level)
  // but must never sharpen — that would mean inventing a day nobody attested.
  const rank = { year: 0, month: 1, day: 2 };
  for (const entry of allEntries()) {
    assert.ok(
      rank[entry.expect.date.precision] <= rank[entry.claim.date_precision],
      `${entry.id}: expected precision ${entry.expect.date.precision} is finer than the claim's ${entry.claim.date_precision}`,
    );
  }
});

test('all three precisions are exercised somewhere in the set', async () => {
  // Year, month and day must each appear, or a verifier that mishandles one of
  // them passes the whole golden set. Month now survives only inside da
  // Vinci's disputed mode, which is precisely why per-mode precision matters.
  const precisions = new Set();
  for (const entry of allEntries()) {
    precisions.add(entry.claim.date_precision);
    for (const mode of entry.expect.date.modes ?? []) precisions.add(mode.precision);
  }
  assert.deepEqual([...precisions].sort(), ['day', 'month', 'year']);

  const davinci = golden.entries.find((e) => e.id === 'da-vinci-clearance');
  const monthMode = davinci.expect.date.modes.find((m) => m.precision === 'month');
  assert.equal(monthMode.value, '2000-07', "the spec's month-precision date is retained as a disputed mode");
});

test('every event_type and status is one the type system knows', async () => {
  for (const entry of allEntries()) {
    assert.ok(
      EVENT_TYPES.includes(entry.claim.event_type),
      `${entry.id}: "${entry.claim.event_type}" is not an EventType`,
    );
    assert.ok(STATUSES.includes(entry.expect.overall), `${entry.id}: bad overall status`);

    for (const field of STATUS_FIELDS) {
      const expectation = entry.expect[field];
      if (expectation?.status !== undefined) {
        assert.ok(STATUSES.includes(expectation.status), `${entry.id}.${field}: bad status`);
      }
    }
  }
});

test('overall is the most severe field status, per §6.5', async () => {
  for (const entry of allEntries()) {
    const fieldStatuses = STATUS_FIELDS
      .map((f) => entry.expect[f]?.status)
      .filter((s) => s !== undefined);

    const worst = fieldStatuses.reduce((a, b) => (STATUS_SEVERITY[b] > STATUS_SEVERITY[a] ? b : a));
    assert.equal(
      entry.expect.overall,
      worst,
      `${entry.id}: overall should be ${worst}, the most severe of ${fieldStatuses.join(', ')}`,
    );
  }
});

test('the clearance/approval distinction is still exercised — now from the other side', async () => {
  // It used to be exercised by holding a clearance and an approval side by
  // side. The registry showed there is no approval to hold: every real device
  // here was cleared. So the distinction is now exercised by the negative
  // case, which asserts an approval that does not exist and must be refuted.
  const byType = golden.entries.reduce((acc, e) => {
    acc[e.claim.event_type] = (acc[e.claim.event_type] ?? 0) + 1;
    return acc;
  }, {});
  assert.ok(byType.regulatory_clearance >= 3, 'AESOP, ROBODOC and da Vinci are all clearances');
  assert.equal(byType.regulatory_approval, undefined, 'no real entry claims an approval any more');

  assert.equal(golden.negative.claim.event_type, 'regulatory_approval');
  assert.equal(golden.negative.expect.event_type.status, 'refuted');

  // ROBODOC still appears twice: a 1992 clinical use and a 2008 clearance.
  const robodoc = golden.entries.filter((e) => e.claim.entity === 'ROBODOC');
  assert.equal(robodoc.length, 2);
  assert.deepEqual(
    robodoc.map((e) => `${e.claim.event_type}:${e.claim.date}`).sort(),
    ['first_clinical_use:1992', 'regulatory_clearance:2008-08-06'],
  );
});

test('AESOP resolves to the primary record, not to a bimodal date', async () => {
  // The spec predicted "contested (date bimodal), 1993–1994". K931783 shows
  // received 1993-04-09 and decided 1993-11-22 — both in 1993 — so there is no
  // bimodal distribution. §6.1 registry-first is exactly this: the primary
  // record outranks the secondary-source disagreement.
  const aesop = golden.entries.find((e) => e.id === 'aesop-510k-clearance');
  assert.equal(aesop.claim.registry_id, 'K931783');
  assert.equal(aesop.claim.registry, 'openfda_device');
  assert.equal(aesop.claim.date, '1993-11-22');
  assert.equal(aesop.claim.date_precision, 'day');

  assert.equal(aesop.expect.date.status, 'corroborated');
  assert.deepEqual(aesop.expect.date.modes, [{ value: '1993-11-22', precision: 'day' }]);
  assert.equal(aesop.expect.conflation.suspected, false, 'no conflation to detect');
  assert.equal(aesop.expect.event_type.status, 'corroborated');
});

test('the deviation from spec §8 is recorded rather than silently applied', async () => {
  // The spec is the contract; departing from it on evidence is legitimate,
  // departing from it quietly is not.
  const deviation = golden.deviations_from_spec.find((d) => d.entry === 'aesop-510k-clearance');
  assert.ok(deviation, 'the AESOP change must be declared');
  assert.match(deviation.spec_says, /contested/);
  assert.match(deviation.this_file_says, /corroborated/);
  assert.match(deviation.why, /K931783/);
  assert.ok(deviation.source, 'the evidence must be attributed');
});

test('the 1994 AESOP claim is refuted, not merely unverified', async () => {
  // §4 distinguishes them: "unverified" is nothing found, "refuted" is sources
  // actively contradicting. K931783's dates contradict 1994 outright.
  const refuted = golden.refuted.find((e) => e.id === 'aesop-510k-clearance-1994');
  assert.ok(refuted, 'the refuted variant is required');
  assert.equal(refuted.claim.date, '1994');
  assert.equal(refuted.expect.overall, 'refuted');
  assert.equal(refuted.expect.date.status, 'refuted');
  assert.notEqual(refuted.expect.date.status, 'unverified');

  // Right about what happened, wrong about when.
  assert.equal(refuted.expect.event_type.status, 'corroborated');
  assert.equal(refuted.expect.conflation.suspected, false);
});

test('refuted is exercised at least once — it is the most severe status', async () => {
  const statuses = allEntries().map((e) => e.expect.overall);
  assert.ok(statuses.includes('refuted'), 'a golden set with no refuted case cannot detect a false claim');
});

test('the two AESOP claims share a claim id because they share a record', async () => {
  // The point of the registry anchor: one event with a disputed date, not two
  // events. A verifier that splits them renders one clearance twice.
  const correct = golden.entries.find((e) => e.id === 'aesop-510k-clearance').claim;
  const wrong = golden.refuted.find((e) => e.id === 'aesop-510k-clearance-1994').claim;

  assert.notEqual(correct.date, wrong.date, 'the dates differ');
  assert.equal(claimId(correct), claimId(wrong), 'yet they are the same event');
  assert.equal(claimIdBasis(correct), 'registry_anchor');

  // Stated in the file too, so the expectation is visible without running this.
  const declared = golden.refuted.find((e) => e.id === 'aesop-510k-clearance-1994').expect.same_claim_id_as;
  assert.equal(declared, 'aesop-510k-clearance');
});

test('unanchored claims still fall back to the §4 entity+date rule', async () => {
  const puma = golden.entries.find((e) => e.id === 'puma-560-first-clinical-use').claim;
  assert.equal(puma.registry_id, undefined, 'no primary record resolved for this one');
  assert.equal(claimIdBasis(puma), 'entity_date');

  // And under that rule the date DOES distinguish, as §4 specifies.
  assert.notEqual(claimId(puma), claimId({ ...puma, date: '1986' }));
});

test('any entry with a registry_id names a real registry', async () => {
  for (const entry of allEntries()) {
    const { registry, registry_id: recordId } = entry.claim;
    if (recordId === undefined && registry === undefined) continue;
    assert.ok(recordId, `${entry.id}: registry without registry_id`);
    assert.ok(registry, `${entry.id}: registry_id without a registry — not an identifier`);
    assert.ok(REGISTRY_NAMES.includes(registry), `${entry.id}: "${registry}" is not a registry`);
  }
});

test('no golden entry claims regulatory_approval any more', async () => {
  // The PMA controls settled it: neither ROBODOC nor da Vinci has a PMA
  // record, and the PMA query path is proven working. Spec §8 asserted
  // approvals for both — the same clearance-vs-approval error the negative
  // case exists to catch, sitting in the golden set built to detect it.
  for (const entry of allEntries()) {
    if (entry.id === 'robodoc-1992-first-fda-approved') continue; // the negative asserts it on purpose
    assert.notEqual(
      entry.claim.event_type,
      'regulatory_approval',
      `${entry.id} still claims an approval that no PMA record supports`,
    );
  }
});

test('both corrected rows are anchored to their K numbers', async () => {
  const robodoc = golden.entries.find((e) => e.id === 'robodoc-2008-clearance');
  assert.equal(robodoc.claim.event_type, 'regulatory_clearance');
  assert.equal(robodoc.claim.registry_id, 'K072629');
  assert.equal(robodoc.claim.date, '2008-08-06');
  assert.equal(robodoc.claim.date_precision, 'day');
  assert.equal(robodoc.expect.overall, 'corroborated', 'complete result set, so fully settled');

  const davinci = golden.entries.find((e) => e.id === 'da-vinci-clearance');
  assert.equal(davinci.claim.event_type, 'regulatory_clearance');
  assert.equal(davinci.claim.registry_id, 'K002489');
});

test('the resolved disputes record what changed and on what evidence', async () => {
  assert.equal(golden.resolved_disputes.length, 2);
  for (const resolved of golden.resolved_disputes) {
    assert.match(resolved.was, /regulatory_approval/);
    assert.match(resolved.now, /regulatory_clearance/);
    assert.match(resolved.resolved_by, /openfda-pma-smoke/, 'the control that made the absence readable');
  }
});

test("da Vinci's date stays disputed — a truncated page cannot establish an earliest", async () => {
  // 25 of 115 records in openFDA's default unspecified order, and the oldest
  // is not in that page. Asserting 2001-03-02 as THE clearance date would
  // repeat, smaller, the error this whole exercise corrected.
  assert.equal(golden.disputed.length, 1, 'only the da Vinci date remains open');
  const dispute = golden.disputed[0];
  assert.equal(dispute.entry, 'da-vinci-clearance');
  assert.equal(dispute.field, 'date', 'the event type is settled; only the date is not');
  assert.equal(dispute.status, 'unresolved');

  assert.match(dispute.evidence_so_far, /25 of 115/, 'the truncation must be stated');
  assert.ok(dispute.candidate_explanations.length >= 3, 'competing explanations, not one guess');
  assert.ok(dispute.resolved_by.decisive.includes('openfda-davinci-510k-earliest'));
  assert.ok(dispute.resolved_by.decisive.includes('openfda-davinci-2000'));
  assert.ok(dispute.not_yet_changed_because);

  const entry = golden.entries.find((e) => e.id === dispute.entry);
  assert.equal(entry.expect.date.status, 'contested', 'the dispute must show in the expectation too');
  assert.deepEqual(entry.expect.date.modes.map((m) => m.value), ['2001-03-02', '2000-07']);
});

test('the AESOP clearance is NOT disputed — it has a complete primary record', async () => {
  const disputedIds = golden.disputed.map((d) => d.entry);
  assert.ok(!disputedIds.includes('aesop-510k-clearance'));

  const aesop = golden.entries.find((e) => e.id === 'aesop-510k-clearance');
  assert.equal(aesop.claim.registry_id, 'K931783', 'settled precisely because it is anchored');
});

test('the cross-year control is confirmed and must not trigger conflation', async () => {
  // K963126 is the control the AESOP hypothesis was mistaken for: a single
  // record whose received and decision dates really do straddle a year.
  const control = golden.cross_year_control;
  assert.equal(control.status, 'confirmed');
  assert.equal(control.registry_id, 'K963126');
  assert.equal(control.received_date, '1996-08-12');
  assert.equal(control.decision_date, '1997-04-07');
  assert.notEqual(control.expect.received_year, control.expect.decision_year, 'that is the point of it');

  // Two dates on one record are one event's lifecycle. A discriminator firing
  // here would fire across most of openFDA.
  assert.equal(control.expect.conflation.suspected, false);
  assert.equal(control.expect.date_from, 'decision_date');

  // And it is an AESOP record — the same device that has a same-year record in
  // K931783. The mechanism exists in the data; it just did not explain the
  // 1993/1994 split.
  assert.match(control.device_name, /AESOP/);
});

test('the STAR entries must not corroborate each other', async () => {
  const star = golden.entries.filter((e) => e.claim.entity === 'STAR');
  assert.equal(star.length, 2);

  const aliases = star.map((e) => e.claim.entity_aliases[0]);
  assert.deepEqual(aliases.sort(), ['Smart Tissue Anastomosis Robot', 'Smart Tissue Autonomous Robot']);
  assert.notEqual(aliases[0], aliases[1], 'the acronym is shared; the expansions are not');

  for (const entry of star) {
    assert.equal(entry.expect.conflation.suspected, false, 'these are two real events, not one merged label');
  }
});

test('the negative case now refutes rather than contests, and says why', async () => {
  // §8 requires "contested". Refuted is strictly more severe (§6.5), so the
  // spec's real bar — must not come back corroborated — is exceeded. The spec
  // expected contested because it assumed ROBODOC held a genuine PMA that
  // sources confused with AESOP's clearance. There is no PMA.
  const negative = golden.negative;
  assert.equal(negative.claim.entity, 'ROBODOC');
  assert.equal(negative.claim.event_type, 'regulatory_approval');
  assert.equal(negative.claim.date, '1992');
  assert.equal(negative.claim.superlative, 'first FDA-approved surgical robot');

  assert.notEqual(negative.expect.overall, 'corroborated', 'the one thing §8 forbids');
  assert.equal(negative.expect.overall, 'refuted');
  assert.ok(
    STATUS_SEVERITY.refuted > STATUS_SEVERITY.contested,
    'refuted must be more severe than the contested the spec asked for',
  );
  assert.ok(negative.expect.overall_note, 'the deviation must be explained inline');

  assert.equal(negative.expect.event_type.status, 'refuted', 'no PMA record exists at all');
  assert.equal(negative.expect.date.status, 'refuted');

  // The superlative stays contested: sources disagree about "first", which is
  // a different question from whether the underlying event happened.
  assert.equal(negative.expect.superlative.status, 'contested');
  assert.equal(negative.expect.conflation.suspected, true);
  assert.equal(negative.expect.conflation.field, 'event_type');

  const aesop = negative.expect.competing_claimants.find((c) => c.entity === 'AESOP');
  assert.ok(aesop, 'AESOP must surface as a competing claimant');
  assert.equal(aesop.event_type, 'regulatory_clearance');
  assert.equal(aesop.registry_id, 'K931783', 'anchored, like every settled claim here');
});

test('the conflation note no longer rests on the false approval premise', async () => {
  // The old wording said ROBODOC's approval was confused with AESOP's
  // clearance. Neither device has an approval, so that framing was itself an
  // instance of the error.
  const note = golden.negative.expect.conflation.note;
  assert.match(note, /neither device has an approval|CLEARED/i);
  assert.ok(
    !/ROBODOC's approval/i.test(note),
    'the note must not presuppose an approval that does not exist',
  );
});

test('only the negative case carries a superlative', async () => {
  // §6.3 turns any superlative into an adversarial search. The positive rows
  // are deliberately superlative-free so they test the ordinary path.
  for (const entry of golden.entries) {
    assert.equal(entry.claim.superlative, null, `${entry.id} should not carry a superlative`);
  }
  assert.ok(golden.negative.claim.superlative);
});
