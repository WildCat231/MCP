/**
 * frontier — the data contract.
 *
 * Every tool input and output in this server conforms to the schemas below.
 * They are defined here once and imported everywhere; nothing downstream
 * re-declares a variant of a shape that lives in this file.
 *
 * Spec reference: CODEX_SPEC.md §4.
 */

// ---------------------------------------------------------------------------
// Claim — the atomic unit
// ---------------------------------------------------------------------------

export type EventType =
  | 'first_clinical_use'
  | 'regulatory_clearance' // e.g. FDA 510(k)
  | 'regulatory_approval' // e.g. FDA PMA — NOT the same as clearance
  | 'publication'
  | 'commercial_launch'
  | 'patent_grant'
  | 'company_founded'
  | 'standard_published'
  | 'other';

/**
 * `regulatory_clearance` and `regulatory_approval` are deliberately distinct.
 * ROBODOC (first clinical use 1992, PMA approval 2008) and AESOP (510(k)
 * clearance 1993/1994) are conflated by nearly every secondary source into
 * competing "first FDA-approved surgical robot" claims. A type system that
 * cannot represent the distinction cannot detect the error, so this union is
 * load-bearing rather than cosmetic.
 */
export const EVENT_TYPES: readonly EventType[] = [
  'first_clinical_use',
  'regulatory_clearance',
  'regulatory_approval',
  'publication',
  'commercial_launch',
  'patent_grant',
  'company_founded',
  'standard_published',
  'other',
] as const;

/** How much of an ISO 8601 date string is actually attested. */
export type DatePrecision = 'year' | 'month' | 'day';

