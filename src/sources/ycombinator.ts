/**
 * Y Combinator Requests for Startups adapter.
 *
 * https://www.ycombinator.com/rfs — an HTML page, not an API, which makes this
 * the most fragile adapter in the server. Two consequences are designed for
 * rather than hoped away.
 *
 * ## A failed parse is an error, never an empty list
 *
 * If the page structure changes, the extractor must say so. Returning zero
 * requests would read as "YC is asking for nothing", which is never true and
 * is exactly the confident-looking fiction this project exists to avoid. Every
 * path that cannot produce requests returns an `error`.
 *
 * ## Stale is worse than none
 *
 * The RFS turns over every few months. A cached copy served silently as
 * current would misrepresent what YC is asking for right now — a worse
 * outcome than having no answer, and the opposite of the general §7 policy
 * where serving stale cache beats serving nothing. So this adapter departs
 * from §7 deliberately:
 *
 *   - fresh (< 7 days)        served normally
 *   - stale (7-90 days)       served with `stale: true`, an age, and a warning
 *                             that it must not be presented as current
 *   - expired (> 90 days)     NOT served. More than one batch cycle old is
 *                             certainly wrong, and the caller is better off
 *                             knowing nothing than believing that.
 *
 * NOTE: the extraction below is written from the page's observable structure
 * and NOT validated against a live response — see README, "Unverified
 * assumptions". `parseRfsPage` is pure, so one recorded fixture confirms or
 * corrects it.
 */

import type { HttpDeps, HttpOptions } from '../http.js';
import { httpGet } from '../http.js';

export const YC_RFS_URL = 'https://www.ycombinator.com/rfs';

/** Fresh for one week; the page changes far less often than that. */
export const RFS_TTL_DAYS = 7;

/**
 * Beyond this the copy predates the current batch and is not served at all.
 * YC runs two batches a year, so ninety days is roughly one cycle — past it,
 * the odds that the list still reflects what YC is asking for are poor enough
 * that silence is the more useful answer.
 */
export const RFS_MAX_STALE_DAYS = 90;

export interface RfsRequest {
  /** The request's heading, e.g. "AI agents for real work". */
  title: string;
  /** Body text, truncated. */
  description?: string;
  /** Named partners, when the page attributes the request. */
  authors?: string[];
  url?: string;
}

export interface RfsResult {
  requests: RfsRequest[];
  source_url: string;
  /** Batch label if the page states one, e.g. "Summer 2026". Never inferred. */
  batch?: string;
  fetched_at: string;
  stale?: boolean;
  age_days?: number;
  warning?: string;
  error?: string;
}

const MAX_DESCRIPTION_CHARS = 600;

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const truncate = (text: string): string =>
  text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS)}…` : text;

/**
 * Structured extraction from the Next.js data island, when present.
 *
 * Preferred over reading the rendered markup: it is the page's own data rather
 * than a guess at its layout, so it survives styling changes that would break
 * a selector.
 */
function fromNextData(html: string): RfsRequest[] | undefined {
  const match = /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (match?.[1] === undefined) return undefined;

  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return undefined;
  }

  // The shape is not contractual, so walk for objects that look like requests
  // rather than assuming a path that a Next.js upgrade would move.
  const found: RfsRequest[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== 'object' || node === null) return;

    const record = node as Record<string, unknown>;
    const title = typeof record['title'] === 'string' ? record['title'].trim() : undefined;
    const body =
      typeof record['description'] === 'string'
        ? record['description']
        : typeof record['body'] === 'string'
          ? record['body']
          : typeof record['content'] === 'string'
            ? record['content']
            : undefined;

    if (title !== undefined && title !== '' && body !== undefined && !seen.has(title)) {
      seen.add(title);
      const text = stripTags(body);
      found.push({
        title,
        ...(text === '' ? {} : { description: truncate(text) }),
        ...(typeof record['url'] === 'string' ? { url: record['url'] } : {}),
      });
    }

    for (const child of Object.values(record)) walk(child);
  };

  walk(data);
  return found.length > 0 ? found : undefined;
}

/**
 * Fallback: read headings and the prose that follows them.
 *
 * Cruder and more likely to pick up navigation text, so it only runs when the
 * structured path finds nothing, and headings that look like page furniture
 * are dropped.
 */
const FURNITURE = /^(request(s)? for startups|apply|companies|about|library|blog|jobs|contact|search|menu|home)$/i;

function fromHeadings(html: string): RfsRequest[] {
  const requests: RfsRequest[] = [];
  const pattern = /<h([23])[^>]*>([\s\S]*?)<\/h\1>([\s\S]*?)(?=<h[23][^>]*>|$)/g;

  for (const match of html.matchAll(pattern)) {
    const title = stripTags(match[2] ?? '');
    if (title === '' || title.length > 200 || FURNITURE.test(title)) continue;

    const body = stripTags(match[3] ?? '');
    requests.push({ title, ...(body === '' ? {} : { description: truncate(body) }) });
  }
  return requests;
}

/** Batch label, only when the page states one. Never inferred from the date. */
export function extractBatch(html: string): string | undefined {
  const match = /\b((?:Winter|Spring|Summer|Fall)\s+20\d{2})\b/.exec(stripTags(html));
  return match?.[1];
}

/** Pure. Extract requests from the RFS page HTML. */
export function parseRfsPage(html: string): { requests: RfsRequest[]; batch?: string; error?: string } {
  if (html.trim() === '') return { requests: [], error: 'Empty response from the RFS page.' };

  const structured = fromNextData(html);
  const requests = structured ?? fromHeadings(html);
  const batch = extractBatch(html);

  if (requests.length === 0) {
    // Never an empty list: YC is never asking for nothing, so zero requests
    // means the extractor failed, not that the page is empty.
    return {
      requests: [],
      ...(batch === undefined ? {} : { batch }),
      error:
        'Could not extract any requests from the RFS page. Neither the structured data island nor the heading ' +
        'fallback matched, which means the page structure has changed. This is a parser failure, not an empty RFS.',
    };
  }

  return { requests, ...(batch === undefined ? {} : { batch }) };
}

export async function fetchRfs(
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<{ requests: RfsRequest[]; batch?: string; error?: string; url: string }> {
  const result = await httpGet(YC_RFS_URL, { ...options, headers: { Accept: 'text/html', ...options.headers } }, deps);
  if (!result.ok) return { requests: [], error: result.error, url: YC_RFS_URL };
  return { ...parseRfsPage(result.body), url: YC_RFS_URL };
}

/** Freshness verdict for a cached copy, given its age. */
export function freshness(ageDays: number): { state: 'fresh' | 'stale' | 'expired'; warning?: string } {
  if (ageDays < RFS_TTL_DAYS) return { state: 'fresh' };
  if (ageDays <= RFS_MAX_STALE_DAYS) {
    return {
      state: 'stale',
      warning:
        `This RFS copy is ${Math.round(ageDays)} days old and the live page could not be refetched. YC revises the ` +
        'RFS every few months, so this MUST NOT be presented as their current asks — treat it as a historical ' +
        'snapshot and say so to anyone reading the output.',
    };
  }
  return {
    state: 'expired',
    warning:
      `The only cached RFS copy is ${Math.round(ageDays)} days old, more than the ${RFS_MAX_STALE_DAYS}-day ceiling, ` +
      'and the live page could not be refetched. It predates the current batch and is not returned: an RFS this old ' +
      'is more misleading than no RFS at all.',
  };
}
