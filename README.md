# Frontier

An MCP server for building **verified historical timelines** of technical fields and tracking each field's research frontier over time.

The calling model decomposes a field, proposes historical milestone claims, and calls this server to verify each claim against real sources and to retrieve current research. The server returns structured evidence; the model does the interpreting.

**This server makes zero LLM calls.** No API key, no model client, no inference dependency. It does HTTP requests to public APIs, parsing and deduplication, caching, and deterministic scoring — nothing else. See [`CODEX_SPEC.md`](./CODEX_SPEC.md) §2.

## Status

**All 10 phases complete, plus three gap-analysis tools. 293 tests green, 5 fixture-gated skips.**

| Phase | | |
|---|---|---|
| 1 | Skeleton, manifest | done |
| 2 | Storage, cache TTLs, rate limiting | done |
| 3 | Source adapters | done — validated against recorded fixtures |
| 4 | `search_literature` | done |
| 5 | `check_registry` | done |
| 6 | `verify_claim`, independence, superlatives | done |
| 7 | Conflation detection (§6.6) | done |
| 8 | `cluster_frontier` | done |
| 9 | Snapshots (§5, §10.9) | done |
| 10 | `.mcpb` packaging | done — **client install needs your machine** |

Snapshot storage was built during Phase 3, because its read semantics had to be settled against the cache's; Phase 9 audited it against §5 and §10.9 and exposed the three tools, which had never been registered.

Fourteen tools are exposed: `ping`, `search_literature`, `check_registry`, `verify_claim`, `disconfirm_superlative`, `cluster_frontier`, `save_snapshot`, `load_snapshot`, `list_snapshots`, `find_incumbents`, `check_abandonment`, `fetch_yc_rfs`, `cache_status`, `clear_cache`.

## `search_literature`

Queries arXiv, PubMed, and Crossref; deduplicates by DOI then normalized title; returns papers newest-first with the window actually used.

**Adaptive window.** With no `from`/`to`, the search starts at 6 months and widens through 12, 24, and 60 until a source returns `max_per_source` results or the ceiling is reached. A fixed window fails fast- and slow-moving fields in opposite directions — six months of machine learning is a firehose, six months of railway signalling is silence. `window_used` and `windows_tried` always come back, because "3 papers" means something completely different over 6 months than over 5 years, and a caller who cannot tell them apart will misread both. An explicit window is never widened: the caller asked a specific question.

**Context anchoring.** Terms are ANDed. A single term returns a `warning` — a warning, not a refusal, since the caller may know something the server does not, and refusing would substitute the server's judgement for Claude's (§2). Generic terms (`robotics`, `system`, `learning`, …) get a stronger one. An unanchored search is worse than an empty one, because it returns plausible results from the wrong discipline and looks like success.

**Failure is never silence.** A source that errors is reported in `errors` and named in the warning, with counts flagged as lower bounds. An empty result from three healthy sources says the field is genuinely quiet; an empty result from three timeouts says nothing at all, and §7 requires those to be distinguishable. Only clean runs are cached, so one timeout cannot make a field look dead for 24 hours.

## `check_registry`

Primary-source lookup across the four registries (§6.1: try this before falling back to literature search). Three behaviours worth knowing:

**openFDA means both databases.** A regulatory query hits 510(k) *and* PMA and returns both. The clearance-vs-approval distinction is invisible if the caller has to know in advance which one to ask for — and getting that wrong is precisely the error this project exists to catch. When a device is present in one and absent from the other, the result says so in plain words.

**Every match, never a chosen one.** No best-match selection anywhere. Picking one record out of several is a judgement about which record a claim refers to, and per §2 that belongs to Claude, with all candidates visible.

**Truncation is reported loudly.** `truncated`, `returned`, and `total_matches` always come back. A truncated set supports "these records exist"; it does *not* support "this is the earliest" or "there are no others", and the warning says so. This is not a hypothetical — see below.

## `verify_claim`

Each field — entity, event type, date — is verified **independently** (§6.2). That is the part that catches the failure whole-claim verification cannot see: the golden set's ROBODOC and da Vinci rows named a real entity on a real date under the wrong event type, and a verifier checking the claim as a unit would have passed both.

**Registry first** (§6.1). For regulatory claims openFDA settles clearance-vs-approval outright, because 510(k) and PMA are separate databases.