export interface Claim {
  /** sha256 of normalized entity + event_type + date. */
  id: string;
  /** e.g. "AESOP". */
  entity: string;
  /** e.g. ["Automated Endoscopic System for Optimal Positioning"]. */
  entity_aliases?: string[];
  event_type: EventType;
  /** ISO 8601, may be partial: "1993" | "1993-11" | "1993-11-04". */
  date: string;
  date_precision: DatePrecision;
  /** e.g. "first FDA-cleared surgical robot" — null if the claim makes none. */
  superlative?: string | null;
  /** One sentence, no superlatives. */
  description: string;
  /** Which decomposed component of the field this claim belongs to. */
  component?: string;
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/**
 * primary   = the record itself (FDA device DB, patent office, the paper's DOI)
 * secondary = peer-reviewed literature discussing the event
 * tertiary  = encyclopedias, news, blogs, vendor pages
 */
export type SourceTier = 'primary' | 'secondary' | 'tertiary';

/** The claim fields that a source can independently attest to. */
export type VerifiableField = 'entity' | 'event_type' | 'date' | 'superlative';

export interface Source {
  url: string;
  title: string;
  publisher?: string;
  tier: SourceTier;
  /** ISO timestamp. */
  retrieved_at: string;
  /**
   * What this source actually attests to, field by field. A source that
   * mentions the entity does not thereby confirm the date — recording the
   * attestation per field is what makes §6.2 independent verification
   * possible.
   */
  supports: {
    field: VerifiableField;
    /** The value THIS source attests to. */
    value: string;
  }[];
  /** Section/page hint. NOT a long verbatim excerpt — see §4 on storage. */
  locator?: string;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type Status =
  /** >=2 independent sources agree, >=1 primary or peer-reviewed. */
  | 'corroborated'
  /** 1 source, nothing contradicting. */
  | 'single_source'
  /** Sources disagree. */
  | 'contested'
  /** Nothing found. */
  | 'unverified'
  /** Sources actively contradict the claim. */
  | 'refuted';

/**
 * Severity ordering for §6.5: `overall` is the most severe status across
 * fields. Higher number = more severe. Kept as data rather than a chain of
 * comparisons so the ordering is stated once and testable directly.
 */
export const STATUS_SEVERITY: Record<Status, number> = {
  refuted: 4,
  contested: 3,
  unverified: 2,
  single_source: 1,
  corroborated: 0,
};

export interface AttestedValue {
  value: string;
  source_count: number;
  max_tier: SourceTier;
}

export interface FieldVerification {
  status: Status;
  attested_values: AttestedValue[];
  sources: Source[];
  /** 0-1. See §6.4 — domain diversity, tier diversity, shared-citation discount. */
  independence_score: number;
}

export interface ConflationEvidence {
  field: string;
  modes: { value: string; source_count: number }[];
  /** Why the distribution looks like conflation rather than ordinary noise. */
  reason: string;
}

export interface VerificationResult {
  claim_id: string;
  fields: {
    entity: FieldVerification;
    event_type: FieldVerification;
    date: FieldVerification;
    superlative?: FieldVerification;
  };
  /** Worst non-unverified field status — see §6.5. */
  overall: Status;
  conflation: {
    suspected: boolean;
    evidence?: ConflationEvidence;
  };
  retrieved_at: string;
  cache_hit: boolean;
}

// ---------------------------------------------------------------------------
// Literature and registries
// ---------------------------------------------------------------------------

export type LiteratureSource = 'arxiv' | 'pubmed' | 'crossref';

export const LITERATURE_SOURCES: readonly LiteratureSource[] = ['arxiv', 'pubmed', 'crossref'] as const;

/**
 * A normalized paper record. Every source adapter (§9 `src/sources/`) returns
 * this shape, so deduplication by DOI and then by normalized title can happen
 * without knowing which API a record came from.
 */
export interface Paper {
  /** Stable id: DOI when present, otherwise `${source}:${source_id}`. */
  id: string;
  title: string;
  abstract?: string;
  authors: string[];
  /** ISO 8601, may be partial. */
  published: string;
  doi?: string;
  url: string;
  venue?: string;
  source: LiteratureSource;
  /** The identifier used by the originating API (arXiv id, PMID, Crossref DOI). */
  source_id: string;
}

export type RegistryName = 'openfda_device' | 'crossref' | 'wikipedia' | 'patentsview';

export const REGISTRY_NAMES: readonly RegistryName[] = [
  'openfda_device',
  'crossref',
  'wikipedia',
  'patentsview',
] as const;

/**
 * Registry records are a discriminated union, one member per registry, rather
 * than a shared shape with an open `Record<string, unknown>` payload.
 *
 * The reason is §6.1: the whole point of hitting a registry first is that it
 * settles distinctions secondary sources blur. openFDA settles
 * clearance-vs-approval because 510(k) and PMA are separate records with
 * separate dates. That distinction only survives into the verifier if the type
 * system carries it — an untyped bag pushes the decision to a string lookup at
 * the call site, where a typo degrades silently into "no event type found".
 *
 * Each member is mapped to an `EventType` by its own typed function in
 * `src/registry.ts`. Adding a registry is therefore a compile error until its
 * mapping exists.
 */
interface RegistryRecordBase {
  /** The registry's own identifier — K number, PMA number, DOI, patent number. */
  record_id: string;
  title: string;
  /**
   * ISO 8601, may be partial. The date the registry attests to *for the event*.
   * Which underlying date this is differs per registry and is documented on
   * each member; the raw dates are also kept, because the gap between them is
   * itself evidence (§6.6).
   */
  date?: string;
  date_precision?: DatePrecision;
  url: string;
}

/**
 * FDA premarket submission pathways. These are different legal instruments,
 * not synonyms, and collapsing them is the canonical failure this system
 * exists to catch.
 */
export type OpenFdaSubmissionType = '510k' | 'pma_original' | 'pma_supplement' | 'de_novo' | 'hde';

export interface OpenFdaDeviceRecord extends RegistryRecordBase {
  registry: 'openfda_device';
  submission_type: OpenFdaSubmissionType;
  /** K number for 510(k); P/H/DEN number for the others. */
  submission_number: string;
  applicant?: string;
  device_name?: string;
  product_code?: string;
  /** FDA decision code, e.g. "SESE" (substantially equivalent), "APPR". */
  decision_code?: string;
  /** ISO. The date FDA issued its decision. This is what `date` carries. */
  decision_date?: string;
  /**
   * ISO. The date FDA received the submission — frequently the previous
   * calendar year. Kept because secondary sources routinely cite it as the
   * clearance date, which is one source of the AESOP 1993/1994 split.
   */
  received_date?: string;
}

export type CrossrefWorkType =
  | 'journal-article'
  | 'proceedings-article'
  | 'book-chapter'
  | 'posted-content'
  | 'report'
  | 'dataset'
  | 'other';

export interface CrossrefRecord extends RegistryRecordBase {
  registry: 'crossref';
  doi: string;
  work_type: CrossrefWorkType;
  container_title?: string;
  publisher?: string;
  authors: string[];
  /** ISO. Earliest of issued / published-print / published-online. Carried by `date`. */
  issued_date?: string;
}

export interface PatentsViewRecord extends RegistryRecordBase {
  registry: 'patentsview';
  patent_number: string;
  /** ISO. Date the patent was granted. This is what `date` carries. */
  grant_date?: string;
  /** ISO. Date the application was filed — typically years earlier. */
  filing_date?: string;
  assignees: string[];
  inventors: string[];
  patent_kind?: string;
}

export interface WikipediaRecord extends RegistryRecordBase {
  registry: 'wikipedia';
  page_id: number;
  /** Canonical title after redirect resolution. */
  canonical_title: string;
  /** Lead-section extract, truncated. Short snippet only — see §4 on storage. */
  extract?: string;
  /**
   * ISO. Last revision timestamp. Attests to the *article*, never to the
   * subject, so it never populates `date`.
   */
  revision_date?: string;
}

export type RegistryRecord = OpenFdaDeviceRecord | CrossrefRecord | PatentsViewRecord | WikipediaRecord;

/**
 * What a registry record attests about a claim's `event_type`.
 *
 * `confidence` is not a probability — it records whether the registry itself
 * draws the distinction (`definitive`, e.g. a 510(k) record is a clearance by
 * construction) or whether this server inferred it from a weaker signal
 * (`inferred`). Only `definitive` is allowed to short-circuit §6.1.
 */
export interface EventTypeAttestation {
  event_type: EventType | null;
  confidence: 'definitive' | 'inferred' | 'none';
  /** Why this mapping holds — surfaced in `Source.supports` and in debugging. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Decomposition and frontier
// ---------------------------------------------------------------------------

/**
 * A component of a decomposed field. Claude does the decomposing; this server
 * only stores and echoes the structure so it can be content-hashed into a
 * snapshot.
 */
export interface Component {
  id: string;
  name: string;
  /** Component id of the parent, if this sits in a hierarchy. */
  parent_id?: string;
  /** Search terms used to anchor queries for this component (§5, context anchoring). */
  terms?: string[];
}

/**
 * A cluster of recent papers. Deliberately unnamed and unsummarized: the
 * server returns representative papers and top terms, and Claude does the
 * naming. Naming here would require either an LLM call or a local ML model,
 * and this server has neither.
 */
export interface FrontierCluster {
  id: string;
  component: string;
  /** Highest-weight TF-IDF terms for the cluster. */
  top_terms: { term: string; weight: number }[];
  /** Papers closest to the cluster centroid. */
  representative_papers: Paper[];
  paper_count: number;
  /** ISO 8601 range covered by the cluster's papers. */
  date_range: { from: string; to: string };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Snapshots exist for reproducibility. The tool is reproducible; its output is
 * not, because search results and the literature both move. A dated,
 * content-hashed, frozen snapshot is the citable artifact.
 */
export interface Snapshot {
  /** Content hash of the canonical JSON of the full payload. */
  id: string;
  query: string;
  created_at: string;
  tool_version: string;
  components: Component[];
  claims: Claim[];
  verifications: VerificationResult[];
  frontier: FrontierCluster[];
}

export type SnapshotInput = Omit<Snapshot, 'id' | 'created_at'>;

// ---------------------------------------------------------------------------
// Cross-cutting result envelope
// ---------------------------------------------------------------------------

/**
 * §7: every tool degrades gracefully. Zero results, timeouts, and malformed
 * responses return a structured empty result with an `error` field rather than
 * throwing across the MCP boundary. `stale` marks results served from cache
 * after all network calls failed — an empty section must never be ambiguous
 * between "nothing is happening in this field" and "the API timed out".
 */
export interface ToolEnvelope {
  error?: string;
  warning?: string;
  stale?: boolean;
  cache_hit?: boolean;
}
