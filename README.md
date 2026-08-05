# Frontier

An MCP server for building **verified historical timelines** of technical fields and tracking each field's research frontier over time.

The calling model decomposes a field, proposes historical milestone claims, and calls this server to verify each claim against real sources and to retrieve current research. The server returns structured evidence; the model does the interpreting.

**This server makes zero LLM calls.** No API key, no model client, no inference dependency. It does HTTP requests to public APIs, parsing and deduplication, caching, and deterministic scoring — nothing else. See [`CODEX_SPEC.md`](./CODEX_SPEC.md) §2.

## Status

**Phase 3 of 10 — source adapters written, awaiting fixtures.**

| Phase | | |
|---|---|---|
| 1 | Skeleton, manifest | done |
| 2 | Storage, cache TTLs, rate limiting | done |
| 3 | Source adapters | code complete, **unvalidated** — see below |
| 4–10 | search, registries, verification, conflation, clustering, snapshots, packaging | not started |

Snapshot storage (§4 integrity, normally Phase 9) is also implemented ahead of order, because its read semantics had to be settled against the cache's.

Three tools are exposed today: `ping`, `cache_status`, `clear_cache`.

### Phase 3 is not finished

Spec §8 requires fixtures recorded from real API responses: *"Record real API responses once, commit them, replay them in tests."* No fixture has been recorded, because every upstream host is blocked by the build environment's egress policy. The adapters are therefore written from each API's published schema and **have never seen a live response**.

Six fixture-replay tests skip with instructions rather than passing vacuously. To finish Phase 3, from a machine with network access:

```sh
npm run build
npm run record-fixtures          # --list to see what it records, --force to re-record
npm test                         # the six skips become real assertions
```

Expect the recordings to correct some field mappings. That is what they are for — the parse functions are pure, so a fixture is enough to confirm or fix one without touching the network again.

**What gets recorded is the raw upstream response**, byte for byte: `response.text()` written straight to disk, with no re-serialization, no pretty-printing, and no added trailing newline. The recorder imports only URL builders, the rate limiter, and the credential headers — never a `parse*` or `to*` function. That constraint is not a convention but a correctness requirement: a fixture that had passed through a parser would test that parser against its own output and pass regardless of how wrong the field mapping was. `test/recorder.test.js` enforces it statically.

Each recording is paired with a `.meta.json` carrying the request URL, HTTP status, content type, byte count, and a SHA-256 of the recorded bytes, so a hand-edited fixture is detectable. No request headers are stored — otherwise the PatentsView recording would carry an API key into the repository. Files take the extension of their payload, so arXiv's Atom feed is `.xml` rather than `.json`. Error responses are recorded too where a fixture opts in: an openFDA 404 `NOT_FOUND` body and whatever PatentsView says about credentials are both evidence the adapters must handle.

## Unverified assumptions

Claims this codebase makes that have **not** been checked against reality, collected here rather than left implicit in comments:

| Assumption | Status | How to settle it |
|---|---|---|
| Every adapter's field mapping (arXiv, PubMed, Crossref, openFDA, Wikipedia, PatentsView) | From published docs; never validated | `npm run record-fixtures`, then `npm test` |
| PatentsView requires an `X-Api-Key` | **Unknown.** Legacy `api.patentsview.org` was open; the current Search API documents the header | Handled at runtime — see below |
| openFDA date formats (`YYYYMMDD` vs `YYYY-MM-DD`) | Both accepted defensively | `openfda-aesop-510k` fixture |
| AESOP's 510(k) received and decision dates | **Unknown** — could not be queried | See "Pending empirical checks" |

## Pending empirical checks

**The AESOP date span.** The golden set (§8) expects AESOP's 510(k) to come back `contested` with a bimodal date across 1993–1994. One plausible mechanical origin is openFDA's own record: FDA receives a submission one year and decides the next, and secondary sources cite whichever date they saw. If that gap is real and spans the year boundary, then a *single* primary record contains both modes, and the conflation discriminator (§6.6) should be able to fire on one record rather than requiring ≥2 sources per mode.

That change has **not** been made. The openFDA query that would establish it returns `403` from this environment's egress proxy, and the discriminator itself does not exist yet (§10.7). The decision rule, for whoever runs the query:

- Record `openfda-aesop-510k` and read `date_received` and `decision_date`.
- **If** they fall in different calendar years spanning 1993–1994 → add a single-record check to the conflation discriminator: one registry record whose received and decision dates straddle a year boundary is itself sufficient evidence of a date mode split, without a second source. Update `test/golden/surgical_robotics.json` so the AESOP row's expected bimodality cites the record rather than the source count.
- **If** they do not → change nothing. The 1993/1994 split has some other origin, and a single-record rule would fire on ordinary FDA processing time across the whole database.

