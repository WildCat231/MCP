/**
 * openFDA device adapter — 510(k) and PMA.
 *
 * https://api.fda.gov/device — keyless at 240 requests/minute.
 *
 * This is the registry that settles clearance-vs-approval (§6.1), because FDA
 * stores the two pathways as separate databases with separate endpoints and
 * separate dates. The adapter therefore keeps them separate all the way
 * through: `searchClearances` hits /510k.json and only ever produces `510k`
 * records, `searchApprovals` hits /pma.json and only ever produces PMA
 * records. Nothing here can turn one into the other.
 *
 * NOTE: written from openFDA's published field reference, NOT validated
 * against a live response — see README, "Unverified assumptions". In
 * particular openFDA has served `decision_date` in both `YYYYMMDD` and
 * `YYYY-MM-DD` form across endpoints and eras, so dates go through
 * `normalizeDate`, which accepts both.
 */

import { normalizeDate } from '../dates.js';
import type { HttpDeps, HttpOptions } from '../http.js';
import { buildUrl, httpGetJson } from '../http.js';
import type { OpenFdaDeviceRecord } from '../types.js';

export const OPENFDA_510K_ENDPOINT = 'https://api.fda.gov/device/510k.json';
export const OPENFDA_PMA_ENDPOINT = 'https://api.fda.gov/device/pma.json';

interface OpenFdaEnvelope<T> {
  meta?: { results?: { total?: number; skip?: number; limit?: number } };
  results?: T[];
  error?: { code?: string; message?: string };
}

interface Raw510k {
  k_number?: string;
  device_name?: string;
  applicant?: string;
  decision_date?: string;
  date_received?: string;
  decision_code?: string;
  decision_description?: string;
  product_code?: string;
  advisory_committee_description?: string;
}

interface RawPma {
  pma_number?: string;
  supplement_number?: string;
  trade_name?: string;
  generic_name?: string;
  applicant?: string;
  decision_date?: string;
  date_received?: string;
  decision_code?: string;
  product_code?: string;
  advisory_committee_description?: string;
}

/** Pure. A raw 510(k) row -> a typed clearance record. */
export function to510kRecord(raw: Raw510k): OpenFdaDeviceRecord | undefined {
  const kNumber = raw.k_number?.trim();
  if (kNumber === undefined || kNumber === '') return undefined;

  const decision = normalizeDate(raw.decision_date);
  const received = normalizeDate(raw.date_received);
  const title = raw.device_name?.trim() ?? kNumber;

  return {
    registry: 'openfda_device',
    record_id: kNumber,
    submission_type: '510k',
    submission_number: kNumber,
    title,
    ...(raw.device_name === undefined ? {} : { device_name: raw.device_name.trim() }),
    ...(raw.applicant === undefined ? {} : { applicant: raw.applicant.trim() }),
    ...(raw.product_code === undefined ? {} : { product_code: raw.product_code.trim() }),
    ...(raw.decision_code === undefined ? {} : { decision_code: raw.decision_code.trim() }),
    // Both dates are kept. The gap between receipt and decision routinely
    // straddles a new year, and secondary sources cite whichever they saw —
    // discarding one would erase the evidence for that (§6.6).
    ...(decision === undefined ? {} : { decision_date: decision.date }),
    ...(received === undefined ? {} : { received_date: received.date }),
    ...(decision === undefined ? {} : { date: decision.date, date_precision: decision.precision }),
    url: `${OPENFDA_510K_ENDPOINT}?search=k_number:"${kNumber}"`,
  };
}

/**
 * Pure. A raw PMA row -> a typed approval record.
 *
 * `supplement_number` distinguishes an original approval from a supplement.
 * FDA uses "000", "S000", or an empty value for the original; anything else is
 * a change to an already-approved device and must not be reported as a first
 * approval.
 */
export function isOriginalPma(supplementNumber: string | undefined): boolean {
  const value = supplementNumber?.trim().toUpperCase();
  return value === undefined || value === '' || value === '000' || value === 'S000';
}

