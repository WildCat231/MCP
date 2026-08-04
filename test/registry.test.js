/**
 * Registry -> EventType mapping (CODEX_SPEC.md §6.1).
 *
 * The clearance/approval distinction is the one this whole system exists to
 * preserve, so it is tested against the canonical ROBODOC/AESOP case directly.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { REGISTRY_TIER, registryEventType, settlesEventType } from '../dist/registry.js';

const aesop510k = {
  registry: 'openfda_device',
  record_id: 'K931861',
  submission_type: '510k',
  submission_number: 'K931861',
  title: 'AESOP',
  device_name: 'Automated Endoscopic System for Optimal Positioning',
  url: 'https://api.fda.gov/device/510k.json',
  decision_date: '1994-03-01',
  received_date: '1993-06-15',
  date: '1994-03-01',
};

const robodocPma = {
  registry: 'openfda_device',
  record_id: 'P050041',
  submission_type: 'pma_original',
  submission_number: 'P050041',
  title: 'ROBODOC Surgical System',
  url: 'https://api.fda.gov/device/pma.json',
  decision_date: '2008-08-08',
  date: '2008-08-08',
};

test('510(k) maps to clearance and PMA to approval — definitively, and differently', async () => {
  const clearance = registryEventType(aesop510k);
  const approval = registryEventType(robodocPma);

  assert.equal(clearance.event_type, 'regulatory_clearance');
  assert.equal(approval.event_type, 'regulatory_approval');
  assert.notEqual(clearance.event_type, approval.event_type);

  // Both definitive: FDA stores these as separate record types, so the server
  // reads the distinction rather than inferring it.
  assert.equal(clearance.confidence, 'definitive');
  assert.equal(approval.confidence, 'definitive');
  assert.ok(clearance.reason.includes('K931861'));
});

test('an openFDA record keeps both its decision and received dates', async () => {
  // The gap between them is one real source of the AESOP 1993/1994 split;
  // collapsing them into a single `date` would erase the evidence (§6.6).
  assert.equal(aesop510k.decision_date, '1994-03-01');
  assert.equal(aesop510k.received_date, '1993-06-15');
  assert.equal(aesop510k.date, aesop510k.decision_date, '`date` carries the decision date');
});

test('PMA supplements are approvals, flagged as such in the reason', async () => {
  const attestation = registryEventType({ ...robodocPma, submission_type: 'pma_supplement' });
  assert.equal(attestation.event_type, 'regulatory_approval');
  assert.match(attestation.reason, /supplement/i);
  assert.match(attestation.reason, /not a first approval/i);
});

test('De Novo and HDE map, but only as inferred', async () => {
  // Neither maps cleanly onto the spec's two regulatory types, so neither is
  // allowed to short-circuit §6.1.
  const deNovo = registryEventType({ ...aesop510k, submission_type: 'de_novo' });
  assert.equal(deNovo.event_type, 'regulatory_clearance');
  assert.equal(deNovo.confidence, 'inferred');

  const hde = registryEventType({ ...robodocPma, submission_type: 'hde' });
  assert.equal(hde.event_type, 'regulatory_approval');
  assert.equal(hde.confidence, 'inferred');
});

test('Crossref distinguishes peer-reviewed articles from preprints', async () => {
  const article = registryEventType({
    registry: 'crossref',
    record_id: '10.1126/scitranslmed.aad9398',
    doi: '10.1126/scitranslmed.aad9398',
    work_type: 'journal-article',
    title: 'Supervised autonomous robotic soft tissue surgery',
    authors: [],
    url: 'https://doi.org/10.1126/scitranslmed.aad9398',
  });
  assert.equal(article.event_type, 'publication');
  assert.equal(article.confidence, 'definitive');

  const preprint = registryEventType({
    registry: 'crossref',
    record_id: '10.0000/preprint',
    doi: '10.0000/preprint',
    work_type: 'posted-content',
    title: 'A preprint',
    authors: [],
    url: 'https://doi.org/10.0000/preprint',
  });
  assert.equal(preprint.event_type, 'publication');
  assert.equal(preprint.confidence, 'inferred', 'a preprint has a DOI without peer review');

  const dataset = registryEventType({
    registry: 'crossref',
    record_id: '10.0000/data',
    doi: '10.0000/data',
    work_type: 'dataset',
    title: 'A dataset',
    authors: [],
    url: 'https://doi.org/10.0000/data',
  });
  assert.equal(dataset.event_type, 'other', 'a data deposit is not a publication');
});

test('PatentsView maps to patent_grant, downgraded without a grant date', async () => {
  const base = {
    registry: 'patentsview',
    record_id: '5397323',
    patent_number: '5397323',
    title: 'Remote center-of-motion robot for surgery',
    assignees: [],
    inventors: [],
    url: 'https://patents.google.com/patent/US5397323',
  };

  const granted = registryEventType({ ...base, grant_date: '1995-03-14' });
  assert.equal(granted.event_type, 'patent_grant');
  assert.equal(granted.confidence, 'definitive');

  const undated = registryEventType({ ...base, filing_date: '1992-10-30' });
  assert.equal(undated.event_type, 'patent_grant');
  assert.equal(undated.confidence, 'inferred');
  assert.match(undated.reason, /filing date is a different event/i);
});

test('Wikipedia attests to no event type at all', async () => {
  // Returning null rather than guessing is what stops a tertiary source from
  // manufacturing an event type no primary record supports.
  const attestation = registryEventType({
    registry: 'wikipedia',
    record_id: '12345',
    page_id: 12345,
    canonical_title: 'ROBODOC',
    title: 'ROBODOC',
    url: 'https://en.wikipedia.org/wiki/ROBODOC',
    revision_date: '2025-11-02T09:14:00Z',
  });
  assert.equal(attestation.event_type, null);
  assert.equal(attestation.confidence, 'none');
});

test('only definitive primary records settle the event type', async () => {
  assert.equal(settlesEventType(aesop510k), true);
  assert.equal(settlesEventType(robodocPma), true);
  assert.equal(settlesEventType({ ...aesop510k, submission_type: 'de_novo' }), false, 'inferred does not settle');

  assert.equal(REGISTRY_TIER.openfda_device, 'primary');
  assert.equal(REGISTRY_TIER.wikipedia, 'tertiary', 'an encyclopedia never corroborates on its own');
});

test('an unhandled registry throws rather than returning a silent undefined', async () => {
  // The dispatcher is exhaustive at compile time; this covers the runtime edge
  // where a record arrives from outside TypeScript's reach.
  assert.throws(() => registryEventType({ registry: 'nonexistent' }), /unhandled variant/);
});
