/**
 * Claim identity.
 *
 * Spec reference: CODEX_SPEC.md §4, which defines `Claim.id` as "sha256 of
 * normalized entity+event_type+date".
 *
 * That definition is right for a claim as it arrives — a sentence from a
 * secondary source, where the entity name and the date are all you have. It is
 * wrong for a claim once a primary record has been found, and the reason is
 * the AESOP case:
 *
 *   K931783 was received 1993-04-09 and decided 1993-11-22. Sources
 *   nonetheless place AESOP's clearance in both 1993 and 1994. Under the §4
 *   rule those are two different claims with two different ids, and nothing
 *   in the data model says they are about the same event — so a timeline can
 *   render both and be internally consistent while showing one clearance
 *   twice.
 *
 * Anchoring on the registry id instead collapses them: same record, same event
 * type, one claim, with a date that is now an *assertion about* the claim
 * rather than part of its identity. The disagreement becomes visible as a
 * contested date field, which is where §6.2 can act on it.
 *
 * The date is therefore deliberately excluded from the hash once an anchor
 * exists. Including it would reintroduce exactly the split the anchor is there
 * to prevent.
 */

import { sha256Hex } from './hash.js';
import type { Claim, EventType, RegistryName } from './types.js';

/** The resolved anchor, when a claim has one. */
export interface ClaimAnchor {
  registry: RegistryName;
  record_id: string;
}

/**
 * Case- and whitespace-normalized, so "AESOP", " aesop " and "Aesop" do not
 * produce three ids for one entity. Punctuation is kept: "PUMA 560" and
 * "PUMA-560" are left distinct because collapsing them would also merge
 * genuinely different model numbers.
 */
export function normalizeEntity(entity: string): string {
  return entity.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Registry ids are case-insensitive in every registry we use. */
export function normalizeRecordId(recordId: string): string {
  return recordId.trim().toUpperCase();
}

/**
 * The anchor for a claim, if it has been resolved. Both fields are required
 * together — a record id without its registry is not an identifier.
 */
export function claimAnchor(claim: Pick<Claim, 'registry' | 'registry_id'>): ClaimAnchor | undefined {
  const { registry, registry_id: recordId } = claim;
  if (registry === undefined || recordId === undefined || recordId.trim() === '') return undefined;
  return { registry, record_id: normalizeRecordId(recordId) };
}

export type ClaimIdBasis = 'registry_anchor' | 'entity_date';

/**
 * How a claim's id was derived. Exposed so callers can tell an anchored claim
 * from an unanchored one without re-deriving.
 */
export function claimIdBasis(claim: Pick<Claim, 'registry' | 'registry_id'>): ClaimIdBasis {
  return claimAnchor(claim) === undefined ? 'entity_date' : 'registry_anchor';
}

export interface ClaimIdInput {
  entity: string;
  event_type: EventType;
  date: string;
  registry?: RegistryName;
  registry_id?: string;
}

/**
 * Derive a claim's id.
 *
 * Anchored:   sha256("<registry>:<record_id>|<event_type>")   — date excluded
 * Unanchored: sha256("<entity>|<event_type>|<date>")          — the §4 rule
 *
 * The two forms are prefixed differently so an anchored id can never
 * accidentally equal an unanchored one.
 */
export function claimId(claim: ClaimIdInput): string {
  const anchor = claimAnchor(claim);
  if (anchor !== undefined) {
    return sha256Hex(`anchor|${anchor.registry}:${anchor.record_id}|${claim.event_type}`);
  }
  return sha256Hex(`claim|${normalizeEntity(claim.entity)}|${claim.event_type}|${claim.date.trim()}`);
}

/** Recompute and attach the id. Use instead of assigning `id` by hand. */
export function withClaimId<T extends ClaimIdInput>(claim: T): T & { id: string } {
  return { ...claim, id: claimId(claim) };
}

/**
 * Whether two claims describe the same event. Anchored claims compare by
 * anchor, which is the point: differing dates do not make them different
 * events.
 */
export function sameEvent(a: ClaimIdInput, b: ClaimIdInput): boolean {
  return claimId(a) === claimId(b);
}