**Anchoring matters.** A claim carrying `registry_id` is verified against *that record only*. Without it, every matching record is a candidate, and their differing dates are different **events** rather than disagreement about one — reported as such, with `entity_candidates` listing each record's applicant. That distinction was a real bug during implementation: verifying an anchored ROBODOC claim against both its clearances reported a "contested date" that was really two unrelated events.

**Independence** (§6.4): domain diversity weighted 0.6, tier diversity 0.4, discounted 0.6× when sources cite a common ancestor; corroboration needs ≥ 0.5 *and* a primary or peer-reviewed source. A single source scores 0 — there is nothing to be independent of — and two tertiary blogs corroborate nothing.

**Superlatives** (§6.3) trigger `disconfirm_superlative`, which searches the category with the **entity removed**; searching it with the entity just rediscovers the claimant. Any rival makes the field contested, full stop — no weighing, and both sides are returned.

**Conflation (§6.6)** runs over the full candidate set, not the anchored subset — an anchored claim has one record and therefore one of everything, so anchoring would hide exactly the ambiguity the check exists to surface.

## Conflation detection

§6.6 forbids doing this semantically. The signal is distributional: *noise scatters, conflation clusters*. Nothing in the detector reads a title or an abstract.

| Check | Fires when |
|---|---|
| **Attribution** | ≥2 organizations each hold ≥2 records under one name |
| **Alias drift** | Two expansions sit in the 0.3–0.9 similarity band **and** each carries a token the other lacks |
| **Event type** | ≥2 event types each attested by ≥2 sources |
| **Date** | ≥2 tight modes (internal spread ≤1 yr), each ≥2 sources, separated by >3 yr |

Every check is reported, including clean ones, so a caller can tell "checked, nothing found" from "not checked". The output is evidence, never a question — §6.6 leaves the clarifying question to Claude, since only Claude knows whether the ambiguity affects the rest of the timeline.

### What it fires on here — and what it does not

**The date detector does not fire on AESOP**, and should not. The spec predicted a 1993/1994 bimodal split; K931783 shows received 1993-04-09 and decided 1993-11-22, both in one year. There is no second mode, and a detector tuned to manufacture one would be wrong. A test pins this down so the rule is not quietly re-added.

**The bimodality that genuinely exists is on entity.** A "DA VINCI" search returns records from three unrelated companies — Intuitive Surgical, Da Vinci Medical, Nova/Da Vinci Systems — two holding multiple records each. That is §6.6's exact shape, and the unanchored K935999 adversarial entry is what exercises it end to end.

Three findings from building it:

- **Device names are a useless clustering key.** "DAVINCI CHOLANGIOGRAM DELIVERY DEVICE" and "INTUITIVE SURGICAL DA VINCI ENDOSCOPIC CONTROL SYSTEM" share almost no tokens, so name clustering yields five singletons and misses a real conflation entirely. The *applicant* collapses them into two real modes — and it is a fact the registry states rather than a string inference.
- **Entity conflation outranks date conflation**, because it causes it. If one name covers two companies, of course their records cluster in different decades; reporting the date split as the finding would describe the symptom and hide the cause. When entity fires, downstream multimodality is noted as expected rather than reported separately.
- **Similarity alone cannot detect drift.** "Smart Tissue Autonomous Robot" vs the same phrase plus "system" scores 0.8 — *higher* than the real STAR drift case at 0.6. The discriminator is mutual exclusivity: each phrase must carry a token the other lacks. Containment is specification; divergence is drift. openFDA also truncates `device_name` at ~50 characters, so prefix-tolerant token matching stops "…OPTIMAL POS" reading as a different expansion of "…Optimal Positioning".

## What truncation cost us

The da Vinci 510(k) search returns **115 matches**. The default page holds 25, in an order openFDA does not specify, and **the oldest record is not among them**. Reading "earliest clearance" off that page gives 2001-03-02; the true earliest is unknown.

That is why `da-vinci-clearance`'s *date* remains disputed even though its *event type* is settled. Asserting 2001-03-02 from an arbitrary 25 of 115 would have repeated, in miniature, the exact error this whole exercise corrected. Two fixtures resolve it — `openfda-davinci-510k-earliest` (sorted ascending) and `openfda-davinci-2000` (any da Vinci decision in calendar 2000) — and until they are recorded the golden set says the date is open.

