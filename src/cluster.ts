/**
 * `cluster_frontier` (CODEX_SPEC.md §5, §10.8).
 *
 * Groups recent papers by shared title/abstract terms using TF-IDF cosine
 * similarity and agglomerative clustering.
 *
 * **Clusters are returned unnamed.** §5 is explicit: "Return clusters with
 * representative papers and top terms — do not attempt to name or summarize
 * them. Naming is Claude's job." That is not modesty about the quality of a
 * generated label; it is what keeps this server free of both LLM calls (§2)
 * and local ML model downloads (§5). Top terms and representative papers are
 * everything a reader needs to name a cluster, and the naming happens where
 * the reasoning already is.
 *
 * Everything here is deterministic arithmetic. §8 requires byte-identical
 * repeat runs, which rules out k-means, random seeds, and any tie-break that
 * depends on object iteration order.
 */

import { contentHash } from './hash.js';
import type { FrontierCluster, Paper } from './types.js';

/**
 * Merge threshold on cosine similarity.
 *
 * TF-IDF cosine over titles and abstracts runs low — two papers on the same
 * narrow topic typically land around 0.2-0.4, not 0.8, because most of their
 * words are ordinary academic prose. 0.18 is set just under that band: high
 * enough that unrelated papers stay apart, low enough that a genuine subtopic
 * is not split into singletons. It is the number most worth tuning, and the
 * one most likely to need adjusting per field.
 */
export const MERGE_THRESHOLD = 0.18;

/**
 * Below this, clustering says nothing. Three papers cannot exhibit structure
 * distinguishable from noise, and presenting two of them as "a cluster" would
 * manufacture exactly the significance §8's cold-field test forbids.
 */
export const MIN_PAPERS_TO_CLUSTER = 4;

/** Terms appearing in more than this fraction of the corpus carry no signal. */
export const MAX_DOCUMENT_FREQUENCY = 0.6;

export const DEFAULT_TOP_TERMS = 8;
export const DEFAULT_REPRESENTATIVES = 3;

/**
 * Ordinary academic connective tissue. Deliberately short: an aggressive
 * domain stopword list would have to be maintained per field, and TF-IDF
 * already suppresses anything that appears everywhere.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do', 'does', 'for', 'from',
  'has', 'have', 'here', 'how', 'in', 'into', 'is', 'it', 'its', 'may', 'more', 'most', 'new', 'no',
  'not', 'of', 'on', 'or', 'our', 'out', 'over', 'she', 'so', 'such', 'than', 'that', 'the', 'their',
  'then', 'there', 'these', 'they', 'this', 'those', 'to', 'two', 'up', 'use', 'used', 'using', 'was',
  'we', 'were', 'what', 'when', 'which', 'while', 'who', 'will', 'with', 'would', 'you',
  // Paper-shaped words that appear in every abstract regardless of topic.
  'study', 'paper', 'results', 'method', 'methods', 'approach', 'propose', 'proposed', 'present',
  'presented', 'show', 'shows', 'shown', 'based', 'novel', 'also', 'both', 'via', 'due', 'however',
]);

/**
 * No stemming, for the same reason deduplication does not stem: two genuinely
 * different terms can differ only in a word ending, and collapsing them would
 * merge distinct subtopics. Numbers are kept — model numbers and years carry
 * real signal in this domain.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function documentText(paper: Paper): string {
  // The title is repeated so its terms weigh more than abstract terms; a
  // title is the author's own summary, and doubling it is cheaper and more
  // predictable than a separate field-weighting scheme.
  return `${paper.title} ${paper.title} ${paper.abstract ?? ''}`;
}

interface Vector {
  paper: Paper;
  weights: Map<string, number>;
  norm: number;
}

/** TF-IDF vectors for a corpus, with document frequency filtering. */
export function buildVectors(papers: Paper[]): Vector[] {
  const tokenized = papers.map((paper) => tokenize(documentText(paper)));

  const documentFrequency = new Map<string, number>();
  for (const tokens of tokenized) {
    for (const term of new Set(tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const total = papers.length;
  const maxDf = Math.max(1, Math.floor(total * MAX_DOCUMENT_FREQUENCY));

  return papers.map((paper, index) => {
    const tokens = tokenized[index] ?? [];
    const termFrequency = new Map<string, number>();
    for (const term of tokens) termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);

    // Smoothed IDF: log((N+1)/(df+1)) + 1 stays positive at df === N, so a
    // universal term is down-weighted rather than zeroed out.
    const weigh = (term: string, count: number): number => {
      const df = documentFrequency.get(term) ?? 1;
      return (count / tokens.length) * (Math.log((total + 1) / (df + 1)) + 1);
    };

    const weights = new Map<string, number>();
    for (const [term, count] of termFrequency) {
      const df = documentFrequency.get(term) ?? 1;
      // Skip terms that are everywhere: they cannot separate anything, and
      // with a small corpus they dominate the vector.
      if (df > maxDf && total > 2) continue;
      weights.set(term, weigh(term, count));
    }

    // If the filter emptied this document, keep its terms after all. A corpus
    // where every paper shares its whole vocabulary is homogeneous, not
    // signal-free — filtering it to nothing produces zero vectors, zero
    // similarity, and a confident report of no structure whatsoever. IDF
    // already handles ubiquity gracefully; the hard cap is an optimization,
    // not a correctness requirement, and it yields when it would erase a
    // document.
    if (weights.size === 0) {
      for (const [term, count] of termFrequency) weights.set(term, weigh(term, count));
    }

    let sumSquares = 0;
    for (const weight of weights.values()) sumSquares += weight * weight;

    return { paper, weights, norm: Math.sqrt(sumSquares) };
  });
}

export function cosine(a: Vector, b: Vector): number {
  if (a.norm === 0 || b.norm === 0) return 0;
  // Iterate the smaller vector: the result is identical and the cost is not.
  const [small, large] = a.weights.size <= b.weights.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, weight] of small.weights) {
    const other = large.weights.get(term);
    if (other !== undefined) dot += weight * other;
  }
  return dot / (a.norm * b.norm);
}

