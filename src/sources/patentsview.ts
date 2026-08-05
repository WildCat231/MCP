/**
 * PatentsView Search API adapter.
 *
 * https://search.patentsview.org/api/v1 — the one registry with a credential.
 *
 * ## Credential handling
 *
 * Spec §5 says all four registries are "free and keyless". That is true of the
 * other three; for PatentsView it could not be confirmed. The legacy
 * `api.patentsview.org` endpoint was open, and the current Search API
 * documents an `X-Api-Key` header, but the live service was unreachable from
 * the build environment, so the requirement is recorded as `unknown` rather
 * than asserted (see README, "Unverified assumptions").
 *
 * The adapter is built not to care:
 *
 *   - key present -> send it
 *   - key absent  -> attempt anyway; the endpoint may be open
 *   - 401/403     -> record the observation, degrade *this registry only*,
 *                    and return a structured `skipped` result
 *
 * A missing key therefore shrinks a multi-registry lookup rather than failing
 * it, and the requirement question answers itself on first contact.
 */

import { availabilityOf, credentialHeaders, credentialValue, noteCredentialRejected } from '../credentials.js';
import type { RegistryAvailability } from '../credentials.js';
import { normalizeDate } from '../dates.js';
import type { HttpDeps, HttpOptions } from '../http.js';
import { httpGetJson } from '../http.js';
import type { PatentsViewRecord } from '../types.js';

export const PATENTSVIEW_ENDPOINT = 'https://search.patentsview.org/api/v1/patent/';

interface RawAssignee {
  assignee_organization?: string;
  assignee_individual_name_last?: string;
  assignee_individual_name_first?: string;
}

interface RawInventor {
  inventor_name_first?: string;
  inventor_name_last?: string;
}

interface RawPatent {
  patent_id?: string;
  patent_number?: string;
  patent_title?: string;
  patent_date?: string;
  patent_type?: string;
  filing_date?: string;
  application?: { filing_date?: string }[];
  assignees?: RawAssignee[];
  inventors?: RawInventor[];
}

interface PatentsViewEnvelope {
  error?: boolean | string;
  count?: number;
  total_hits?: number;
  patents?: RawPatent[];
}

function assigneeNames(assignees: RawAssignee[] | undefined): string[] {
  return (assignees ?? [])
    .map((a) =>
      a.assignee_organization?.trim() ??
      [a.assignee_individual_name_first, a.assignee_individual_name_last]
        .filter((p) => p !== undefined && p.trim() !== '')
        .join(' ')
        .trim(),
    )
    .filter((name) => name !== '');
}

function inventorNames(inventors: RawInventor[] | undefined): string[] {
  return (inventors ?? [])
    .map((i) => [i.inventor_name_first, i.inventor_name_last].filter((p) => p !== undefined && p.trim() !== '').join(' ').trim())
    .filter((name) => name !== '');
}

/** Pure. A raw patent row -> a typed grant record. */
export function toPatentRecord(raw: RawPatent): PatentsViewRecord | undefined {
  const number = (raw.patent_id ?? raw.patent_number)?.trim();
  if (number === undefined || number === '') return undefined;

  const grant = normalizeDate(raw.patent_date);
  // Filing date lives on the nested application object in the v1 schema, with
  // a flat fallback for the legacy shape.
  const filing = normalizeDate(raw.application?.[0]?.filing_date ?? raw.filing_date);

  return {
    registry: 'patentsview',
    record_id: number,
    patent_number: number,
    title: raw.patent_title?.replace(/\s+/g, ' ').trim() ?? number,
    ...(grant === undefined ? {} : { grant_date: grant.date, date: grant.date, date_precision: grant.precision }),
    ...(filing === undefined ? {} : { filing_date: filing.date }),
    assignees: assigneeNames(raw.assignees),
    inventors: inventorNames(raw.inventors),
    ...(raw.patent_type === undefined ? {} : { patent_kind: raw.patent_type.trim() }),
    url: `https://patents.google.com/patent/US${number}`,
  };
}

export function parsePatents(json: unknown): { records: PatentsViewRecord[]; total?: number; error?: string } {
  const envelope = json as PatentsViewEnvelope;
  if (typeof envelope.error === 'string' && envelope.error !== '') {
    return { records: [], error: envelope.error };
  }
  const records = (envelope.patents ?? []).map(toPatentRecord).filter((r): r is PatentsViewRecord => r !== undefined);
  const total = envelope.total_hits ?? envelope.count;
  return { records, ...(typeof total === 'number' ? { total } : {}) };
}

export interface PatentsViewQuery {
  /** Matched against patent titles. */
  text: string;
  limit?: number;
}

const RETURNED_FIELDS = [
  'patent_id',
  'patent_title',
  'patent_date',
  'patent_type',
  'assignees.assignee_organization',
  'inventors.inventor_name_first',
  'inventors.inventor_name_last',
  'application.filing_date',
];

export function patentsviewUrl(query: PatentsViewQuery): string {
  const url = new URL(PATENTSVIEW_ENDPOINT);
  url.searchParams.set('q', JSON.stringify({ _text_any: { patent_title: query.text } }));
  url.searchParams.set('f', JSON.stringify(RETURNED_FIELDS));
  url.searchParams.set('o', JSON.stringify({ size: query.limit ?? 25 }));
  return url.toString();
}

export interface PatentsViewResult {
  records: PatentsViewRecord[];
  total?: number;
  /** True when the registry was skipped rather than queried. */
  skipped?: boolean;
  availability: RegistryAvailability;
  warning?: string;
  error?: string;
  url: string;
}

/**
 * Search granted patents, degrading gracefully rather than failing when the
 * credential is absent or refused.
 *
 * Returning `skipped: true` with a `warning` — instead of an `error` — is the
 * whole point: a caller aggregating four registries must be able to report
 * three results plus one honest gap, and must never confuse "this registry was
 * unavailable" with "there are no patents".
 */
export async function searchPatents(
  query: PatentsViewQuery,
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<PatentsViewResult> {
  const url = patentsviewUrl(query);
  const availability = availabilityOf('patentsview');

  // Already refused once this process; do not keep asking.
  if (!availability.available) {
    return {
      records: [],
      skipped: true,
      availability,
      ...(availability.note === undefined ? {} : { warning: availability.note }),
      url,
    };
  }

  const hasKey = credentialValue('patentsview') !== undefined;
  const result = await httpGetJson<unknown>(
    url,
    { ...options, headers: { ...credentialHeaders('patentsview'), ...options.headers } },
    deps,
  );

  if (!result.ok) {
    if (result.kind === 'unauthenticated' || result.kind === 'forbidden') {
      // The first hard evidence about this endpoint's requirements. Record the
      // status, not just the fact of refusal: a 401 proves a key is needed, a
      // 403 does not, and the message the user sees has to reflect that.
      const status = result.kind === 'unauthenticated' ? 401 : 403;
      noteCredentialRejected('patentsview', status, result.error);
      const updated = availabilityOf('patentsview');
      return {
        records: [],
        skipped: true,
        availability: updated,
        warning:
          updated.note ??
          (hasKey
            ? 'PatentsView refused the supplied API key; patent evidence is unavailable.'
            : 'PatentsView refused the request; patent evidence is unavailable.'),
        url,
      };
    }
    return { records: [], availability, error: result.error, url };
  }

  return { ...parsePatents(result.value), availability, url };
}
