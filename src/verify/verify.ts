/**
 * `verify_claim` — the §6 orchestration.
 *
 * Phase 6 covers §6.1 (registry first), §6.2 (fields verified independently),
 * §6.3 (superlatives), §6.4 (independence) and §6.5 (overall status).
 * Conflation detection (§6.6) is Phase 7 and is deliberately absent; the
 * result reports `conflation.suspected = false` with a note saying so, rather
 * than implying the check ran.
 *
 * ## Why fields are verified separately
 *
 * §6.2 is the part that catches the most common failure. A source that
 * mentions ROBODOC does not thereby confirm that ROBODOC was *approved*, and a
 * claim can be right about the entity and the date while being wrong about
 * what happened — which is exactly what the golden set's ROBODOC and da Vinci
 * rows turned out to be. Whole-claim verification cannot see that: the entity
 * checks out, the date checks out, and the claim passes.
 *
 * So each field gets its own evidence gathering, its own attested values, its
 * own independence score, and its own status. `Source.supports` records what
 * each source actually attests to, field by field.
 */

import { datesCompatible, yearOf } from '../dates.js';
import type { HttpDeps, HttpOptions } from '../http.js';
import { checkRegistry } from '../registries.js';
import { registryEventType, REGISTRY_TIER } from '../registry.js';
import type {
  AttestedValue,
  Claim,
  FieldVerification,
  RegistryRecord,
  Source,
  SourceTier,
  Status,
  VerificationResult,
  VerifiableField,
} from '../types.js';
import { STATUS_SEVERITY } from '../types.js';
import { scoreIndependence } from './independence.js';
import { disconfirmSuperlative } from './superlative.js';
import type { DisconfirmResult } from './superlative.js';

export type VerifyDepth = 'fast' | 'thorough';

export interface VerifyClaimInput {
  claim: Claim;
  depth?: VerifyDepth;
}

export interface EntityCandidate {
  registry_id: string;
  device_name?: string;
  /** The discriminating field: three companies can share one device name. */
  applicant?: string;
  date?: string;
  event_type?: string;
}

export interface VerifyClaimOutput extends VerificationResult {
  /** Attached when the claim carried a superlative (§6.3). */
  superlative_detail?: DisconfirmResult;
  /** Which registries were consulted, so an empty result is auditable. */
  registries_queried: string[];
  /**
   * Every registry record the entity name matched, with its applicant. Deciding
   * which one a claim refers to is interpretation, so the candidates are
   * returned rather than resolved (§2) — and when a claim carries `registry_id`
   * the choice has already been made and only that record is verified against.
   */
  entity_candidates?: EntityCandidate[];
  /** True when the claim named a specific record and it was found. */
  anchored: boolean;
  warning?: string;
  error?: string;
}

/** §6.5 severity ordering, applied over the fields that were actually verified. */
export function worstStatus(statuses: Status[]): Status {
  if (statuses.length === 0) return 'unverified';
  return statuses.reduce((worst, current) =>
    STATUS_SEVERITY[current] > STATUS_SEVERITY[worst] ? current : worst,
  );
}

const REGULATORY_EVENTS = new Set(['regulatory_clearance', 'regulatory_approval']);

/** Which registry to try first for a given claim (§6.1). */
export function registryFor(claim: Claim): 'openfda_device' | 'crossref' | 'wikipedia' | undefined {
  if (claim.registry !== undefined) return claim.registry === 'patentsview' ? undefined : claim.registry;
  if (REGULATORY_EVENTS.has(claim.event_type)) return 'openfda_device';
  if (claim.event_type === 'publication') return 'crossref';
  return undefined;
}

/**
 * Turn a registry record into a Source, recording what it actually attests to.
 *
 * Exactly ONE entity value per record. An earlier version emitted the device
 * name *and* the applicant as competing `entity` attestations, which made every
 * openFDA record disagree with itself — "AESOP SYSTEM AND ACCESSORIES" and
 * "COMPUTER MOTION, INC." are two descriptions of one entity, not two rival
 * values. The applicant is still the discriminator for entity ambiguity, but it
 * belongs in `entity_candidates`, not in the attested-value distribution.
 */
