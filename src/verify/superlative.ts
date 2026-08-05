/**
 * `disconfirm_superlative` (CODEX_SPEC.md §5, §6.3).
 *
 * A source saying "X was first" does not rule out Y. Superlatives cannot be
 * verified by confirmation, only attacked: you have to search for the
 * *category* and see who else turns up.
 *
 * So the query is deliberately built from the category with the entity
 * REMOVED. Searching "first FDA-approved surgical robot ROBODOC" finds pages
 * about ROBODOC; searching the FDA's device database for surgical robots finds
 * everything that could unseat it. That inversion is the whole method.
 *
 * §6.3 is absolute about the outcome: if any competing claimant surfaces with
 * sources, the field is `contested`, full stop — even when the original claim
 * has more support. This module does not weigh the claimants against each
 * other, and must not start.
 */

import type { HttpDeps, HttpOptions } from '../http.js';
import { searchClearances, searchApprovals } from '../sources/openfda.js';
import type { Claim, OpenFdaDeviceRecord, Paper, Status } from '../types.js';
import { yearOf } from '../dates.js';
import { searchLiterature } from '../search.js';

/** Ordinal words that mark a claim as a superlative. */
const ORDINALS = [
  'first', 'earliest', 'oldest', 'original', 'initial',
  'largest', 'biggest', 'smallest', 'fastest', 'best', 'leading', 'only',
];

/** Words that carry no discriminating power once the ordinal is stripped. */
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'in', 'to', 'for', 'ever', 'world', 'worlds', 'us', 'usa']);

export interface ParsedSuperlative {
  /** The ordinal claimed, e.g. "first". */
  ordinal?: string;
  /** What is being claimed about, entity removed: "FDA-approved surgical robot". */
  category: string;
  /** Category terms usable as a search query. */
  terms: string[];
}

/**
 * Split a superlative into its ordinal and its category, dropping the entity.
 *
 * Purely lexical — no model call, per §2. It does not need to be clever: the
 * category only has to be good enough to find rival claimants, and returning
 * slightly too broad a category surfaces more candidates, which is the safe
 * direction to err in for an adversarial search.
 */