## The PMA question: resolved

Both controls returned 200 — `openfda-pma-smoke` shows 56,853 records — so the PMA query path is proven and the 404s are genuine absences.

| | PMA | 510(k) | Verdict |
|---|---|---|---|
| **da Vinci** | absent | 115 records | **cleared, never approved** |
| **ROBODOC** | absent | 2 records (complete) | **cleared, never approved** |

Spec §8 lists both as `regulatory_approval`. They are not. **The golden set built to catch the clearance-vs-approval error contained that error twice.** Both rows are corrected to `regulatory_clearance` and anchored: ROBODOC to K072629 (2008-08-06, definitive — 2 of 2 records) and da Vinci to K002489.

Two consequences worth stating:

- **K002489 is a genuine cross-year record**: received 2000-08-10, decided 2001-03-02. That is the mechanism the falsified AESOP hypothesis predicted — it exists in the data, just not where it was looked for. It is the likeliest origin of a "2000" in secondary sources, though August is still not the July §8 states, so the date stays disputed rather than explained away.
- **The negative case now returns `refuted`, not `contested`.** §8 asked for contested on the assumption ROBODOC held a real PMA that sources confused with AESOP's clearance. There is no PMA. Refuted is strictly more severe in the §6.5 ordering, so the spec's real bar — must not come back corroborated — is exceeded. Its conflation note was rewritten too: the error is not one device's approval mistaken for another's clearance, but the phrase "FDA-approved" applied across the field to devices that were *cleared*.

## Wikipedia: ROBODOC has no article

`Robodoc` returns HTTP 200 — as a **disambiguation page**. The adapter yielding zero records is correct behaviour, not a failure: an article describing no single subject attests to nothing. Rather than guess a third casing, the search endpoint was recorded and asked; it resolves to "Robotic surgery". The device has no article of its own, which is itself a finding about tertiary coverage. `check_registry` now falls back to search automatically and returns candidate titles.

## Fixtures

All fixtures are recorded and the suite runs green with no skips. To re-record from a network-capable machine:

```sh
npm run build
npm run record-fixtures          # --list to see what it records, --force to re-record
```

Two remain unrecorded by design, because they were added to resolve the da Vinci date: `openfda-davinci-510k-earliest` and `openfda-davinci-2000`.

The recorder distinguishes three outcomes, because they license different conclusions:

| Outcome | Meaning |
|---|---|
| `recorded` | A result was captured. |
| `REFUSED` | The service answered **429 / 408 / 5xx** — a rate limit or an outage. It says nothing about the query, so it is **never written as a fixture**. |
| `HTTPFAIL` | The service answered with some other non-2xx this fixture did not opt into. That *is* a real answer about the query. |
| `UNREACHED` | The request never got there — DNS, TLS, refused connection. **Nothing was learned**, and an unreached fixture must never be read as an absence. |

`REFUSED` exists because a GDELT 429 was once written to disk as a recording. A fixture whose content is a rate-limit page still *looks* like a recording, and a replay test against it validates the parser against that error page and passes — reporting success while proving nothing. Some error responses genuinely are data (openFDA's 404 means "no matches", PatentsView's 401 means "you need a key") and those still opt in via `allowError`; refusals never do, regardless.

`test/fixtures.test.js` guards what is already committed: it fails on any fixture whose recorded status is a refusal, checks each body against its recorded SHA-256, and rejects an HTML fixture containing rate-limit text behind a 200.

**What gets recorded is the raw upstream response**, byte for byte: `response.text()` written straight to disk, with no re-serialization, no pretty-printing, and no added trailing newline. The recorder imports only URL builders, the rate limiter, and the credential headers — never a `parse*` or `to*` function. That constraint is not a convention but a correctness requirement: a fixture that had passed through a parser would test that parser against its own output and pass regardless of how wrong the field mapping was. `test/recorder.test.js` enforces it statically.

Each recording is paired with a `.meta.json` carrying the request URL, HTTP status, content type, byte count, and a SHA-256 of the recorded bytes, so a hand-edited fixture is detectable. No request headers are stored — otherwise the PatentsView recording would carry an API key into the repository. Files take the extension of their payload, so arXiv's Atom feed is `.xml` rather than `.json`. Error responses are recorded too where a fixture opts in: an openFDA 404 `NOT_FOUND` body and whatever PatentsView says about credentials are both evidence the adapters must handle.

