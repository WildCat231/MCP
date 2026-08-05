/**
 * Content-addressed snapshots with verified reads.
 *
 * Spec reference: CODEX_SPEC.md §4 ("treat snapshot integrity as a first-class
 * requirement") and §5 (save/load/list).
 *
 * ## Why snapshot reads are not cache reads
 *
 * The cache and the snapshot store sit on the same filesystem primitives and
 * have deliberately opposite failure semantics:
 *
 *   Cache read     corruption -> `miss`. Silent, cheap, correct. A cache entry
 *                  is a copy of something re-derivable; throwing it away and
 *                  refetching loses nothing.
 *
 *   Snapshot read  corruption -> hard failure. Never a miss, never a partial
 *                  result, never a "best effort" return.
 *
 * A snapshot is the citable artifact — the thing that makes an unreproducible
 * output quotable six months later. Serving a snapshot whose bytes no longer
 * match its content address would silently break the one guarantee it exists
 * to provide, and the caller would have no way to tell. So every read
 * recomputes the hash and compares it to both the stored id and the filename,
 * and any mismatch is surfaced loudly.
 *
 * The `id` is the hash of the snapshot with `id` itself omitted — a value
 * cannot contain its own hash. `created_at` *is* covered: two runs producing
 * identical findings at different times are different artifacts, because the
 * date is part of what is being cited.
 */

import path from 'node:path';

import { contentHash } from './hash.js';
import { snapshotsDir as defaultSnapshotsDir, frontierHome } from './paths.js';
import { listJson, readJson, removeJson, writeJson } from './store.js';
import type { Snapshot, SnapshotInput } from './types.js';

export type SnapshotFailure =
  | 'not_found'
  /** File unreadable or not JSON at all. */
  | 'unreadable'
  /** Parsed, but not shaped like a snapshot. */
  | 'malformed'
  /** Parsed and well-shaped, but the bytes do not match the content address. */
  | 'checksum_mismatch'
  /** Stored under a filename that is not its own id. */
  | 'misfiled';

export interface SnapshotIntegrityDetail {
  reason: SnapshotFailure;
  id: string;
  detail: string;
  expected_id?: string;
  computed_id?: string;
}

export class SnapshotIntegrityError extends Error {
  readonly reason: SnapshotFailure;
  readonly detail: SnapshotIntegrityDetail;

  constructor(detail: SnapshotIntegrityDetail) {
    super(detail.detail);
    this.name = 'SnapshotIntegrityError';
    this.reason = detail.reason;
    this.detail = detail;
  }
}

export type SnapshotRead =
  | { ok: true; snapshot: Snapshot; verified: true }
  | { ok: false; verified: false; failure: SnapshotIntegrityDetail };

export interface SnapshotSummary {
  id: string;
  query: string;
  created_at: string;
  tool_version: string;
  /** Whether this entry's checksum verified during the listing scan. */
  verified: boolean;
  counts: { components: number; claims: number; verifications: number; frontier: number };
}

/** The content address of a snapshot: its hash with `id` excluded. */
export function snapshotId(snapshot: Omit<Snapshot, 'id'>): string {
  return contentHash(snapshot);
}

function looksLikeSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<Snapshot>;
  return (
    typeof s.id === 'string' &&
    typeof s.query === 'string' &&
    typeof s.created_at === 'string' &&
    typeof s.tool_version === 'string' &&
    Array.isArray(s.components) &&
    Array.isArray(s.claims) &&
    Array.isArray(s.verifications) &&
    Array.isArray(s.frontier)
  );
}

export interface SnapshotStoreOptions {
  home?: string;
  /** Injected for deterministic tests. */
  now?: () => Date;
}

export class SnapshotStore {
  readonly #dir: string;
  readonly #now: () => Date;

  constructor(options: SnapshotStoreOptions = {}) {
    this.#dir = defaultSnapshotsDir(options.home ?? frontierHome());
    this.#now = options.now ?? (() => new Date());
  }

  get dir(): string {
    return this.#dir;
  }

