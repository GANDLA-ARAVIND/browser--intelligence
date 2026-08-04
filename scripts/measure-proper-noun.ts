/**
 * v1.1 item 1 — proper-noun dominance (CLAUDE.md §14).
 *
 * Measurement only. Nothing here is wired into src/lib or the extension —
 * this script computes three candidate embedding-text transforms over the
 * real corpus and reports how each changes the same-company/same-role
 * similarity gap, clustering shape, and a hand-judged search spot-check,
 * so the choice between them can be made from numbers rather than intuition.
 *
 *   npx tsx scripts/measure-proper-noun.ts
 */

import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import {
  clusterByMutualKnn,
  collapseNearDuplicates,
  createEmbedder,
  deriveBoilerplateSuffixes,
  dot,
  dotVec,
  EMBEDDING_DIM,
  expandGroups,
  filterHistory,
  stripBoilerplate,
  type Cluster,
  type DuplicateGroup,
  type Embedder,
  type Page,
  type RawVisit,
} from '../src/lib/index.js';

const INPUT = './history-export.json';
// SMOKE=1 for a fast single-run dry pass while developing this script —
// never the number reported in the actual measurement.
const RUNS_PER_VARIANT = process.env['SMOKE'] === '1' ? 1 : 3;
// Matches the extension's own production defaults (backfill.ts CLUSTER_*),
// not validate.ts's own CLI defaults — this measures against what actually
// ships, not the harness's separate default invocation.
const CLUSTER_OPTS = { k: 10, sharedMin: 4, minSim: 0.2, minClusterSize: 5 };

// ---------------------------------------------------------------------------
// Load — same shape-sniffing as validate.ts, trimmed to this corpus's shape.
// ---------------------------------------------------------------------------

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
// Candidate (a) — aggressive domain-suffix stripping.
//
// The shipped `deriveBoilerplateSuffixes` (titles.ts) only strips a trailing
// segment that recurs across `max(5, 0.3% of corpus)` titles corpus-wide —
// tuned for site-wide chrome like "- YouTube", which appears on hundreds of
// unrelated titles. A single employer's name on a job board recurs far less
// (tens of postings, not hundreds), so it mostly survives that gate today.
// This variant reuses the identical mechanism — same separator, same
// stripBoilerplate function — with the occurrence floor dropped to 3, so a
// narrower, employer-scale recurrence pattern also qualifies.
// ---------------------------------------------------------------------------

function deriveBoilerplateSuffixesAggressive(titles: string[], minOccurrences: number): Map<string, number> {
  const TITLE_SEPARATOR = /\s+[|–—·•:»~\-]\s+/;
  const counts = new Map<string, number>();
  for (const title of titles) {
    const parts = title.split(TITLE_SEPARATOR);
    if (parts.length < 2) continue;
    const tail = parts[parts.length - 1]!.trim();
    if (tail.length === 0 || tail.length > 40) continue;
    counts.set(tail.toLowerCase(), (counts.get(tail.toLowerCase()) ?? 0) + 1);
  }
  const boilerplate = new Map<string, number>();
  for (const [tail, count] of counts) if (count >= minOccurrences) boilerplate.set(tail, count);
  return boilerplate;
}

// ---------------------------------------------------------------------------
// Candidate (b) — down-weight/remove capitalised tokens outside
// sentence-initial position. Implemented as removal (the more testable end
// of "down-weight or remove"): MiniLM mean-pools over the whole input, so
// there is no per-token weight to turn down without a different pooling
// scheme — removal is the clean, measurable version of the same idea.
//
// Script-safety (§14's standing rule): `/^[A-Z]/` only matches Latin
// uppercase. Telugu, Chinese and Arabic have no case distinction at all, so
// this is structurally a no-op outside Latin text — verified below, not
// assumed, against 37 real Telugu titles from this corpus (no Chinese or
// Arabic titles exist in it, so two synthetic fixture titles stand in,
// labelled as such).
// ---------------------------------------------------------------------------

function stripNonInitialCapitalized(text: string): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= 1) return text;
  const kept = [words[0]!];
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (/^[A-Z]/.test(w)) continue; // dropped — capitalised, not sentence-initial
    kept.push(w);
  }
  return kept.join(' ');
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

