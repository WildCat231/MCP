/**
 * Independence scoring (CODEX_SPEC.md §6.4).
 *
 * Three sources agreeing means nothing if all three paraphrase the same review
 * article. The score answers "how many genuinely separate lines of evidence is
 * this?", not "how many URLs are there?".
 *
 * Everything here is pure arithmetic over `Source[]`. No network, no judgement.
 */

import type { Source, SourceTier } from '../types.js';

/**
 * §6.4: "Corroboration requires independence_score >= 0.5 AND at least one
 * primary or peer-reviewed source."
 *
 * 0.5 is the midpoint of a scale where 0 means "one voice repeated" and 1
 * means "fully disjoint origins". It is deliberately not higher: demanding
 * near-total independence would leave most genuine historical facts
 * uncorroborated, because primary records are often mirrored. It is
 * deliberately not lower: below the midpoint, most of the agreement is coming
 * from a shared origin.
 */
export const INDEPENDENCE_FLOOR = 0.5;

/**
 * Domain diversity outweighs tier diversity. Two documents on one host are one
 * publisher's decision however they are tiered; two hosts are two decisions.
 * Tier still counts, because a primary record plus a peer-reviewed paper is a
 * stronger pair than two of either.
 */
export const DOMAIN_WEIGHT = 0.6;
export const TIER_WEIGHT = 0.4;

/**
 * Multiplier applied when sources cite a common ancestor. Not zero: sharing a
 * reference is normal in a small field and does not prove derivation. Not
 * near-1: if the agreement traces to one upstream document, the sources are
 * closer to one voice than to several.
 */
export const SHARED_ANCESTOR_DISCOUNT = 0.6;

/**
 * Multi-part public suffixes common enough to matter. A full Public Suffix
 * List would be a dependency and a maintenance burden for a marginal gain;
 * getting these wrong only ever *overstates* independence slightly, and the
 * cases that matter here (fda.gov, doi.org, nih.gov, wikipedia.org) are all
 * two-label domains anyway.
 */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'ac.uk', 'gov.uk', 'org.uk', 'com.au', 'edu.au', 'gov.au',
  'co.jp', 'ac.jp', 'co.nz', 'co.za', 'com.br', 'com.cn', 'ac.cn',
]);

/** Registrable domain (eTLD+1), approximately. Falls back to the raw host. */
export function registrableDomain(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = url.trim().toLowerCase();
  }
  host = host.replace(/^www\./, '');

  const labels = host.split('.');
  if (labels.length <= 2) return host;

  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

export interface IndependenceBreakdown {
  score: number;
  source_count: number;
  distinct_domains: number;
  domains: string[];
  distinct_tiers: number;
  tiers: SourceTier[];
  domain_component: number;
  tier_component: number;
  shared_ancestors: string[];
  discount_applied: boolean;
  /** Whether at least one source is primary or peer-reviewed (§6.4). */
  has_primary_or_peer_reviewed: boolean;
  /** Whether both §6.4 conditions for corroboration are met. */
  corroboration_eligible: boolean;
  reason: string;
}

export interface IndependenceInput {
  sources: Source[];
  /**
   * Optional citation graph: source URL -> DOIs it cites. Populated from
   * Crossref `reference` arrays when they are available. Absent references
   * mean no discount, never a penalty — we cannot distinguish "cites nothing
   * in common" from "we do not know what it cites".
   */
  references?: Map<string, string[]>;
}

/** DOIs cited by two or more sources. */
export function sharedAncestors(sources: Source[], references?: Map<string, string[]>): string[] {
  if (references === undefined || sources.length < 2) return [];

  const counts = new Map<string, number>();
  for (const source of sources) {
    // A source citing the same DOI twice still counts once.
    for (const doi of new Set(references.get(source.url) ?? [])) {
      counts.set(doi, (counts.get(doi) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([doi]) => doi)
    .sort();
}

export function scoreIndependence(input: IndependenceInput): IndependenceBreakdown {
  const sources = input.sources;
  const domains = [...new Set(sources.map((s) => registrableDomain(s.url)))].sort();
  const tiers = [...new Set(sources.map((s) => s.tier))].sort() as SourceTier[];
  const hasStrong = sources.some((s) => s.tier === 'primary' || s.tier === 'secondary');

  if (sources.length === 0) {
    return {
      score: 0,
      source_count: 0,
      distinct_domains: 0,
      domains: [],
      distinct_tiers: 0,
      tiers: [],
      domain_component: 0,
      tier_component: 0,
      shared_ancestors: [],
      discount_applied: false,
      has_primary_or_peer_reviewed: false,
      corroboration_eligible: false,
      reason: 'No sources.',
    };
  }

  if (sources.length === 1) {
    // A single source cannot be independent of itself. Zero is the honest
    // answer, and it is why `single_source` is a distinct status from
    // `corroborated` rather than a weak version of it.
    return {
      score: 0,
      source_count: 1,
      distinct_domains: domains.length,
      domains,
      distinct_tiers: tiers.length,
      tiers,
      domain_component: 0,
      tier_component: 0,
      shared_ancestors: [],
      discount_applied: false,
      has_primary_or_peer_reviewed: hasStrong,
      corroboration_eligible: false,
      reason: 'Single source: independence is undefined with nothing to be independent of.',
    };
  }

  // Fraction of the maximum possible spread, so n sources on n domains scores
  // 1 regardless of n.
  const domainComponent = (domains.length - 1) / (sources.length - 1);
  // 1 tier -> 0, 2 -> 0.5, 3 -> 1.
  const tierComponent = (tiers.length - 1) / 2;

  const ancestors = sharedAncestors(sources, input.references);
  const discount = ancestors.length > 0 ? SHARED_ANCESTOR_DISCOUNT : 1;

  const raw = DOMAIN_WEIGHT * domainComponent + TIER_WEIGHT * tierComponent;
  const score = Number(Math.min(1, Math.max(0, raw * discount)).toFixed(4));

  const eligible = score >= INDEPENDENCE_FLOOR && hasStrong;

  const reasons: string[] = [
    `${sources.length} sources across ${domains.length} domain(s) and ${tiers.length} tier(s).`,
  ];
  if (domains.length === 1) {
    reasons.push(`All sources are on ${domains[0]} — one publisher, however many documents.`);
  }
  if (!hasStrong) {
    reasons.push('No primary or peer-reviewed source: tertiary agreement cannot corroborate (§6.4).');
  }
  if (ancestors.length > 0) {
    reasons.push(
      `Discounted: ${ancestors.length} shared citation ancestor(s) (${ancestors.slice(0, 3).join(', ')}) suggest a common origin.`,
    );
  }
  if (score < INDEPENDENCE_FLOOR) {
    reasons.push(`Score ${score} is below the ${INDEPENDENCE_FLOOR} corroboration floor.`);
  }

  return {
    score,
    source_count: sources.length,
    distinct_domains: domains.length,
    domains,
    distinct_tiers: tiers.length,
    tiers,
    domain_component: Number(domainComponent.toFixed(4)),
    tier_component: Number(tierComponent.toFixed(4)),
    shared_ancestors: ancestors,
    discount_applied: ancestors.length > 0,
    has_primary_or_peer_reviewed: hasStrong,
    corroboration_eligible: eligible,
    reason: reasons.join(' '),
  };
}