## Unverified assumptions

Claims this codebase makes that have **not** been checked against reality, collected here rather than left implicit in comments:

| Assumption | Status | How to settle it |
|---|---|---|
| arXiv, PubMed, Crossref, openFDA 510(k) field mappings | **Validated** against recorded fixtures | done |
| openFDA PMA field mapping | **Validated** — `openfda-pma-smoke` returned 56,853 records | done |
| Wikipedia field mapping | **Validated** against recorded fixtures | done |
| PatentsView field mapping | Unvalidated — the host was never reached | re-record `patentsview-surgical-robot` |
| **GDELT field mapping** | **Unvalidated — zero usable recordings.** One attempt returned 429, the other timed out. Not tested; treat both `find_incumbents`' news channel and half of `check_abandonment` as unverified. | retry `gdelt-surgical-robotics` |
| Hacker News field mapping | Unvalidated — written from published docs | record `hackernews-*` |
| The YC RFS page structure | Unvalidated, and the most fragile extractor here | record `yc-rfs`, then pin |
| PatentsView requires an `X-Api-Key` | **Unknown.** Legacy `api.patentsview.org` was open; the current Search API documents the header | Handled at runtime — see below |
| openFDA date formats (`YYYYMMDD` vs `YYYY-MM-DD`) | Both accepted defensively | `openfda-aesop-510k` fixture |
| AESOP's 510(k) dates | **Confirmed** against K931783: received 1993-04-09, decision 1993-11-22 | done |
| K963126's dates | **Confirmed** — received 1996, decided 1997 | done |
| da Vinci / ROBODOC event types | **Resolved** — both cleared, never approved | done |
| da Vinci's clearance date | **Disputed** — result set truncated at 25 of 115, unsorted | `openfda-davinci-510k-earliest` |

## The AESOP cross-year hypothesis was falsified

The earlier working hypothesis was that AESOP's disputed 1993/1994 clearance date came from openFDA's own record — FDA receiving a submission one year and deciding the next, with secondary sources citing whichever date they saw. If true, a *single* primary record would contain both modes, and the §6.6 conflation discriminator could have fired on one record instead of requiring ≥2 sources per mode.

**It is false.** K931783 was received 1993-04-09 and decided 1993-11-22 — both within 1993. There is no year boundary in that record to explain anything, and **the single-record check was not added**. It would have fired on ordinary FDA processing time across most of the openFDA database.

Three consequences, all now in the golden set:

1. **AESOP's clearance is `corroborated` at `1993-11-22`, day precision**, anchored to K931783. This *deviates from spec §8*, which predicts `contested (date bimodal)`. The deviation is declared in `deviations_from_spec` inside the golden file rather than applied quietly. The spec encoded the secondary-source confusion, which is real; the primary record outranks it, which is exactly what §6.1 "registry first" is for.
2. **The 1994 variant became a `refuted` case** rather than a second mode — actively contradicted by the record, not merely unsupported. It is the only golden entry exercising `refuted`, the most severe status.
3. **K963126 is reserved as the cross-year control** in `future_cases`: received 1996, decided 1997, a record whose dates genuinely do straddle a year. The verifier must report the decision date *without* flagging conflation, because two dates on one record are one event's lifecycle. It is promoted to an asserted entry once its fixture is recorded.

Both openFDA dates remain preserved separately on `OpenFdaDeviceRecord`, which is what made the hypothesis testable in the first place.

## Claim identity: the registry anchor

`Claim` carries optional `registry_id` and `registry`. Once resolved, that pair — not the entity name and date — identifies the claim:

```
anchored:    sha256("anchor|<registry>:<record_id>|<event_type>")   date excluded
unanchored:  sha256("claim|<entity>|<event_type>|<date>")           the §4 rule
```

The §4 rule is right for a claim as it arrives, when a sentence from a secondary source is all you have. It is wrong once a primary record has been found, and AESOP is why: under the §4 rule, "cleared in 1993" and "cleared in 1994" are two different claims with two different ids, and nothing in the data model says they concern the same event — so a timeline can render both and be internally consistent while showing one clearance twice.

