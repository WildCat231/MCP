/**
 * `check_registry` (CODEX_SPEC.md §5, §10.5).
 *
 * Primary-source lookup across the four registries. §6.1 makes this the first
 * step of verification, because a primary hit short-circuits most of the
 * ambiguity below it.
 *
 * Three things this does that a naive lookup would not.
 *
 * **Every match, never a chosen one.** No best-match selection anywhere.
 * Picking one record out of several is a judgement about which record a claim
 * refers to, and per §2 that judgement belongs to Claude, with all candidates
 * visible.
 *
 * **Truncation is reported loudly.** This is not a theoretical concern. A
 * da Vinci 510(k) search returns 115 records; the default page holds 25, in an
 * order openFDA does not specify, and the oldest record is not among them.
 * Reading "earliest clearance" off that page yields 2001-03-02 when the true
 * answer is unknown. So `truncated` and `total_matches` are always returned,
 * and the warning says explicitly that ordering claims cannot be made from a
 * truncated set.
 *
 * **openFDA means both databases.** A regulatory query hits 510(k) *and* PMA
 * and returns both, because the entire clearance-vs-approval distinction is
 * invisible if a caller has to know in advance which one to ask. Absence from
 * one and presence in the other is the finding.
 */

import { availabilityOf } from './credentials.js';
import type { RegistryAvailability } from './credentials.js';
import type { HttpDeps, HttpOptions } from './http.js';
import { lookupDoi, crossrefSearchUrl, searchCrossref, toRegistryRecord } from './sources/crossref.js';
import {
  approvalSearchUrl,
  clearanceByNumberUrl,
  clearanceSearchUrl,
  searchApprovals,
  searchClearances,
} from './sources/openfda.js';
import { searchPatents } from './sources/patentsview.js';
import { lookupPage, searchPages, summaryUrl } from './sources/wikipedia.js';
import type { CrossrefRecord, RegistryName, RegistryRecord } from './types.js';

export interface CheckRegistryInput {
  registry: RegistryName;
  query: string;
  /** Registry-specific narrowing. openFDA accepts `field: value` clauses. */
  filters?: Record<string, string>;
  limit?: number;
  /** e.g. `decision_date:asc` for openFDA. See the truncation note above. */
  sort?: string;
}

export interface CheckRegistryOutput {
  registry: RegistryName;
  records: RegistryRecord[];
  /** Every URL queried — openFDA uses two. */
  registry_url: string[];
  returned: number;
  /** Total matches upstream, when the registry reports one. */
  total_matches?: number;
  /**
   * True when the registry holds more matches than were returned. A truncated
   * set supports "these records exist"; it does NOT support "this is the
   * earliest" or "there are none others".
   */
  truncated: boolean;
  /** Per-sub-query detail, so an openFDA absence is attributable. */
  breakdown?: { source: string; returned: number; total?: number; url: string; error?: string }[];
  availability?: RegistryAvailability;
  /** Candidate titles when a Wikipedia lookup resolved to nothing usable. */
  candidates?: string[];
  warning?: string;
  error?: string;
}

const DEFAULT_LIMIT = 25;

function truncationWarning(returned: number, total: number, sorted: boolean): string {
  return (
    `Truncated: ${returned} of ${total} matches returned` +
    (sorted ? ' (sorted).' : ' in the registry default order, which is unspecified.') +
    ' These records exist, but this set does NOT establish which is earliest or latest,' +
    ' and absence from it is not absence from the registry.' +
    (sorted ? '' : ' Re-query with an explicit sort to make ordering claims.')
  );
}

/** A DOI, loosely: enough to tell a lookup from a free-text search. */
function looksLikeDoi(query: string): boolean {
  return /^(https?:\/\/(dx\.)?doi\.org\/)?10\.\d{4,9}\//i.test(query.trim());
}

/** A 510(k) K number. */
function looksLikeKNumber(query: string): boolean {
  return /^K\d{6}$/i.test(query.trim());
}

