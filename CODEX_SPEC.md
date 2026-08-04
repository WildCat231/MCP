# Frontier — MCP server specification

You are building an MCP server called `frontier`. Read this entire document before writing any code. Build it in the phase order given at the end. Do not skip ahead.

---

## 1. What this is

A local MCP server that lets Claude build **verified historical timelines** of any technical field and track that field's research frontier over time.

The user asks Claude about a field ("surgical robotics", "solid-state batteries"). Claude decomposes the field into components, proposes historical milestone claims, and calls this server to **verify each claim against real sources** and to **retrieve current research**. Claude then renders a timeline.

---

## 2. The one architectural rule

**This server makes zero LLM calls. Ever.**

There is no API key, no model client, no inference dependency anywhere in this codebase. Claude is already the reasoning layer — it is the thing calling these tools. The server does only:

- HTTP requests to public APIs
- Parsing, normalization, deduplication
- Caching to SQLite
- Deterministic scoring and clustering arithmetic

If you find yourself wanting to "ask a model" to decide something, that decision belongs in Claude's context, not in this server. Return the structured evidence and let Claude judge. Any PR that adds an LLM dependency is wrong.

---

## 3. Technical constraints

- **Node.js + TypeScript.** Not Python. Claude Desktop bundles a Node runtime, so a Node server installs with zero prerequisites; a Python server requires the user to install Python. This constraint is about distribution, and it is non-negotiable.
- **Transport:** stdio. Use `@modelcontextprotocol/sdk`.
- **Storage:** SQLite via `better-sqlite3`. Single file at `~/.frontier/frontier.db`.
- **Dependencies:** keep minimal. SDK, better-sqlite3, a fetch polyfill if needed, `fast-xml-parser` for arXiv Atom. Nothing else without justification.
- **Packaging:** the repo must build to an `.mcpb` bundle. Include a valid `manifest.json` from the start, not as an afterthought.
- **No network calls at import time.** Server must start offline and fail gracefully per-tool.

---

## 4. Data model

These schemas are the contract. Every tool input and output conforms to them. Define them once in `src/types.ts` and import everywhere.

### Claim

The atomic unit. **A claim is never verified as a whole — each field is verified independently.**

```ts
type EventType =
  | "first_clinical_use"
  | "regulatory_clearance"    // e.g. FDA 510(k)
  | "regulatory_approval"     // e.g. FDA PMA — NOT the same as clearance
  | "publication"
  | "commercial_launch"
  | "patent_grant"
  | "company_founded"
  | "standard_published"
  | "other";

interface Claim {
  id: string;                 // sha256 of normalized entity+event_type+date
  entity: string;             // "AESOP"
  entity_aliases?: string[];  // ["Automated Endoscopic System for Optimal Positioning"]
  event_type: EventType;
  date: string;               // ISO 8601, may be partial: "1993" | "1993-11" | "1993-11-04"
  date_precision: "year" | "month" | "day";
  superlative?: string | null;// "first FDA-cleared surgical robot" — null if none
  description: string;        // one sentence, no superlatives
  component?: string;         // which decomposed component this belongs to
}
```

`regulatory_clearance` and `regulatory_approval` being distinct types is deliberate and load-bearing. The canonical test case for this whole system is that ROBODOC (first clinical use 1992, PMA approval 2008) and AESOP (510(k) clearance 1993/1994) get conflated by nearly every secondary source into competing "first FDA-approved surgical robot" claims. A system that cannot represent that distinction cannot detect that error.

### Source

```ts
interface Source {
  url: string;
  title: string;
  publisher?: string;
  tier: "primary" | "secondary" | "tertiary";
  // primary   = the record itself (FDA device DB, patent office, the paper's DOI)
  // secondary = peer-reviewed literature discussing the event
  // tertiary  = encyclopedias, news, blogs, vendor pages
  retrieved_at: string;       // ISO timestamp
  supports: {
    field: "entity" | "event_type" | "date" | "superlative";
    value: string;            // the value THIS source attests to
  }[];
  locator?: string;           // section/page hint, NOT a long verbatim excerpt
}
```

