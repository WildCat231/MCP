/**
 * Conflation detection (CODEX_SPEC.md §6.6).
 *
 * §6.6 is explicit that this must not be attempted semantically. The signal is
 * distributional:
 *
 *   > Noise scatters; conflation clusters.
 *
 * Two real events merged under one label produce a *bimodal* distribution with
 * *tight* modes. Ordinary source disagreement produces wide scatter. The
 * difference is measurable without understanding anything about the subject,
 * which is the point — and which is why nothing here reads a title or an
 * abstract.
 *
 * The output is evidence, never a question. §6.6: "Do not ask the clarifying
 * question yourself — return the modes and let Claude decide whether to ask,
 * since only Claude knows whether the ambiguity affects the rest of the
 * timeline."
 *
 * ## What this actually fires on, in this data
 *
 * The spec anticipated the date detector firing on AESOP's 1993/1994 split.
 * It does not, and should not: the primary record K931783 shows received
 * 1993-04-09 and decided 1993-11-22, both in one year, so there is no bimodal
 * date distribution to find. That expectation was built on a hypothesis the
 * registry falsified.
 *
 * The bimodality that genuinely exists here is on ENTITY. A "DA VINCI" search
 * returns records from three unrelated companies — Intuitive Surgical, Da
 * Vinci Medical, and Nova/Da Vinci Systems — two of which hold multiple
 * records each. That is exactly §6.6's shape (≥2 modes, ≥2 sources per mode,
 * well separated), and it is the case the detector is built and tested
 * against.
 */

import { yearOf } from '../dates.js';
import type { AttestedValue, ConflationEvidence } from '../types.js';

/**
 * §6.6 gives this one directly: "a gap between modes exceeding the field's
 * tolerance (for dates: 3 years)". Three years is wide enough that ordinary
 * disagreement about when something happened stays inside one mode, and narrow
 * enough to separate genuinely distinct events — a clearance and an approval
 * for the same device are typically further apart than that, and two sources
 * arguing about a single event are typically closer.
 */
export const DATE_GAP_YEARS = 3;

/**
 * "Each supported by >=2 sources" (§6.6). A mode of one is not a mode — it is
 * the scatter the heuristic exists to ignore. This is what stops a single
 * outlying date from being reported as a merged event.
 */
export const MIN_SOURCES_PER_MODE = 2;

/**
 * "Low within-mode variance" (§6.6), made concrete. A mode whose own members
 * span more than a year is not tight, and a pair of loose clusters is scatter
 * that happens to have a hole in it rather than two distinct events.
 */
export const MAX_WITHIN_MODE_SPREAD_YEARS = 1;

/**
 * Band for "materially different phrases" (§6.6 alias drift).
 *
 * Below the floor, two names are simply unrelated — that is two entities being
 * discussed, not one label covering two. Above the ceiling, they are the same
 * phrase with punctuation or word-order noise. In between is the dangerous
 * case: enough shared structure that sources treat them as one entity, with a
 * content word that differs. "Smart Tissue Anastomosis Robot" and "Smart
 * Tissue Autonomous Robot" sit at 0.6 — three tokens shared out of five,
 * differing in the word that decides whether they are the same machine.
 *
 * The band is necessary but NOT sufficient. Drift also requires
 * `mutually_exclusive`: each phrase must carry a token the other lacks.
 * Without that, "Smart Tissue Autonomous Robot" and "Smart Tissue Autonomous
 * Robot system" score 0.8 — higher than the real drift case — and get flagged
 * for being more specific. Containment is specification, not divergence.
 */
export const ALIAS_DIVERGENCE_MIN = 0.3;
export const ALIAS_DIVERGENCE_MAX = 0.9;

export interface ConflationResult {
  suspected: boolean;
  evidence?: ConflationEvidence;
  /** Every field examined, including those that came back clean. */
  checks: FieldCheck[];
}

export interface FieldCheck {
  field: string;
  suspected: boolean;
  modes: { value: string; source_count: number }[];
  reason: string;
}

const clean = (value: string): string =>
  value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

const tokens = (value: string): string[] => clean(value).split(' ').filter((t) => t !== '');

/**
 * Two tokens count as the same word when one is a prefix of the other.
 *
 * openFDA truncates `device_name` at around fifty characters, so the AESOP
 * record ends "...FOR OPTIMAL POS". Treating "pos" and "positioning" as
 * different words made a truncated copy of a phrase look like a materially
 * different expansion of it — a false positive with no signal in it at all.
 * Three characters is the floor, below which prefixes match too much.
 */