export function parseSuperlative(superlative: string, entity?: string): ParsedSuperlative {
  let text = superlative.trim().toLowerCase();

  // Remove the entity so the search cannot simply rediscover the claimant.
  if (entity !== undefined && entity.trim() !== '') {
    text = text.replace(new RegExp(escapeRegExp(entity.trim().toLowerCase()), 'g'), ' ');
  }

  let ordinal: string | undefined;
  for (const candidate of ORDINALS) {
    const pattern = new RegExp(`\\b${candidate}\\b`);
    if (pattern.test(text)) {
      ordinal = candidate;
      text = text.replace(pattern, ' ');
      break;
    }
  }

  const words = text
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w !== '' && !STOPWORDS.has(w));

  return {
    ...(ordinal === undefined ? {} : { ordinal }),
    category: words.join(' '),
    terms: words,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface CompetingClaimant {
  entity: string;
  date?: string;
  event_type: string;
  registry_id?: string;
  sources: { url: string; title: string; tier: 'primary' | 'secondary' | 'tertiary' }[];
  /** True when this claimant's date precedes the claim's — a direct threat to "first". */
  predates_claim: boolean;
}

export interface DisconfirmResult {
  claim_id: string;
  superlative: string;
  parsed: ParsedSuperlative;
  competing_claimants: CompetingClaimant[];
  /** Literature that discusses the category, returned as evidence, unnamed (§2). */
  supporting_evidence: Paper[];
  verdict: Status;
  /** The queries actually issued, so a null result is auditable. */
  queries: string[];
  warning?: string;
  error?: string;
}

function claimantFromRecord(record: OpenFdaDeviceRecord, claimDate: string): CompetingClaimant {
  const claimYear = yearOf(claimDate);
  const recordYear = record.date === undefined ? undefined : yearOf(record.date);

  return {
    // The applicant is the entity: a device name is a product, a company is a
    // claimant, and the da Vinci case showed three companies sharing one name.
    entity: record.applicant ?? record.device_name ?? record.submission_number,
    ...(record.date === undefined ? {} : { date: record.date }),
    event_type: record.submission_type === '510k' ? 'regulatory_clearance' : 'regulatory_approval',
    registry_id: record.submission_number,
    sources: [{ url: record.url, title: record.device_name ?? record.title, tier: 'primary' as const }],
    predates_claim: claimYear !== undefined && recordYear !== undefined && recordYear < claimYear,
  };
}

const REGULATORY_EVENTS = new Set(['regulatory_clearance', 'regulatory_approval']);

/**
 * Search the superlative's category for anyone else who could hold it.
 *
 * For regulatory superlatives this is unusually strong: openFDA is an
 * exhaustive list of who was cleared or approved and when, so "first
 * FDA-approved X" can be attacked against the actual population rather than
 * against whatever a search engine surfaces.
 */
export async function disconfirmSuperlative(
  claim: Claim,
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<DisconfirmResult> {
  const superlative = claim.superlative ?? '';
  const parsed = parseSuperlative(superlative, claim.entity);
  const queries: string[] = [];

  if (superlative.trim() === '') {
    return {
      claim_id: claim.id,
      superlative,
      parsed,
      competing_claimants: [],
      supporting_evidence: [],
      verdict: 'unverified',
      queries,
      warning: 'No superlative to disconfirm.',
    };
  }

  if (parsed.terms.length === 0) {
    return {
      claim_id: claim.id,
      superlative,
      parsed,
      competing_claimants: [],
      supporting_evidence: [],
      verdict: 'unverified',
      queries,
      warning:
        `Superlative "${superlative}" reduces to nothing searchable once the entity and ordinal are removed. ` +
        'It cannot be disconfirmed, which is not the same as being true.',
    };
  }

  const claimants: CompetingClaimant[] = [];
  const errors: string[] = [];

  if (REGULATORY_EVENTS.has(claim.event_type)) {
    // Drop regulator-specific words that are not device descriptors, so the
    // category matches device names rather than the regulator's own name.
    const deviceTerms = parsed.terms.filter((t) => !/^(fda|approved|cleared|approval|clearance)$/.test(t));
    const query = deviceTerms.join(' ');
    if (query !== '') {
      const shared = { query, limit: 50, sort: 'decision_date:asc' };
      const [clearances, approvals] = [
        await searchClearances(shared, options, deps),
        await searchApprovals(shared, options, deps),
      ];
      queries.push(clearances.url, approvals.url);

      for (const record of [...clearances.records, ...approvals.records]) {
        // Never let the claimed entity disconfirm itself.
        if (record.applicant?.toLowerCase().includes(claim.entity.toLowerCase()) === true) continue;
        if (record.device_name?.toLowerCase().includes(claim.entity.toLowerCase()) === true) continue;
        claimants.push(claimantFromRecord(record, claim.date));
      }

      if (clearances.error !== undefined) errors.push(`510k: ${clearances.error}`);
      if (approvals.error !== undefined) errors.push(`pma: ${approvals.error}`);
    }
  }

  // Literature evidence for the category, returned unnamed: identifying which
  // entity a paper is crowning is interpretation, and that is Claude's (§2).
  const literature = await searchLiterature(
    { terms: parsed.terms.slice(0, 4), max_per_source: 10 },
    options,
    deps,
  );
  if (literature.errors !== undefined) {
    errors.push(...Object.entries(literature.errors).map(([source, message]) => `${source}: ${message}`));
  }

  // §6.3: any competing claimant with sources makes it contested, full stop.
  // No weighing, no "but the original has more support".
  const verdict: Status =
    claimants.length > 0
      ? 'contested'
      : errors.length > 0
        ? 'unverified'
        : literature.results.length > 0
          ? 'single_source'
          : 'unverified';

  const notes: string[] = [];
  if (claimants.length > 0) {
    const earlier = claimants.filter((c) => c.predates_claim).length;
    notes.push(
      `${claimants.length} competing claimant(s) found${earlier > 0 ? `, ${earlier} predating the claim` : ''}. ` +
        'Per §6.3 the superlative is contested and is not resolved here — both sides are returned for the caller to present.',
    );
  }
  if (errors.length > 0) {
    notes.push(
      `Searches failed (${errors.join('; ')}). Absence of competing claimants is NOT established — a superlative ` +
        'that could not be attacked has not been supported.',
    );
  }

  return {
    claim_id: claim.id,
    superlative,
    parsed,
    // Earliest first: the strongest threat to a "first" claim leads.
    competing_claimants: claimants.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999')),
    supporting_evidence: literature.results,
    verdict,
    queries,
    ...(notes.length === 0 ? {} : { warning: notes.join(' ') }),
    ...(errors.length === 0 ? {} : { error: errors.join('; ') }),
  };
}