Store locators and URLs, not extended verbatim text. Cache short snippets only (under 200 chars) for debugging.

### FieldVerification and VerificationResult

```ts
type Status =
  | "corroborated"   // >=2 independent sources agree, >=1 primary or peer-reviewed
  | "single_source"  // 1 source, nothing contradicting
  | "contested"      // sources disagree
  | "unverified"     // nothing found
  | "refuted";       // sources actively contradict the claim

interface FieldVerification {
  status: Status;
  attested_values: { value: string; source_count: number; max_tier: string }[];
  sources: Source[];
  independence_score: number; // 0-1, see §6.4
}

interface VerificationResult {
  claim_id: string;
  fields: {
    entity: FieldVerification;
    event_type: FieldVerification;
    date: FieldVerification;
    superlative?: FieldVerification;
  };
  overall: Status;            // worst non-unverified field status, see §6.5
  conflation: {
    suspected: boolean;
    evidence?: {
      field: string;
      modes: { value: string; source_count: number }[];
      reason: string;
    };
  };
  retrieved_at: string;
  cache_hit: boolean;
}
```

### Snapshot

```ts
interface Snapshot {
  id: string;                 // content hash of the full payload
  query: string;
  created_at: string;
  tool_version: string;
  components: Component[];
  claims: Claim[];
  verifications: VerificationResult[];
  frontier: FrontierCluster[];
}
```

Snapshots exist for reproducibility. The tool is reproducible; its **output is not**, because search results and the literature both move. A dated, content-hashed, frozen snapshot is the citable artifact. Treat snapshot integrity as a first-class requirement, not a nice-to-have.

---

## 5. Tools exposed over MCP

Each tool is a thin, deterministic function. Names, inputs, and outputs as follows.

### `search_literature`
```
input:  { terms: string[], sources?: ("arxiv"|"pubmed"|"crossref")[],
          from?: string, to?: string, max_per_source?: number }
output: { results: Paper[], window_used: {from,to}, counts_by_source: {} }
```
Queries arXiv (Atom API), PubMed E-utilities, and Crossref. All three are free and keyless. Deduplicate by DOI, then by normalized title.

**Adaptive window.** If `from`/`to` are omitted, start at 6 months and widen (12, 24, 60 months) until `max_per_source` results or the ceiling is hit. Always return `window_used` so the caller knows whether it is seeing a firehose or a trickle. A fixed window fails fast-moving and slow-moving fields in opposite directions.

**Context anchoring.** Never search a bare component name. Callers pass multi-term arrays; join them so that "transformer" in an ML context cannot return power-engineering results. If a caller passes a single generic term, return a warning field in the response.

### `check_registry`
```
input:  { registry: "openfda_device"|"crossref"|"wikipedia"|"patentsview",
          query: string, filters?: object }
output: { records: RegistryRecord[], registry_url: string }
```
Primary-source lookup. **Always try this before `verify_claim` falls back to general literature search.** For any regulatory claim, openFDA settles clearance-vs-approval definitively because 510(k) and PMA are separate database records with separate dates. All four registries are free and keyless.

### `verify_claim`
```
input:  { claim: Claim, depth?: "fast"|"thorough" }
output: VerificationResult
```
The core tool. Full algorithm in §6.

### `disconfirm_superlative`
```
input:  { claim: Claim }
output: { competing_claimants: {entity,date,event_type,sources}[], verdict: Status }
```
A source saying "X was first" does not rule out Y. Superlatives are unverifiable by confirmation and require an actively adversarial search: query for the superlative *category* rather than the entity, and collect every entity that any source names as the holder. Called automatically by `verify_claim` when `claim.superlative` is non-null.

### `cluster_frontier`
```
input:  { papers: Paper[], component: string }
output: { clusters: FrontierCluster[] }
```
Group recent papers by shared title/abstract terms using TF-IDF cosine similarity and agglomerative clustering. **Return clusters with representative papers and top terms — do not attempt to name or summarize them.** Naming is Claude's job. This keeps the server free of both LLM calls and local ML model downloads.

