/**
 * Phase 0 — validation harness (CLAUDE.md §11).
 *
 * A thin CLI over src/lib. Answers the single riskiest question in the project:
 *
 *   do title embeddings, clustered, read like the developer's actual life?
 *
 * If the clusters come out as "Technology" / "Programming" / "Web Development",
 * the premise is broken and it needs fixing here rather than after four weeks
 * of infrastructure.
 *
 * The pipeline itself lives in src/lib and is shared with the extension. What
 * stays here is Node-only: file IO, argument parsing, table printing, the
 * comparison algorithms, and the sweep harness.
 *
 *   npm run validate -- --help
 */

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';

import {
  buildNeighbourCache,
  centroidOf,
  clusterByMutualKnn,
  collapseNearDuplicates,
  componentsFromCache,
  createEmbedder,
  describeCluster,
  dot,
  dotVec,
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  expandGroups,
  filterHistory,
} from '../src/lib/index.js';
import type {
  Cluster,
  DuplicateGroup,
  FilterStats,
  NeighbourCache,
  Page,
  RawVisit,
} from '../src/lib/index.js';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: flags } = parseArgs({
  options: {
    input: { type: 'string', default: './history-export.json' },
    algo: { type: 'string', default: 'knn' },
    knn: { type: 'string', default: '6' },
    shared: { type: 'string' },
    threshold: { type: 'string', default: '0.35' },
    'min-cluster-size': { type: 'string', default: '5' },
    k: { type: 'string' },
    'min-sim': { type: 'string', default: '0.20' },
    'dup-threshold': { type: 'string', default: '0.97' },
    sweep: { type: 'boolean', default: false },
    'list-junk': { type: 'boolean', default: false },
    seed: { type: 'string', default: '42' },
    limit: { type: 'string' },
    'strip-suffixes': { type: 'boolean', default: true },
    'no-strip-suffixes': { type: 'boolean', default: false },
    'noise-sample': { type: 'string', default: '15' },
    json: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  strict: true,
});

if (flags.help) {
  console.log(`
Phase 0 validation harness — cluster your browsing history by title embedding.

  npm run validate -- [options]

  --input <path>            history export (default ./history-export.json)
  --algo <knn|community|kmeans>
                            clustering algorithm (default knn)
  --knn <n>                 knn: neighbours per page in the mutual-kNN graph (default 6)
  --shared <n>              knn: neighbours two pages must share to stay linked.
                            Raise it to break up over-merged clusters (default k/3)
  --threshold <n>           community: min cosine similarity to be neighbours (default 0.35)
  --min-cluster-size <n>    clusters smaller than this become noise (default 5)
  --k <n>                   kmeans: number of centroids (default round(sqrt(n/2)))
  --min-sim <n>             floor: knn edges, and kmeans distance-to-centroid, below
                            this similarity are discarded as noise (default 0.20)
  --dup-threshold <n>       collapse pages at or above this cosine into one node
                            before clustering (default 0.97; 1.1 disables)
  --sweep                   grid-search k and --shared on the collapsed set and
                            print a comparison table instead of clustering once
  --seed <n>                kmeans: RNG seed, for reproducible runs (default 42)
  --limit <n>               only process the n most recent pages (fast iteration)
  --no-strip-suffixes       keep data-derived boilerplate title suffixes ("- YouTube")
  --noise-sample <n>        how many noise titles to print (default 15)
  --json <path>             also write the full clustering to a JSON file
`);
  process.exit(0);
}

const OPTS = {
  input: flags.input!,
  algo: flags.algo!,
  knn: Number(flags.knn),
  shared: flags.shared === undefined ? Math.max(1, Math.floor(Number(flags.knn) / 3)) : Number(flags.shared),
  threshold: Number(flags.threshold),
  minClusterSize: Number(flags['min-cluster-size']),
  k: flags.k === undefined ? undefined : Number(flags.k),
  minSim: Number(flags['min-sim']),
  dupThreshold: Number(flags['dup-threshold']),
  sweep: flags.sweep!,
  listJunk: flags['list-junk']!,
  seed: Number(flags.seed),
  limit: flags.limit === undefined ? undefined : Number(flags.limit),
  stripSuffixes: flags['strip-suffixes']! && !flags['no-strip-suffixes'],
  noiseSample: Number(flags['noise-sample']),
  json: flags.json,
};

if (OPTS.algo !== 'knn' && OPTS.algo !== 'community' && OPTS.algo !== 'kmeans') {
  fail(`unknown --algo "${OPTS.algo}" (expected "knn", "community", or "kmeans")`);
}

// Re-exported from src/lib so the CLI and the extension cannot drift apart.
const MODEL = EMBEDDING_MODEL;
const DIM = EMBEDDING_DIM;
const BATCH_SIZE = EMBEDDING_BATCH_SIZE;

// ---------------------------------------------------------------------------
// Loading — sniff whichever export shape we were handed
// ---------------------------------------------------------------------------

interface LoadResult {
  visits: RawVisit[];
  shape: string;
  /** true when the export is one row per visit, so visitCount must be derived */
  perVisit: boolean;
}

async function loadHistory(path: string): Promise<LoadResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      fail(
        `no history export at ${path}\n\n` +
          `  Two ways to get one:\n` +
          `    npm run export-history          read Chrome's local history DB (fastest, stays local)\n` +
          `    Google Takeout > Chrome > History, then point --input at BrowserHistory.json\n`
      );
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(text);

  // Google Takeout: { "Browser History": [ { title, url, time_usec } ] }
  if (parsed && typeof parsed === 'object' && 'Browser History' in parsed) {
    const rows = (parsed as Record<string, unknown>)['Browser History'];
    if (!Array.isArray(rows)) fail('"Browser History" key is not an array');
    return {
      visits: (rows as Record<string, unknown>[]).map((row) => ({
        url: String(row['url'] ?? ''),
        title: String(row['title'] ?? ''),
        lastVisit: Math.floor(Number(row['time_usec'] ?? 0) / 1000),
      })),
      shape: 'Google Takeout (per-visit)',
      perVisit: true,
    };
  }

  // chrome.history.search() dump, or our own exporter: [ { url, title, ... } ]
  const rows: unknown = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? ((parsed as Record<string, unknown>)['items'] ?? (parsed as Record<string, unknown>)['history'])
      : undefined;

  if (!Array.isArray(rows)) {
    fail(
      'unrecognised export shape — expected a top-level array, or an object with ' +
        '"Browser History", "items", or "history"'
    );
  }

  const list = rows as Record<string, unknown>[];
  const hasVisitCount = list.some((row) => typeof row['visitCount'] === 'number');
  return {
    visits: list.map((row) => {
      const visit: RawVisit = {
        url: String(row['url'] ?? ''),
        title: String(row['title'] ?? ''),
        lastVisit: Number(row['lastVisitTime'] ?? row['last_visit_time'] ?? row['time'] ?? 0),
      };
      if (typeof row['visitCount'] === 'number') visit.visitCount = row['visitCount'];
      if (typeof row['typedCount'] === 'number') visit.typedCount = row['typedCount'];
      return visit;
    }),
    shape: hasVisitCount ? 'chrome.history items' : 'generic array (no visitCount — deriving)',
    perVisit: !hasVisitCount,
  };
}



