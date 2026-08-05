/**
 * `search_literature` (CODEX_SPEC.md §5, §10.4).
 *
 * Queries arXiv, PubMed, and Crossref, deduplicates, and returns papers with
 * the window that was actually used.
 *
 * Two behaviours carry the weight here.
 *
 * **Adaptive window.** A fixed window fails fast-moving and slow-moving fields
 * in opposite directions: six months of machine learning is a firehose, six
 * months of railway signalling is silence. So when no window is given, start
 * at 6 months and widen — 12, 24, 60 — until `max_per_source` results or the
 * ceiling. `window_used` always comes back, because "8 papers in 6 months" and
 * "8 papers in 5 years" describe completely different fields and a caller that
 * cannot tell them apart will misread both.
 *
 * **Context anchoring.** Never search a bare component name. "Transformer" in
 * an ML context must not return power-engineering results. Callers pass
 * multi-term arrays which are ANDed; a single generic term gets a warning
 * rather than a refusal, since the caller may know something we do not.
 */

import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import type { HttpDeps, HttpOptions } from './http.js';
import { searchArxiv } from './sources/arxiv.js';
import { searchCrossref } from './sources/crossref.js';
import { searchPubmed } from './sources/pubmed.js';
import type { LiteratureSource, Paper } from './types.js';

/**
 * Widening ladder in months. Six months is the opening bid because it is short
 * enough that an active field returns a representative sample rather than a
 * decade of backlog; 60 is the ceiling because beyond five years "current
 * research" stops meaning anything.
 */
export const WINDOW_LADDER_MONTHS: readonly number[] = [6, 12, 24, 60] as const;

/** Below this, a term is too generic to anchor a search on its own. */
export const GENERIC_TERMS: ReadonlySet<string> = new Set([
  'ai', 'ml', 'science', 'technology', 'research', 'system', 'systems', 'method',
  'methods', 'device', 'devices', 'model', 'models', 'network', 'networks',
  'algorithm', 'algorithms', 'data', 'learning', 'control', 'design', 'analysis',
  'robot', 'robotics', 'engineering', 'medicine', 'computing', 'software',
]);

export interface SearchWindow {
  from: string;
  to: string;
}

export interface SearchLiteratureInput {
  terms: string[];
  sources?: LiteratureSource[];
  from?: string;
  to?: string;
  max_per_source?: number;
}

export interface SearchLiteratureOutput {
  results: Paper[];
  window_used: SearchWindow;
  counts_by_source: Record<string, number>;
  /** Widening steps tried, so a caller can see a field was scraped for. */
  windows_tried: { window: SearchWindow; months: number; results: number }[];
  /** Set when the window was chosen rather than supplied. */
  window_adaptive: boolean;
  /** Per-source failures. A source that errored is NOT a source with no papers. */
  errors?: Record<string, string>;
  warning?: string;
  duplicates_removed: number;
}

export const DEFAULT_MAX_PER_SOURCE = 25;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Window ending now and reaching back `months`. */
export function windowFor(months: number, now: Date): SearchWindow {
  const from = new Date(now.getTime());
  from.setUTCMonth(from.getUTCMonth() - months);
  return { from: isoDate(from), to: isoDate(now) };
}

/**
 * §5: "If a caller passes a single generic term, return a warning field."
 *
 * A warning, not an error: the caller may have a good reason, and refusing to
 * search would substitute our judgement for Claude's (§2). But an unanchored
 * search returns plausible-looking results from the wrong field entirely,
 * which is worse than no results because it looks like success.
 */
export function anchoringWarning(terms: string[]): string | undefined {
  const usable = terms.map((t) => t.trim()).filter((t) => t !== '');

  if (usable.length === 0) return 'No search terms supplied.';
  if (usable.length > 1) return undefined;

  const only = usable[0] ?? '';
  const words = only.split(/\s+/);

  if (words.length === 1 && GENERIC_TERMS.has(only.toLowerCase())) {
    return (
      `Single generic term "${only}": results are not anchored to a field and may come from an ` +
      'unrelated discipline. Pass additional terms to disambiguate.'
    );
  }
  if (words.length === 1) {
    return (
      `Single term "${only}": nothing constrains the field context. If this word has meanings in ` +
      'other disciplines, results will mix them. Consider adding a domain term.'
    );
  }
  return undefined;
}