async function checkOpenFda(
  input: CheckRegistryInput,
  options: HttpOptions,
  deps: HttpDeps,
): Promise<CheckRegistryOutput> {
  const limit = input.limit ?? DEFAULT_LIMIT;

  // An exact K number is an identifier, not a search term — §6.1's anchor path.
  if (looksLikeKNumber(input.query)) {
    const url = clearanceByNumberUrl(input.query);
    const result = await searchClearances(
      { query: input.query, limit: 1, filters: { k_number: input.query.toUpperCase() } },
      options,
      deps,
    );
    return {
      registry: 'openfda_device',
      records: result.records,
      registry_url: [url],
      returned: result.records.length,
      ...(result.total === undefined ? {} : { total_matches: result.total }),
      truncated: false,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  }

  const query = {
    query: input.query,
    limit,
    ...(input.filters === undefined ? {} : { filters: input.filters }),
    ...(input.sort === undefined ? {} : { sort: input.sort }),
  };

  // Both databases, always. Asking only the one the caller guessed is how a
  // clearance gets reported as an approval.
  const [clearances, approvals] = [
    await searchClearances(query, options, deps),
    await searchApprovals(query, options, deps),
  ];

  const records = [...clearances.records, ...approvals.records];
  const breakdown = [
    {
      source: '510k',
      returned: clearances.records.length,
      ...(clearances.total === undefined ? {} : { total: clearances.total }),
      url: clearanceSearchUrl(query),
      ...(clearances.error === undefined ? {} : { error: clearances.error }),
    },
    {
      source: 'pma',
      returned: approvals.records.length,
      ...(approvals.total === undefined ? {} : { total: approvals.total }),
      url: approvalSearchUrl(query),
      ...(approvals.error === undefined ? {} : { error: approvals.error }),
    },
  ];

  const total = (clearances.total ?? clearances.records.length) + (approvals.total ?? approvals.records.length);
  const truncated = total > records.length;

  const notes: string[] = [];
  if (truncated) notes.push(truncationWarning(records.length, total, input.sort !== undefined));

  // The finding that matters, stated rather than left to be inferred.
  if (clearances.records.length > 0 && approvals.records.length === 0 && approvals.error === undefined) {
    notes.push('Present in 510(k) and absent from PMA: this device was CLEARED, not APPROVED.');
  } else if (approvals.records.length > 0 && clearances.records.length === 0 && clearances.error === undefined) {
    notes.push('Present in PMA and absent from 510(k): this device was APPROVED, not merely cleared.');
  }

  const errors = breakdown.filter((b) => b.error !== undefined).map((b) => b.source);
  if (errors.length > 0) {
    notes.push(
      `${errors.join(' and ')} query failed — absence from the results is NOT evidence of absence from the registry.`,
    );
  }

  return {
    registry: 'openfda_device',
    records,
    registry_url: breakdown.map((b) => b.url),
    returned: records.length,
    total_matches: total,
    truncated,
    breakdown,
    ...(notes.length === 0 ? {} : { warning: notes.join(' ') }),
  };
}

async function checkCrossref(
  input: CheckRegistryInput,
  options: HttpOptions,
  deps: HttpDeps,
): Promise<CheckRegistryOutput> {
  if (looksLikeDoi(input.query)) {
    const doi = input.query.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    const result = await lookupDoi(doi, options, deps);
    return {
      registry: 'crossref',
      records: result.records,
      registry_url: [result.url],
      returned: result.records.length,
      total_matches: result.records.length,
      truncated: false,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  }

  const limit = input.limit ?? DEFAULT_LIMIT;
  const search = await searchCrossref({ terms: [input.query], rows: limit }, options, deps);
  // Search returns Papers; re-derive registry records from the same payload
  // shape so a title search and a DOI lookup yield the same record type.
  const records = search.papers
    .map((paper) =>
      toRegistryRecord({
        DOI: paper.doi ?? '',
        title: [paper.title],
        type: 'journal-article',
        author: [],
        ...(paper.venue === undefined ? {} : { 'container-title': [paper.venue] }),
        ...(paper.published === '' ? {} : { issued: { 'date-parts': [paper.published.split('-').map(Number)] } }),
        URL: paper.url,
      }),
    )
    .filter((r): r is CrossrefRecord => r !== undefined);

  const total = search.total ?? records.length;
  const truncated = total > records.length;

  return {
    registry: 'crossref',
    records,
    registry_url: [crossrefSearchUrl({ terms: [input.query], rows: limit })],
    returned: records.length,
    total_matches: total,
    truncated,
    ...(truncated ? { warning: truncationWarning(records.length, total, false) } : {}),
    ...(search.error === undefined ? {} : { error: search.error }),
  };
}

async function checkWikipedia(
  input: CheckRegistryInput,
  options: HttpOptions,
  deps: HttpDeps,
): Promise<CheckRegistryOutput> {
  const direct = await lookupPage(input.query, options, deps);

  if (direct.records.length > 0) {
    return {
      registry: 'wikipedia',
      records: direct.records,
      registry_url: [direct.url],
      returned: direct.records.length,
      total_matches: direct.records.length,
      truncated: false,
      warning:
        'Wikipedia is a tertiary source (§4) and attests to no event type. Useful for aliases and for ' +
        'finding primary sources to chase; never sufficient to corroborate on its own.',
    };
  }

  // No usable article: a 404, or a disambiguation page, which resolves to zero
  // records by design. Either way, search rather than guessing another title —
  // "ROBODOC" is a disambiguation page and the device has no article of its own.
  const search = await searchPages(input.query, input.limit ?? 5, options, deps);

  return {
    registry: 'wikipedia',
    records: [],
    registry_url: [summaryUrl(input.query), search.url],
    returned: 0,
    total_matches: 0,
    truncated: false,
    ...(search.titles.length === 0 ? {} : { candidates: search.titles }),
    warning:
      search.titles.length === 0
        ? `No Wikipedia article resolves "${input.query}", and the search found no candidates.`
        : `"${input.query}" resolves to no single article — it is missing or a disambiguation page. ` +
          `Candidate titles: ${search.titles.join(', ')}. Re-query with one of these; note that an entity ` +
          'without its own article is itself a finding about tertiary coverage.',
    ...(direct.error === undefined ? {} : { error: direct.error }),
  };
}

async function checkPatentsview(
  input: CheckRegistryInput,
  options: HttpOptions,
  deps: HttpDeps,
): Promise<CheckRegistryOutput> {
  const result = await searchPatents({ text: input.query, limit: input.limit ?? DEFAULT_LIMIT }, options, deps);
  const total = result.total ?? result.records.length;
  const truncated = total > result.records.length;

  const notes = [
    result.warning,
    truncated ? truncationWarning(result.records.length, total, false) : undefined,
  ].filter((n): n is string => n !== undefined);

  return {
    registry: 'patentsview',
    records: result.records,
    registry_url: [result.url],
    returned: result.records.length,
    total_matches: total,
    truncated,
    availability: result.availability,
    ...(notes.length === 0 ? {} : { warning: notes.join(' ') }),
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

export async function checkRegistry(
  input: CheckRegistryInput,
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<CheckRegistryOutput> {
  if (input.query.trim() === '') {
    return {
      registry: input.registry,
      records: [],
      registry_url: [],
      returned: 0,
      truncated: false,
      error: 'Empty query.',
    };
  }

  switch (input.registry) {
    case 'openfda_device':
      return checkOpenFda(input, options, deps);
    case 'crossref':
      return checkCrossref(input, options, deps);
    case 'wikipedia':
      return checkWikipedia(input, options, deps);
    case 'patentsview':
      return checkPatentsview(input, options, deps);
    default: {
      const unknown: never = input.registry;
      return {
        registry: input.registry,
        records: [],
        registry_url: [],
        returned: 0,
        truncated: false,
        error: `Unknown registry: ${String(unknown)}`,
      };
    }
  }
}

/** Availability across every credentialed registry, for diagnostics. */
export function registryAvailability(): Record<string, RegistryAvailability> {
  const out: Record<string, RegistryAvailability> = {};
  for (const registry of ['openfda_device', 'crossref', 'wikipedia', 'patentsview'] as RegistryName[]) {
    out[registry] = availabilityOf(registry);
  }
  return out;
}