export function toPmaRecord(raw: RawPma): OpenFdaDeviceRecord | undefined {
  const pmaNumber = raw.pma_number?.trim();
  if (pmaNumber === undefined || pmaNumber === '') return undefined;

  const original = isOriginalPma(raw.supplement_number);
  const decision = normalizeDate(raw.decision_date);
  const received = normalizeDate(raw.date_received);
  const supplement = raw.supplement_number?.trim();
  const submissionNumber = original || supplement === undefined || supplement === '' ? pmaNumber : `${pmaNumber}/${supplement}`;
  const title = raw.trade_name?.trim() ?? raw.generic_name?.trim() ?? pmaNumber;

  return {
    registry: 'openfda_device',
    record_id: submissionNumber,
    submission_type: original ? 'pma_original' : 'pma_supplement',
    submission_number: submissionNumber,
    title,
    ...(raw.trade_name === undefined ? {} : { device_name: raw.trade_name.trim() }),
    ...(raw.applicant === undefined ? {} : { applicant: raw.applicant.trim() }),
    ...(raw.product_code === undefined ? {} : { product_code: raw.product_code.trim() }),
    ...(raw.decision_code === undefined ? {} : { decision_code: raw.decision_code.trim() }),
    ...(decision === undefined ? {} : { decision_date: decision.date }),
    ...(received === undefined ? {} : { received_date: received.date }),
    ...(decision === undefined ? {} : { date: decision.date, date_precision: decision.precision }),
    url: `${OPENFDA_PMA_ENDPOINT}?search=pma_number:"${pmaNumber}"`,
  };
}

export function parse510k(json: unknown): { records: OpenFdaDeviceRecord[]; total?: number; error?: string } {
  const envelope = json as OpenFdaEnvelope<Raw510k>;
  // openFDA reports "no matches" as a 404 with an error body rather than an
  // empty result set. That is a legitimate empty answer, not a fault.
  if (envelope.error !== undefined) {
    return envelope.error.code === 'NOT_FOUND'
      ? { records: [], total: 0 }
      : { records: [], error: envelope.error.message ?? envelope.error.code ?? 'openFDA error' };
  }
  const records = (envelope.results ?? []).map(to510kRecord).filter((r): r is OpenFdaDeviceRecord => r !== undefined);
  const total = envelope.meta?.results?.total;
  return { records, ...(typeof total === 'number' ? { total } : {}) };
}

export function parsePma(json: unknown): { records: OpenFdaDeviceRecord[]; total?: number; error?: string } {
  const envelope = json as OpenFdaEnvelope<RawPma>;
  if (envelope.error !== undefined) {
    return envelope.error.code === 'NOT_FOUND'
      ? { records: [], total: 0 }
      : { records: [], error: envelope.error.message ?? envelope.error.code ?? 'openFDA error' };
  }
  const records = (envelope.results ?? []).map(toPmaRecord).filter((r): r is OpenFdaDeviceRecord => r !== undefined);
  const total = envelope.meta?.results?.total;
  return { records, ...(typeof total === 'number' ? { total } : {}) };
}

/** Escape a value for openFDA's Lucene-ish search syntax. */
export function quote(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`;
}

export interface OpenFdaQuery {
  /** Free text matched against device and applicant names. */
  query: string;
  limit?: number;
  /** Extra `field:value` clauses, ANDed with the free-text search. */
  filters?: Record<string, string>;
}

function searchExpression(query: OpenFdaQuery, nameField: string): string {
  const term = quote(query.query.trim());
  const clauses = [`(${nameField}:${term}+OR+applicant:${term})`];
  for (const [field, value] of Object.entries(query.filters ?? {})) {
    clauses.push(`${field}:${quote(value)}`);
  }
  return clauses.join('+AND+');
}

export function clearanceSearchUrl(query: OpenFdaQuery): string {
  // openFDA's `search` uses `+` as its AND separator and must not be
  // percent-encoded, so it is appended rather than passed through URLSearchParams.
  const base = buildUrl(OPENFDA_510K_ENDPOINT, { limit: query.limit ?? 25 });
  return `${base}&search=${searchExpression(query, 'device_name')}`;
}

export function approvalSearchUrl(query: OpenFdaQuery): string {
  const base = buildUrl(OPENFDA_PMA_ENDPOINT, { limit: query.limit ?? 25 });
  return `${base}&search=${searchExpression(query, 'trade_name')}`;
}

export async function searchClearances(
  query: OpenFdaQuery,
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<{ records: OpenFdaDeviceRecord[]; total?: number; error?: string; url: string }> {
  const url = clearanceSearchUrl(query);
  const result = await httpGetJson<unknown>(url, options, deps);
  // A 404 carries openFDA's NOT_FOUND body, which parse510k reads as empty.
  if (!result.ok) {
    return result.status === 404 ? { records: [], total: 0, url } : { records: [], error: result.error, url };
  }
  return { ...parse510k(result.value), url };
}

export async function searchApprovals(
  query: OpenFdaQuery,
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<{ records: OpenFdaDeviceRecord[]; total?: number; error?: string; url: string }> {
  const url = approvalSearchUrl(query);
  const result = await httpGetJson<unknown>(url, options, deps);
  if (!result.ok) {
    return result.status === 404 ? { records: [], total: 0, url } : { records: [], error: result.error, url };
  }
  return { ...parsePma(result.value), url };
}
