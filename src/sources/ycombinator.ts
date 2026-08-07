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

    const cleanTitle = title === undefined ? undefined : title.replace(ANCHOR_GLYPHS, '').trim();
    if (cleanTitle !== undefined && cleanTitle !== '' && body !== undefined && !seen.has(cleanTitle)) {
      if (FURNITURE.test(cleanTitle) || BATCH_HEADING.test(cleanTitle)) {
        for (const child of Object.values(record)) walk(child);
        return;
      }
      seen.add(cleanTitle);
      const text = stripTags(body);
      found.push({
        title: cleanTitle,
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
 * Headings that are page structure rather than requests.
 *
 * Observed on the Fall 2026 page: the heading scan collected "Footer", "Make
 * something people want.", "Programs", "Resources" and "Company" from the site
 * chrome. Container scoping below is the real fix — this list is the backstop
 * for chrome that lives inside the content region.
 */
const FURNITURE =
  /^(request(s)? for startups|rfs|apply|companies|about|library|blog|jobs|contact|search|menu|home|footer|header|navigation|programs|resources|company|support|legal|press|security|privacy|terms|subscribe|follow|social|news|events|people|make something people want\.?)$/i;

/** A batch label heading, e.g. "Fall 2026". Read separately, never a request. */
const BATCH_HEADING = /^(winter|spring|summer|fall|autumn)\s+20\d{2}$/i;

/**
 * Anchor glyphs that heading permalinks append to their own text.
 *
 * The Fall 2026 page renders each request heading with a "#" permalink inside
 * the <h>, so every genuine title came out with a trailing " #". Stripped from
 * both ends rather than removed globally: a title could legitimately contain a
 * "#" in the middle (a language name, a channel), and removing those would
 * corrupt a real request.
 */
const ANCHOR_GLYPHS = /^[\s#¶§¤]+|[\s#¶§¤]+$/g;

/** Heading text with permalink anchors removed and glyphs trimmed. */
function cleanHeading(html: string): string {
  // Drop in-page anchor links first — that is where the glyph lives — then
  // trim any glyph the markup rendered as bare text.
  const withoutAnchors = html.replace(/<a\b[^>]*href=["']#[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, ' ');
  return stripTags(withoutAnchors).replace(ANCHOR_GLYPHS, '').trim();
}

export type ExtractionScope = 'main' | 'article' | 'chrome-stripped' | 'whole-document';

/**
 * Narrow the document to the region that holds requests.
 *
 * Scanning document-wide was the root defect: headings from the footer and the
 * site nav are structurally indistinguishable from request headings once you
 * are only looking at <h2>/<h3> tags, so no keyword filter can be relied on to
 * separate them. Scoping to the content container removes them by position
 * instead of by guessing at their text.
 */
export function contentRegion(html: string): { html: string; scope: ExtractionScope } {
  // Greedy to the LAST closing tag, so a nested <main> cannot truncate early.
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html);
  if (main?.[1] !== undefined && main[1].trim() !== '') return { html: main[1], scope: 'main' };

  const article = /<article\b[^>]*>([\s\S]*)<\/article>/i.exec(html);
  if (article?.[1] !== undefined && article[1].trim() !== '') return { html: article[1], scope: 'article' };

  // No semantic container: cut the chrome out instead.
  const stripped = html.replace(/<(footer|nav|header|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  if (stripped !== html) return { html: stripped, scope: 'chrome-stripped' };

  return { html, scope: 'whole-document' };
}

/**
 * Fallback: read headings and the prose that follows them, within the content
 * region only. Runs when the structured path finds nothing.
 */
function fromHeadings(html: string, batch: string | undefined): RfsRequest[] {
  const requests: RfsRequest[] = [];
  const pattern = /<h([23])[^>]*>([\s\S]*?)<\/h\1>([\s\S]*?)(?=<h[23][^>]*>|$)/g;
  const normalized = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();

  for (const match of html.matchAll(pattern)) {
    const title = cleanHeading(match[2] ?? '');
    if (title === '' || title.length > 200) continue;
    if (FURNITURE.test(title) || BATCH_HEADING.test(title)) continue;
    // The batch label is returned separately; counting it as a request both
    // inflates the count and puts a non-request at the top of the list.
    if (batch !== undefined && normalized(title) === normalized(batch)) continue;

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

export interface RfsParse {
  requests: RfsRequest[];
  batch?: string;
  /** Which extractor produced the requests — answers "is the data island there?". */
  method: 'next-data' | 'headings';
  /** Which region was scanned. `whole-document` means chrome could not be excluded. */
  scope: ExtractionScope;
  error?: string;
}

/** Pure. Extract requests from the RFS page HTML. */
export function parseRfsPage(html: string): RfsParse {
  if (html.trim() === '') {
    return { requests: [], method: 'headings', scope: 'whole-document', error: 'Empty response from the RFS page.' };
  }

  const batch = extractBatch(html);

  // The data island is preferred when present: it is the page's own data
  // rather than an inference from its layout, and it carries no chrome.
  const structured = fromNextData(html);
  const region = contentRegion(html);
  const requests = structured ?? fromHeadings(region.html, batch);
  const method: RfsParse['method'] = structured === undefined ? 'headings' : 'next-data';
  const scope: ExtractionScope = structured === undefined ? region.scope : 'whole-document';

  if (requests.length === 0) {
    // Never an empty list: YC is never asking for nothing, so zero requests
    // means the extractor failed, not that the page is empty.
    return {
      requests: [],
      ...(batch === undefined ? {} : { batch }),
      method,
      scope,
      error:
        'Could not extract any requests from the RFS page. Neither the structured data island nor the heading ' +
        'fallback matched, which means the page structure has changed. This is a parser failure, not an empty RFS.',
    };
  }

  return { requests, ...(batch === undefined ? {} : { batch }), method, scope };
}

export async function fetchRfs(
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<RfsParse & { url: string }> {
  const result = await httpGet(YC_RFS_URL, { ...options, headers: { Accept: 'text/html', ...options.headers } }, deps);
  if (!result.ok) {
    return { requests: [], method: 'headings', scope: 'whole-document', error: result.error, url: YC_RFS_URL };
  }
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
