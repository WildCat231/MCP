/**
 * Wikipedia REST adapter.
 *
 * https://en.wikipedia.org/api/rest_v1 — keyless.
 *
 * Wikipedia is tertiary and attests to no event type (see `registry.ts`). It
 * earns its place for two other jobs: resolving entity aliases and redirects,
 * and surfacing candidate primary sources to chase. Nothing it returns should
 * corroborate a claim on its own.
 *
 * NOTE: written from the published REST schema, NOT validated against a live
 * response — see README, "Unverified assumptions".
 */

import { normalizeDate } from '../dates.js';
import type { HttpDeps, HttpOptions } from '../http.js';
import { buildUrl, httpGetJson } from '../http.js';
import type { WikipediaRecord } from '../types.js';

export const WIKIPEDIA_REST = 'https://en.wikipedia.org/api/rest_v1';
export const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';

/** Extracts are truncated: §4 says store locators, not extended verbatim text. */
export const MAX_EXTRACT_CHARS = 200;

interface SummaryResponse {
  type?: string;
  pageid?: number;
  title?: string;
  titles?: { canonical?: string; normalized?: string; display?: string };
  extract?: string;
  timestamp?: string;
  description?: string;
  content_urls?: { desktop?: { page?: string } };
}

interface SearchResponse {
  query?: {
    search?: { title?: string; pageid?: number; snippet?: string }[];
  };
}

/**
 * All records from a summary response, as an array — zero or one.
 *
 * Plural for the same reason as every other registry lookup: callers should
 * never have to remember which registries return one match and which return
 * many. A disambiguation page yields zero, which is the honest answer.
 */
export function parseSummaryRecords(json: unknown): WikipediaRecord[] {
  const record = parseSummary(json);
  return record === undefined ? [] : [record];
}

export function parseSummary(json: unknown): WikipediaRecord | undefined {
  const response = json as SummaryResponse;
  const pageId = response.pageid;
  const title = response.titles?.canonical ?? response.title;
  if (typeof pageId !== 'number' || title === undefined || title.trim() === '') return undefined;

  // Disambiguation pages describe no subject at all; returning one as a record
  // would let an ambiguous entity ("Mercury") masquerade as a resolved one.
  if (response.type === 'disambiguation') return undefined;

  const extract = response.extract?.replace(/\s+/g, ' ').trim();
  const revision = normalizeDate(response.timestamp);
  const canonical = title.trim();
  const display = response.title?.trim() ?? canonical;

  return {
    registry: 'wikipedia',
    record_id: String(pageId),
    page_id: pageId,
    canonical_title: canonical,
    title: display,
    ...(extract === undefined || extract === ''
      ? {}
      : { extract: extract.length > MAX_EXTRACT_CHARS ? `${extract.slice(0, MAX_EXTRACT_CHARS)}…` : extract }),
    ...(revision === undefined ? {} : { revision_date: revision.date }),
    url:
      response.content_urls?.desktop?.page ??
      `https://en.wikipedia.org/wiki/${encodeURIComponent(canonical.replace(/ /g, '_'))}`,
  };
}

export function parseSearch(json: unknown): { titles: string[] } {
  const response = json as SearchResponse;
  const titles = (response.query?.search ?? [])
    .map((hit) => hit.title?.trim() ?? '')
    .filter((title) => title !== '');
  return { titles };
}

export function summaryUrl(title: string): string {
  // The REST path takes an underscored, path-encoded title.
  return `${WIKIPEDIA_REST}/page/summary/${encodeURIComponent(title.trim().replace(/ /g, '_'))}`;
}

export function searchUrl(query: string, limit = 5): string {
  return buildUrl(WIKIPEDIA_API, {
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: limit,
    format: 'json',
    origin: '*',
  });
}

export async function lookupPage(
  title: string,
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<{ records: WikipediaRecord[]; error?: string; url: string }> {
  const url = summaryUrl(title);
  const result = await httpGetJson<unknown>(url, options, deps);
  if (!result.ok) {
    // A missing article is an answer, not a fault.
    return result.status === 404 ? { records: [], url } : { records: [], error: result.error, url };
  }
  return { records: parseSummaryRecords(result.value), url };
}

export async function searchPages(
  query: string,
  limit = 5,
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<{ titles: string[]; error?: string; url: string }> {
  const url = searchUrl(query, limit);
  const result = await httpGetJson<unknown>(url, options, deps);
  if (!result.ok) return { titles: [], error: result.error, url };
  return { ...parseSearch(result.value), url };
}