function reportBoilerplate(boilerplate: Map<string, number>): void {
  if (boilerplate.size === 0) return;
  const top = [...boilerplate.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`\n  derived ${boilerplate.size} boilerplate title suffixes, stripped before embedding:`);
  console.log(
    '    ' + top.map(([suffix, count]) => `${suffix} (${count})`).join(', ') + (boilerplate.size > 12 ? ', …' : '')
  );
}

// ---------------------------------------------------------------------------
// Embedding — the lib does the inference; the progress bar is Node's business
// ---------------------------------------------------------------------------

async function embedTitles(texts: string[]): Promise<Float32Array> {
  console.log(`  loading ${MODEL} (quantized, ~23MB — downloaded once)…`);
  const embedder = await createEmbedder({ cacheDir: './.models' });

  const startedAt = performance.now();
  const isTty = process.stdout.isTTY === true;

  const matrix = await embedder.embed(texts, (done, total) => {
    const elapsed = (performance.now() - startedAt) / 1000;
    const rate = done / elapsed;
    const eta = (total - done) / rate;
    const line = `  [embed] ${done}/${total} (${((done / total) * 100).toFixed(1)}%) · ${rate.toFixed(1)} titles/s · eta ${eta.toFixed(0)}s`;

    // The old loop logged on `offset % (BATCH_SIZE * 10) === 0`, where offset
    // was the batch's start index. Recovering it from `done` keeps the non-TTY
    // cadence byte-identical.
    const offset = Math.floor((done - 1) / BATCH_SIZE) * BATCH_SIZE;
    if (isTty) process.stdout.write(`\r${line.padEnd(78)}`);
    else if (offset % (BATCH_SIZE * 10) === 0 || done === total) console.log(line);
  });

  if (isTty) process.stdout.write('\n');
  return matrix;
}



// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/**
 * Reports the pairwise-similarity distribution over a deterministic sample.
 * MiniLM cosine on short titles lands far lower than intuition suggests — on
 * real history the median pair sits near 0.02 and same-topic pairs near 0.20 —
 * so any absolute threshold has to be read off the data, not guessed.
 */
function similarityProfile(matrix: Float32Array, count: number): string {
  const random = mulberry32(7);
  const target = Math.min(200_000, (count * (count - 1)) / 2);
  const samples = new Float64Array(target);
  for (let s = 0; s < target; s++) {
    let i = Math.floor(random() * count);
    let j = Math.floor(random() * count);
    if (i === j) j = (j + 1) % count;
    samples[s] = dot(matrix, i, j);
  }
  samples.sort();
  const at = (p: number) => samples[Math.min(target - 1, Math.floor(target * p))]!.toFixed(3);
  return `p50=${at(0.5)}  p90=${at(0.9)}  p99=${at(0.99)}  p99.9=${at(0.999)}  max=${at(1)}  (${target} sampled pairs)`;
}



/** Proves the cache path reproduces the untouched original exactly. */
function assertCacheMatchesReference(
  matrix: Float32Array,
  cache: NeighbourCache,
  count: number,
  combos: Array<[number, number, number]>
): void {
  for (const [k, shared, floor] of combos) {
    const options = { k, sharedMin: shared, minSim: floor, minClusterSize: OPTS.minClusterSize };
    const reference = clusterByMutualKnn(matrix, count, options);
    const fast = componentsFromCache(cache, count, options);
    const referenceShape = reference.clusters.map((c) => [...c.members].sort((a, b) => a - b).join(',')).sort();
    const fastShape = fast.components.map((c) => [...c].sort((a, b) => a - b).join(',')).sort();
    if (referenceShape.join('|') !== fastShape.join('|') || reference.noise.join(',') !== fast.noise.join(',')) {
      fail(`sweep fast path diverged from clusterByMutualKnn at k=${k} shared=${shared} min-sim=${floor}`);
    }
  }
}

/**
 * Community detection against an absolute cosine threshold. For every point,
 * collect everything within `threshold`; keep neighbourhoods at least
 * `minClusterSize` strong; take them largest-first, skipping claimed points.
 *
 * Kept as a comparison arm — it produces tighter, more conservative clusters
 * than mutual-kNN and cannot chain, at the cost of a threshold that has to be
 * retuned per dataset.
 */
function clusterByCommunity(
  matrix: Float32Array,
  count: number,
  threshold: number,
  minClusterSize: number
): { clusters: Cluster[]; noise: number[] } {
  const neighbours: number[][] = Array.from({ length: count }, () => []);
  let edgeCount = 0;

  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (dot(matrix, i, j) >= threshold) {
        neighbours[i]!.push(j);
        neighbours[j]!.push(i);
        edgeCount++;
        if (edgeCount > 40_000_000) {
          fail(`--threshold ${threshold} is too low for ${count} pages (edge explosion). Raise it.`);
        }
      }
    }
  }

  const candidates: number[][] = [];
  for (let i = 0; i < count; i++) {
    const group = neighbours[i]!;
    if (group.length + 1 >= minClusterSize) candidates.push([i, ...group]);
  }
  candidates.sort((a, b) => b.length - a.length);

  const assigned = new Uint8Array(count);
  const clusters: Cluster[] = [];

  for (const candidate of candidates) {
    const free = candidate.filter((index) => assigned[index] === 0);
    if (free.length < minClusterSize) continue;
    for (const index of free) assigned[index] = 1;
    clusters.push(describeCluster(matrix, free));
  }

  const noise: number[] = [];
  for (let i = 0; i < count; i++) if (assigned[i] === 0) noise.push(i);

  clusters.sort((a, b) => b.members.length - a.members.length);
  return { clusters, noise };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Spherical k-means, the fallback §5 names. Centroids are renormalized each
 * iteration so the objective stays cosine. Points too far from their own
 * centroid, and clusters below `minClusterSize`, fall out as noise.
 */
