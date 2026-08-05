/**
 * PubMed E-utilities adapter.
 *
 * https://eutils.ncbi.nlm.nih.gov/entrez/eutils — keyless at 3 requests/second.
 *
 * Two calls per search: `esearch` returns PMIDs, `esummary` returns metadata
 * for them. Both are rate-limited through the same host bucket, so a search
 * costs two tokens.
 *
 * NOTE: written from NCBI's published schema, NOT validated against a live
 * response — see README, "Unverified assumptions".
 */

import { normalizeDate } from '../dates.js';
import type { HttpDeps, HttpOptions } from '../http.js';
import { buildUrl, httpGetJson } from '../http.js';
import type { Paper } from '../types.js';

export const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

interface ESearchResponse {
  esearchresult?: {
    idlist?: string[];
    count?: string;
  };
}

interface ESummaryArticleId {
  idtype?: string;
  value?: string;
}

interface ESummaryDoc {
  uid?: string;
  title?: string;
  pubdate?: string;
  epubdate?: string;
  fulljournalname?: string;
  source?: string;
  authors?: { name?: string; authtype?: string }[];
  articleids?: ESummaryArticleId[];
}

interface ESummaryResponse {
  result?: Record<string, ESummaryDoc | string[]> & { uids?: string[] };
}

export function parseESearch(json: unknown): { pmids: string[]; total?: number } {
  const response = json as ESearchResponse;
  const pmids = (response.esearchresult?.idlist ?? []).filter((id) => typeof id === 'string' && id !== '');
  const count = Number(response.esearchresult?.count);
  return { pmids, ...(Number.isFinite(count) ? { total: count } : {}) };
}

function doiOf(doc: ESummaryDoc): string | undefined {
  const entry = (doc.articleids ?? []).find((a) => a.idtype?.toLowerCase() === 'doi');
  const value = entry?.value?.trim().toLowerCase();
  return value === undefined || value === '' ? undefined : value;
}

/** Pure. An esummary document -> a normalized `Paper`. */
export function toPaper(doc: ESummaryDoc): Paper | undefined {
  const pmid = doc.uid?.trim();
  const title = doc.title?.replace(/\s+/g, ' ').trim();
  if (pmid === undefined || pmid === '' || title === undefined || title === '') return undefined;

  const doi = doiOf(doc);
  // `epubdate` is the electronic publication date and precedes `pubdate` when
  // they differ; prefer it, since first public availability is what a timeline
  // milestone means.
  const published = normalizeDate(doc.epubdate) ?? normalizeDate(doc.pubdate);
  const venue = doc.fulljournalname?.trim() ?? doc.source?.trim();

  const authors = (doc.authors ?? [])
    // Collective author entries ("Smith J, et al" groups) are not people and
    // pollute independence scoring if counted as distinct authors.
    .filter((a) => a.authtype === undefined || a.authtype === 'Author')
    .map((a) => a.name?.trim() ?? '')
    .filter((n) => n !== '');

  return {
    id: doi ?? `pubmed:${pmid}`,
    title,
    authors,
    published: published?.date ?? '',
    ...(doi === undefined ? {} : { doi }),
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    ...(venue === undefined || venue === '' ? {} : { venue }),
    source: 'pubmed',
    source_id: pmid,
  };
}

export function parseESummary(json: unknown): Paper[] {
  const response = json as ESummaryResponse;
  const result = response.result;
  if (result === undefined) return [];

  const uids = Array.isArray(result.uids) ? result.uids : [];
  const papers: Paper[] = [];
  for (const uid of uids) {
    const doc = result[uid];
    if (doc === undefined || Array.isArray(doc)) continue;
    const paper = toPaper(doc as ESummaryDoc);
    if (paper !== undefined) papers.push(paper);
  }
  return papers;
}

export interface PubmedQuery {
  terms: string[];
  retmax?: number;
  /** Inclusive ISO date bounds. */
  from?: string;
  to?: string;
}

/** AND the terms, quoting phrases so PubMed does not split them. */
export function buildPubmedTerm(query: PubmedQuery): string {
  const terms = query.terms
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .map((t) => (t.includes(' ') ? `"${t}"` : t));

  let term = terms.join(' AND ');
  if (query.from !== undefined || query.to !== undefined) {
    const from = (query.from ?? '1800-01-01').replace(/-/g, '/');
    const to = (query.to ?? '3000-01-01').replace(/-/g, '/');
    term += ` AND ("${from}"[Date - Publication] : "${to}"[Date - Publication])`;
  }
  return term;
}

export function esearchUrl(query: PubmedQuery): string {
  return buildUrl(`${EUTILS_BASE}/esearch.fcgi`, {
    db: 'pubmed',
    term: buildPubmedTerm(query),
    retmax: query.retmax ?? 25,
    retmode: 'json',
    sort: 'date',
    tool: 'frontier-mcp',
  });
}

export function esummaryUrl(pmids: string[]): string {
  return buildUrl(`${EUTILS_BASE}/esummary.fcgi`, {
    db: 'pubmed',
    id: pmids.join(','),
    retmode: 'json',
    tool: 'frontier-mcp',
  });
}

export async function searchPubmed(
  query: PubmedQuery,
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<{ papers: Paper[]; total?: number; error?: string; url: string }> {
  const searchUrl = esearchUrl(query);
  const search = await httpGetJson<unknown>(searchUrl, options, deps);
  if (!search.ok) return { papers: [], error: search.error, url: searchUrl };

  const { pmids, total } = parseESearch(search.value);
  // No hits is a real answer, not a failure — and it must not look like one.
  if (pmids.length === 0) return { papers: [], ...(total === undefined ? {} : { total }), url: searchUrl };

  const summaryUrl = esummaryUrl(pmids);
  const summary = await httpGetJson<unknown>(summaryUrl, options, deps);
  if (!summary.ok) return { papers: [], error: summary.error, url: summaryUrl };

  return { papers: parseESummary(summary.value), ...(total === undefined ? {} : { total }), url: searchUrl };
}