  pathFor(id: string): string {
    return path.join(this.#dir, `${id}.json`);
  }

  /**
   * Freeze a payload. The id is derived, never supplied — a caller cannot
   * assert an address that does not match the content.
   *
   * Saving is idempotent: the same payload at the same timestamp yields the
   * same id and rewrites the same bytes.
   */
  async save(input: SnapshotInput): Promise<{ id: string; path: string; snapshot: Snapshot }> {
    const withoutId: Omit<Snapshot, 'id'> = {
      query: input.query,
      created_at: this.#now().toISOString(),
      tool_version: input.tool_version,
      components: input.components,
      claims: input.claims,
      verifications: input.verifications,
      frontier: input.frontier,
    };

    const id = snapshotId(withoutId);
    const snapshot: Snapshot = { id, ...withoutId };
    const file = this.pathFor(id);
    await writeJson(file, snapshot);

    return { id, path: file, snapshot };
  }

  /**
   * Read and verify. Returns a discriminated result rather than throwing, so
   * the MCP boundary stays clean (§7) — but note that unlike a cache miss,
   * `ok: false` here is always a reportable failure, never a normal outcome to
   * paper over.
   */
  async read(id: string): Promise<SnapshotRead> {
    const file = this.pathFor(id);
    const result = await readJson<unknown>(file);

    if (result.corrupt === true) {
      return this.#fail(id, 'unreadable', `Snapshot ${id} exists but could not be read or parsed as JSON.`);
    }
    if (result.value === undefined) {
      return this.#fail(id, 'not_found', `No snapshot with id ${id}.`);
    }
    if (!looksLikeSnapshot(result.value)) {
      return this.#fail(id, 'malformed', `File for ${id} parsed as JSON but is not a snapshot.`);
    }

    const snapshot = result.value;
    const { id: storedId, ...rest } = snapshot;
    const computed = snapshotId(rest);

    // The filename must be the id: a snapshot renamed on disk is no longer
    // addressable by its content, and quoting it by that filename would be
    // quoting something the address does not describe.
    if (storedId !== id) {
      return this.#fail(
        id,
        'misfiled',
        `Snapshot filed as ${id} declares id ${storedId}.`,
        storedId,
        computed,
      );
    }

    if (computed !== storedId) {
      return this.#fail(
        id,
        'checksum_mismatch',
        `Snapshot ${id} failed integrity check: contents hash to ${computed}. ` +
          'The file has been modified or truncated since it was written; it must not be cited.',
        storedId,
        computed,
      );
    }

    return { ok: true, snapshot, verified: true };
  }

  /** Throwing variant, for call sites where a bad snapshot must halt the work. */
  async load(id: string): Promise<Snapshot> {
    const result = await this.read(id);
    if (!result.ok) throw new SnapshotIntegrityError(result.failure);
    return result.snapshot;
  }

  /**
   * List snapshots, verifying each. A failing entry is reported with
   * `verified: false` rather than hidden, on the same principle as §6.5's
   * "never drop a node for failing verification" — a corrupt snapshot the user
   * can see is useful; one silently omitted is a lie of omission.
   */
  async list(query?: string): Promise<{ snapshots: SnapshotSummary[]; unreadable: SnapshotIntegrityDetail[] }> {
    const summaries: SnapshotSummary[] = [];
    const unreadable: SnapshotIntegrityDetail[] = [];

    for (const file of await listJson(this.#dir)) {
      const id = path.basename(file, '.json');
      const result = await this.read(id);

      if (!result.ok) {
        unreadable.push(result.failure);
        continue;
      }
      const snapshot = result.snapshot;
      if (query !== undefined && !snapshot.query.toLowerCase().includes(query.toLowerCase())) {
        continue;
      }
      summaries.push({
        id: snapshot.id,
        query: snapshot.query,
        created_at: snapshot.created_at,
        tool_version: snapshot.tool_version,
        verified: true,
        counts: {
          components: snapshot.components.length,
          claims: snapshot.claims.length,
          verifications: snapshot.verifications.length,
          frontier: snapshot.frontier.length,
        },
      });
    }

    // Newest first.
    summaries.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { snapshots: summaries, unreadable };
  }

  /** Re-verify every snapshot without returning payloads. */
  async verifyAll(): Promise<{ checked: number; verified: number; failures: SnapshotIntegrityDetail[] }> {
    const failures: SnapshotIntegrityDetail[] = [];
    let checked = 0;
    let verified = 0;

    for (const file of await listJson(this.#dir)) {
      checked += 1;
      const result = await this.read(path.basename(file, '.json'));
      if (result.ok) verified += 1;
      else failures.push(result.failure);
    }
    return { checked, verified, failures };
  }

  async delete(id: string): Promise<boolean> {
    return removeJson(this.pathFor(id));
  }

  #fail(
    id: string,
    reason: SnapshotFailure,
    detail: string,
    expected?: string,
    computed?: string,
  ): SnapshotRead {
    return {
      ok: false,
      verified: false,
      failure: {
        reason,
        id,
        detail,
        ...(expected === undefined ? {} : { expected_id: expected }),
        ...(computed === undefined ? {} : { computed_id: computed }),
      },
    };
  }
}