Both dates are already preserved separately on `OpenFdaDeviceRecord` precisely so this stays answerable.

## Credentials

Three registries are keyless. PatentsView may not be, and the code does not assume an answer:

| State | Behaviour |
|---|---|
| `PATENTSVIEW_API_KEY` set | Sent as `X-Api-Key` |
| Not set | Request attempted anyway — the endpoint may be open |
| Refused | That registry is skipped with a `warning`; the observation is recorded so it is not retried this process |

A missing key **shrinks** a multi-registry lookup rather than failing it, and a skip is never reported as "no patents found". Adding the key and restarting recovers — the refusal is held in memory only, never persisted. Key values never appear in tool output.

### 401 and 403 mean different things

The two statuses license different conclusions, so they produce different reasons and different wording:

| Status | Key set? | Reason | What the user is told |
|---|---|---|---|
| 401 | no | `credential_missing_and_required` | A key **is** required. Stated as fact — this is the one status that proves it. |
| 401 | yes | `credential_rejected` | The key is wrong, expired, or revoked. |
| 403 | yes | `credential_insufficient` | The key authenticated but was refused: scope, plan, or quota. Not a bad key. |
| 403 | no | `access_forbidden` | **Hedged.** A key may help, but a 403 can equally be an IP block, a geo restriction, or an exhausted anonymous quota. |

The last row is the reason for the split. Collapsing 401 and 403 would have the server tell a rate-limited or IP-blocked user to go obtain an API key — a guess presented as a diagnosis, for a problem no key fixes. `HttpFailureKind` carries `unauthenticated` and `forbidden` separately for the same reason, and the response body is included in the error string because it usually says which case applies.

## Requirements

Node.js 18 or newer. No other prerequisites — no Python, no API keys, no native modules, no model downloads. The dependency tree is pure JavaScript, so the same bundle runs on macOS, Windows, and Linux.

## Build and test

```sh
npm install
npm run build     # tsc -> dist/
npm test          # builds first, then runs the suite
```

Tests make no network calls and pass with the network disabled. Time-dependent behaviour (cache TTLs, rate-limit spacing) is driven by an injectable `FakeClock`, so the suite asserts arXiv's 3-second request floor without taking 3 seconds and without flaking under load.

## Run

```sh
npm start         # node dist/index.js, speaking MCP over stdio
```

The server speaks JSON-RPC on stdout, so it is not meant to be used interactively — point an MCP client at it:

```json
{
  "mcpServers": {
    "frontier": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"]
    }
  }
}
```