Anchoring collapses them into one claim with a disputed date, which is where §6.2 can act on it. The date is deliberately excluded from the anchored hash; including it would reintroduce the split the anchor exists to prevent. `registry` is required alongside `registry_id` because `"K931783"` is only meaningful as an openFDA identifier, and a bare string would let a patent number and a DOI collide.

## Registry lookups return every match

No adapter picks a best match. A device family often has several clearances, and silently returning the first produces exactly the false certainty the verifier exists to detect, while hiding the siblings that would have shown the caller there was a choice to make. Choosing among candidates is a judgement about which record a claim refers to, and per §2 that judgement belongs to Claude, with all the candidates in front of it.

Every registry lookup is therefore plural, including the ones that can only ever return zero or one (`lookupDoi`, `lookupPage`) — a caller who has to remember which registries return one and which return many will eventually take `[0]` from the wrong one. Exact-identifier lookups (`clearanceByNumberUrl`, `approvalByNumberUrl`) are kept separate from fuzzy name searches, so resolving a `registry_id` never falls back to device-name matching.

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

## Gap analysis

Three tools beyond the spec, for answering "has anyone already built this?" rather than "what happened when".

### `find_incumbents(idea_terms, control_terms)`

An occupancy sweep across **literature, patents, companies, consortia, regulators and news**.

`control_terms` is **required**, and that is the entire design. A zero is what this tool exists to produce and also its central hazard: "no incumbents found" and "the sweep didn't work" render identically, and the first is a green light while the second is nothing at all. So the caller names a category they already know is occupied, it runs through the **same channels via the same code path**, and where the control comes back empty that channel is broken — making the idea's zero there meaningless.

Control verdicts are **per channel**, because failures are rarely global: a missing PatentsView key takes out patents while news keeps working. The output leads with a `flag` giving one of four readable verdicts — `OCCUPIED`, `APPARENTLY UNOCCUPIED`, `PARTIAL`, or `NOT INTERPRETABLE`. Occupancy stands even when a control fails, since a broken channel returns nothing rather than inventing results.

Channels that are structurally weak say so rather than being silently dropped: Hacker News over-indexes English-language software startups, Wikipedia only covers notable consortia, and openFDA is US medical devices only — for a non-medical idea that channel is *inapplicable*, which the control demonstrates by failing.

### `check_abandonment(entity_terms)`

Searches news and Hacker News for **pivots, shutdowns, acquisitions, deprecations and wind-downs**, returning stated reasons where a source gives one.

This is the signal no registry records. An empty gap and a graveyard look identical from an occupancy sweep and mean opposite things — nobody has tried, versus several tried and failed for reasons that will apply to you too.

**Reasons are extracted, never summarized.** Where a source sentence contains a causal connective ("because", "citing", "due to", "after failing to"), that sentence is returned verbatim. A sentence without one is the event, not its cause, so returning it would invent an attribution the source never made. Classification records the word that triggered it, so "classified as a pivot" is auditable.

Absence here is flagged as a **weak** negative: launches get announced and failures do not, and the smaller the company the quieter the ending.

### `fetch_yc_rfs()`

