/**
 * GDELT DOC 2.0 adapter — news.
 *
 * https://api.gdeltproject.org/api/v2/doc/doc — free and keyless, indexing
 * worldwide news in near-real time. Chosen over a news aggregator with an API
 * key because §3's zero-prerequisites constraint applies to every source, not
 * just the ones the spec happened to name.
 *
 * NOTE: written from GDELT's published DOC 2.0 documentation and NOT validated
 * against a live response — see README, "Unverified assumptions".
 */

import { normalizeDate } from '../dates.js';
import type { HttpDeps, HttpOptions } from '../http.js';
import { buildUrl, httpGetJson } from '../http.js';

export const GDELT_ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';

export interface NewsArticle {
  title: string;
  url: string;
  domain: string;
  /** ISO date, when GDELT first saw the article. */
  seen: string;
  language?: string;
  country?: string;
}

interface RawArticle {
  title?: string;
  url?: string;
  domain?: string;
  seendate?: string;
  language?: string;
  sourcecountry?: string;
}

/** GDELT stamps dates as `20240115T120000Z`. */
export function parseSeenDate(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(raw.trim());
  if (match === null) return normalizeDate(raw)?.date;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** Pure. Never throws; a malformed payload is an empty list with an error. */
export function parseGdelt(json: unknown): { articles: NewsArticle[]; error?: string } {
  if (typeof json !== 'object' || json === null) {
    return { articles: [], error: 'GDELT response was not an object' };
  }
  const raw = (json as { articles?: RawArticle[] }).articles;
  if (raw === undefined) {
    // GDELT returns an empty body, not an empty array, when nothing matches.
    return { articles: [] };
  }

  const articles: NewsArticle[] = [];
  for (const item of raw) {
    const url = item.url?.trim();
    const title = item.title?.replace(/\s+/g, ' ').trim();
    if (url === undefined || url === '' || title === undefined || title === '') continue;

    let domain = item.domain?.trim() ?? '';
    if (domain === '') {
      try {
        domain = new URL(url).hostname;
      } catch {
        domain = '';
      }
    }

    articles.push({
      title,
      url,
      domain,
      seen: parseSeenDate(item.seendate) ?? '',
      ...(item.language === undefined ? {} : { language: item.language }),
      ...(item.sourcecountry === undefined ? {} : { country: item.sourcecountry }),
    });
  }
  return { articles };
}

export interface GdeltQuery {
  /** Terms are ANDed; multi-word terms are phrase-quoted. */
  terms: string[];
  /** GDELT timespan, e.g. "12m", "3m", "24h". Default two years. */
  timespan?: string;
  maxRecords?: number;
}

export function buildGdeltQuery(terms: string[]): string {
  return terms
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .map((t) => (t.includes(' ') ? `"${t}"` : t))
    .join(' ');
}

export function gdeltUrl(query: GdeltQuery): string {
  return buildUrl(GDELT_ENDPOINT, {
    query: buildGdeltQuery(query.terms),
    mode: 'artlist',
    format: 'json',
    // GDELT caps at 250 and silently truncates above it.
    maxrecords: Math.min(query.maxRecords ?? 50, 250),
    timespan: query.timespan ?? '24m',
    sort: 'datedesc',
  });
}

export async function searchNews(
  query: GdeltQuery,
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<{ articles: NewsArticle[]; error?: string; url: string }> {
  const url = gdeltUrl(query);
  const result = await httpGetJson<unknown>(url, options, deps);
  if (!result.ok) return { articles: [], error: result.error, url };
  return { ...parseGdelt(result.value), url };
}
