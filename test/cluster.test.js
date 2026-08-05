/**
 * Phase 8: cluster_frontier (CODEX_SPEC.md §5, §10.8).
 *
 * Two properties matter most and are tested hardest: clusters carry no names
 * (§5, and the reason this server needs neither an LLM nor a local model), and
 * a sparse field is reported as sparse rather than dressed up as structure
 * (§8's cold-field requirement).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MERGE_THRESHOLD,
  MIN_PAPERS_TO_CLUSTER,
  agglomerate,
  buildVectors,
  clusterFrontier,
  cosine,
  tokenize,
} from '../dist/cluster.js';

let counter = 0;
const paper = (title, abstract = '', published = '2026-01-01') => {
  counter += 1;
  return {
    id: `p${counter}`,
    title,
    abstract,
    authors: [],
    published,
    url: `https://example.org/p${counter}`,
    source: 'crossref',
    source_id: `p${counter}`,
  };
};

/** Two clearly separate topics, four papers each. */
function twoTopics() {
  counter = 0;
  return [
    paper('Autonomous suturing with a supervised surgical robot', 'suturing anastomosis autonomous robot tissue'),
    paper('Supervised autonomous anastomosis in soft tissue', 'anastomosis suturing autonomous tissue robot'),
    paper('Robotic soft tissue suturing under supervision', 'suturing tissue robot autonomous anastomosis'),
    paper('Autonomous tissue anastomosis robot evaluation', 'autonomous anastomosis tissue suturing robot'),
    paper('Solid-state electrolyte interfaces in lithium batteries', 'electrolyte lithium battery interface anode'),
    paper('Lithium anode stability at electrolyte interfaces', 'lithium electrolyte anode battery interface'),
    paper('Battery electrolyte interface engineering for lithium anodes', 'battery lithium electrolyte anode interface'),
    paper('Interfacial lithium transport in solid electrolytes', 'lithium electrolyte interface battery anode'),
  ];
}

// ---------------------------------------------------------------------------
// §5: clusters are not named
// ---------------------------------------------------------------------------

test('clusters carry no name, label, or summary field', async () => {
  // §5: "do not attempt to name or summarize them. Naming is Claude's job."
  // This is what keeps the server free of LLM calls and model downloads.
  const { clusters } = clusterFrontier({ papers: twoTopics(), component: 'surgical robotics' });
  assert.ok(clusters.length > 0);

  for (const cluster of clusters) {
    assert.deepEqual(
      Object.keys(cluster).sort(),
      ['component', 'date_range', 'id', 'paper_count', 'representative_papers', 'top_terms'],
    );
    for (const forbidden of ['name', 'label', 'title', 'summary', 'description', 'theme']) {
      assert.equal(cluster[forbidden], undefined, `clusters must not carry a "${forbidden}"`);
    }
  }
});

test('top terms and representative papers are supplied as naming evidence', async () => {
  const { clusters, warning } = clusterFrontier({ papers: twoTopics(), component: 'surgical robotics' });
  for (const cluster of clusters) {
    assert.ok(cluster.top_terms.length > 0, 'terms are the evidence for a name');
    assert.ok(cluster.representative_papers.length > 0);
    for (const term of cluster.top_terms) {
      assert.equal(typeof term.term, 'string');
      assert.ok(term.weight > 0);
    }
  }
  assert.match(warning, /deliberately unnamed/);
});

// ---------------------------------------------------------------------------
// clustering behaviour
// ---------------------------------------------------------------------------

test('two distinct topics separate into two clusters', async () => {
  const { clusters } = clusterFrontier({ papers: twoTopics(), component: 'mixed' });
  assert.equal(clusters.length, 2, `expected 2 clusters, got ${clusters.length}`);
  assert.deepEqual(clusters.map((c) => c.paper_count), [4, 4]);

  const terms = clusters.map((c) => c.top_terms.map((t) => t.term));
  const surgical = terms.find((t) => t.includes('anastomosis'));
  const battery = terms.find((t) => t.includes('electrolyte'));
  assert.ok(surgical, 'one cluster should be about anastomosis');
  assert.ok(battery, 'the other about electrolytes');
  assert.ok(!surgical.includes('electrolyte'), 'and the vocabularies should not bleed');
});