function tokensAlike(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 3 && longer.startsWith(shorter);
}

/**
 * Jaccard similarity over token sets, with prefix-tolerant matching.
 *
 * `ignore` drops tokens before comparing — used for the entity's own name,
 * since an expansion may or may not repeat the abbreviation it expands and
 * that choice says nothing about whether two expansions differ.
 */
export interface TokenComparison {
  similarity: number;
  /** Tokens only the first phrase has, after prefix matching. */
  left_only: string[];
  /** Tokens only the second phrase has. */
  right_only: string[];
  /**
   * True when each phrase has a token the other lacks. This is what separates
   * DIVERGENCE from SPECIFICATION: "Smart Tissue Anastomosis Robot" and "Smart
   * Tissue Autonomous Robot" each carry a word the other does not and cannot
   * both be right, whereas "Smart Tissue Autonomous Robot" and the same phrase
   * plus "system" are one name at two levels of detail. Similarity alone
   * cannot tell them apart — the second pair actually scores *higher*.
   */
  mutually_exclusive: boolean;
}

export function compareTokens(a: string, b: string, ignore: string[] = []): TokenComparison {
  const ignored = new Set(ignore.flatMap((value) => tokens(value)));
  const left = [...new Set(tokens(a))].filter((t) => !ignored.has(t));
  const right = [...new Set(tokens(b))].filter((t) => !ignored.has(t));
  if (left.length === 0 || right.length === 0) {
    return { similarity: 0, left_only: left, right_only: right, mutually_exclusive: false };
  }

  const matchedRight = new Set<string>();
  const leftOnly: string[] = [];
  for (const token of left) {
    const match = right.find((r) => !matchedRight.has(r) && tokensAlike(token, r));
    if (match === undefined) leftOnly.push(token);
    else matchedRight.add(match);
  }
  const rightOnly = right.filter((r) => !matchedRight.has(r));
  const shared = left.length - leftOnly.length;

  return {
    similarity: shared / (left.length + right.length - shared),
    left_only: leftOnly,
    right_only: rightOnly,
    mutually_exclusive: leftOnly.length > 0 && rightOnly.length > 0,
  };
}