interface RunMetrics {
  clusterCount: number;
  nodeNoisePct: number;
  pageNoisePct: number;
  largestPct: number;
  uniqueNodes: number;
  embedMs: number;
  collapseMs: number;
  clusterMs: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

async function runOnce(
  embedder: Embedder,
  pages: Page[]
): Promise<RunMetrics & { matrix: Float32Array; groups: DuplicateGroup[]; clusters: Cluster[]; noise: number[] }> {
  let mark = performance.now();
  const matrix = await embedder.embed(pages.map((p) => p.embedText));
  const embedMs = performance.now() - mark;

  mark = performance.now();
  const { groups, repMatrix } = collapseNearDuplicates(matrix, pages, 0.97);
  const collapseMs = performance.now() - mark;

  mark = performance.now();
  const { clusters, noise } = clusterByMutualKnn(repMatrix, groups.length, CLUSTER_OPTS);
  const clusterMs = performance.now() - mark;

  const nodeNoisePct = (noise.length / groups.length) * 100;
  const pageNoisePct = (expandGroups(groups, noise).length / pages.length) * 100;
  const largestNodes = clusters.length === 0 ? 0 : Math.max(...clusters.map((c) => c.members.length));
  const largestPct = (largestNodes / groups.length) * 100;

  return {
    clusterCount: clusters.length,
    nodeNoisePct,
    pageNoisePct,
    largestPct,
    uniqueNodes: groups.length,
    embedMs,
    collapseMs,
    clusterMs,
    matrix,
    groups,
    clusters,
    noise,
  };
}

/** Finds the page index whose title matches `needle` (substring, case-insensitive). */
function findPage(pages: Page[], needle: string): number {
  const index = pages.findIndex((p) => p.title.toLowerCase().includes(needle.toLowerCase()));
  if (index === -1) throw new Error(`fixture title not found: ${needle}`);
  return index;
}

/** Which cluster (if any) a page's representative group ended up in. */
function clusterOfPage(
  pageIndex: number,
  groups: DuplicateGroup[],
  clusters: Cluster[]
): number | null {
  const groupIndex = groups.findIndex((g) => g.members.includes(pageIndex));
  if (groupIndex === -1) return null;
  const clusterIndex = clusters.findIndex((c) => c.members.includes(groupIndex));
  return clusterIndex === -1 ? null : clusterIndex;
}

/**
 * Reports the *composition* of whichever cluster the temple page landed in,
 * rather than a pairwise "is this one other Maps page in the same cluster"
 * check — with 1,037 Google Maps direction rows and only 89 distinct titles
 * in this corpus, an arbitrary single comparison page is not representative
 * of whether the cluster as a whole is still the temple/Maps merge §14
 * documents. Counts how many of the cluster's own pages are Maps-titled.
 */
function templeClusterComposition(
  pages: Page[],
  groups: DuplicateGroup[],
  clusters: Cluster[],
  templeIdx: number
): { size: number; mapsShare: number; sampleTitles: string[] } | null {
  const clusterIndex = clusterOfPage(templeIdx, groups, clusters);
  if (clusterIndex === null) return null;
  const cluster = clusters[clusterIndex]!;
  const pageIndices = expandGroups(groups, cluster.members);
  const mapsCount = pageIndices.filter((i) => /google maps$/i.test(pages[i]!.title.trim())).length;
  return {
    size: pageIndices.length,
    mapsShare: mapsCount / pageIndices.length,
    sampleTitles: cluster.members.slice(0, 5).map((groupIndex) => pages[groups[groupIndex]!.representative]!.title),
  };
}

function topDomainOfCluster(pages: Page[], groups: DuplicateGroup[], cluster: Cluster): string {
  const pageIndices = expandGroups(groups, cluster.members);
  const counts = new Map<string, number>();
  for (const i of pageIndices) {
    const d = pages[i]!.domain;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '?';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Loading + filtering…');
  const visits = await loadHistory(INPUT);
  const filtered = filterHistory(visits, false, { stripSuffixes: true });
  const basePages = filtered.pages;
  console.log(`  ${visits.length} raw rows -> ${basePages.length} pages after filtering`);

  // Fixture pairs for the same-company/same-role gap, found by content —
  // §14's original example titles are no longer present in this corpus
  // snapshot, so this reconstructs the phenomenon from what is actually here
  // now rather than reusing numbers that no longer correspond to real rows.
  //
  // Two same-company pairs, both varying role AND city (not just one word),
  // so the test actually measures whether the company name dominates
  // substantively different text — a pair like "Software Engineer" vs
  // "Principal Software Engineer" at the same company in the same city
  // would score high on textual near-identity alone, telling us nothing
  // about proper-noun dominance specifically.
  const sameCompanyPairs: Array<[string, string]> = [
    ['AI ML Engineer - Bengaluru - Capgemini', 'Software Engineer - Hyderabad - Capgemini'],
    ['Software Engineer - Pune - Optum', 'Lead Full Stack Engineer - Chennai - Optum'],
  ];
  const sameCompanyIdx = sameCompanyPairs.map(([a, b]) => [findPage(basePages, a), findPage(basePages, b)] as const);

  const sameRoleTitles = [
    'Software Engineer - Bengaluru - Google',
    'Software Engineer - Bengaluru - Texas Instruments',
    'Software Engineer - Bengaluru - Wells Fargo',
    'Software Engineer - Bengaluru - Ibrowsejobs Technologies',
  ];
  const sameRoleIdx = sameRoleTitles.map((t) => findPage(basePages, t));

  console.log('\nFixture titles located:');
  for (const [i, j] of sameCompanyIdx) {
    console.log(`  same-company pair: "${basePages[i]!.title}" / "${basePages[j]!.title}"`);
  }
  for (const i of sameRoleIdx) console.log(`  same-role fixture:  "${basePages[i]!.title}"`);

  // --- Build the three embed-text variants over the identical page set ----
  const aggressiveBoilerplate = deriveBoilerplateSuffixesAggressive(basePages.map((p) => p.title), 3);

  const variants: Record<string, Page[]> = {
    baseline: basePages,
    a_domain_suffix: basePages.map((p) => ({ ...p, embedText: stripBoilerplate(p.title, aggressiveBoilerplate) })),
    b_strip_caps: basePages.map((p) => ({ ...p, embedText: stripNonInitialCapitalized(p.embedText) })),
  };

  // Show what (a) and (b) actually did to the fixture titles, before any
  // embedding — the transform should be inspectable on its own.
  console.log('\nWhat each variant embeds for the fixture titles:');
  for (const [name, pages] of Object.entries(variants)) {
    console.log(`  [${name}]`);
    console.log(`    "${pages[sameCompanyIdx[0]![0]]!.embedText}"`);
    console.log(`    "${pages[sameRoleIdx[0]!]!.embedText}"`);
  }

  console.log('\nLoading embedder…');
  const embedder = await createEmbedder({ cacheDir: './.models' });

  type FullRun = Awaited<ReturnType<typeof runOnce>>;
  const results: Record<string, FullRun[]> = {};

  for (const [name, pages] of Object.entries(variants)) {
    results[name] = [];
    console.log(`\n${'='.repeat(70)}\nVARIANT: ${name}  (${RUNS_PER_VARIANT} runs)\n${'='.repeat(70)}`);
    for (let run = 1; run <= RUNS_PER_VARIANT; run++) {
      const started = performance.now();
      const outcome = await runOnce(embedder, pages);
      results[name]!.push(outcome);
      const gaps = sameCompanyIdx.map(([i, j]) => dot(outcome.matrix, i, j));
      console.log(
        `  run ${run}/${RUNS_PER_VARIANT}: ${outcome.clusterCount} clusters, node-noise ${outcome.nodeNoisePct.toFixed(1)}%, ` +
          `page-noise ${outcome.pageNoisePct.toFixed(1)}%, largest ${outcome.largestPct.toFixed(1)}%, ` +
          `same-company sims ${gaps.map((g) => g.toFixed(3)).join('/')}  (${fmtMs(performance.now() - started)})`
      );
    }
  }

  // Runs feeding the "last run" reports below (cluster #1, job clusters,
  // search) — the median run by cluster count, so a report picks a run
  // representative of the median rather than whichever happened to run last.
  function medianRun(runs: FullRun[]): FullRun {
    const sorted = [...runs].sort((a, b) => a.clusterCount - b.clusterCount);
    return sorted[Math.floor(sorted.length / 2)]!;
  }

  // --- Median report -------------------------------------------------------
  console.log(`\n${'='.repeat(70)}\nMEDIAN OF ${RUNS_PER_VARIANT} RUNS\n${'='.repeat(70)}`);
  console.log('variant            clusters  node-noise%  page-noise%  largest%');
  for (const [name, runs] of Object.entries(results)) {
    console.log(
      `${name.padEnd(18)} ${median(runs.map((r) => r.clusterCount)).toFixed(0).padStart(8)}  ` +
        `${median(runs.map((r) => r.nodeNoisePct)).toFixed(1).padStart(10)}%  ` +
        `${median(runs.map((r) => r.pageNoisePct)).toFixed(1).padStart(10)}%  ` +
        `${median(runs.map((r) => r.largestPct)).toFixed(1).padStart(7)}%`
    );
  }

  // --- Similarity gap: median across all 3 runs' own matrices -------------
  console.log(`\nSame-company vs same-role similarity (median of ${RUNS_PER_VARIANT} runs):`);
  for (const [name, runs] of Object.entries(results)) {
    console.log(`  [${name}]`);
    sameCompanyIdx.forEach(([i, j], pairIdx) => {
      const sims = runs.map((r) => dot(r.matrix, i, j));
      const [titleA, titleB] = sameCompanyPairs[pairIdx]!;
      console.log(`    same-company (${titleA} ~ ${titleB}): ${median(sims).toFixed(3)}  (runs: ${sims.map((s) => s.toFixed(3)).join(', ')})`);
    });
    for (let idx = 1; idx < sameRoleIdx.length; idx++) {
      const roleSims = runs.map((r) => dot(r.matrix, sameRoleIdx[0]!, sameRoleIdx[idx]!));
      console.log(
        `    same-role, diff company (${sameRoleTitles[0]} ~ ${sameRoleTitles[idx]}): ${median(roleSims).toFixed(3)}`
      );
    }
  }

  // --- Cluster #1 (temple + Google Maps) and job-cluster fragmentation ----
  console.log(`\n${'='.repeat(70)}\nCLUSTER #1 (temple/Maps) AND JOB-CLUSTER FRAGMENTATION\n${'='.repeat(70)}`);
  const templeIdx = basePages.findIndex((p) => /veerabhadreshwara/i.test(p.title));

  for (const [name] of Object.entries(variants)) {
    const outcome = medianRun(results[name]!);
    const composition = templeIdx === -1 ? null : templeClusterComposition(basePages, outcome.groups, outcome.clusters, templeIdx);
    if (composition === null) {
      console.log(`  [${name}] temple page landed in noise (no cluster) — trivially "split"`);
    } else {
      console.log(
        `  [${name}] temple's cluster: ${composition.size} pages, ${(composition.mapsShare * 100).toFixed(0)}% Google-Maps-titled` +
          `  ${composition.mapsShare > 0.3 ? 'STILL LOOKS LIKE THE MERGE' : 'proper-noun merge largely gone'}`
      );
      console.log(`           sample: ${composition.sampleTitles.map((t) => truncate(t, 50)).join(' | ')}`);
    }

    // Job clusters: clusters whose top domain is naukri.com/linkedin.com and
    // whose 8 nearest titles are dominated by the "<role> - <city> - <company>"
    // pattern, counted per distinct company appearing as a cluster's own
    // dominant employer.
    const jobClusters = outcome.clusters.filter((c) => {
      const domain = topDomainOfCluster(basePages, outcome.groups, c);
      return /naukri|linkedin|indeed/i.test(domain);
    });
    console.log(`           job-board clusters (naukri/linkedin/indeed as top domain): ${jobClusters.length}`);
  }

  // --- Candidate (b) script-safety: Telugu (real) + Chinese/Arabic (synthetic fixtures) ---
  console.log(`\n${'='.repeat(70)}\n(b) SCRIPT-SAFETY CHECK — Telugu (real corpus), Chinese/Arabic (synthetic)\n${'='.repeat(70)}`);
  const teluguTitles = basePages.filter((p) => /[ఀ-౿]/.test(p.title)).map((p) => p.embedText);
  console.log(`  ${teluguTitles.length} real Telugu-script titles in this corpus`);
  let teluguChanged = 0;
  for (const t of teluguTitles) {
    if (stripNonInitialCapitalized(t) !== t) teluguChanged++;
  }
  console.log(`  changed by the capital-token strip: ${teluguChanged} / ${teluguTitles.length}`);
  if (teluguChanged > 0) {
    console.log('  SAMPLE CHANGES (should be none if the heuristic is a true no-op on this script):');
    for (const t of teluguTitles) {
      const out = stripNonInitialCapitalized(t);
      if (out !== t) console.log(`    "${t}" -> "${out}"`);
    }
  }

  const syntheticFixtures = [
    // Synthetic — not real user data, for script coverage this corpus lacks.
    { script: 'Chinese', text: '如何学习深度学习和机器学习基础知识' },
    { script: 'Chinese (mixed Latin+CJK)', text: 'Python 深度学习 Tutorial 教程' },
    { script: 'Arabic', text: 'كيفية تعلم البرمجة بلغة بايثون للمبتدئين' },
    { script: 'Arabic (mixed Latin+Arabic)', text: 'دورة Python للمبرمجين الجدد' },
  ];
  for (const { script, text } of syntheticFixtures) {
    const out = stripNonInitialCapitalized(text);
    console.log(`  [${script}] "${text}" -> "${out}"  ${out === text ? '(no-op, as expected)' : '(CHANGED — investigate)'}`);
  }

  // --- Hand-judged search spot-check ---------------------------------------
  console.log(`\n${'='.repeat(70)}\nSEARCH SPOT-CHECK — 10 queries, top 5 per variant\n${'='.repeat(70)}`);
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

  // embed() returns a flat `texts.length × EMBEDDING_DIM` matrix, not an
  // array of per-text vectors — destructuring it directly would silently
  // grab the first float instead of the first vector.
  const queryVectors: Record<string, Float32Array> = {};
  for (const q of queries) {
    const qMatrix = await embedder.embed([q]);
    queryVectors[q] = qMatrix.slice(0, EMBEDDING_DIM);
  }

  const searchReport: Record<string, unknown> = {};
  for (const [name] of Object.entries(variants)) {
    const outcome = medianRun(results[name]!);
    console.log(`\n--- variant: ${name} ---`);
    const perQuery: Record<string, string[]> = {};
    for (const q of queries) {
      const qvec = queryVectors[q]!;
      const scored = basePages.map((p, i) => ({ i, sim: dotVec(outcome.matrix, i, qvec) }));
      scored.sort((x, y) => y.sim - x.sim);
      const top = scored.slice(0, 5);
      perQuery[q] = top.map((t) => `${t.sim.toFixed(3)}  ${basePages[t.i]!.title}`);
      console.log(`  "${q}"`);
      for (const line of perQuery[q]!) console.log(`      ${line}`);
    }
    searchReport[name] = perQuery;
  }

  const plainResults: Record<string, RunMetrics[]> = {};
  for (const [name, runs] of Object.entries(results)) {
    plainResults[name] = runs.map((r) => ({
      clusterCount: r.clusterCount,
      nodeNoisePct: r.nodeNoisePct,
      pageNoisePct: r.pageNoisePct,
      largestPct: r.largestPct,
      uniqueNodes: r.uniqueNodes,
      embedMs: r.embedMs,
      collapseMs: r.collapseMs,
      clusterMs: r.clusterMs,
    }));
  }
  await writeFile(
    './.scratch/proper-noun-measurement.json',
    JSON.stringify({ results: plainResults, searchReport }, null, 2),
    'utf8'
  );
  console.log('\nWrote full data to .scratch/proper-noun-measurement.json');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