interface Cluster {
  members: number[];
}

/**
 * Agglomerative clustering with average linkage.
 *
 * Average linkage rather than single or complete: single linkage chains, so
 * one bridging paper merges two unrelated topics; complete linkage demands
 * every pair be similar, which splits real subtopics that have a couple of
 * outliers. Average sits between and is the standard choice for text.
 *
 * Ties are broken by lowest member index so the result cannot depend on
 * iteration order (§8 determinism).
 */
export function agglomerate(vectors: Vector[], threshold = MERGE_THRESHOLD): Cluster[] {
  let clusters: Cluster[] = vectors.map((_, index) => ({ members: [index] }));

  const similarity: number[][] = vectors.map(() => new Array<number>(vectors.length).fill(0));
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      const value = cosine(vectors[i] as Vector, vectors[j] as Vector);
      (similarity[i] as number[])[j] = value;
      (similarity[j] as number[])[i] = value;
    }
  }

  const averageLinkage = (a: Cluster, b: Cluster): number => {
    let sum = 0;
    for (const i of a.members) for (const j of b.members) sum += (similarity[i] as number[])[j] ?? 0;
    return sum / (a.members.length * b.members.length);
  };

  for (;;) {
    let bestScore = threshold;
    let bestPair: [number, number] | undefined;

    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const score = averageLinkage(clusters[i] as Cluster, clusters[j] as Cluster);
        // Strictly greater keeps the first (lowest-index) pair on a tie.
        if (score > bestScore) {
          bestScore = score;
          bestPair = [i, j];
        }
      }
    }

    if (bestPair === undefined) break;
    const [i, j] = bestPair;
    const merged: Cluster = {
      members: [...(clusters[i] as Cluster).members, ...(clusters[j] as Cluster).members].sort((a, b) => a - b),
    };
    clusters = clusters.filter((_, index) => index !== i && index !== j);
    clusters.push(merged);
    clusters.sort((a, b) => (a.members[0] ?? 0) - (b.members[0] ?? 0));
  }

  return clusters;
}

export interface ClusterFrontierInput {
  papers: Paper[];
  component: string;
  top_terms?: number;
  representatives?: number;
  threshold?: number;
}

export interface ClusterFrontierOutput {
  clusters: FrontierCluster[];
  /** Papers in, after invalid entries are dropped. */
  paper_count: number;
  /** Set when the corpus is too small for clustering to mean anything. */
  too_sparse?: boolean;
  warning?: string;
}

function dateRange(papers: Paper[]): { from: string; to: string } {
  const dates = papers.map((p) => p.published).filter((d) => d !== '').sort();
  return { from: dates[0] ?? '', to: dates[dates.length - 1] ?? '' };
}

/** Highest mean TF-IDF terms across a cluster's members. */
function topTerms(members: Vector[], limit: number): { term: string; weight: number }[] {
  const totals = new Map<string, number>();
  for (const member of members) {
    for (const [term, weight] of member.weights) {
      totals.set(term, (totals.get(term) ?? 0) + weight);
    }
  }
  return [...totals.entries()]
    .map(([term, total]) => ({ term, weight: Number((total / members.length).toFixed(6)) }))
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .slice(0, limit);
}