/** Jaccard similarity with prefix-tolerant matching. See `compareTokens`. */
export function tokenSimilarity(a: string, b: string, ignore: string[] = []): number {
  return compareTokens(a, b, ignore).similarity;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

interface DateMode {
  values: { value: string; year: number; source_count: number }[];
  sources: number;
  minYear: number;
  maxYear: number;
}

/**
 * Single-link clustering on the year axis with a gap threshold. Sorting first
 * makes this O(n log n) and, more importantly, deterministic — §8 requires
 * byte-identical repeat runs, which rules out any clustering that depends on
 * input order or a random seed.
 */
export function clusterDates(values: AttestedValue[]): DateMode[] {
  const points = values
    .map((v) => ({ value: v.value, year: yearOf(v.value), source_count: v.source_count }))
    .filter((p): p is { value: string; year: number; source_count: number } => p.year !== undefined)
    .sort((a, b) => a.year - b.year || a.value.localeCompare(b.value));

  const modes: DateMode[] = [];
  for (const point of points) {
    const current = modes[modes.length - 1];
    if (current !== undefined && point.year - current.maxYear <= DATE_GAP_YEARS) {
      current.values.push(point);
      current.sources += point.source_count;
      current.maxYear = Math.max(current.maxYear, point.year);
    } else {
      modes.push({
        values: [point],
        sources: point.source_count,
        minYear: point.year,
        maxYear: point.year,
      });
    }
  }
  return modes;
}

export function checkDates(values: AttestedValue[]): FieldCheck {
  const modes = clusterDates(values);
  const substantial = modes.filter((m) => m.sources >= MIN_SOURCES_PER_MODE);
  const reported = substantial.map((m) => ({
    // The earliest member represents the mode; showing a computed centroid
    // would invent a date no source stated.
    value: m.values[0]?.value ?? String(m.minYear),
    source_count: m.sources,
  }));

  if (values.length === 0) {
    return { field: 'date', suspected: false, modes: [], reason: 'No attested dates.' };
  }
  if (substantial.length < 2) {
    return {
      field: 'date',
      suspected: false,
      modes: reported,
      reason:
        modes.length > 1
          ? `${modes.length} date clusters, but only ${substantial.length} backed by >=${MIN_SOURCES_PER_MODE} sources. Scatter, not conflation.`
          : 'Dates fall in a single cluster.',
    };
  }

  const loose = substantial.filter((m) => m.maxYear - m.minYear > MAX_WITHIN_MODE_SPREAD_YEARS);
  if (loose.length > 0) {
    return {
      field: 'date',
      suspected: false,
      modes: reported,
      reason:
        `${substantial.length} clusters, but ${loose.length} span more than ${MAX_WITHIN_MODE_SPREAD_YEARS} year(s) internally. ` +
        'Wide modes are scatter with a hole in it, not two distinct events.',
    };
  }

  const gaps: number[] = [];
  for (let i = 1; i < substantial.length; i += 1) {
    gaps.push((substantial[i]?.minYear ?? 0) - (substantial[i - 1]?.maxYear ?? 0));
  }

  return {
    field: 'date',
    suspected: true,
    modes: reported,
    reason:
      `${substantial.length} tight date modes, each backed by >=${MIN_SOURCES_PER_MODE} sources, separated by ` +
      `${gaps.join(', ')} year(s) — more than the ${DATE_GAP_YEARS}-year tolerance. Bimodal-with-tight-modes ` +
      'means two real events have probably been merged under one label.',
  };
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * Attribution divergence: one name, several organizations.
 *
 * This is the da Vinci case and it is the strongest entity signal available,
 * because the organization is a fact the registry states rather than something
 * inferred from a string. Device names are a poor clustering key — "DAVINCI
 * CHOLANGIOGRAM DELIVERY DEVICE" and "INTUITIVE SURGICAL DA VINCI ENDOSCOPIC
 * CONTROL SYSTEM" share almost no tokens, so name clustering would report five
 * singletons and find nothing. The applicant collapses them into two real
 * modes.
 */
export function checkAttribution(attributions: AttestedValue[]): FieldCheck {
  const byOrg = new Map<string, { value: string; count: number }>();
  for (const attribution of attributions) {
    const key = clean(attribution.value);
    const existing = byOrg.get(key);
    if (existing === undefined) {
      byOrg.set(key, { value: attribution.value, count: attribution.source_count });
    } else {
      existing.count += attribution.source_count;
    }
  }

  const all = [...byOrg.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  const substantial = all.filter((o) => o.count >= MIN_SOURCES_PER_MODE);
  const modes = substantial.map((o) => ({ value: o.value, source_count: o.count }));

  if (all.length <= 1) {
    return {
      field: 'entity',
      suspected: false,
      modes: all.map((o) => ({ value: o.value, source_count: o.count })),
      reason: all.length === 0 ? 'No attributions.' : 'All records attributed to one organization.',
    };
  }
  if (substantial.length < 2) {
    return {
      field: 'entity',
      suspected: false,
      modes: all.map((o) => ({ value: o.value, source_count: o.count })),
      reason:
        `${all.length} organizations share this name, but only ${substantial.length} hold >=${MIN_SOURCES_PER_MODE} ` +
        'records. A single stray record is scatter.',
    };
  }

  return {
    field: 'entity',
    suspected: true,
    modes,
    reason:
      `${substantial.length} distinct organizations each hold >=${MIN_SOURCES_PER_MODE} records under this name` +
      (all.length > substantial.length ? ` (${all.length - substantial.length} more hold one each)` : '') +
      '. A shared name is not a shared entity: these are separate entities being treated as one, which produces ' +
      'false corroboration. Returned as evidence — which entity the claim means is not decided here.',
  };
}

/**
 * Alias drift: one abbreviation, materially different expansions.
 *
 * §6.6's second entity rule, and the STAR case: "Smart Tissue *Anastomosis*
 * Robot" (2014) and "Smart Tissue *Autonomous* Robot" (2022) are different
 * systems whose sources appear to corroborate each other across a decade.
 */
export function checkAliasDrift(aliases: AttestedValue[], entity?: string): FieldCheck {
  const ignore = entity === undefined ? [] : [entity];
  const unique = [...new Map(aliases.map((a) => [clean(a.value), a])).values()];

  if (unique.length < 2) {
    return { field: 'entity_aliases', suspected: false, modes: [], reason: 'Fewer than two distinct expansions.' };
  }

  const diverging: { a: AttestedValue; b: AttestedValue; similarity: number }[] = [];
  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      const left = unique[i];
      const right = unique[j];
      if (left === undefined || right === undefined) continue;
      const comparison = compareTokens(left.value, right.value, ignore);
      const inBand =
        comparison.similarity >= ALIAS_DIVERGENCE_MIN && comparison.similarity <= ALIAS_DIVERGENCE_MAX;
      if (inBand && comparison.mutually_exclusive) {
        diverging.push({ a: left, b: right, similarity: comparison.similarity });
      }
    }
  }

  if (diverging.length === 0) {
    return {
      field: 'entity_aliases',
      suspected: false,
      modes: unique.map((a) => ({ value: a.value, source_count: a.source_count })),
      reason:
        `${unique.length} expansions, none both in the ${ALIAS_DIVERGENCE_MIN}-${ALIAS_DIVERGENCE_MAX} similarity ` +
        'band and mutually exclusive. Near-identical phrasings, unrelated names, and one phrase merely being more ' +
        'specific than another are all excluded — none of them is drift.',
    };
  }

  const pairs = diverging
    .sort((x, y) => y.similarity - x.similarity)
    .map((d) => `"${d.a.value}" vs "${d.b.value}" (${d.similarity.toFixed(2)})`);

  return {
    field: 'entity_aliases',
    suspected: true,
    modes: unique.map((a) => ({ value: a.value, source_count: a.source_count })),
    reason:
      `Expansions differ materially while sharing structure: ${pairs.join('; ')}. That is entity drift — the ` +
      'shared abbreviation makes sources appear to corroborate each other when they describe different things.',
  };
}

// ---------------------------------------------------------------------------
// Event type
// ---------------------------------------------------------------------------

/**
 * Event-type conflation is categorical: no distance measure, no tolerance.
 * Two event types each attested by two or more sources means the label covers
 * two different kinds of event — the clearance-vs-approval merge this whole
 * system exists to detect.
 */
export function checkEventTypes(values: AttestedValue[]): FieldCheck {
  const substantial = values.filter((v) => v.source_count >= MIN_SOURCES_PER_MODE);
  const modes = substantial.map((v) => ({ value: v.value, source_count: v.source_count }));

  if (substantial.length < 2) {
    return {
      field: 'event_type',
      suspected: false,
      modes,
      reason:
        values.length > 1
          ? `${values.length} event types attested, but only ${substantial.length} by >=${MIN_SOURCES_PER_MODE} sources.`
          : 'A single event type is attested.',
    };
  }

  return {
    field: 'event_type',
    suspected: true,
    modes,
    reason:
      `${substantial.length} event types each attested by >=${MIN_SOURCES_PER_MODE} sources (${modes
        .map((m) => m.value)
        .join(', ')}). One label is covering two kinds of event.`,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface ConflationInput {
  dates?: AttestedValue[];
  event_types?: AttestedValue[];
  /** Organizations the records are attributed to — openFDA applicants. */
  attributions?: AttestedValue[];
  /** Distinct expansions of the entity name attested across sources. */
  aliases?: AttestedValue[];
  /** The claim's entity, excluded from alias comparison — see tokenSimilarity. */
  entity?: string;
}

/**
 * Run every check. The first firing check becomes `evidence`, but all of them
 * are returned in `checks` — a field that was examined and came back clean is
 * useful information, and silently omitting it would leave a caller unable to
 * tell "checked, nothing found" from "not checked".
 */
export function detectConflation(input: ConflationInput): ConflationResult {
  // Order is priority order, not execution order. An entity split CAUSES
  // multimodal dates and event types: if a name covers two companies, of
  // course their records cluster in different decades. Reporting the date
  // split as the finding would describe the symptom and hide the cause, so
  // entity checks are consulted for `evidence` first.
  const checks: FieldCheck[] = [
    checkAttribution(input.attributions ?? []),
    checkAliasDrift(input.aliases ?? [], input.entity),
    checkEventTypes(input.event_types ?? []),
    checkDates(input.dates ?? []),
  ];

  const firing = checks.find((c) => c.suspected);
  const alsoFiring = checks.filter((c) => c.suspected && c !== firing).map((c) => c.field);

  const downstream =
    firing !== undefined && firing.field.startsWith('entity') && alsoFiring.length > 0
      ? ` ${alsoFiring.join(' and ')} also came back multimodal, which is expected downstream of an entity split ` +
        'rather than a separate finding.'
      : '';

  return {
    suspected: firing !== undefined,
    ...(firing === undefined
      ? {}
      : {
          evidence: {
            field: firing.field,
            modes: firing.modes,
            reason: firing.reason + downstream,
          },
        }),
    checks,
  };
}
