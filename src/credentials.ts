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

/**
 * Why a registry is unusable right now.
 *
 * 401 and 403 are kept apart because they license different conclusions:
 *
 *   401 no key   The service asked us to authenticate. This is proof a
 *                credential is required — the one status that settles the
 *                question PatentsView leaves open.
 *   401 + key    We authenticated and were told the credential is bad:
 *                wrong, expired, or revoked.
 *   403 + key    We authenticated and were refused anyway — insufficient
 *                scope, plan, or quota. The key is real but not enough.
 *   403 no key   Ambiguous, and the important case. It may mean a key is
 *                required, but it equally may mean an IP block, a geo
 *                restriction, or an exhausted anonymous quota. Telling the
 *                user to obtain an API key here would be a guess presented as
 *                a diagnosis, so this reason deliberately does not claim one.
 */
export type DegradationReason =
  | 'credential_missing_and_required'
  | 'credential_rejected'
  | 'credential_insufficient'
  | 'access_forbidden';

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

interface Refusal {
  /** 401 or 403 — the two license different conclusions, so the code is kept. */
  status: 401 | 403;
  detail: string;
}

/**
 * Registries observed to refuse us this process. Kept in memory only: a key
 * added to the environment should take effect on restart without anyone having
 * to clear a cache, and a persisted "this is broken" flag would outlive the
 * condition that caused it — especially for a 403, which is often a quota that
 * resets.
 */
const rejected = new Map<RegistryName, Refusal>();

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
 * Record that the endpoint refused us. The status code is required, not
 * optional: it is the whole basis for deciding what we are allowed to tell the
 * user about why.
 */
export function noteCredentialRejected(registry: RegistryName, status: 401 | 403, detail: string): void {
  rejected.set(registry, { status, detail });
}

/** Test seam; also lets a long-running process recover after a key is added. */
export function clearCredentialRejections(): void {
  rejected.clear();
}

/**
 * Turn a refusal into a reason and a message that claims no more than the
 * status code supports.
 */
function explainRefusal(
  registry: RegistryName,
  spec: CredentialSpec,
  refusal: Refusal,
  hasKey: boolean,
): { reason: DegradationReason; note: string } {
  const suffix = 'Other registries were unaffected.';

  if (refusal.status === 401) {
    return hasKey
      ? {
          reason: 'credential_rejected',
          note: `${registry} rejected the key in ${spec.env_var} (${refusal.detail}). The key appears to be wrong, expired, or revoked. ${suffix}`,
        }
      : {
          reason: 'credential_missing_and_required',
          // A 401 is the one status that proves the requirement, so this is
          // the one place the instruction is stated as fact.
          note: `${registry} requires an API key (${refusal.detail}). Set ${spec.env_var}. ${spec.how_to_obtain}. ${suffix}`,
        };
  }

  return hasKey
    ? {
        reason: 'credential_insufficient',
        note: `${registry} accepted the key in ${spec.env_var} but refused the request (${refusal.detail}). This usually means insufficient scope, plan, or quota rather than a bad key. ${suffix}`,
      }
    : {
        reason: 'access_forbidden',
        // Deliberately hedged: a 403 without a key does not establish that a
        // key would have helped.
        note: `${registry} refused the request (${refusal.detail}). No API key was set, so one may be required — but a 403 can equally mean an IP block, a geo restriction, or an exhausted anonymous quota. Setting ${spec.env_var} is worth trying (${spec.how_to_obtain}); if the refusal persists, the cause is not the credential. ${suffix}`,
      };
}

export function availabilityOf(registry: RegistryName): RegistryAvailability {
  const spec = credentialFor(registry);

  if (spec === undefined) {
    return { registry, available: true, credential: 'not_applicable' };
  }

  const value = credentialValue(registry);
  const rejection = rejected.get(registry);

  if (rejection !== undefined) {
    const hasKey = value !== undefined;
    const { reason, note } = explainRefusal(registry, spec, rejection, hasKey);
    return {
      registry,
      available: false,
      credential: hasKey ? 'supplied' : 'absent',
      reason,
      env_var: spec.env_var,
      how_to_obtain: spec.how_to_obtain,
      note,
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