test('papers are never dropped — every input lands in some cluster', async () => {
  const papers = twoTopics();
  const { clusters, paper_count } = clusterFrontier({ papers, component: 'mixed' });
  const clustered = clusters.reduce((sum, c) => sum + c.paper_count, 0);
  assert.equal(clustered, papers.length);
  assert.equal(paper_count, papers.length);
});

test('an unrelated paper is returned as a singleton, not forced into a cluster', async () => {
  const papers = [...twoTopics(), paper('Railway interlocking signal timing verification', 'railway signal interlocking')];
  const { clusters, warning } = clusterFrontier({ papers, component: 'mixed' });

  const singleton = clusters.find((c) => c.paper_count === 1);
  assert.ok(singleton, 'the outlier stays on its own');
  assert.match(singleton.representative_papers[0].title, /Railway/);
  assert.match(warning, /returned as singletons rather than dropped/);
});

test('date_range spans the cluster and nothing is invented', async () => {
  counter = 0;
  const papers = [
    paper('Autonomous suturing robot tissue', 'suturing anastomosis autonomous', '2024-03-01'),
    paper('Suturing tissue autonomous robot', 'anastomosis suturing autonomous', '2025-06-15'),
    paper('Autonomous anastomosis tissue suturing', 'suturing autonomous anastomosis', '2026-01-20'),
    paper('Robot suturing autonomous tissue anastomosis', 'autonomous suturing anastomosis', '2023-11-05'),
  ];
  const { clusters } = clusterFrontier({ papers, component: 'x' });
  assert.equal(clusters[0].date_range.from, '2023-11-05');
  assert.equal(clusters[0].date_range.to, '2026-01-20');
});

// ---------------------------------------------------------------------------
// §8: cold field
// ---------------------------------------------------------------------------

test('a sparse field is reported as sparse, not as one research theme', async () => {
  // §8: "Frontier section must honestly report low activity, not fabricate
  // significance."
  counter = 0;
  const { clusters, too_sparse, warning } = clusterFrontier({
    papers: [paper('Railway interlocking verification', 'railway signalling interlocking')],
    component: 'railway signalling',
  });

  assert.equal(too_sparse, true);
  assert.equal(clusters.length, 1);
  assert.match(warning, /sparse field, not a field with one research theme/);
  assert.match(warning, new RegExp(`below the ${MIN_PAPERS_TO_CLUSTER}`));
});

test('an empty corpus is not a finding about the field', async () => {
  const { clusters, too_sparse, warning } = clusterFrontier({ papers: [], component: 'railway signalling' });
  assert.deepEqual(clusters, []);
  assert.equal(too_sparse, true);
  assert.match(warning, /not a finding about the field/);
});

test('all-singletons is reported as scattered activity, not as themes', async () => {
  counter = 0;
  const papers = [
    paper('Railway interlocking signal timing', 'railway interlocking'),
    paper('Quantum dot photoluminescence spectra', 'quantum dot photoluminescence'),
    paper('Ancient Roman aqueduct hydraulics', 'aqueduct roman hydraulics'),
    paper('Enzymatic degradation of polyethylene', 'enzyme polyethylene degradation'),
  ];
  const { clusters, warning } = clusterFrontier({ papers, component: 'grab bag' });
  assert.equal(clusters.length, 4);
  assert.match(warning, /scattered activity, not themes/);
});

// ---------------------------------------------------------------------------
// determinism and mechanics
// ---------------------------------------------------------------------------

test('clustering is deterministic regardless of input order', async () => {
  // §8 requires byte-identical repeat runs, which rules out k-means and any
  // order-dependent tie-break.
  const papers = twoTopics();
  const forward = clusterFrontier({ papers, component: 'mixed' });
  const reversed = clusterFrontier({ papers: [...papers].reverse(), component: 'mixed' });

  assert.deepEqual(
    forward.clusters.map((c) => c.id).sort(),
    reversed.clusters.map((c) => c.id).sort(),
    'cluster ids are content-addressed by membership, so order cannot change them',
  );

  const again = clusterFrontier({ papers, component: 'mixed' });
  assert.equal(JSON.stringify(forward), JSON.stringify(again), 'repeat runs must be byte-identical');
});

