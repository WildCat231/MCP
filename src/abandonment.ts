/**
 * `check_abandonment` — did anyone try this and stop?
 *
 * The highest-value signal in gap analysis, and the one no registry records. A
 * registry tells you a company existed and a patent was granted; neither tells
 * you the product was killed in 2023 because the unit economics never closed.
 * An empty gap and a graveyard look identical from the occupancy side, and
 * they mean opposite things: nobody has tried, versus several have tried and
 * failed for reasons that will apply to you too.
 *
 * ## Reasons are extracted, never summarized
 *
 * Where a source states a reason, the sentence containing it is returned
 * verbatim as a snippet. It is not paraphrased, condensed, or interpreted —
 * that would be reasoning, and per §2 reasoning belongs to Claude. The
 * extraction is a regex over causal connectives ("because", "due to",
 * "citing", "cited"), which is deterministic and auditable in a way that a
 * generated summary would not be.
 *
 * ## Absence here is especially weak
 *
 * Shutdowns are systematically under-reported: companies announce launches and
 * go quiet on failures, and the smaller the company the quieter the ending. So
 * "no abandonment signals" carries much less weight than "no incumbents", and
 * the output says so rather than leaving the asymmetry to be inferred.
 */

import type { HttpDeps, HttpOptions } from './http.js';
import { searchNews } from './sources/gdelt.js';
import { searchHackerNews } from './sources/hackernews.js';

export type AbandonmentSignal = 'shutdown' | 'pivot' | 'acquisition' | 'deprecation' | 'wind_down';

/**
 * Query vocabulary per signal, and the patterns that classify a hit.
 *
 * Kept as literal word lists rather than a cleverer model because the whole
 * classification has to be inspectable: a caller reading "classified as a
 * pivot" needs to be able to see which word caused that.
 */
export const SIGNAL_TERMS: Record<AbandonmentSignal, string[]> = {
  shutdown: ['shuts down', 'shutting down', 'shut down', 'ceases operations', 'closes down', 'is closing'],
  pivot: ['pivots to', 'pivoting to', 'pivoted', 'changes direction', 'refocuses on'],
  acquisition: ['acquired by', 'acquires', 'acquisition of', 'acqui-hire', 'bought by'],
  deprecation: ['deprecated', 'deprecating', 'end of life', 'sunset', 'sunsetting', 'discontinued'],
  wind_down: ['winds down', 'winding down', 'lays off', 'layoffs', 'insolvency', 'administration', 'bankruptcy'],
};

const CLASSIFIERS: Record<AbandonmentSignal, RegExp> = {
  shutdown: /\b(shut(s|ting)?\s+down|ceas(e|es|ed|ing)\s+operations|clos(e|es|ed|ing)\s+(down|its\s+doors))\b/i,
  pivot: /\b(pivot(s|ed|ing)?|refocus(es|ed|ing)?|chang(e|es|ed|ing)\s+direction)\b/i,
  acquisition: /\b(acqui(re|res|red|sition|-?hire)|bought\s+by|takeover)\b/i,
  deprecation: /\b(deprecat(e|es|ed|ing|ion)|end[-\s]of[-\s]life|sunset(s|ting|ted)?|discontinu(e|es|ed|ing))\b/i,
  wind_down: /\b(wind(s|ing)?\s+down|lay(s|ing)?\s+off|laid\s+off|layoffs?|insolven(t|cy)|bankrupt(cy)?|administration)\b/i,
};

/**
 * Causal connectives. A sentence containing one is where a stated reason
 * lives; a sentence without one is a report of the event, not its cause.
 */
const REASON_MARKERS =
  /\b(because|due to|citing|cited|owing to|as a result of|blamed|attributed to|after failing to|unable to|ran out of)\b/i;

export interface AbandonmentHit {
  signal: AbandonmentSignal;
  title: string;
  url: string;
  date?: string;
  source: 'news' | 'hackernews';
  /** Domain or author, for judging the source's weight. */
  publisher?: string;
  /**
   * The sentence stating a reason, verbatim. Absent when no source sentence
   * contained a causal connective — which means no reason was stated, not
   * that no reason exists.
   */
  stated_reason?: string;
  /** The word that caused the classification, so the label is auditable. */
  matched_on: string;
}

export interface CheckAbandonmentInput {
  entity_terms: string[];
  signals?: AbandonmentSignal[];
  max_per_signal?: number;
}

export interface CheckAbandonmentOutput {
  entity_terms: string[];
  /** Read first: what was found, and how much weight a zero carries. */
  flag: string;
  hits: AbandonmentHit[];
  signals_found: AbandonmentSignal[];
  /** Hits carrying an explicitly stated reason. */
  reasons: { signal: AbandonmentSignal; reason: string; url: string; date?: string }[];
  counts_by_signal: Record<string, number>;
  searched: { signal: AbandonmentSignal; query: string[]; news_hits: number; hn_hits: number }[];
  errors?: Record<string, string>;
  warning?: string;
  error?: string;
}

const DEFAULT_MAX = 10;

/** Split into sentences well enough to isolate a reason clause. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * The first sentence containing a causal connective, verbatim and length-capped.
 * Returns undefined rather than falling back to the first sentence: a sentence
 * without a connective is the event, and returning it as "the stated reason"
 * would invent an attribution the source never made.
 */
export function extractStatedReason(text: string | undefined): string | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  for (const sentence of sentences(text)) {
    if (REASON_MARKERS.test(sentence)) {
      return sentence.length > 300 ? `${sentence.slice(0, 300)}…` : sentence;
    }
  }
  return undefined;
}