### `save_snapshot` / `load_snapshot` / `list_snapshots`
```
save:  { snapshot: Omit<Snapshot,"id"|"created_at"> } -> { id, path }
load:  { id: string } -> Snapshot
list:  { query?: string } -> { snapshots: {id,query,created_at}[] }
```
Content-address by hashing the canonical JSON. Write to `~/.frontier/snapshots/{id}.json`.

### `cache_status` / `clear_cache`
Diagnostics. Report entry counts, age distribution, and hit rate by tool.

---

## 6. The verification algorithm

This is the part that determines whether the product is a research tool or a machine for generating confident-looking fiction. Implement it exactly.

### 6.1 Registry first
If `event_type` is regulatory, query openFDA before anything else. If it is `publication`, query Crossref by DOI or title. A primary-source hit short-circuits most of the ambiguity below. Only fall through to literature and general search when the registry returns nothing.

### 6.2 Verify fields independently
Run separate evidence-gathering for entity, event_type, and date. A source that mentions the entity does **not** thereby confirm the date; record what each source actually attests to in `Source.supports`. This is what catches the case where the entity is real, the date is real, and the event type is wrong — the single most common failure and the one whole-claim verification cannot see.

### 6.3 Superlative handling
If `claim.superlative` is set, call `disconfirm_superlative`. If any competing claimant surfaces with sources, the superlative field is `contested`, full stop — even if the original claim has more supporting sources. Do not resolve it. Return both and let Claude present the disagreement.

### 6.4 Independence scoring
Three sources agreeing means nothing if all three paraphrase the same review article. Compute `independence_score` from:
- distinct registrable domains (higher is better)
- tier diversity (a primary + a secondary beats two tertiaries)
- shared-citation detection: if Crossref shows sources citing a common ancestor, discount
Corroboration requires `independence_score >= 0.5` AND at least one primary or peer-reviewed source. Two tertiary blog posts do not corroborate anything.

### 6.5 Overall status
`overall` = the most severe status across fields, with severity ordered:
`refuted > contested > unverified > single_source > corroborated`.
**Never drop a node for failing verification.** Flag it. An unverified node rendered as unverified is useful information; a silently omitted node is a lie of omission.

### 6.6 Conflation detection
Do not attempt this semantically. Use the distributional signal:

> Collect all attested values for a field. Cluster them. **Noise scatters; conflation clusters.** Flag `conflation.suspected = true` when there are ≥2 modes, each supported by ≥2 sources, with low within-mode variance and a gap between modes exceeding the field's tolerance (for dates: 3 years).

Bimodal-with-tight-modes means two real events have been merged under one label. Wide scatter means ordinary source noise. This single heuristic catches both canonical failures — the ROBODOC/AESOP regulatory conflation, and the STAR acronym drift where "Smart Tissue *Anastomosis* Robot" (2014) and "Smart Tissue *Autonomous* Robot" (2022) are materially different systems whose sources appear to corroborate each other across a decade.

Also flag when `entity_aliases` expand to materially different phrases across sources — that is entity drift and produces false corroboration.

Return the evidence. **Do not ask the clarifying question yourself** — return the modes and let Claude decide whether to ask, since only Claude knows whether the ambiguity affects the rest of the timeline.

---

## 7. Rate limiting, caching, resilience

- **Token-bucket limiter per host.** arXiv requires ≥3s between requests. Respect it or get IP-banned mid-development. PubMed allows 3/sec keyless.
- **Cache everything, keyed on the normalized request.** Registry lookups: 30-day TTL. Literature searches: 24-hour TTL. Verification results: 7-day TTL, and always return `cache_hit` so callers know.
- **Every tool degrades gracefully.** Zero results, timeouts, and malformed responses return a structured empty result with an `error` field. Never throw across the MCP boundary. Never return an empty section that looks like "nothing is happening in this field" when it actually means "the API timed out."
- **Offline mode:** if all network calls fail, serve from cache and mark results `stale: true`.

---

## 8. Testing — required, not optional

Every module gets a `--test` flag that runs it against committed fixtures in `test/fixtures/`. Record real API responses once, commit them, replay them in tests. Tests must pass with the network disabled.

