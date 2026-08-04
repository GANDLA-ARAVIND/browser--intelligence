/**
 * Hybrid retrieval measurement (CLAUDE.md §14, DECISIONS.md — follows the
 * proper-noun mitigation measurement, which was rejected on both candidates).
 *
 * Measurement only — nothing wired into src/lib or the extension. Combines a
 * BM25 lexical score with the existing vector cosine score and compares
 * against vector-only search on the same 10 queries used for the
 * proper-noun round, plus latency, before any implementation decision.
 *
 *   npx tsx scripts/measure-hybrid-retrieval.ts
 */

import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import {
  createEmbedder,
  dotVec,
  EMBEDDING_DIM,
  filterHistory,
  tokenizeForLabels,
  type Page,
  type RawVisit,
} from '../src/lib/index.js';

const INPUT = './history-export.json';

async function loadHistory(path: string): Promise<RawVisit[]> {
  const text = await readFile(path, 'utf8');
  const rows = JSON.parse(text) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const visit: RawVisit = {
      url: String(row['url'] ?? ''),
      title: String(row['title'] ?? ''),
      lastVisit: Number(row['lastVisitTime'] ?? 0),
    };
    if (typeof row['visitCount'] === 'number') visit.visitCount = row['visitCount'];
    return visit;
  });
}

// ---------------------------------------------------------------------------
// BM25 — reuses `tokenizeForLabels` (labels.ts), already script-safety-tested
// against Telugu/Chinese/Arabic/Devanagari/Thai (§14's standing rule), rather
// than writing a second tokenizer that would need the same testing again.
// ---------------------------------------------------------------------------

const BM25_K1 = 1.5;
const BM25_B = 0.75;

interface Bm25Index {
  docTerms: string[][];
  df: Map<string, number>;
  avgLen: number;
  n: number;
}