/** Which signal a piece of text reports, and the substring that decided it. */
export function classify(text: string): { signal: AbandonmentSignal; matched: string } | undefined {
  for (const signal of Object.keys(CLASSIFIERS) as AbandonmentSignal[]) {
    const match = CLASSIFIERS[signal].exec(text);
    if (match !== null) return { signal, matched: match[0] };
  }
  return undefined;
}

export async function checkAbandonment(
  input: CheckAbandonmentInput,
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<CheckAbandonmentOutput> {
  const entityTerms = input.entity_terms.map((t) => t.trim()).filter((t) => t !== '');
  const signals = input.signals ?? (Object.keys(SIGNAL_TERMS) as AbandonmentSignal[]);
  const max = input.max_per_signal ?? DEFAULT_MAX;

  if (entityTerms.length === 0) {
    return {
      entity_terms: [],
      flag: 'No entity terms supplied; nothing was searched.',
      hits: [],
      signals_found: [],
      reasons: [],
      counts_by_signal: {},
      searched: [],
      error: 'entity_terms is empty.',
    };
  }

  const hits: AbandonmentHit[] = [];
  const searched: CheckAbandonmentOutput['searched'] = [];
  const errors: Record<string, string> = {};
  const seen = new Set<string>();

  for (const signal of signals) {
    // One representative term per signal keeps the query count bounded; the
    // classifier catches the rest of the vocabulary in whatever comes back.
    const probe = SIGNAL_TERMS[signal][0] ?? signal;
    const terms = [...entityTerms, probe];

    const news = await searchNews({ terms, maxRecords: max }, options, deps);
    const hn = await searchHackerNews({ terms, hitsPerPage: max }, options, deps);

    if (news.error !== undefined) errors[`news:${signal}`] = news.error;
    if (hn.error !== undefined) errors[`hackernews:${signal}`] = hn.error;

    searched.push({ signal, query: terms, news_hits: news.articles.length, hn_hits: hn.stories.length });

    for (const article of news.articles) {
      if (seen.has(article.url)) continue;
      const classified = classify(article.title);
      if (classified === undefined) continue;
      seen.add(article.url);
      hits.push({
        signal: classified.signal,
        title: article.title,
        url: article.url,
        ...(article.seen === '' ? {} : { date: article.seen }),
        source: 'news',
        publisher: article.domain,
        ...(extractStatedReason(article.title) === undefined
          ? {}
          : { stated_reason: extractStatedReason(article.title) as string }),
        matched_on: classified.matched,
      });
    }

    for (const story of hn.stories) {
      if (seen.has(story.url)) continue;
      const haystack = `${story.title} ${story.text ?? ''}`;
      const classified = classify(haystack);
      if (classified === undefined) continue;
      seen.add(story.url);
      hits.push({
        signal: classified.signal,
        title: story.title,
        url: story.url,
        ...(story.created === '' ? {} : { date: story.created }),
        source: 'hackernews',
        ...(story.author === undefined ? {} : { publisher: story.author }),
        ...(extractStatedReason(haystack) === undefined
          ? {}
          : { stated_reason: extractStatedReason(haystack) as string }),
        matched_on: classified.matched,
      });
    }
  }

  // Newest first; undated last rather than dropped.
  hits.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  const countsBySignal: Record<string, number> = {};
  for (const hit of hits) countsBySignal[hit.signal] = (countsBySignal[hit.signal] ?? 0) + 1;

  const signalsFound = [...new Set(hits.map((h) => h.signal))];
  const reasons = hits
    .filter((h) => h.stated_reason !== undefined)
    .map((h) => ({
      signal: h.signal,
      reason: h.stated_reason as string,
      url: h.url,
      ...(h.date === undefined ? {} : { date: h.date }),
    }));

  const errorCount = Object.keys(errors).length;
  const searchesRun = searched.length * 2;

  let flag: string;
  if (hits.length > 0) {
    flag =
      `${hits.length} abandonment signal(s) found: ${signalsFound.join(', ')}. ` +
      `${reasons.length} carr${reasons.length === 1 ? 'ies' : 'y'} an explicitly stated reason. ` +
      'Someone has been here before — read the reasons before treating this as an open gap.';
  } else if (errorCount === searchesRun) {
    flag =
      'NOT INTERPRETABLE: every search failed. This is not evidence that nothing was abandoned — nothing was ' +
      'looked at.';
  } else if (errorCount > 0) {
    flag =
      `No abandonment signals found, but ${errorCount} of ${searchesRun} searches failed. Partial coverage: treat ` +
      'this as weaker than a clean negative.';
  } else {
    flag =
      'No abandonment signals found. Note this is a WEAK negative: launches are announced and failures are not, ' +
      'and the smaller the company the quieter the ending. Absence here is much weaker evidence than absence of ' +
      'incumbents would be.';
  }

  const notes = [
    'Reasons are extracted verbatim from source sentences containing a causal connective, never summarized (§2). ' +
      'A hit without a stated reason means no source stated one, not that there was none.',
  ];
  if (errorCount > 0) {
    notes.push(`Failed searches: ${Object.keys(errors).join(', ')}.`);
  }

  return {
    entity_terms: entityTerms,
    flag,
    hits,
    signals_found: signalsFound,
    reasons,
    counts_by_signal: countsBySignal,
    searched,
    ...(errorCount === 0 ? {} : { errors }),
    warning: notes.join(' '),
  };
}
