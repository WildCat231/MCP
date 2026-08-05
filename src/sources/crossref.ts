/**
 * Crossref REST API adapter.
 *
 * https://api.crossref.org — keyless. Serves double duty: a literature source
 * (`Paper`) and a primary registry for publication claims (`CrossrefRecord`).
 *
 * NOTE: written from Crossref's published schema, NOT validated against a live
 * response — see README, "Unverified assumptions".
 */

import { fromDateParts } from '../dates.js';
import type { HttpDeps, HttpOptions } from '../http.js';
import { buildUrl, httpGetJson } from '../http.js';
import type { CrossrefRecord, CrossrefWorkType, Paper } from '../types.js';

export const CROSSREF_ENDPOINT = 'https://api.crossref.org/works';

interface CrossrefAuthor {
  given?: string;
  family?: string;
  name?: string;
}

export interface CrossrefItem {
  DOI?: string;
  title?: string[];
  'container-title'?: string[];
  author?: CrossrefAuthor[];
  issued?: { 'date-parts'?: unknown };
  'published-print'?: { 'date-parts'?: unknown };
  'published-online'?: { 'date-parts'?: unknown };
  publisher?: string;
  type?: string;
  URL?: string;
  abstract?: string;
}

interface CrossrefEnvelope {
  message?: {
    items?: CrossrefItem[];
    'total-results'?: number;
  } & CrossrefItem;
}

/** Crossref `type` values we model explicitly; everything else is `other`. */
const WORK_TYPES: Readonly<Record<string, CrossrefWorkType>> = {
  'journal-article': 'journal-article',
  'proceedings-article': 'proceedings-article',
  'book-chapter': 'book-chapter',
  'posted-content': 'posted-content',
  report: 'report',
  dataset: 'dataset',
};

export function crossrefWorkType(raw: string | undefined): CrossrefWorkType {
  return (raw === undefined ? undefined : WORK_TYPES[raw]) ?? 'other';
}

function authorNames(authors: CrossrefAuthor[] | undefined): string[] {
  return (authors ?? [])
    .map((a) => a.name ?? [a.given, a.family].filter((p) => p !== undefined && p !== '').join(' '))
    .map((n) => n.trim())
    .filter((n) => n !== '');
}

/** Crossref abstracts arrive as JATS XML fragments; strip tags for a plain summary. */
function stripJats(abstract: string | undefined): string | undefined {
  if (abstract === undefined) return undefined;
  const text = abstract.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text === '' ? undefined : text;
}

function firstTitle(item: CrossrefItem): string {
  return (item.title ?? []).map((t) => t.trim()).find((t) => t !== '') ?? '';
}

/**
 * Earliest known publication date. Crossref's `issued` is usually the one to
 * trust, but a work can carry an online date months before print; the earliest
 * is what "when did this become public" means.
 */
function publicationDate(item: CrossrefItem) {
  const candidates = [
    fromDateParts(item.issued?.['date-parts']),
    fromDateParts(item['published-online']?.['date-parts']),
    fromDateParts(item['published-print']?.['date-parts']),
  ].filter((d) => d !== undefined);

  if (candidates.length === 0) return undefined;
  return candidates.reduce((earliest, current) => (current.date < earliest.date ? current : earliest));
}

/** Pure. One Crossref item -> a normalized `Paper`. */
export function toPaper(item: CrossrefItem): Paper | undefined {
  const doi = item.DOI?.trim().toLowerCase();
  const title = firstTitle(item);
  if (title === '' || doi === undefined || doi === '') return undefined;

  const published = publicationDate(item);
  const abstract = stripJats(item.abstract);
  const venue = (item['container-title'] ?? []).find((c) => c.trim() !== '');

  return {
    id: doi,
    title,
    ...(abstract === undefined ? {} : { abstract }),
    authors: authorNames(item.author),
    published: published?.date ?? '',
    doi,
    url: item.URL ?? `https://doi.org/${doi}`,
    ...(venue === undefined ? {} : { venue: venue.trim() }),
    source: 'crossref',
    source_id: doi,
  };
}