function buildBm25Index(docs: string[]): Bm25Index {
  const docTerms = docs.map((d) => tokenizeForLabels(d));
  const df = new Map<string, number>();
  for (const terms of docTerms) {
    for (const term of new Set(terms)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const avgLen = docTerms.reduce((sum, t) => sum + t.length, 0) / docTerms.length;
  return { docTerms, df, avgLen, n: docTerms.length };
}

function bm25Score(index: Bm25Index, docIndex: number, queryTerms: string[]): number {
  const terms = index.docTerms[docIndex]!;
  const len = terms.length;
  const tf = new Map<string, number>();
  for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  for (const qt of queryTerms) {
    const f = tf.get(qt);
    if (f === undefined) continue;
    const df = index.df.get(qt) ?? 0;
    const idf = Math.log((index.n - df + 0.5) / (df + 0.5) + 1);
    const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (len / index.avgLen));
    score += idf * ((f * (BM25_K1 + 1)) / denom);
  }
  return score;
}

function minMaxNormalize(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < 1e-9) return values.map(() => 0);
  return values.map((v) => (v - min) / (max - min));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Loading + filtering…');
  const visits = await loadHistory(INPUT);
  const filtered = filterHistory(visits, false, { stripSuffixes: true });
  const pages: Page[] = filtered.pages;
  console.log(`  ${visits.length} raw rows -> ${pages.length} pages after filtering`);

  console.log('\nLoading embedder…');
  const embedder = await createEmbedder({ cacheDir: './.models' });

  console.log('Embedding baseline corpus (vector-only reference)…');
  let mark = performance.now();
  const matrix = await embedder.embed(pages.map((p) => p.embedText));
  console.log(`  embedded ${pages.length} pages in ${((performance.now() - mark) / 1000).toFixed(1)}s`);

  // Indexed on the raw title, not `embedText`: the boilerplate-suffix
  // stripper already run for the vector path removes "- Google Maps" etc.
  // from most titles, which corrupts the document-frequency statistics
  // IDF depends on — "maps" measured as df=5 (idf 6.97, treated as rare)
  // over embedText vs its true df=804 (idf 1.99) over raw title. IDF's
  // arithmetic was never wrong; the input population was.
  console.log('Building BM25 index (on raw title, not the boilerplate-stripped embedText)…');
  mark = performance.now();
  const bm25 = buildBm25Index(pages.map((p) => p.title));
  console.log(`  indexed in ${(performance.now() - mark).toFixed(0)}ms`);

  // Same 10 queries as the proper-noun measurement round, for a fair,
  // continuous comparison against the same baseline.
  const queries = [
    'docker networking setup',
    'software engineer jobs bengaluru',
    'react state management',
    'telugu vlogs food',
    'leetcode two sum',
    'temple directions google maps',
    'resume for freshers',
    'python interview questions',
    'machine learning tutorial',
    'capgemini careers',
  ];

  const LATENCY_REPS = 20; // per query, for a stable median

  console.log(`\n${'='.repeat(78)}\nVECTOR-ONLY vs HYBRID (BM25 + vector), top 5 per query\n${'='.repeat(78)}`);

  const vectorLatencies: number[] = [];
  const hybridLatencies: number[] = [];

  for (const q of queries) {
    const qMatrix = await embedder.embed([q]);
    const qVec = qMatrix.slice(0, EMBEDDING_DIM);
    const queryTerms = tokenizeForLabels(q);

    // --- vector-only ---
    let vecTimes: number[] = [];
    let vecScored: Array<{ i: number; sim: number }> = [];
    for (let rep = 0; rep < LATENCY_REPS; rep++) {
      const t0 = performance.now();
      vecScored = pages.map((_, i) => ({ i, sim: dotVec(matrix, i, qVec) }));
      vecScored.sort((a, b) => b.sim - a.sim);
      vecTimes.push(performance.now() - t0);
    }
    vectorLatencies.push(median(vecTimes));

    // --- hybrid: BM25 + vector, min-max normalized per query, blended 50/50 ---
    let hybTimes: number[] = [];
    let hybridTop: Array<{ i: number; hybrid: number; vec: number; bm25: number }> = [];
    for (let rep = 0; rep < LATENCY_REPS; rep++) {
      const t0 = performance.now();
      const vecSims = pages.map((_, i) => dotVec(matrix, i, qVec));
      const bm25Scores = pages.map((_, i) => bm25Score(bm25, i, queryTerms));
      const vecNorm = minMaxNormalize(vecSims);
      const bm25Norm = minMaxNormalize(bm25Scores);
      const combined = pages.map((_, i) => ({
        i,
        hybrid: 0.5 * vecNorm[i]! + 0.5 * bm25Norm[i]!,
        vec: vecSims[i]!,
        bm25: bm25Scores[i]!,
      }));
      combined.sort((a, b) => b.hybrid - a.hybrid);
      hybridTop = combined;
      hybTimes.push(performance.now() - t0);
    }
    hybridLatencies.push(median(hybTimes));

    console.log(`\n"${q}"`);
    console.log('  vector-only:');
    for (const r of vecScored.slice(0, 5)) console.log(`      ${r.sim.toFixed(3)}  ${pages[r.i]!.title}`);
    console.log('  hybrid (BM25+vector):');
    for (const r of hybridTop.slice(0, 5)) {
      console.log(`      hybrid=${r.hybrid.toFixed(3)} (vec=${r.vec.toFixed(3)}, bm25=${r.bm25.toFixed(2)})  ${pages[r.i]!.title}`);
    }
  }

  console.log(`\n${'='.repeat(78)}\nLATENCY (median of ${LATENCY_REPS} reps per query, ${pages.length} pages)\n${'='.repeat(78)}`);
  console.log(`  vector-only:        ${median(vectorLatencies).toFixed(1)}ms  (range ${Math.min(...vectorLatencies).toFixed(1)}-${Math.max(...vectorLatencies).toFixed(1)}ms)`);
  console.log(`  hybrid (BM25+vec):  ${median(hybridLatencies).toFixed(1)}ms  (range ${Math.min(...hybridLatencies).toFixed(1)}-${Math.max(...hybridLatencies).toFixed(1)}ms)`);
  console.log(`  overhead:           +${(median(hybridLatencies) - median(vectorLatencies)).toFixed(1)}ms`);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