/** Members closest to the cluster centroid, i.e. most typical of it. */
function representatives(members: Vector[], limit: number): Paper[] {
  if (members.length <= limit) {
    return [...members]
      .sort((a, b) => (b.paper.published || '').localeCompare(a.paper.published || ''))
      .map((m) => m.paper);
  }

  const centroid = new Map<string, number>();
  for (const member of members) {
    for (const [term, weight] of member.weights) {
      centroid.set(term, (centroid.get(term) ?? 0) + weight / members.length);
    }
  }
  let centroidNorm = 0;
  for (const weight of centroid.values()) centroidNorm += weight * weight;
  const centroidVector: Vector = {
    paper: members[0]?.paper as Paper,
    weights: centroid,
    norm: Math.sqrt(centroidNorm),
  };

  return [...members]
    .map((member) => ({ member, score: cosine(member, centroidVector) }))
    .sort((a, b) => b.score - a.score || a.member.paper.id.localeCompare(b.member.paper.id))
    .slice(0, limit)
    .map((entry) => entry.member.paper);
}

export function clusterFrontier(input: ClusterFrontierInput): ClusterFrontierOutput {
  const papers = input.papers.filter((p) => p.title.trim() !== '');
  const termLimit = input.top_terms ?? DEFAULT_TOP_TERMS;
  const representativeLimit = input.representatives ?? DEFAULT_REPRESENTATIVES;

  if (papers.length === 0) {
    return {
      clusters: [],
      paper_count: 0,
      too_sparse: true,
      warning: `No papers supplied for "${input.component}". Nothing to cluster; this is not a finding about the field.`,
    };
  }

  if (papers.length < MIN_PAPERS_TO_CLUSTER) {
    // §8's cold-field requirement: report low activity honestly rather than
    // fabricating significance. One cluster of everything, stated as such.
    const vectors = buildVectors(papers);
    return {
      clusters: [
        {
          id: contentHash({ component: input.component, papers: papers.map((p) => p.id).sort() }).slice(0, 16),
          component: input.component,
          top_terms: topTerms(vectors, termLimit),
          representative_papers: representatives(vectors, representativeLimit),
          paper_count: papers.length,
          date_range: dateRange(papers),
        },
      ],
      paper_count: papers.length,
      too_sparse: true,
      warning:
        `Only ${papers.length} paper(s) for "${input.component}" — below the ${MIN_PAPERS_TO_CLUSTER} needed for ` +
        'clustering to distinguish structure from noise. Returned as one group. This is a sparse field, not a ' +
        'field with one research theme.',
    };
  }

  const vectors = buildVectors(papers);
  const grouped = agglomerate(vectors, input.threshold ?? MERGE_THRESHOLD);

  const clusters: FrontierCluster[] = grouped
    .map((cluster) => {
      const members = cluster.members.map((index) => vectors[index] as Vector);
      const clusterPapers = members.map((m) => m.paper);
      return {
        // Content-addressed by membership, so the same grouping always carries
        // the same id across runs and across snapshots.
        id: contentHash({
          component: input.component,
          papers: clusterPapers.map((p) => p.id).sort(),
        }).slice(0, 16),
        component: input.component,
        top_terms: topTerms(members, termLimit),
        representative_papers: representatives(members, representativeLimit),
        paper_count: clusterPapers.length,
        date_range: dateRange(clusterPapers),
      };
    })
    // Largest first, then by id so equal-sized clusters have a stable order.
    .sort((a, b) => b.paper_count - a.paper_count || a.id.localeCompare(b.id));

  const singletons = clusters.filter((c) => c.paper_count === 1).length;
  const notes: string[] = [];
  if (singletons === clusters.length) {
    notes.push(
      `No two papers exceeded the ${input.threshold ?? MERGE_THRESHOLD} similarity threshold: ${clusters.length} ` +
        'singletons. The field has no shared vocabulary at this granularity — scattered activity, not themes.',
    );
  } else if (singletons > 0) {
    notes.push(`${singletons} paper(s) did not join any cluster; they are returned as singletons rather than dropped.`);
  }
  notes.push('Clusters are deliberately unnamed (§5) — top terms and representative papers are the evidence for naming.');

  return {
    clusters,
    paper_count: papers.length,
    ...(notes.length === 0 ? {} : { warning: notes.join(' ') }),
  };
}