/** Pure. One Crossref item -> a primary-source registry record. */
export function toRegistryRecord(item: CrossrefItem): CrossrefRecord | undefined {
  const doi = item.DOI?.trim().toLowerCase();
  const title = firstTitle(item);
  if (doi === undefined || doi === '' || title === '') return undefined;

  const issued = publicationDate(item);
  const container = (item['container-title'] ?? []).find((c) => c.trim() !== '');

  return {
    registry: 'crossref',
    record_id: doi,
    doi,
    title,
    work_type: crossrefWorkType(item.type),
    ...(container === undefined ? {} : { container_title: container.trim() }),
    ...(item.publisher === undefined ? {} : { publisher: item.publisher }),
    authors: authorNames(item.author),
    ...(issued === undefined ? {} : { issued_date: issued.date, date: issued.date, date_precision: issued.precision }),
    url: item.URL ?? `https://doi.org/${doi}`,
  };
}

export function parseCrossrefSearch(json: unknown): { papers: Paper[]; total?: number } {
  const envelope = json as CrossrefEnvelope;
  const items = envelope.message?.items ?? [];
  const papers = items.map(toPaper).filter((p): p is Paper => p !== undefined);
  const total = envelope.message?.['total-results'];
  return { papers, ...(typeof total === 'number' ? { total } : {}) };
}

/**
 * All records in a Crossref response, as an array.
 *
 * A DOI lookup resolves to at most one work, but the shape stays plural on
 * purpose: every registry lookup in this server returns *all* matches, and a
 * caller that has to remember which registries return one and which return
 * many will eventually take `[0]` from the wrong one.
 */
export function parseCrossrefWork(json: unknown): CrossrefRecord[] {
  const envelope = json as CrossrefEnvelope;
  // A /works/{doi} response carries the work directly on `message`; a search
  // response carries `message.items`.
  if (Array.isArray(envelope.message?.items)) {
    return envelope.message.items.map(toRegistryRecord).filter((r): r is CrossrefRecord => r !== undefined);
  }
  if (envelope.message === undefined) return [];
  const record = toRegistryRecord(envelope.message);
  return record === undefined ? [] : [record];
}

export interface CrossrefQuery {
  terms: string[];
  rows?: number;
  /** Inclusive ISO date bounds. */
  from?: string;
  to?: string;
}

export function crossrefSearchUrl(query: CrossrefQuery): string {
  const filters = [
    query.from === undefined ? undefined : `from-pub-date:${query.from}`,
    query.to === undefined ? undefined : `until-pub-date:${query.to}`,
  ].filter((f): f is string => f !== undefined);

  return buildUrl(CROSSREF_ENDPOINT, {
    query: query.terms.join(' '),
    rows: query.rows ?? 25,
    sort: 'issued',
    order: 'desc',
    ...(filters.length === 0 ? {} : { filter: filters.join(',') }),
    // Crossref asks callers to identify themselves for the polite pool.
    mailto: 'frontier-mcp@users.noreply.github.com',
  });
}

export function crossrefDoiUrl(doi: string): string {
  return `${CROSSREF_ENDPOINT}/${encodeURIComponent(doi.trim().toLowerCase())}`;
}

export async function searchCrossref(
  query: CrossrefQuery,
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<{ papers: Paper[]; total?: number; error?: string; url: string }> {
  const url = crossrefSearchUrl(query);
  const result = await httpGetJson<unknown>(url, options, deps);
  if (!result.ok) return { papers: [], error: result.error, url };
  return { ...parseCrossrefSearch(result.value), url };
}

export async function lookupDoi(
  doi: string,
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<{ records: CrossrefRecord[]; error?: string; url: string }> {
  const url = crossrefDoiUrl(doi);
  const result = await httpGetJson<unknown>(url, options, deps);
  // An unregistered DOI is an answer, not a fault.
  if (!result.ok) {
    return result.status === 404 ? { records: [], url } : { records: [], error: result.error, url };
  }
  return { records: parseCrossrefWork(result.value), url };
}