### Golden set (`test/golden/surgical_robotics.json`)
Hand-written expected answers. The pipeline is broken if it misses these:

| Entity | Event | Date | Expected status |
|---|---|---|---|
| PUMA 560 | first_clinical_use (neurosurgical biopsy) | 1985 | corroborated |
| ROBODOC | first_clinical_use | 1992 | corroborated |
| AESOP | regulatory_clearance (510k) | 1993–1994 | contested (date bimodal) |
| ROBODOC | regulatory_approval (PMA) | 2008 | corroborated |
| da Vinci | regulatory_approval | 2000-07 | corroborated |
| STAR | publication (supervised autonomous anastomosis, Sci Transl Med) | 2016 | corroborated |
| STAR | publication (autonomous laparoscopic anastomosis, Sci Robotics) | 2022 | corroborated |

Plus a required negative: the claim `{entity: "ROBODOC", event_type: "regulatory_approval", date: "1992", superlative: "first FDA-approved surgical robot"}` **must** return `contested` with AESOP as a competing claimant and `conflation.suspected = true`. If it returns `corroborated`, verification is not working and no other feature matters.

### Other required tests
- **Hallucination audit script:** sample N verified claims, HEAD-request every citation URL, report dead/redirected rates. Target under 5% dead.
- **Determinism:** run the same verification 3× against fixtures; results must be byte-identical.
- **Cold field:** run against a sparse domain (railway signalling). Frontier section must honestly report low activity, not fabricate significance.
- **Adversarial inputs:** ambiguous entity ("Mercury"), over-broad query ("science"), leaf-level query already too narrow to decompose. Each must degrade gracefully with a structured warning.

---

## 9. Repository layout

```
frontier/
  manifest.json           # MCPB manifest — valid from day one
  package.json
  src/
    index.ts              # MCP server entry, tool registration
    types.ts              # all schemas from §4
    db.ts                 # SQLite init, migrations, cache layer
    ratelimit.ts          # token bucket per host
    sources/
      arxiv.ts  pubmed.ts  crossref.ts
      openfda.ts  wikipedia.ts  patentsview.ts
    verify/
      verify.ts           # §6 orchestration
      independence.ts     # §6.4
      conflation.ts       # §6.6
      superlative.ts      # §6.3
    cluster.ts            # TF-IDF, no ML model download
    snapshot.ts
  test/
    fixtures/  golden/
```

---

## 10. Build order

Build and verify each phase before starting the next. Report what you built and what the tests show at each boundary.

1. **Skeleton.** MCP server that starts, registers one no-op tool, and connects over stdio. Valid `manifest.json`. Confirm it appears in a client. Nothing else.
2. **Storage + rate limiting.** SQLite schema, cache layer with TTLs, token-bucket limiter. Tests with fake clock.
3. **Source adapters.** One file per API, each a pure function returning normalized records. Record fixtures. Tests offline.
4. **`search_literature`** including adaptive window and context-anchoring warning.
5. **`check_registry`** across all four registries. This must work before verification, since verification depends on primary sources.
6. **`verify_claim`** — fields first (§6.2), then independence (§6.4), then superlatives (§6.3). Run the golden set. Do not proceed until the ROBODOC negative case returns `contested`.
7. **Conflation detection** (§6.6). Re-run golden set; the AESOP date must come back bimodal.
8. **`cluster_frontier`** — TF-IDF only.
9. **Snapshots** with content-addressing and integrity checks.
10. **Package as `.mcpb`.** Install locally from the file and confirm every tool is reachable.

---

## 11. Standing instructions

- Write the type definitions before the implementation for each module.
- No dependency beyond §3 without stating why.
- Prefer returning structured evidence over returning conclusions. When in doubt about whether the server or Claude should decide something, it is Claude.
- Comment the *why* on every non-obvious threshold (the 3-year conflation gap, the 0.5 independence floor). Future-you will want to tune these and needs to know what they were for.
- After each phase, stop and report: what you built, what the tests show, what you had to decide that this spec did not cover.
