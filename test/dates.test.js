/**
 * Date normalization.
 *
 * Precision tracking is the substance here: padding a partial date to a full
 * one would manufacture disagreements between sources that never disagreed,
 * and the AESOP date case turns on exactly that distinction.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { datesCompatible, fromDateParts, normalizeDate, yearOf } from '../dist/dates.js';

test('ISO dates keep their stated precision', async () => {
  assert.deepEqual(normalizeDate('1994-03-01'), { date: '1994-03-01', precision: 'day' });
  assert.deepEqual(normalizeDate('1994-03'), { date: '1994-03', precision: 'month' });
  assert.deepEqual(normalizeDate('1994'), { date: '1994', precision: 'year' });
});

test('a year is never silently padded to a full date', async () => {
  const parsed = normalizeDate('1993');
  assert.equal(parsed.date, '1993');
  assert.notEqual(parsed.date, '1993-01-01');
});

test('openFDA compact dates parse, and are not truncated to a bare year', async () => {
  assert.deepEqual(normalizeDate('19940301'), { date: '1994-03-01', precision: 'day' });
});

test('timestamps reduce to a day', async () => {
  assert.deepEqual(normalizeDate('2025-11-02T09:14:00Z'), { date: '2025-11-02', precision: 'day' });
});

test('PubMed prose dates parse', async () => {
  assert.deepEqual(normalizeDate('1993 Nov'), { date: '1993-11', precision: 'month' });
  assert.deepEqual(normalizeDate('1993 Nov 4'), { date: '1993-11-04', precision: 'day' });
  assert.deepEqual(normalizeDate('1993 Nov-Dec'), { date: '1993-11', precision: 'month' });
});

test('a year embedded in prose is recovered at year precision', async () => {
  assert.deepEqual(normalizeDate('c. 1993'), { date: '1993', precision: 'year' });
});

test('unparseable input yields undefined rather than a guess', async () => {
  for (const input of ['', '   ', 'n/a', 'forthcoming', null, undefined, 'page 42']) {
    assert.equal(normalizeDate(input), undefined, `${JSON.stringify(input)} should not parse`);
  }
});

test('implausible years are rejected', async () => {
  assert.equal(normalizeDate('0042-01-01'), undefined);
  assert.equal(normalizeDate('9999-01-01'), undefined);
});

test('out-of-range components degrade precision rather than failing', async () => {
  // A month of 13 is bad data; the year is still usable and still true.
  assert.deepEqual(normalizeDate('1994-13'), { date: '1994', precision: 'year' });
  assert.deepEqual(normalizeDate('1994-03-45'), { date: '1994-03', precision: 'month' });
});

test('Crossref date-parts handle truncation', async () => {
  assert.deepEqual(fromDateParts([[2016, 5, 4]]), { date: '2016-05-04', precision: 'day' });
  assert.deepEqual(fromDateParts([[2016, 5]]), { date: '2016-05', precision: 'month' });
  assert.deepEqual(fromDateParts([[2016]]), { date: '2016', precision: 'year' });
  assert.equal(fromDateParts([]), undefined);
  assert.equal(fromDateParts([[]]), undefined);
  assert.equal(fromDateParts(undefined), undefined);
});

test('yearOf extracts the coarse component used by conflation checks', async () => {
  assert.equal(yearOf('1994-03-01'), 1994);
  assert.equal(yearOf('1994'), 1994);
  assert.equal(yearOf('not a date'), undefined);
});

test('compatibility compares only the shared precision', async () => {
  // "1993" does not contradict "1993-11" — it is less specific, not different.
  assert.equal(datesCompatible('1993', '1993-11'), true);
  assert.equal(datesCompatible('1993-11', '1993-11-04'), true);
  assert.equal(datesCompatible('1993-06', '1993-11'), false);
  assert.equal(datesCompatible('1993', '1994'), false);
});