function recordToSource(record: RegistryRecord, retrievedAt: string): Source {
  const supports: Source['supports'] = [];

  const entityValue = record.registry === 'openfda_device' ? (record.device_name ?? record.title) : record.title;
  supports.push({ field: 'entity', value: entityValue });

  const attestation = registryEventType(record);
  if (attestation.event_type !== null) {
    supports.push({ field: 'event_type', value: attestation.event_type });
  }
  if (record.date !== undefined) {
    supports.push({ field: 'date', value: record.date });
  }

  return {
    url: record.url,
    title: record.title,
    publisher: record.registry,
    tier: REGISTRY_TIER[record.registry],
    retrieved_at: retrievedAt,
    supports,
    locator: record.record_id,
  };
}

function highestTier(tiers: SourceTier[]): SourceTier {
  if (tiers.includes('primary')) return 'primary';
  if (tiers.includes('secondary')) return 'secondary';
  return 'tertiary';
}

/**
 * Collect the values sources attest to for one field, and the sources backing
 * each. Matching is exact except for dates, where a coarser value that does
 * not contradict a finer one counts as agreement rather than dissent — "1993"
 * and "1993-11-22" are the same attestation at different precisions.
 */
function attestedFor(field: VerifiableField, sources: Source[]): { values: AttestedValue[]; byValue: Map<string, Source[]> } {
  const byValue = new Map<string, Source[]>();

  for (const source of sources) {
    for (const support of source.supports) {
      if (support.field !== field) continue;

      let key = support.value;
      if (field === 'date') {
        // Fold into an existing compatible mode, keeping the most precise
        // representative so precision is never coarsened away.
        for (const existing of byValue.keys()) {
          if (datesCompatible(existing, support.value)) {
            key = existing.length >= support.value.length ? existing : support.value;
            if (key !== existing) {
              byValue.set(key, byValue.get(existing) ?? []);
              byValue.delete(existing);
            }
            break;
          }
        }
      }
      byValue.set(key, [...(byValue.get(key) ?? []), source]);
    }
  }

  const values: AttestedValue[] = [...byValue.entries()]
    .map(([value, backing]) => ({
      value,
      source_count: backing.length,
      max_tier: highestTier(backing.map((s) => s.tier)),
    }))
    .sort((a, b) => b.source_count - a.source_count || a.value.localeCompare(b.value));

  return { values, byValue };
}

/**
 * Loose name comparison for entities.
 *
 * Registries name things fully — "AESOP SYSTEM AND ACCESSORIES" — while claims
 * name them as people do, "AESOP". Requiring exact equality marked every
 * correct claim as refuted. Containment either way is the right test, on
 * alphanumerics only so "DAVINCI" and "da Vinci" compare equal.
 *
 * This is deliberately permissive. Name similarity is weak evidence and cannot
 * distinguish Intuitive Surgical's da Vinci from Da Vinci Medical's; that
 * discrimination needs the applicant, and per §2 it is Claude's to make with
 * `entity_candidates` in hand.
 */
function namesMatch(a: string, b: string): boolean {
  const norm = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const left = norm(a);
  const right = norm(b);
  if (left === '' || right === '') return false;
  return left.includes(right) || right.includes(left);
}

/** Does the claim's value appear among what the sources attest? */
function claimSupported(
  field: VerifiableField,
  claimValue: string,
  values: AttestedValue[],
  aliases: string[] = [],
): boolean {
  if (field === 'date') return values.some((v) => datesCompatible(v.value, claimValue));
  if (field === 'entity') {
    const candidates = [claimValue, ...aliases];
    return values.some((v) => candidates.some((c) => namesMatch(v.value, c)));
  }
  return values.some((v) => v.value.toLowerCase() === claimValue.toLowerCase());
}