test('cluster ids are content-addressed by membership', async () => {
  const papers = twoTopics();
  const a = clusterFrontier({ papers, component: 'mixed' });
  const b = clusterFrontier({ papers, component: 'a different component' });
  assert.notEqual(a.clusters[0].id, b.clusters[0].id, 'the component is part of the address');
});

test('tokenize drops stopwords, short tokens and punctuation but keeps numbers', async () => {
  const tokens = tokenize('The novel PUMA 560 robot: a study of results, in 1985!');
  assert.ok(!tokens.includes('the'));
  assert.ok(!tokens.includes('novel'), 'paper-shaped words are stopped too');
  assert.ok(!tokens.includes('study'));
  assert.ok(tokens.includes('puma'));
  assert.ok(tokens.includes('560'), 'model numbers carry real signal');
  assert.ok(tokens.includes('1985'));
  assert.ok(tokens.includes('robot'));
});

test('tokenize does not stem', async () => {
  // Same reason deduplication does not: two genuinely different terms can
  // differ only in a word ending.
  const tokens = tokenize('robotic robots robot');
  assert.deepEqual([...new Set(tokens)].sort(), ['robot', 'robotic', 'robots']);
});

test('cosine is 1 for identical text and 0 for disjoint vocabularies', async () => {
  counter = 0;
  const [a, b] = buildVectors([paper('autonomous suturing robot'), paper('autonomous suturing robot')]);
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-9);

  counter = 0;
  const [c, d] = buildVectors([paper('autonomous suturing robot'), paper('lithium electrolyte anode')]);
  assert.equal(cosine(c, d), 0);
});

test('terms appearing in every document are suppressed', async () => {
  // They cannot separate anything, and with a small corpus they dominate.
  counter = 0;
  const papers = [
    paper('robot anastomosis suturing tissue', 'robot'),
    paper('robot electrolyte lithium anode', 'robot'),
    paper('robot railway interlocking signal', 'robot'),
    paper('robot quantum photoluminescence dot', 'robot'),
  ];
  const { clusters } = clusterFrontier({ papers, component: 'x' });
  for (const cluster of clusters) {
    assert.ok(
      !cluster.top_terms.some((t) => t.term === 'robot'),
      'a term in every document carries no signal and must not lead',
    );
  }
});

test('the merge threshold is respected', async () => {
  const vectors = buildVectors(twoTopics());
  assert.equal(agglomerate(vectors, -1).length, 1, 'a negative threshold merges everything');
  assert.equal(agglomerate(vectors, 0).length, 2, 'threshold 0 still keeps disjoint vocabularies apart');
  assert.equal(agglomerate(vectors, 0.99).length, 8, 'a near-1 threshold merges nothing');
  assert.ok(MERGE_THRESHOLD > 0 && MERGE_THRESHOLD < 1);
});

test('a homogeneous corpus still clusters instead of collapsing to zero vectors', async () => {
  // Every paper sharing its whole vocabulary is a homogeneous field, not a
  // signal-free one. Document-frequency filtering would erase every term and
  // report confident structurelessness; the fallback keeps the terms.
  counter = 0;
  const papers = [
    paper('Autonomous suturing anastomosis tissue robot', 'autonomous suturing anastomosis tissue robot'),
    paper('Suturing anastomosis autonomous robot tissue', 'suturing anastomosis autonomous robot tissue'),
    paper('Tissue robot autonomous suturing anastomosis', 'tissue robot autonomous suturing anastomosis'),
    paper('Robot tissue suturing autonomous anastomosis', 'robot tissue suturing autonomous anastomosis'),
  ];
  const { clusters } = clusterFrontier({ papers, component: 'homogeneous' });
  assert.equal(clusters.length, 1, 'one topic, correctly seen as one topic');
  assert.equal(clusters[0].paper_count, 4);
  assert.ok(clusters[0].top_terms.length > 0, 'and it still has terms to name it by');
});

test('representative papers are capped and drawn from the cluster', async () => {
  const papers = twoTopics();
  const { clusters } = clusterFrontier({ papers, component: 'mixed', representatives: 2 });
  for (const cluster of clusters) {
    assert.ok(cluster.representative_papers.length <= 2);
    for (const representative of cluster.representative_papers) {
      assert.ok(papers.some((p) => p.id === representative.id));
    }
  }
});