function clusterByKMeans(
  matrix: Float32Array,
  count: number,
  k: number,
  minSim: number,
  minClusterSize: number,
  seed: number
): { clusters: Cluster[]; noise: number[] } {
  const random = mulberry32(seed);
  const centroids = new Float32Array(k * DIM);

  // k-means++ seeding.
  const first = Math.floor(random() * count);
  centroids.set(matrix.subarray(first * DIM, first * DIM + DIM), 0);
  const bestSim = new Float32Array(count).fill(-1);

  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < count; i++) {
      const sim = dotVec(matrix, i, centroids.subarray((c - 1) * DIM, c * DIM) as Float32Array);
      if (sim > bestSim[i]!) bestSim[i] = sim;
      total += Math.max(0, 1 - bestSim[i]!);
    }
    let target = random() * total;
    let picked = count - 1;
    for (let i = 0; i < count; i++) {
      target -= Math.max(0, 1 - bestSim[i]!);
      if (target <= 0) {
        picked = i;
        break;
      }
    }
    centroids.set(matrix.subarray(picked * DIM, picked * DIM + DIM), c * DIM);
  }

  const assignment = new Int32Array(count).fill(-1);

  for (let iteration = 0; iteration < 30; iteration++) {
    let moved = 0;
    for (let i = 0; i < count; i++) {
      let best = -1;
      let bestScore = -Infinity;
      for (let c = 0; c < k; c++) {
        const score = dotVec(matrix, i, centroids.subarray(c * DIM, c * DIM + DIM) as Float32Array);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (assignment[i] !== best) moved++;
      assignment[i] = best;
    }

    centroids.fill(0);
    for (let i = 0; i < count; i++) {
      const base = assignment[i]! * DIM;
      const src = i * DIM;
      for (let d = 0; d < DIM; d++) centroids[base + d]! += matrix[src + d]!;
    }
    for (let c = 0; c < k; c++) {
      let norm = 0;
      for (let d = 0; d < DIM; d++) norm += centroids[c * DIM + d]! ** 2;
      norm = Math.sqrt(norm);
      if (norm === 0) {
        // Empty cluster — reseed it on a random point rather than losing it.
        const reseed = Math.floor(random() * count);
        centroids.set(matrix.subarray(reseed * DIM, reseed * DIM + DIM), c * DIM);
        continue;
      }
      for (let d = 0; d < DIM; d++) centroids[c * DIM + d]! /= norm;
    }

    if (moved === 0) break;
  }

  const buckets: number[][] = Array.from({ length: k }, () => []);
  const noise: number[] = [];
  for (let i = 0; i < count; i++) {
    const c = assignment[i]!;
    const sim = dotVec(matrix, i, centroids.subarray(c * DIM, c * DIM + DIM) as Float32Array);
    if (sim < minSim) noise.push(i);
    else buckets[c]!.push(i);
  }

  const clusters: Cluster[] = [];
  for (const bucket of buckets) {
    if (bucket.length < minClusterSize) {
      noise.push(...bucket);
      continue;
    }
    clusters.push(describeCluster(matrix, bucket));
  }

  clusters.sort((a, b) => b.members.length - a.members.length);
  noise.sort((a, b) => a - b);
  return { clusters, noise };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function topDomains(pages: Page[], members: number[], limit = 3): string {
  const counts = new Map<string, number>();
  for (const index of members) {
    const domain = pages[index]!.domain;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([domain, count]) => `${domain} (${count})`)
    .join(', ');
}

/** Group indices -> every page they stand for. */

function printClusters(
  pages: Page[],
  groups: DuplicateGroup[],
  clusters: Cluster[],
  noise: number[]
): void {
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`CLUSTERS — ${clusters.length} found, 8 nearest-centroid titles each`);
  console.log('═'.repeat(78));

  clusters.forEach((cluster, position) => {
    const nodes = cluster.members.length;
    const pageIndices = expandGroups(groups, cluster.members);
    const collapsedNote = pageIndices.length === nodes ? '' : ` (${nodes} unique)`;
    console.log(
      `\n[${String(position + 1).padStart(2)}] ${pageIndices.length} page${pageIndices.length === 1 ? '' : 's'}${collapsedNote}  ·  ${topDomains(pages, pageIndices)}`
    );
    cluster.members.slice(0, 8).forEach((groupIndex, rank) => {
      const group = groups[groupIndex]!;
      const page = pages[group.representative]!;
      const revisits = page.visitCount > 1 ? `  (${page.visitCount}×)` : '';
      // ×N marks a collapsed near-duplicate set, so the display never hides
      // that several URLs stood behind one line.
      const collapsed = group.members.length > 1 ? `  ×${group.members.length}` : '';
      // Display the original title, not embedText. Stripping a suffix that is
      // also the topic — react.dev titles every page "… – React" — would leave
      // a cluster reading "Quick Start / useEffect / Managing State" with no
      // sign of what it is about, and a human reading these is the whole point
      // of Phase 0. What gets embedded is unchanged.
      console.log(`     ${cluster.sims[rank]!.toFixed(3)}  ${truncate(page.title, 56)}${collapsed}${revisits}`);
    });
    if (nodes > 8) console.log(`            … and ${nodes - 8} more`);
  });

  const noisePages = expandGroups(groups, noise);
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`NOISE — ${noisePages.length} unclustered pages (${noise.length} unique)`);
  console.log('═'.repeat(78));
  if (noise.length > 0 && OPTS.noiseSample > 0) {
    for (const groupIndex of noise.slice(0, OPTS.noiseSample)) {
      const group = groups[groupIndex]!;
      const collapsed = group.members.length > 1 ? `  ×${group.members.length}` : '';
      console.log(`     ${truncate(pages[group.representative]!.title, 62)}${collapsed}`);
    }
    if (noise.length > OPTS.noiseSample) console.log(`     … and ${noise.length - OPTS.noiseSample} more`);
  }
}

