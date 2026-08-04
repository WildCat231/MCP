/**
 * Registry → EventType mapping.
 *
 * One explicit, typed function per registry. The dispatcher at the bottom is
 * exhaustive over the `RegistryRecord` union, so adding a registry to the
 * union without adding its mapping here is a compile error rather than a
 * silent `undefined` at runtime.
 *
 * Spec reference: CODEX_SPEC.md §6.1 (registry first) and §4 (EventType).
 */

import type {
  CrossrefRecord,
  EventTypeAttestation,
  OpenFdaDeviceRecord,
  PatentsViewRecord,
  RegistryName,
  RegistryRecord,
  SourceTier,
  WikipediaRecord,
} from './types.js';

/**
 * Evidence tier by registry (§4). Three of the four are the record itself and
 * are therefore primary. Wikipedia is an encyclopedia — tertiary, and never
 * sufficient for corroboration on its own (§6.4).
 */
export const REGISTRY_TIER: Record<RegistryName, SourceTier> = {
  openfda_device: 'primary',
  crossref: 'primary',
  patentsview: 'primary',
  wikipedia: 'tertiary',
};

/** Compile-time exhaustiveness guard. Unreachable if the union is covered. */
function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// openFDA device
// ---------------------------------------------------------------------------

/**
 * The load-bearing mapping. FDA's premarket pathways are distinct legal
 * instruments stored as separate database records, so this registry draws the
 * clearance/approval line itself and we do not have to infer it.
 *
 * De Novo and HDE are marked `inferred` rather than `definitive` because
 * neither maps cleanly onto the spec's two regulatory event types:
 *   - De Novo grants a *classification* for a novel low-to-moderate-risk
 *     device, authorizing marketing without PMA-level premarket review. It
 *     behaves like a clearance and creates the predicate that later 510(k)s
 *     cite, so it maps to clearance — but FDA's own term is "authorization",
 *     and a caller distinguishing the three pathways should not be told this
 *     is the same thing as a 510(k).
 *   - HDE authorizes marketing for a rare-disease device on a probable-benefit
 *     standard rather than the PMA's reasonable-assurance-of-effectiveness
 *     standard. FDA calls the result an approval, so it maps to approval, but
 *     it is a weaker finding than a PMA and should not corroborate a bare
 *     "FDA-approved" superlative unchallenged.
 */
export function openFdaDeviceEventType(record: OpenFdaDeviceRecord): EventTypeAttestation {
  switch (record.submission_type) {
    case '510k':
      return {
        event_type: 'regulatory_clearance',
        confidence: 'definitive',
        reason: `510(k) submission ${record.submission_number}: FDA clearance via substantial equivalence, not premarket approval.`,
      };
    case 'pma_original':
      return {
        event_type: 'regulatory_approval',
        confidence: 'definitive',
        reason: `Original PMA ${record.submission_number}: FDA premarket approval.`,
      };
    case 'pma_supplement':
      return {
        event_type: 'regulatory_approval',
        confidence: 'definitive',
        reason: `PMA supplement ${record.submission_number}: approval of a change to an already-approved device, not a first approval.`,
      };
    case 'de_novo':
      return {
        event_type: 'regulatory_clearance',
        confidence: 'inferred',
        reason: `De Novo request ${record.submission_number}: FDA marketing authorization by novel classification. Closer to clearance than to PMA approval, but FDA's own term is "authorization".`,
      };
    case 'hde':
      return {
        event_type: 'regulatory_approval',
        confidence: 'inferred',
        reason: `HDE ${record.submission_number}: humanitarian device approval on a probable-benefit standard, a weaker finding than a PMA.`,
      };
    default:
      return assertNever(record.submission_type, 'openFdaDeviceEventType');
  }
}

// ---------------------------------------------------------------------------
// Crossref
// ---------------------------------------------------------------------------