Fetches and parses [YC's Requests for Startups](https://www.ycombinator.com/rfs), cached 7 days.

Two policies follow from the RFS turning over every few months:

- **Stale is worse than none**, so this deliberately departs from §7's serve-stale-when-offline rule. Under 7 days it is served normally; from 7 to 90 days it is served with `stale: true`, an age, and a warning that it must not be presented as current; past 90 days — more than one batch cycle — it is **not served at all**.
- **A parse failure is an error, never an empty list.** YC is never asking for nothing, so zero requests means the extractor broke, not that the page is empty. Extraction prefers the page's own structured data island over reading rendered markup, with a heading fallback that discards page furniture.

### Pinning the RFS extractor

Once `yc-rfs` is recorded, pin the extraction as a regression baseline:

```sh
npm run pin-yc-rfs -- --write   # prints every title, writes test/golden/yc-rfs-expected.json
```

The script prints the extraction **method** (`next-data` or `headings`) and the **region scanned**, so one run answers whether the page has a usable structured data island. It refuses to pin a list containing a glyph, page chrome, or a batch label.

Then **read the printed titles against the live page** and set `"reviewed": true`. The test refuses an unreviewed baseline, because the baseline is generated by running the parser over the fixture and so cannot establish that the parser is *right* — a wrong extractor would pin its own wrong output and pass forever. The human check is what establishes correctness.

What the reviewed baseline does establish is that the extractor has not **drifted**: it pins the request count and every verbatim title in order, so a change that starts returning navigation text, half the requests, or a plausible-looking list from the wrong part of the page fails loudly instead of passing with different content. That is the failure mode a parser over unversioned HTML actually has.

#### Three defects the first recording caught

The first real recording extracted 19 items from the Fall 2026 page, and all three failures were invisible to any test written against a reconstruction of the page:

| Defect | Fix |
|---|---|
| The batch label "Fall 2026" was item 1 | Batch labels are matched and excluded; the batch is returned separately |
| Items 15–19 were footer and nav ("Footer", "Programs", "Resources", "Company", "Make something people want.") | Extraction is **scoped to the content container** (`<main>`, else `<article>`, else chrome elements stripped) — footer headings are structurally identical to request headings, so position excludes them where no keyword filter reliably could |
| Every genuine title carried a trailing `" #"` from the heading permalink | In-page anchor elements are removed, then glyphs trimmed from both ends — not globally, so a genuine `C#` in a title survives |

This is the argument for recording fixtures rather than reasoning about page structure, in one example.

### No LinkedIn adapter

No API exposes the data, the terms of service prohibit scraping it, and the anti-bot measures make any scraper unreliable. That last point is the disqualifying one here specifically: a channel that fails *intermittently* is worse than one that does not exist, because `find_incumbents`' control can only catch a channel that fails consistently.

## Packaging

```sh
npm run bundle        # -> build/frontier.mcpb
```

The bundle stages a clean tree rather than packing the working directory: manifest, compiled `dist/`, a `package.json` trimmed to production dependencies, and the production dependency closure read from `npm ls --omit=dev` — so it stays correct as dependencies change instead of being an ignore list that rots. Packing the repo directly ships TypeScript (18 MB) and the fixtures: **31 MB unpacked, versus 10.5 MB staged (3.3 MB packed).**

`npm run bundle` verifies the staged tree **before packing**: it resolves every bare import in the compiled output against the staged `node_modules`, then starts the server and waits for it to speak stdio. A bundle that cannot start fails the build with the process's own stderr in front of you, rather than three steps later as an MCP client reporting `-32000 connection closed` — which says only that the child died, never why.

Nine tests verify the archive, running the server from the **extracted bundle** rather than the repo — the only way to catch a missing dependency, since the repo has every devDependency installed alongside. One starts the entry point directly and asserts on its captured stderr, so diagnosing a startup failure never requires the shell. Another drives a real JSON-RPC handshake and then asserts the process is **still alive** — and still answering after idling — because "it started" is not the property a client depends on, and the regression that prompted these tests started perfectly well before exiting. They skip with instructions when `build/frontier.mcpb` is absent.

### The entry point has no direct-run guard, deliberately

`src/index.ts` is a library and `src/main.ts` is the executable. That split exists because the guard it replaced failed twice, the same way both times:

```js
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1]).href;
```

- **Windows:** `process.argv[1]` is a backslash drive path that never equals a `file://` URL.
- **Symlinked launcher:** `process.argv[1]` is the link, `import.meta.url` is the **realpath**. Reproducible with `ln -s dist/index.js entry.js && node entry.js`.

Both produce the same symptom, and it is the hardest kind to read: **exit code 0, empty stderr, no crash, no missing dependency.** The module loads, runs nothing, and the process drains. A client reports only "connection closed"; a log shows nothing at all.

Fixing the comparison a second time would leave a third variant waiting — case-folding filesystems, UNC paths, percent-encoding in an install directory. So the guard is gone rather than repaired: an executable that is only ever an executable never needs to ask whether it is one. Three tests keep it that way, including one that launches through a symlink.

### What still needs a real client

The sandbox has no desktop and no network, so these are unverified:

| | Why it needs your machine |
|---|---|
| **Installing the `.mcpb`** | §10.10's "install locally from the file". Everything up to the install is tested; the install itself is not. |
| **`${user_config.home}` substitution** | The client substitutes this into `FRONTIER_HOME`. If left blank it may arrive as an empty string or be omitted — `paths.ts` treats both as "use the default", but that path has never run under a real client. |
| **Windows and macOS** | `compatibility.platforms` claims all three and the tree has no native modules, but only Linux has run. `${__dirname}` substitution is client-side. |
| **The client's Node runtime** | The manifest requires `>=18`. Claude Desktop bundles its own. |
| **Every network-bound tool** | `search_literature`, `check_registry`, `verify_claim`, `disconfirm_superlative` are tested against recorded fixtures and stubs only. No tool in this repo has ever made a live call except the fixture recorder. |
| **PatentsView credentials** | Still unverified — the host was never reached. |

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
  main.ts               the executable — no is-this-the-main-module guard
  index.ts              library: createServer() and tool registration
  types.ts              the data contract (spec §4)
  registry.ts           registry -> EventType mapping, one typed function each
  claim.ts              claim identity and the registry anchor
  credentials.ts        optional API keys, graceful degradation
  http.ts               the single outbound HTTP path
  dates.ts              partial-date normalization with explicit precision
  search.ts             search_literature: adaptive window, dedup
  cluster.ts            TF-IDF clustering, no model download
  occupancy.ts          find_incumbents: controlled occupancy sweep
  abandonment.ts        check_abandonment: pivots, shutdowns, stated reasons
  registries.ts         check_registry: all four registries, truncation reporting
  verify/
    verify.ts           §6 orchestration: fields verified independently
    independence.ts     §6.4 scoring
    superlative.ts      §6.3 adversarial disconfirmation
    conflation.ts       §6.6 distributional detection
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
    gdelt.ts  hackernews.ts  ycombinator.ts
test/
  smoke.test.js         handshake, tool listing, tool calls
  cache.test.js         TTLs, staleness, key normalization, atomicity
  snapshot.test.js      integrity, tampering, the contrast with cache reads
  ratelimit.test.js     token buckets, FIFO fairness, per-host isolation
  registry.test.js      clearance vs approval, and the rest of the mapping
  credentials.test.js   degradation when a key is missing or refused
  dates.test.js         partial dates, precision, source-specific formats
  sources.test.js       adapter logic, plus fixture replay
  search.test.js        adaptive window, context anchoring, dedup, failures
  registries.test.js    truncation, both openFDA databases, degradation
  verify.test.js        independence, superlatives, the §10.6 gate, determinism
  conflation.test.js    entity/alias/date/event-type detection and its negatives
  cluster.test.js       unnamed clusters, cold fields, determinism
  gapanalysis.test.js   control interpretability, reason extraction, RFS staleness
  fixtures.test.js      guards recordings: no refusals, digests match, no error pages
  golden.test.js        golden-set shape, incl. date_precision on every entry
  recorder.test.js      guards the recorder's raw-capture invariant
  fixtures/             recorded API responses (raw bytes + .meta.json)
  golden/               hand-written expected answers
```

## The golden set

`test/golden/surgical_robotics.json` holds the §8 expected answers: seven positive rows plus the required ROBODOC negative. Every entry states `date_precision` explicitly, on both the input claim and the expected verification, and `test/golden.test.js` checks that each declared precision matches the granularity of its own date string — cross-checked against the same `normalizeDate` the pipeline uses, so the fixture and the implementation cannot drift apart.

Precision is tracked this strictly because it is itself a claim. A verifier that pads `1985` to `1985-01-01` manufactures a disagreement no source expressed; one that coarsens da Vinci's `2000-07` to `2000` discards information the sources do carry. `da-vinci-pma-approval` is the only month-precision row, and it exists partly as the case that would pass silently if precision were ignored. A separate test asserts expected precision is never *finer* than the claim's — coarsening is legitimate when sources disagree, sharpening is invention.

The verifier does not exist yet (§10.6), so these tests lock the contract rather than exercise it. They also encode the relationships the spec calls load-bearing: the 1993 and 1994 AESOP claims derive the *same* claim id because they cite the same record (§6.2 — one event, disputed date), the two STAR entries must not corroborate each other despite the shared acronym (§6.6), and the negative case must return `contested` with AESOP as a competing clearance-not-approval claimant. The AESOP date finding did not weaken that last one: the conflation there is on event type, which the registry settles independently of any date.

The file has four sections — `entries` (the seven §8 positives), `refuted`, `negative` (required), and `future_cases` (reserved, explicitly `not_yet_asserted` with a `blocked_on` note, so unverified values can be recorded without masquerading as assertions).

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