/**
 * Deduplicate across sources: DOI first, then normalized title.
 *
 * DOI is exact. Title matching is a fallback for arXiv preprints that have no
 * DOI yet, and is deliberately conservative — case, punctuation and whitespace
 * are normalized but nothing is stemmed, because two genuinely different
 * papers can have titles that differ only in a word ending.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function deduplicate(papers: Paper[]): { papers: Paper[]; removed: number } {
  const byDoi = new Map<string, Paper>();
  const byTitle = new Map<string, Paper>();
  const kept: Paper[] = [];
  let removed = 0;

  for (const paper of papers) {
    const doi = paper.doi?.trim().toLowerCase();
    const title = normalizeTitle(paper.title);

    if (doi !== undefined && doi !== '' && byDoi.has(doi)) {
      removed += 1;
      continue;
    }
    if (title !== '' && byTitle.has(title)) {
      removed += 1;
      continue;
    }

    if (doi !== undefined && doi !== '') byDoi.set(doi, paper);
    if (title !== '') byTitle.set(title, paper);
    kept.push(paper);
  }

  return { papers: kept, removed };
}

interface SourceOutcome {
  papers: Paper[];
  error?: string;
}

async function querySource(
  source: LiteratureSource,
  terms: string[],
  window: SearchWindow,
  max: number,
  options: HttpOptions,
  deps: HttpDeps,
): Promise<SourceOutcome> {
  switch (source) {
    case 'arxiv': {
      // arXiv's API has no date filter, so the window is applied after the
      // fact. Over-fetch so the filter has something to work with.
      const result = await searchArxiv({ terms, maxResults: max * 2 }, options, deps);
      const inWindow = result.papers.filter(
        (p) => p.published !== '' && p.published >= window.from && p.published <= window.to,
      );
      return { papers: inWindow.slice(0, max), ...(result.error === undefined ? {} : { error: result.error }) };
    }
    case 'pubmed': {
      const result = await searchPubmed({ terms, retmax: max, from: window.from, to: window.to }, options, deps);
      return { papers: result.papers, ...(result.error === undefined ? {} : { error: result.error }) };
    }
    case 'crossref': {
      const result = await searchCrossref({ terms, rows: max, from: window.from, to: window.to }, options, deps);
      return { papers: result.papers, ...(result.error === undefined ? {} : { error: result.error }) };
    }
    default:
      return { papers: [], error: `unknown source: ${String(source)}` };
  }
}

export interface SearchDeps extends HttpDeps {
  clock?: Clock;
}

export async function searchLiterature(
  input: SearchLiteratureInput,
  options: HttpOptions = {},
  deps: SearchDeps = {},
): Promise<SearchLiteratureOutput> {
  const clock = deps.clock ?? systemClock;
  const now = new Date(clock.now());
  const sources = input.sources ?? ['arxiv', 'pubmed', 'crossref'];
  const max = input.max_per_source ?? DEFAULT_MAX_PER_SOURCE;
  const terms = input.terms.map((t) => t.trim()).filter((t) => t !== '');
  const warning = anchoringWarning(input.terms);

  if (terms.length === 0) {
    return {
      results: [],
      window_used: windowFor(WINDOW_LADDER_MONTHS[0] ?? 6, now),
      counts_by_source: {},
      windows_tried: [],
      window_adaptive: true,
      duplicates_removed: 0,
      ...(warning === undefined ? {} : { warning }),
    };
  }

  // An explicit window is never widened — the caller asked a specific question.
  const explicit = input.from !== undefined || input.to !== undefined;
  const ladder = explicit
    ? [{ months: 0, window: { from: input.from ?? '1800-01-01', to: input.to ?? isoDate(now) } }]
    : WINDOW_LADDER_MONTHS.map((months) => ({ months, window: windowFor(months, now) }));

  const windowsTried: SearchLiteratureOutput['windows_tried'] = [];
  let best: { window: SearchWindow; papers: Paper[]; removed: number; counts: Record<string, number>; errors: Record<string, string> } | undefined;

  for (const step of ladder) {
    const counts: Record<string, number> = {};
    const errors: Record<string, string> = {};
    const collected: Paper[] = [];

    // Sequential, not parallel: the rate limiter would serialize same-host
    // requests anyway, and widening often stops early, so firing every source
    // at once would spend tokens on windows we never use.
    for (const source of sources) {
      const outcome = await querySource(source, terms, step.window, max, options, deps);
      counts[source] = outcome.papers.length;
      if (outcome.error !== undefined) errors[source] = outcome.error;
      collected.push(...outcome.papers);
    }

    const { papers, removed } = deduplicate(collected);
    windowsTried.push({ window: step.window, months: step.months, results: papers.length });
    best = { window: step.window, papers, removed, counts, errors };

    // Stop as soon as any source is satisfied. Widening further would bury a
    // genuinely active field in older work.
    const satisfied = Object.values(counts).some((count) => count >= max);
    if (satisfied || explicit) break;
  }

  const result = best ?? {
    window: windowFor(WINDOW_LADDER_MONTHS[0] ?? 6, now),
    papers: [],
    removed: 0,
    counts: {},
    errors: {},
  };

  // Newest first; papers with no date sort last rather than being dropped.
  const sorted = [...result.papers].sort((a, b) => (b.published || '').localeCompare(a.published || ''));

  const errorCount = Object.keys(result.errors).length;
  const notes = [warning];

  // §7: an empty section must never be ambiguous between "nothing is happening
  // in this field" and "the API timed out".
  if (errorCount > 0) {
    notes.push(
      `${errorCount} of ${sources.length} source(s) failed: ${Object.keys(result.errors).join(', ')}. ` +
        'Counts below are lower bounds, not a measure of activity in this field.',
    );
  }
  if (sorted.length === 0 && errorCount === 0 && !explicit) {
    notes.push(
      `No results after widening to ${WINDOW_LADDER_MONTHS[WINDOW_LADDER_MONTHS.length - 1]} months. ` +
        'All sources answered; this field appears genuinely quiet.',
    );
  }

  const combined = notes.filter((n) => n !== undefined).join(' ');

  return {
    results: sorted,
    window_used: result.window,
    counts_by_source: result.counts,
    windows_tried: windowsTried,
    window_adaptive: !explicit,
    duplicates_removed: result.removed,
    ...(errorCount === 0 ? {} : { errors: result.errors }),
    ...(combined === '' ? {} : { warning: combined }),
  };
}