/**
 * A registered DOI is a publication event. The distinction that matters here
 * is peer review: a journal article is definitively a publication, whereas a
 * preprint or report has a DOI without having passed review, and a dataset is
 * a deposit rather than a publication at all.
 */
export function crossrefEventType(record: CrossrefRecord): EventTypeAttestation {
  switch (record.work_type) {
    case 'journal-article':
    case 'proceedings-article':
    case 'book-chapter':
      return {
        event_type: 'publication',
        confidence: 'definitive',
        reason: `Crossref-registered ${record.work_type} (DOI ${record.doi}).`,
      };
    case 'posted-content':
      return {
        event_type: 'publication',
        confidence: 'inferred',
        reason: `Crossref posted-content (DOI ${record.doi}) — a preprint. Publication event, but not peer-reviewed; treat as a date of first public availability.`,
      };
    case 'report':
      return {
        event_type: 'publication',
        confidence: 'inferred',
        reason: `Crossref report (DOI ${record.doi}) — published but typically not peer-reviewed.`,
      };
    case 'dataset':
      return {
        event_type: 'other',
        confidence: 'inferred',
        reason: `Crossref dataset (DOI ${record.doi}) — a data deposit, not a publication.`,
      };
    case 'other':
      return {
        event_type: 'publication',
        confidence: 'inferred',
        reason: `Crossref work of unrecognized type (DOI ${record.doi}); a registered DOI implies publication but the form is unknown.`,
      };
    default:
      return assertNever(record.work_type, 'crossrefEventType');
  }
}

// ---------------------------------------------------------------------------
// PatentsView
// ---------------------------------------------------------------------------

/**
 * PatentsView indexes granted US patents, so the event is a grant. Without a
 * grant date the record cannot attest to *when*, which downgrades confidence
 * but not the event type — filing date is a different event and must never be
 * substituted for it.
 */
export function patentsviewEventType(record: PatentsViewRecord): EventTypeAttestation {
  if (record.grant_date !== undefined) {
    return {
      event_type: 'patent_grant',
      confidence: 'definitive',
      reason: `US patent ${record.patent_number} granted ${record.grant_date}.`,
    };
  }
  return {
    event_type: 'patent_grant',
    confidence: 'inferred',
    reason: `US patent ${record.patent_number} present in the granted-patent index, but the record carries no grant date. Filing date is a different event and is not a substitute.`,
  };
}

// ---------------------------------------------------------------------------
// Wikipedia
// ---------------------------------------------------------------------------

/**
 * Wikipedia attests to nothing about event type. An article describes a
 * subject, not an event, and its only structured date is the last revision
 * timestamp, which is a fact about the article. Returning `null` here rather
 * than guessing is what keeps a tertiary source from manufacturing an event
 * type that no primary record supports.
 *
 * Wikipedia is still worth querying — for entity aliases and for finding
 * candidate primary sources — but that value shows up elsewhere.
 */
export function wikipediaEventType(record: WikipediaRecord): EventTypeAttestation {
  return {
    event_type: null,
    confidence: 'none',
    reason: `Wikipedia article "${record.canonical_title}" describes a subject, not a dated event; its revision timestamp attests only to the article.`,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Exhaustive dispatch over the registry union. */
export function registryEventType(record: RegistryRecord): EventTypeAttestation {
  switch (record.registry) {
    case 'openfda_device':
      return openFdaDeviceEventType(record);
    case 'crossref':
      return crossrefEventType(record);
    case 'patentsview':
      return patentsviewEventType(record);
    case 'wikipedia':
      return wikipediaEventType(record);
    default:
      return assertNever(record, 'registryEventType');
  }
}

/**
 * Whether a record settles the event type on its own. §6.1 lets a primary-source
 * hit short-circuit the ambiguity below it; only a definitive attestation from
 * a primary registry earns that.
 */
export function settlesEventType(record: RegistryRecord): boolean {
  return registryEventType(record).confidence === 'definitive' && REGISTRY_TIER[record.registry] === 'primary';
}