/**
 * Status for one field (§6.2 + §6.4 + §4's status definitions).
 *
 * The `refuted` case is the one worth stating explicitly: sources agree on a
 * value, the claim states a different one, and nothing supports the claim.
 * That is not `unverified` — nothing found — it is active contradiction, and
 * collapsing the two would let a disproved claim look merely unresearched.
 */
function verifyField(
  field: VerifiableField,
  claimValue: string,
  sources: Source[],
  aliases: string[] = [],
): FieldVerification {
  const relevant = sources.filter((s) => s.supports.some((x) => x.field === field));
  const { values } = attestedFor(field, relevant);
  const independence = scoreIndependence({ sources: relevant });

  if (relevant.length === 0) {
    return { status: 'unverified', attested_values: [], sources: [], independence_score: 0 };
  }

  const supported = claimSupported(field, claimValue, values, aliases);
  const distinctValues = values.length;

  let status: Status;
  if (!supported) {
    // Something was attested, and it was not this.
    status = 'refuted';
  } else if (distinctValues > 1) {
    status = 'contested';
  } else if (relevant.length === 1) {
    status = 'single_source';
  } else if (independence.corroboration_eligible) {
    status = 'corroborated';
  } else {
    // Multiple sources, but not independent enough to corroborate (§6.4).
    // Treated as single_source rather than corroborated: repetition is not
    // confirmation.
    status = 'single_source';
  }

  return {
    status,
    attested_values: values,
    sources: relevant,
    independence_score: independence.score,
  };
}

