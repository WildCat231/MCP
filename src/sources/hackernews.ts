/**
 * Hacker News (Algolia) adapter — companies and product announcements.
 *
 * https://hn.algolia.com/api/v1/search — free and keyless.
 *
 * HN is a deliberately narrow lens: it over-indexes English-language software
 * startups and under-indexes everything else, so it is treated as one weak
 * channel in an occupancy sweep rather than as evidence of what exists. What
 * it is unusually good at is the thing no registry records — a company
 * announcing a launch, a pivot, or a shutdown in its own words, with a date.
 *
 * NOTE: written from Algolia's published HN API documentation and NOT
 * validated against a live response — see README, "Unverified assumptions".
 */

import type { HttpDeps, HttpOptions } from '../http.js';
import { buildUrl, httpGetJson } from '../http.js';

export const HN_SEARCH_ENDPOINT = 'https://hn.algolia.com/api/v1/search';
export const HN_SEARCH_BY_DATE_ENDPOINT = 'https://hn.algolia.com/api/v1/search_by_date';

export interface HackerNewsStory {
  id: string;
  title: string;
  /** External link, or the HN discussion when the post is self-hosted text. */
  url: string;
  discussion_url: string;
  author?: string;
  points?: number;
  comments?: number;
  /** ISO date. */
  created: string;
  /** Self-post body, truncated. Kept short per §4 on storage. */
  text?: string;
}

export const MAX_TEXT_CHARS = 400;

interface RawHit {
  objectID?: string;
  title?: string;
  story_title?: string;
  url?: string;
  story_url?: string;
  author?: string;
  points?: number;
  num_comments?: number;
  created_at?: string;
  story_text?: string;
  comment_text?: string;
}

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseHackerNews(json: unknown): { stories: HackerNewsStory[]; total?: number; error?: string } {
  if (typeof json !== 'object' || json === null) {
    return { stories: [], error: 'Hacker News response was not an object' };
  }
  const envelope = json as { hits?: RawHit[]; nbHits?: number };
  const hits = envelope.hits ?? [];

  const stories: HackerNewsStory[] = [];
  for (const hit of hits) {
    const id = hit.objectID?.trim();
    const title = (hit.title ?? hit.story_title)?.replace(/\s+/g, ' ').trim();
    if (id === undefined || id === '' || title === undefined || title === '') continue;

    const discussion = `https://news.ycombinator.com/item?id=${id}`;
    const body = stripHtml(hit.story_text ?? hit.comment_text ?? '');

    stories.push({
      id,
      title,
      url: hit.url ?? hit.story_url ?? discussion,
      discussion_url: discussion,
      ...(hit.author === undefined ? {} : { author: hit.author }),
      ...(typeof hit.points === 'number' ? { points: hit.points } : {}),
      ...(typeof hit.num_comments === 'number' ? { comments: hit.num_comments } : {}),
      created: hit.created_at?.slice(0, 10) ?? '',
      ...(body === '' ? {} : { text: body.length > MAX_TEXT_CHARS ? `${body.slice(0, MAX_TEXT_CHARS)}…` : body }),
    });
  }

  return { stories, ...(typeof envelope.nbHits === 'number' ? { total: envelope.nbHits } : {}) };
}

export interface HackerNewsQuery {
  terms: string[];
  hitsPerPage?: number;
  /** `story` (default) or `comment`. Comments carry abandonment chatter. */
  tags?: 'story' | 'comment' | '(story,comment)';
  /** Sort by date rather than relevance — better for "what happened recently". */
  byDate?: boolean;
}

export function hackerNewsUrl(query: HackerNewsQuery): string {
  const endpoint = query.byDate === true ? HN_SEARCH_BY_DATE_ENDPOINT : HN_SEARCH_ENDPOINT;
  return buildUrl(endpoint, {
    query: query.terms.map((t) => t.trim()).filter((t) => t !== '').join(' '),
    tags: query.tags ?? 'story',
    hitsPerPage: Math.min(query.hitsPerPage ?? 30, 100),
  });
}

export async function searchHackerNews(
  query: HackerNewsQuery,
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<{ stories: HackerNewsStory[]; total?: number; error?: string; url: string }> {
  const url = hackerNewsUrl(query);
  const result = await httpGetJson<unknown>(url, options, deps);
  if (!result.ok) return { stories: [], error: result.error, url };
  return { ...parseHackerNews(result.value), url };
}
