/**
 * Date normalization.
 *
 * Every source states dates differently — openFDA has used both `YYYYMMDD` and
 * `YYYY-MM-DD`, Crossref returns `[[y, m, d]]` tuples that may be truncated to
 * just `[[y]]`, PubMed emits prose like `1993 Nov`. They all normalize to a
 * partial ISO 8601 string plus an explicit precision.
 *
 * Precision is tracked rather than padded because the difference matters to
 * the verifier: a source attesting "1993" does not contradict one attesting
 * "1993-11-04", but a source attesting "1993-06" does. Silently padding to
 * `1993-01-01` would manufacture a disagreement that no source actually made —
 * and the AESOP date case turns on exactly this kind of distinction.
 */

import type { DatePrecision } from './types.js';

export interface NormalizedDate {
  /** Partial ISO 8601: "1993" | "1993-11" | "1993-11-04". */
  date: string;
  precision: DatePrecision;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number): string => String(n).padStart(2, '0');

function build(year: number, month?: number, day?: number): NormalizedDate | undefined {
  // 1450 is arbitrary but well below any plausible technology milestone; the
  // point is to reject parse artifacts like a page number read as a year.
  if (!Number.isInteger(year) || year < 1450 || year > 2200) return undefined;
  if (month === undefined || !Number.isInteger(month) || month < 1 || month > 12) {
    return { date: String(year), precision: 'year' };
  }
  if (day === undefined || !Number.isInteger(day) || day < 1 || day > 31) {
    return { date: `${year}-${pad(month)}`, precision: 'month' };
  }
  return { date: `${year}-${pad(month)}-${pad(day)}`, precision: 'day' };
}

/**
 * Parse the date formats these APIs actually emit. Returns undefined rather
 * than a guess when the input is unrecognizable — an absent date is honest,
 * an invented one is not.
 */
export function normalizeDate(raw: string | number | null | undefined): NormalizedDate | undefined {
  if (raw === null || raw === undefined) return undefined;
  const text = String(raw).trim();
  if (text === '') return undefined;

  // ISO-ish, possibly with a time component: 1994-03-01, 1994-03, 1994-03-01T00:00:00Z
  //
  // The trailing group requires a digit after the separator. Without that,
  // ` .*` also matches the month in PubMed's "1993 Nov", and the whole string
  // parses as a bare year — silently discarding a month the source did state.
  const iso = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?(?:[T ]\d.*)?$/.exec(text);
  if (iso !== null) {
    return build(Number(iso[1]), iso[2] === undefined ? undefined : Number(iso[2]), iso[3] === undefined ? undefined : Number(iso[3]));
  }

  // Compact: 19940301. Checked before bare-year so it is not truncated to 1994.
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact !== null) {
    return build(Number(compact[1]), Number(compact[2]), Number(compact[3]));
  }

  // PubMed prose: "1993 Nov", "1993 Nov 4", "1993 Nov-Dec".
  const prose = /^(\d{4})\s+([A-Za-z]{3})[A-Za-z]*(?:\s*-\s*[A-Za-z]+)?(?:\s+(\d{1,2}))?/.exec(text);
  if (prose !== null) {
    const monthKey = (prose[2] ?? '').toLowerCase();
    return build(Number(prose[1]), MONTHS[monthKey], prose[3] === undefined ? undefined : Number(prose[3]));
  }

  // Bare year anywhere in an otherwise unparseable string, e.g. "c. 1993".
  const year = /(?:^|\D)(1[4-9]\d{2}|2[01]\d{2})(?:\D|$)/.exec(text);
  if (year !== null) {
    return build(Number(year[1]));
  }

  return undefined;
}

/** Crossref's `date-parts`: `[[1993, 11, 4]]`, often truncated to `[[1993]]`. */
export function fromDateParts(parts: unknown): NormalizedDate | undefined {
  if (!Array.isArray(parts) || parts.length === 0) return undefined;
  const first = parts[0];
  if (!Array.isArray(first) || first.length === 0) return undefined;
  const [year, month, day] = first as (number | undefined)[];
  if (typeof year !== 'number') return undefined;
  return build(year, typeof month === 'number' ? month : undefined, typeof day === 'number' ? day : undefined);
}

/** The year component of a partial ISO date, for coarse comparisons (§6.6). */
export function yearOf(date: string): number | undefined {
  const match = /^(\d{4})/.exec(date.trim());
  return match === null ? undefined : Number(match[1]);
}

/**
 * Whether two partial dates are compatible — i.e. neither contradicts the
 * other at the precision they share. "1993" and "1993-11" agree; "1993-06" and
 * "1993-11" do not.
 */
export function datesCompatible(a: string, b: string): boolean {
  const left = a.trim().split('-');
  const right = b.trim().split('-');
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    if (Number(left[i]) !== Number(right[i])) return false;
  }
  return true;
}
