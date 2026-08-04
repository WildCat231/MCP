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
 * A normalized primary-source record. `fields` keeps the registry's own
 * key/value payload intact so the verifier can read registry-specific
 * distinctions (510(k) vs PMA, grant date vs filing date) without this type
 * having to enumerate every registry's schema.
 */
export interface RegistryRecord {
  registry: RegistryName;
  /** The registry's own identifier — K number, PMA number, DOI, patent number. */
  record_id: string;
  title: string;
  /** ISO 8601, may be partial. The date the registry attests to. */
  date?: string;
  url: string;
  fields: Record<string, unknown>;
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
