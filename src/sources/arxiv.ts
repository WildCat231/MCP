/**
 * arXiv Atom API adapter.
 *
 * https://export.arxiv.org/api/query — keyless. Terms require >= 3s between
 * requests, enforced by the host bucket in `ratelimit.ts`.
 *
 * NOTE: the field mapping below is written from arXiv's published Atom schema
 * and has NOT been validated against a live response — see README,
 * "Unverified assumptions". `parseArxivAtom` is pure, so recording one real
 * response into test/fixtures/ is enough to confirm or correct it.
 */

import { XMLParser } from 'fast-xml-parser';

import { normalizeDate } from '../dates.js';
import type { HttpDeps, HttpOptions } from '../http.js';
import { buildUrl, httpGet } from '../http.js';
import type { Paper } from '../types.js';

export const ARXIV_ENDPOINT = 'https://export.arxiv.org/api/query';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // arXiv emits a single <entry> for one hit and repeated <entry> for many;
  // forcing these to arrays removes the branch from every call site.
  isArray: (name) => ['entry', 'author', 'link', 'category'].includes(name),
  trimValues: true,
});

/** Collapse the whitespace arXiv wraps titles and abstracts in. */
function clean(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return clean(node);
  if (typeof node === 'object' && node !== null && '#text' in node) {
    return clean((node as { '#text': unknown })['#text']);
  }
  return '';
}

/**
 * arXiv ids look like `http://arxiv.org/abs/2301.12345v2`. The version suffix
 * is dropped so that v1 and v2 of the same preprint deduplicate to one paper.
 */
export function arxivIdFromUrl(url: string): string {
  const match = /abs\/(.+?)(?:v\d+)?$/.exec(url.trim());
  return match?.[1] ?? url.trim();
}

/** Pure. Parses an Atom feed into normalized papers; never throws. */
export function parseArxivAtom(xml: string): { papers: Paper[]; total?: number; error?: string } {
  let feed: Record<string, unknown>;
  try {
    const parsed = parser.parse(xml) as { feed?: Record<string, unknown> };
    if (parsed.feed === undefined) return { papers: [], error: 'response contained no <feed> element' };
    feed = parsed.feed;
  } catch (err) {
    return { papers: [], error: `unparseable Atom: ${err instanceof Error ? err.message : String(err)}` };
  }

  const totalRaw = feed['opensearch:totalResults'];
  const total = totalRaw === undefined ? undefined : Number(textOf(totalRaw) || totalRaw);

  const entries = Array.isArray(feed['entry']) ? (feed['entry'] as Record<string, unknown>[]) : [];
  const papers: Paper[] = [];

  for (const entry of entries) {
    const rawId = clean(entry['id']);
    if (rawId === '') continue;
    const sourceId = arxivIdFromUrl(rawId);

    const title = clean(entry['title']);
    if (title === '') continue;

    const authors = (Array.isArray(entry['author']) ? entry['author'] : [])
      .map((a) => clean((a as { name?: unknown }).name))
      .filter((name) => name !== '');

    const published = normalizeDate(clean(entry['published']));
    const doi = clean(entry['arxiv:doi']);
    const journalRef = clean(entry['arxiv:journal_ref']);
    const abstract = clean(entry['summary']);

    papers.push({
      // A DOI is the stronger identifier when arXiv knows one, because it is
      // what the Crossref and PubMed records will also carry — which is what
      // makes cross-source deduplication work.
      id: doi !== '' ? doi : `arxiv:${sourceId}`,
      title,
      ...(abstract === '' ? {} : { abstract }),
      authors,
      published: published?.date ?? '',
      ...(doi === '' ? {} : { doi }),
      url: rawId,
      ...(journalRef === '' ? {} : { venue: journalRef }),
      source: 'arxiv',
      source_id: sourceId,
    });
  }

  return { papers, ...(Number.isFinite(total) ? { total: total as number } : {}) };
}

export interface ArxivQuery {
  /** Terms are ANDed; see §5 on context anchoring — never search a bare name. */
  terms: string[];
  maxResults?: number;
  start?: number;
}

/** Quote multi-word terms so arXiv treats them as phrases rather than ORs. */
export function buildArxivQuery(terms: string[]): string {
  return terms
    .map((term) => term.trim())
    .filter((term) => term !== '')
    .map((term) => (term.includes(' ') ? `all:"${term}"` : `all:${term}`))
    .join(' AND ');
}

export function arxivUrl(query: ArxivQuery): string {
  return buildUrl(ARXIV_ENDPOINT, {
    search_query: buildArxivQuery(query.terms),
    start: query.start ?? 0,
    max_results: query.maxResults ?? 25,
    sortBy: 'submittedDate',
    sortOrder: 'descending',
  });
}

export async function searchArxiv(
  query: ArxivQuery,
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<{ papers: Paper[]; total?: number; error?: string; url: string }> {
  const url = arxivUrl(query);
  // arXiv serves Atom; asking for JSON gets a 406 from some edge caches.
  const result = await httpGet(url, { ...options, headers: { Accept: 'application/atom+xml', ...options.headers } }, deps);
  if (!result.ok) return { papers: [], error: result.error, url };
  return { ...parseArxivAtom(result.body), url };
}
