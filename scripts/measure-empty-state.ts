/**
 * v1.1 item 3 — search empty state (CLAUDE.md §11 Phase 4 backlog).
 *
 * Measurement only. Two rounds of retrieval work (proper-noun mitigation,
 * hybrid retrieval) were both rejected on the same underlying evidence: the
 * baseline vector scores for queries with real content in the corpus are
 * already high (machine learning tutorial 0.988, leetcode two sum 0.958,
 * capgemini careers 0.910) — ranking is not the problem. The failures are
 * queries whose content simply isn't in the corpus, presented identically to
 * real hits. This measures whether the *shape* of the score distribution
 * (not an absolute cutoff — §11 already measured top scores ranging 0.376 to
 * 0.892 across five queries, which is why a fixed floor doesn't transfer)
 * separates "real hit" queries from "nothing matched" queries.
 *
 *   npx tsx scripts/measure-empty-state.ts
 */

import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { createEmbedder, dotVec, EMBEDDING_DIM, filterHistory, type Page, type RawVisit } from '../src/lib/index.js';

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

function stddev(values: number[]): number {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

async function main(): Promise<void> {
  console.log('Loading + filtering…');
  const visits = await loadHistory(INPUT);
  const filtered = filterHistory(visits, false, { stripSuffixes: true });
  const pages: Page[] = filtered.pages;
  console.log(`  ${visits.length} raw rows -> ${pages.length} pages after filtering`);

  console.log('\nLoading embedder…');
  const embedder = await createEmbedder({ cacheDir: './.models' });

  console.log('Embedding baseline corpus…');
  const mark = performance.now();
  const matrix = await embedder.embed(pages.map((p) => p.embedText));
  console.log(`  embedded ${pages.length} pages in ${((performance.now() - mark) / 1000).toFixed(1)}s`);

  // Same 10 "content present" queries used for both retrieval rounds, plus 5
  // deliberately absent topics — checked against the real corpus content
  // list built up over both prior measurement rounds, not guessed.
  const presentQueries = [
    'docker networking setup', // kept from prior rounds despite weak scores — see note below
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
  const absentQueries = [
    'docker container tutorial',
    'rust programming ownership borrowing',
    'sourdough bread recipe',
    'guitar chords for beginners',
    'tax filing deadline',
  ];

  interface Row {
    query: string;
    group: 'present' | 'absent';
    top1: number;
    gap12: number;
    gap15: number;
    stdevTop20: number;
    top5Titles: string[];
  }

  const rows: Row[] = [];

  for (const [group, queries] of [
    ['present', presentQueries],
    ['absent', absentQueries],
  ] as const) {
    for (const q of queries) {
      const qMatrix = await embedder.embed([q]);
      const qVec = qMatrix.slice(0, EMBEDDING_DIM);
      const scored = pages.map((p, i) => ({ title: p.title, sim: dotVec(matrix, i, qVec) }));
      scored.sort((a, b) => b.sim - a.sim);
      const top20 = scored.slice(0, 20).map((s) => s.sim);
      rows.push({
        query: q,
        group,
        top1: top20[0]!,
        gap12: top20[0]! - top20[1]!,
        gap15: top20[0]! - top20[4]!,
        stdevTop20: stddev(top20),
        top5Titles: scored.slice(0, 5).map((s) => s.title),
      });
    }
  }

  console.log(`\n${'='.repeat(100)}`);
  console.log('PER-QUERY: top1, gap to #2, gap to #5, stdev(top20)');
  console.log('='.repeat(100));
  console.log('group     top1    gap12   gap15   stdev20   query');
  for (const r of rows) {
    console.log(
      `${r.group.padEnd(9)} ${r.top1.toFixed(3)}   ${r.gap12.toFixed(3)}   ${r.gap15.toFixed(3)}   ${r.stdevTop20.toFixed(4)}    "${r.query}"`
    );
  }

  console.log(`\nTop 5 titles per query (to sanity-check the "absent" queries are genuinely absent):`);
  for (const r of rows) {
    console.log(`\n[${r.group}] "${r.query}"`);
    for (const t of r.top5Titles) console.log(`    ${t}`);
  }

  // --- Which metric separates the two groups? -----------------------------
  function groupStats(metric: keyof Pick<Row, 'top1' | 'gap12' | 'gap15' | 'stdevTop20'>, group: 'present' | 'absent') {
    const values = rows.filter((r) => r.group === group).map((r) => r[metric]);
    return {
      min: Math.min(...values),
      max: Math.max(...values),
      mean: values.reduce((s, v) => s + v, 0) / values.length,
    };
  }

  console.log(`\n${'='.repeat(100)}`);
  console.log('GROUP SEPARATION — does the range of "present" overlap the range of "absent"?');
  console.log('='.repeat(100));
  for (const metric of ['top1', 'gap12', 'gap15', 'stdevTop20'] as const) {
    const p = groupStats(metric, 'present');
    const a = groupStats(metric, 'absent');
    const overlap = p.min <= a.max && a.min <= p.max;
    console.log(
      `  ${metric.padEnd(10)} present: [${p.min.toFixed(3)}, ${p.max.toFixed(3)}] mean ${p.mean.toFixed(3)}   ` +
        `absent: [${a.min.toFixed(3)}, ${a.max.toFixed(3)}] mean ${a.mean.toFixed(3)}   ` +
        `${overlap ? 'OVERLAPS — does not cleanly separate' : 'NO OVERLAP — separates cleanly'}`
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