export async function verifyClaim(
  input: VerifyClaimInput,
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<VerifyClaimOutput> {
  const claim = input.claim;
  const retrievedAt = new Date().toISOString();
  const registriesQueried: string[] = [];
  const notes: string[] = [];
  const errors: string[] = [];
  const sources: Source[] = [];
  let allRecords: RegistryRecord[] = [];
  let anchored = false;

  // §6.1: registry first. A primary hit short-circuits most of the ambiguity
  // below, and for regulatory claims openFDA settles clearance-vs-approval
  // outright because 510(k) and PMA are separate records.
  const registry = registryFor(claim);
  if (registry !== undefined) {
    const query = claim.registry_id ?? claim.entity;
    const result = await checkRegistry({ registry, query }, options, deps);
    registriesQueried.push(registry);

    if (result.error !== undefined) {
      errors.push(`${registry}: ${result.error}`);
    } else {
      allRecords = result.records;

      // An anchored claim names its record. Verifying against the whole result
      // set instead would compare a claim about one clearance against every
      // other clearance the device family ever received, and report the
      // difference as a contested date — which is not disagreement, it is two
      // different events.
      const anchorId = claim.registry_id?.trim().toUpperCase();
      const matched =
        anchorId === undefined
          ? result.records
          : result.records.filter((r) => r.record_id.toUpperCase() === anchorId);

      if (anchorId !== undefined && matched.length === 0 && result.records.length > 0) {
        notes.push(
          `Claim is anchored to ${anchorId}, which is not among the ${result.records.length} record(s) returned. ` +
            'Verified against the full result set instead; treat field statuses as unanchored.',
        );
        for (const record of result.records) sources.push(recordToSource(record, retrievedAt));
      } else {
        anchored = anchorId !== undefined && matched.length > 0;
        for (const record of matched) sources.push(recordToSource(record, retrievedAt));
      }

      if (!anchored && result.records.length > 1) {
        notes.push(
          `${result.records.length} registry records match this name and the claim names none of them. ` +
            'Differing dates below are different EVENTS, not disagreement about one — set registry_id to ' +
            'verify against a specific record.',
        );
      }

      if (result.warning !== undefined) notes.push(result.warning);
      if (result.truncated) {
        notes.push('Registry result truncated — absence of a value below is not absence from the registry.');
      }
    }
  } else {
    notes.push(
      `No registry covers ${claim.event_type} claims; verification rests on literature and is weaker for it.`,
    );
  }

  const fields: VerificationResult['fields'] = {
    entity: verifyField('entity', claim.entity, sources, claim.entity_aliases ?? []),
    event_type: verifyField('event_type', claim.event_type, sources),
    date: verifyField('date', claim.date, sources),
  };

  // Candidates come from every matching record, not just the anchored one:
  // seeing the siblings is how a caller notices they anchored to the wrong
  // record, or that three companies share the name.
  const entityCandidates: EntityCandidate[] = allRecords.map((record) => ({
    registry_id: record.record_id,
    ...(record.registry === 'openfda_device' && record.device_name !== undefined
      ? { device_name: record.device_name }
      : {}),
    ...(record.registry === 'openfda_device' && record.applicant !== undefined
      ? { applicant: record.applicant }
      : {}),
    ...(record.date === undefined ? {} : { date: record.date }),
    ...(registryEventType(record).event_type === null
      ? {}
      : { event_type: registryEventType(record).event_type as string }),
  }));

  const distinctApplicants = new Set(
    allRecords
      .map((r) => (r.registry === 'openfda_device' ? r.applicant : undefined))
      .filter((a): a is string => a !== undefined),
  );
  if (distinctApplicants.size > 1) {
    notes.push(
      `${distinctApplicants.size} distinct applicants match this name (${[...distinctApplicants].slice(0, 4).join('; ')}). ` +
        'A shared name is not a shared entity — check entity_candidates before treating these as one device.',
    );
  }

  // §6.3: a superlative always triggers an adversarial search, and any
  // competing claimant makes it contested regardless of the rest.
  let superlativeDetail: DisconfirmResult | undefined;
  if (claim.superlative !== undefined && claim.superlative !== null && claim.superlative.trim() !== '') {
    superlativeDetail = await disconfirmSuperlative(claim, options, deps);
    const claimantSources = superlativeDetail.competing_claimants.flatMap((c) =>
      c.sources.map((s) => ({
        url: s.url,
        title: s.title,
        tier: s.tier,
        retrieved_at: retrievedAt,
        supports: [{ field: 'superlative' as const, value: c.entity }],
      })),
    );

    fields.superlative = {
      status: superlativeDetail.verdict,
      attested_values: superlativeDetail.competing_claimants.map((c) => ({
        value: c.entity,
        source_count: c.sources.length,
        max_tier: highestTier(c.sources.map((s) => s.tier)),
      })),
      sources: claimantSources,
      independence_score: scoreIndependence({ sources: claimantSources }).score,
    };

    if (superlativeDetail.warning !== undefined) notes.push(superlativeDetail.warning);
    if (superlativeDetail.error !== undefined) errors.push(superlativeDetail.error);
  }

  // §6.5: the most severe status across the fields actually verified.
  const overall = worstStatus(
    (['entity', 'event_type', 'date', 'superlative'] as const)
      .map((f) => fields[f]?.status)
      .filter((s): s is Status => s !== undefined),
  );

  // §6.6 belongs to Phase 7. Saying so beats reporting `suspected: false` as
  // though a check had run and found nothing.
  notes.push('Conflation detection (§6.6) is not implemented yet; conflation.suspected is not a finding.');

  if (sources.length === 0 && errors.length === 0) {
    notes.push(
      'No sources found. This is "nothing located", not "claim disproved" — see §6.5: an unverified node is ' +
        'still useful information and must not be dropped.',
    );
  }

  return {
    claim_id: claim.id,
    fields,
    overall,
    conflation: { suspected: false },
    retrieved_at: retrievedAt,
    cache_hit: false,
    ...(superlativeDetail === undefined ? {} : { superlative_detail: superlativeDetail }),
    registries_queried: registriesQueried,
    anchored,
    ...(entityCandidates.length === 0 ? {} : { entity_candidates: entityCandidates }),
    ...(notes.length === 0 ? {} : { warning: notes.join(' ') }),
    ...(errors.length === 0 ? {} : { error: errors.join('; ') }),
  };
}