`manifest.json` is a valid [MCPB](https://github.com/anthropics/mcpb) manifest, so the repo will also build to an installable `.mcpb` bundle (Phase 10).

## Storage

State lives in `~/.frontier`, overridable with the `FRONTIER_HOME` environment variable (or the data-directory setting when installed as an `.mcpb`):

```
~/.frontier/
  cache/<namespace>/<shard>/<key>.json   registry | literature | verification
  snapshots/<id>.json                    phase 9
  stats.json                             per-tool hit-rate counters
```

Cache entries are plain JSON, one file per entry, keyed by a SHA-256 of the normalized request. Writes go to a temp file and are then renamed, which is atomic within a directory — a crash mid-write leaves the previous entry intact rather than a truncated file that still parses.

TTLs are 30 days for registry lookups, 24 hours for literature searches, and 7 days for verification results. **Expired entries are retained, not deleted**: spec §7 requires that when every network call fails the server falls back to cache and marks the result `stale`, which is only possible if expiry means "don't serve this as fresh" rather than "erase this". Only `clear_cache` and `prune()` delete.

### Cache reads and snapshot reads fail differently

The two stores share the same filesystem primitives and have deliberately opposite failure semantics:

| | Corruption on disk | Why |
|---|---|---|
| **Cache** | Reported as a plain `miss` | A cache entry is a copy of something re-derivable. Discarding it and refetching loses nothing. |
| **Snapshot** | Hard, named failure — never a miss, never partial | A snapshot is the citable artifact. Serving one whose bytes no longer match its content address would silently break the only guarantee it provides. |

Every snapshot read recomputes the content hash and compares it against both the stored `id` and the filename, distinguishing `not_found`, `unreadable`, `malformed`, `checksum_mismatch`, and `misfiled`. `list()` reports failing entries rather than hiding them, on the same principle as §6.5's "never drop a node for failing verification". A test asserts the contrast directly: identical byte-level damage is a shrug in one store and an alarm in the other.

The `id` is the hash of the snapshot with `id` itself omitted — a value cannot contain its own hash. `created_at` *is* covered, because two runs finding the same thing on different days are different citable artifacts.

## Layout

```
manifest.json           MCPB manifest
scripts/
  record-fixtures.mjs   the only thing here that touches the network
src/
  index.ts              MCP server entry, tool registration
  types.ts              the data contract (spec §4)
  registry.ts           registry -> EventType mapping, one typed function each
  credentials.ts        optional API keys, graceful degradation
  http.ts               the single outbound HTTP path
  dates.ts              partial-date normalization with explicit precision
  cache.ts              TTL cache layer
  snapshot.ts           content-addressed snapshots, verified reads
  store.ts              atomic filesystem JSON store
  ratelimit.ts          token bucket per host
  clock.ts              injectable time, incl. FakeClock for tests
  paths.ts              ~/.frontier resolution
  hash.ts               canonical JSON, content addressing
  sources/
    arxiv.ts  pubmed.ts  crossref.ts
    openfda.ts  wikipedia.ts  patentsview.ts
test/
  smoke.test.js         handshake, tool listing, tool calls
  cache.test.js         TTLs, staleness, key normalization, atomicity
  snapshot.test.js      integrity, tampering, the contrast with cache reads
  ratelimit.test.js     token buckets, FIFO fairness, per-host isolation
  registry.test.js      clearance vs approval, and the rest of the mapping
  credentials.test.js   degradation when a key is missing or refused
  dates.test.js         partial dates, precision, source-specific formats
  sources.test.js       adapter logic, plus fixture replay (currently skipped)
  golden.test.js        golden-set shape, incl. date_precision on every entry
  recorder.test.js      guards the recorder's raw-capture invariant
  fixtures/             recorded API responses (raw bytes + .meta.json)
  golden/               hand-written expected answers
```

## The golden set

`test/golden/surgical_robotics.json` holds the §8 expected answers: seven positive rows plus the required ROBODOC negative. Every entry states `date_precision` explicitly, on both the input claim and the expected verification, and `test/golden.test.js` checks that each declared precision matches the granularity of its own date string — cross-checked against the same `normalizeDate` the pipeline uses, so the fixture and the implementation cannot drift apart.

Precision is tracked this strictly because it is itself a claim. A verifier that pads `1985` to `1985-01-01` manufactures a disagreement no source expressed; one that coarsens da Vinci's `2000-07` to `2000` discards information the sources do carry. `da-vinci-pma-approval` is the only month-precision row, and it exists partly as the case that would pass silently if precision were ignored. A separate test asserts expected precision is never *finer* than the claim's — coarsening is legitimate when sources disagree, sharpening is invention.

The verifier does not exist yet (§10.6), so these tests lock the contract rather than exercise it. They also encode the relationships the spec calls load-bearing: AESOP's date is bimodal while its event type is not (§6.2), the two STAR entries must not corroborate each other despite the shared acronym (§6.6), and the negative case must return `contested` with AESOP as a competing clearance-not-approval claimant.

## Deviations from `CODEX_SPEC.md`

The spec is the contract; where the implementation departs from it, it is recorded here.

- **§3 storage: filesystem-backed JSON instead of SQLite/`better-sqlite3`.** Requested explicitly. The practical gain is distribution: `better-sqlite3` is a native module, so a cross-platform `.mcpb` would have to ship prebuilt binaries per platform and Node ABI, or compile on the user's machine — which reintroduces exactly the zero-prerequisites problem that §3's Node-over-Python constraint exists to avoid. The cache is small, write-rarely/read-often, and never queried relationally, so a file per entry is a fair trade. What is given up is transactional multi-key writes and indexed queries; if snapshot integrity (§4) or `cache_status` over a very large cache later needs either, this is the decision to revisit.
- **§4 `RegistryRecord`: a discriminated union instead of an open `fields` bag.** Each registry has its own record type and its own typed `EventType` mapping function in `src/registry.ts`, dispatched exhaustively. Adding a registry without adding its mapping is a compile error.
- **`cache_status` / `clear_cache` registered in Phase 2**, though §10 does not assign them to a phase. They are storage diagnostics with no other natural home, and registering them makes Phase 2 verifiable from a client rather than only from unit tests.
- **§5 "all four registries are free and keyless" is not relied on.** PatentsView is treated as optionally credentialed; see "Credentials" above.
- **Snapshot storage built during Phase 3** rather than Phase 9, because its read semantics are defined by contrast with the cache's and the two are best settled together.
- **One dependency added beyond §3's list: `fast-xml-parser`,** which §3 explicitly anticipates for arXiv Atom. `zod` remains the other (the MCP SDK's tool API requires it). The tree is still free of native modules.

## License

MIT