interface SweepRow {
  minSim: number;
  k: number;
  shared: number;
  clusters: number;
  noisePct: number;
  medianSize: number;
  largestPages: number;
  /** Largest cluster as a share of unique nodes — the chaining alarm. */
  largestPct: number;
  inBand: boolean;
  score: number;
}

const BAND = { minClusters: 30, maxClusters: 80, maxNoisePct: 35, maxLargestPct: 10 };

/**
 * Fix 3: k, shared and min-sim were all tuned on synthetic data with no
 * duplicates in it. Sweeps the full grid on the collapsed set.
 *
 * min-sim is on the grid because an absolute cosine floor is the same
 * transferability problem as an absolute clustering threshold (§14): at 0.20 it
 * sits on the measured within-topic median of 0.194 and cuts roughly half of
 * all genuine same-topic pairs before k or shared ever apply.
 *
 * Lowering the floor reintroduces the chaining that the shared-neighbour test
 * exists to prevent, so `largest%` is reported against unique nodes — if one
 * cluster starts swallowing the graph it shows up there first.
 */
function printSweep(repMatrix: Float32Array, groups: DuplicateGroup[], totalPages: number): void {
  const minSimValues = [0.05, 0.1, 0.15, 0.2];
  const kValues = [4, 6, 8, 10, 12, 15];
  const sharedValues = [1, 2, 3, 4];
  const nodes = groups.length;

  const maxK = Math.max(...kValues);
  const cacheStart = performance.now();
  const cache = buildNeighbourCache(repMatrix, nodes, maxK);
  console.log(`\n  neighbour cache: top-${maxK} for ${nodes} nodes in ${fmt(performance.now() - cacheStart)}`);

  // Spot-check the fast path against the untouched reference implementation.
  assertCacheMatchesReference(repMatrix, cache, nodes, [
    [6, 2, 0.2],
    [10, 1, 0.05],
    [4, 3, 0.15],
  ]);
  console.log(`  fast path verified identical to clusterByMutualKnn on 3 spot checks`);

  const rows: SweepRow[] = [];
  for (const minSim of minSimValues) {
    for (const k of kValues) {
      for (const shared of sharedValues) {
        if (shared >= k) continue;
        const { components, noise } = componentsFromCache(cache, nodes, {
          k,
          sharedMin: shared,
          minSim,
          minClusterSize: OPTS.minClusterSize,
        });
        const sizes = components.map((members) => expandGroups(groups, members).length).sort((a, b) => a - b);
        const noisePct = (expandGroups(groups, noise).length / totalPages) * 100;
        const medianSize = sizes.length === 0 ? 0 : sizes[Math.floor(sizes.length / 2)]!;
        const largestPages = sizes.length === 0 ? 0 : sizes[sizes.length - 1]!;
        const largestNodes = components.length === 0 ? 0 : components[0]!.length;
        const largestPct = (largestNodes / nodes) * 100;

        const inBand =
          components.length >= BAND.minClusters &&
          components.length <= BAND.maxClusters &&
          noisePct < BAND.maxNoisePct &&
          largestPct < BAND.maxLargestPct;

        // Lower is better. Out-of-band rows rank by how far out they are, so
        // near-misses sit above collapses.
        const clusterMiss =
          components.length < BAND.minClusters
            ? BAND.minClusters - components.length
            : Math.max(0, components.length - BAND.maxClusters);
        const score =
          (inBand ? 0 : 1000) +
          clusterMiss +
          Math.max(0, noisePct - BAND.maxNoisePct) * 2 +
          Math.max(0, largestPct - BAND.maxLargestPct) * 4 +
          (inBand ? noisePct : 0);

        rows.push({ minSim, k, shared, clusters: components.length, noisePct, medianSize, largestPages, largestPct, inBand, score });
      }
    }
  }

  rows.sort((a, b) => a.score - b.score);

  const header = '   min-sim   k  shared  clusters   noise%   median   largest   largest%';
  const line = (row: SweepRow): string =>
    `     ${row.minSim.toFixed(2)}  ${String(row.k).padStart(2)}  ${String(row.shared).padStart(6)}  ` +
    `${String(row.clusters).padStart(8)}   ${row.noisePct.toFixed(1).padStart(5)}%   ` +
    `${String(row.medianSize).padStart(6)}   ${String(row.largestPages).padStart(7)}   ` +
    `${row.largestPct.toFixed(1).padStart(6)}%${row.inBand ? '  ←' : ''}`;

  console.log(`\n${'─'.repeat(78)}`);
  console.log(`SWEEP — ${nodes} unique nodes, ${totalPages} pages, min-cluster-size=${OPTS.minClusterSize}`);
  console.log(`        ${rows.length} combinations, best first`);
  console.log('─'.repeat(78));
  console.log(header);
  for (const row of rows) console.log(line(row));

  console.log(`\n  ← in band: ${BAND.minClusters}–${BAND.maxClusters} clusters, noise < ${BAND.maxNoisePct}%, largest < ${BAND.maxLargestPct}% of unique nodes`);
  console.log(`  largest% is of unique nodes, not pages — it is the chaining alarm.`);

  const inBandCount = rows.filter((row) => row.inBand).length;
  console.log(`\n${'─'.repeat(78)}`);
  console.log(`TOP 5${inBandCount === 0 ? '  (none in band — showing closest)' : ` of ${inBandCount} in band`}`);
  console.log('─'.repeat(78));
  console.log(header);
  for (const row of rows.slice(0, 5)) console.log(line(row));

  const best = rows[0];
  if (best !== undefined) {
    console.log(
      `\n  rerun the best with:\n` +
        `    npm run validate -- --knn ${best.k} --shared ${best.shared} --min-sim ${best.minSim}\n`
    );
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function printFilterReport(stats: FilterStats, shape: string): void {
  const rows: Array<[string, number]> = [
    ['raw rows', stats.raw],
    ['− unparseable / non-URL', -stats.droppedNoUrl],
    ['− non-http scheme (chrome://, file:, …)', -stats.droppedScheme],
    ['− localhost / private network', -stats.droppedLocal],
    ['− search-result pages', -stats.droppedSearch],
    ['− duplicates after normalization', -stats.droppedDuplicate],
    ['− junk titles (auth, errors, interstitials)', -stats.droppedJunkTitle],
    ['− title < 15 chars', -stats.droppedShortTitle],
    ['= kept', stats.kept],
  ];
  console.log(`\n  source shape: ${shape}`);
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(42)}${String(value).padStart(8)}`);
  }
  const retained = stats.raw === 0 ? 0 : (stats.kept / stats.raw) * 100;
  console.log(`  ${'retention'.padEnd(42)}${`${retained.toFixed(1)}%`.padStart(8)}`);
}

function fmt(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function fail(message: string): never {
  console.error(`\n  error: ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const timings: Array<[string, number]> = [];
  const totalStart = performance.now();

  console.log('\nPhase 0 — history clustering validation');
  console.log('─'.repeat(78));

  // 1. Load
  let mark = performance.now();
  const { visits, shape, perVisit } = await loadHistory(OPTS.input);
  timings.push(['load', performance.now() - mark]);

  // 2. Filter
  mark = performance.now();
  const filtered = filterHistory(visits, perVisit, { stripSuffixes: OPTS.stripSuffixes });
  let { pages } = filtered;
  const { stats, boilerplate, junkDropped } = filtered;
  timings.push(['filter', performance.now() - mark]);
  // Printed here rather than inside filterHistory: src/lib must stay silent so
  // it can run in the offscreen document.
  reportBoilerplate(boilerplate);
  printFilterReport(stats, shape);

  if (OPTS.listJunk) {
    const counts = new Map<string, number>();
    for (const title of junkDropped) counts.set(title, (counts.get(title) ?? 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`\n  ${sorted.length} distinct titles dropped as junk (${junkDropped.length} pages):\n`);
    for (const [title, count] of sorted) console.log(`  ${String(count).padStart(4)}  ${title.slice(0, 68)}`);
    return;
  }

  if (OPTS.limit !== undefined && pages.length > OPTS.limit) {
    pages = pages.slice(0, OPTS.limit);
    console.log(`\n  --limit ${OPTS.limit}: using the ${pages.length} most recent pages`);
  }
  if (pages.length < OPTS.minClusterSize) {
    fail(`only ${pages.length} pages survived filtering — not enough to cluster`);
  }

  const oldest = new Date(Math.min(...pages.map((p) => p.lastVisit)));
  const newest = new Date(Math.max(...pages.map((p) => p.lastVisit)));
  console.log(`  window: ${oldest.toISOString().slice(0, 10)} → ${newest.toISOString().slice(0, 10)}`);

  // 3. Embed
  console.log(`\n  embedding ${pages.length} titles in batches of ${BATCH_SIZE}…`);
  mark = performance.now();
  const matrix = await embedTitles(pages.map((page) => page.embedText));
  const embedMs = performance.now() - mark;
  timings.push(['embed', embedMs]);

  // 4. Collapse near-duplicates before clustering.
  console.log(`\n  pairwise similarity: ${similarityProfile(matrix, pages.length)}`);

  mark = performance.now();
  const { groups, repMatrix } = collapseNearDuplicates(matrix, pages, OPTS.dupThreshold);
  timings.push(['collapse', performance.now() - mark]);

  const collapsedAway = pages.length - groups.length;
  console.log(
    `  collapsed: ${pages.length} pages → ${groups.length} unique nodes ` +
      `(−${collapsedAway}, ${((collapsedAway / pages.length) * 100).toFixed(1)}%, at ≥ ${OPTS.dupThreshold} cosine)`
  );

  const biggest = [...groups].sort((a, b) => b.members.length - a.members.length).slice(0, 5);
  if (biggest[0] !== undefined && biggest[0].members.length > 1) {
    console.log('  largest collapsed sets:');
    for (const group of biggest) {
      if (group.members.length < 2) continue;
      console.log(`    ×${String(group.members.length).padStart(3)}  ${truncate(pages[group.representative]!.title, 60)}`);
    }
  }

  if (groups.length < OPTS.minClusterSize) {
    fail(`only ${groups.length} unique nodes after collapse — not enough to cluster`);
  }

  if (OPTS.sweep) {
    printSweep(repMatrix, groups, pages.length);
    console.log(`\n  timings`);
    for (const [stage, ms] of timings) console.log(`    ${stage.padEnd(16)}${fmt(ms).padStart(10)}`);
    console.log(`    ${'TOTAL'.padEnd(16)}${fmt(performance.now() - totalStart).padStart(10)}\n`);
    return;
  }

  // 5. Cluster the representatives.
  const k = OPTS.k ?? Math.min(60, Math.max(2, Math.round(Math.sqrt(groups.length / 2))));
  const settings =
    OPTS.algo === 'kmeans'
      ? `kmeans · k=${k} · min-sim=${OPTS.minSim} · min-cluster-size=${OPTS.minClusterSize} · seed=${OPTS.seed}`
      : OPTS.algo === 'community'
        ? `community · threshold=${OPTS.threshold} · min-cluster-size=${OPTS.minClusterSize}`
        : `mutual-kNN + shared-neighbour · k=${OPTS.knn} · shared=${OPTS.shared} · min-sim=${OPTS.minSim} · min-cluster-size=${OPTS.minClusterSize}`;
  console.log(`  clustering: ${settings}`);

  mark = performance.now();
  let graphLine: string | null = null;
  let result: { clusters: Cluster[]; noise: number[] };

  if (OPTS.algo === 'kmeans') {
    result = clusterByKMeans(repMatrix, groups.length, k, OPTS.minSim, OPTS.minClusterSize, OPTS.seed);
  } else if (OPTS.algo === 'community') {
    result = clusterByCommunity(repMatrix, groups.length, OPTS.threshold, OPTS.minClusterSize);
  } else {
    const knn = clusterByMutualKnn(repMatrix, groups.length, {
      k: OPTS.knn,
      sharedMin: OPTS.shared,
      minSim: OPTS.minSim,
      minClusterSize: OPTS.minClusterSize,
    });
    result = knn;
    // These counts used to be logged from inside the clustering function.
    // src/lib prints nothing, so the CLI reports them instead.
    graphLine = `  graph: ${knn.mutualEdges} edges kept, ${knn.bridgesCut} bridges cut by the shared-neighbour test, ${knn.components} components`;
  }
  timings.push(['cluster', performance.now() - mark]);
  if (graphLine !== null) console.log(graphLine);

  // 6. Report — members expanded back out of their representatives.
  printClusters(pages, groups, result.clusters, result.noise);

  const noisePages = expandGroups(groups, result.noise).length;
  const clustered = pages.length - noisePages;
  console.log(`\n${'─'.repeat(78)}`);
  console.log('SUMMARY');
  console.log(`  raw rows          ${stats.raw}`);
  console.log(`  after filtering   ${stats.kept}${OPTS.limit !== undefined ? ` (embedded ${pages.length})` : ''}`);
  console.log(`  unique nodes      ${groups.length} (after near-duplicate collapse)`);
  console.log(`  clusters          ${result.clusters.length}`);
  console.log(
    `  clustered         ${clustered} pages (${((clustered / pages.length) * 100).toFixed(1)}%)   noise ${noisePages} (${((noisePages / pages.length) * 100).toFixed(1)}%)`
  );
  console.log('\n  timings');
  for (const [stage, ms] of timings) console.log(`    ${stage.padEnd(16)}${fmt(ms).padStart(10)}`);
  console.log(`    ${'per title'.padEnd(16)}${`${(embedMs / pages.length).toFixed(1)}ms`.padStart(10)}  (embed)`);
  console.log(`    ${'TOTAL'.padEnd(16)}${fmt(performance.now() - totalStart).padStart(10)}`);

  if (OPTS.json !== undefined) {
    await writeFile(
      OPTS.json,
      JSON.stringify(
        {
          settings,
          stats,
          uniqueNodes: groups.length,
          clusters: result.clusters.map((cluster) => ({
            nodes: cluster.members.length,
            size: expandGroups(groups, cluster.members).length,
            topDomains: topDomains(pages, expandGroups(groups, cluster.members), 5),
            nodeList: cluster.members.map((groupIndex, rank) => {
              const group = groups[groupIndex]!;
              const page = pages[group.representative]!;
              return {
                title: page.title,
                embedded: page.embedText,
                url: page.normalizedUrl,
                visitCount: page.visitCount,
                collapsed: group.members.length,
                simToCentroid: Number(cluster.sims[rank]!.toFixed(4)),
                // Every URL this node stands for, so a collapse can be audited.
                members: group.members.map((index) => pages[index]!.normalizedUrl),
              };
            }),
          })),
          noise: result.noise.map((groupIndex) => {
            const group = groups[groupIndex]!;
            const page = pages[group.representative]!;
            return {
              title: page.title,
              embedded: page.embedText,
              url: page.normalizedUrl,
              collapsed: group.members.length,
            };
          }),
        },
        null,
        2
      ),
      'utf8'
    );
    console.log(`\n  wrote ${OPTS.json}`);
  }

  console.log(
    `\n  Exit criterion (§11): do these read like your actual life, or like\n` +
      `  "Technology" / "Programming" / "Web Development"? If the latter, fix it here.\n`
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
