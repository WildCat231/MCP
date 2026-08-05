/**
 * Optional API credentials, and graceful degradation without them.
 *
 * Three of the four registries are genuinely keyless. PatentsView is not
 * settled: its legacy `api.patentsview.org` endpoint was open, and the current
 * `search.patentsview.org` Search API documents an `X-Api-Key` header, but
 * this could not be confirmed against the live service from the build
 * environment (see README, "Unverified assumptions"). So its requirement is
 * recorded as `unknown` rather than guessed.
 *
 * The design does not depend on resolving that question. A credential is
 * always optional at startup:
 *
 *   - present  -> send it
 *   - absent   -> attempt the request anyway; the endpoint may be open
 *   - rejected -> degrade this registry only, record why, and stop retrying
 *
 * A 401/403 is therefore treated as an *observation* about the endpoint rather
 * than as an error in the caller's request. That self-discovers the answer at
 * runtime, and it is the correct behaviour whichever way the answer falls: a
 * missing key must never fail a multi-registry lookup, only shrink it.
 */

import type { RegistryName } from './types.js';

export interface CredentialSpec {
  registry: RegistryName;
  env_var: string;
  /** HTTP header the key travels in. */
  header: string;
  how_to_obtain: string;
  /**
   * What is actually known about whether the key is mandatory.
   * `unknown` means exactly that — it has not been observed, and the code
   * must not behave as though it had been.
   */
  requirement: 'required' | 'optional' | 'unknown';
}

export const CREDENTIALS: Readonly<Partial<Record<RegistryName, CredentialSpec>>> = {
  patentsview: {
    registry: 'patentsview',
    env_var: 'PATENTSVIEW_API_KEY',
    header: 'X-Api-Key',
    how_to_obtain: 'Request a key at https://patentsview.org/apis/keyrequest',
    requirement: 'unknown',
  },
};

/** Why a registry is unusable right now. */
export type DegradationReason = 'credential_rejected' | 'credential_missing_and_required';

export interface RegistryAvailability {
  registry: RegistryName;
  available: boolean;
  /**
   * `not_applicable` — this registry takes no credential.
   * `supplied`       — a key was found in the environment.
   * `absent`         — no key; we will still attempt, since the endpoint may be open.
   */
  credential: 'not_applicable' | 'supplied' | 'absent';
  reason?: DegradationReason;
  env_var?: string;
  how_to_obtain?: string;
  /** Human-readable note surfaced in the tool envelope's `warning`. */
  note?: string;
}

/**
 * Registries observed to reject our credential state this process. Kept in
 * memory only: a key added to the environment should take effect on restart
 * without anyone having to clear a cache, and a persisted "this is broken"
 * flag would outlive the condition that caused it.
 */
const rejected = new Map<RegistryName, string>();

export function credentialFor(registry: RegistryName): CredentialSpec | undefined {
  return CREDENTIALS[registry];
}

export function credentialValue(registry: RegistryName): string | undefined {
  const spec = credentialFor(registry);
  if (spec === undefined) return undefined;
  const raw = process.env[spec.env_var];
  return raw !== undefined && raw.trim() !== '' ? raw.trim() : undefined;
}

/** Headers to attach for this registry. Empty when there is no key to send. */
export function credentialHeaders(registry: RegistryName): Record<string, string> {
  const spec = credentialFor(registry);
  const value = credentialValue(registry);
  if (spec === undefined || value === undefined) return {};
  return { [spec.header]: value };
}

/**
 * Record that the endpoint refused our credential state. Called on a 401/403,
 * which is the only evidence that actually settles whether a key is required.
 */
export function noteCredentialRejected(registry: RegistryName, detail: string): void {
  rejected.set(registry, detail);
}

/** Test seam; also lets a long-running process recover after a key is added. */
export function clearCredentialRejections(): void {
  rejected.clear();
}

export function availabilityOf(registry: RegistryName): RegistryAvailability {
  const spec = credentialFor(registry);

  if (spec === undefined) {
    return { registry, available: true, credential: 'not_applicable' };
  }

  const value = credentialValue(registry);
  const rejection = rejected.get(registry);

  if (rejection !== undefined) {
    return {
      registry,
      available: false,
      credential: value === undefined ? 'absent' : 'supplied',
      reason: value === undefined ? 'credential_missing_and_required' : 'credential_rejected',
      env_var: spec.env_var,
      how_to_obtain: spec.how_to_obtain,
      note:
        value === undefined
          ? `${registry} requires an API key: ${rejection}. Set ${spec.env_var}. ${spec.how_to_obtain}. Other registries were unaffected.`
          : `${registry} rejected the key in ${spec.env_var}: ${rejection}. Other registries were unaffected.`,
    };
  }

  if (value === undefined) {
    return {
      registry,
      available: true,
      credential: 'absent',
      env_var: spec.env_var,
      how_to_obtain: spec.how_to_obtain,
      note:
        spec.requirement === 'required'
          ? `${spec.env_var} is not set; ${registry} will be attempted but is expected to refuse.`
          : `${spec.env_var} is not set; ${registry} will be attempted without a key.`,
    };
  }

  return { registry, available: true, credential: 'supplied', env_var: spec.env_var };
}

/**
 * Snapshot of credential state for diagnostics. Reports only whether a key is
 * present — never any part of its value, since tool output goes into a model
 * context and from there potentially into a transcript.
 */
export function credentialReport(): Record<string, Omit<RegistryAvailability, 'registry'>> {
  const out: Record<string, Omit<RegistryAvailability, 'registry'>> = {};
  for (const registry of Object.keys(CREDENTIALS) as RegistryName[]) {
    const { registry: _omit, ...rest } = availabilityOf(registry);
    out[registry] = rest;
  }
  return out;
}
