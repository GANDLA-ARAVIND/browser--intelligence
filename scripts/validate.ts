/**
 * Phase 0 — validation harness (CLAUDE.md §11).
 *
 * Standalone Node. No extension code, no LLM, no network beyond the one-time
 * MiniLM weight download. Answers the single riskiest question in the project:
 *
 *   do title embeddings, clustered, read like the developer's actual life?
 *
 * If the clusters come out as "Technology" / "Programming" / "Web Development",
 * the premise is broken and it needs fixing here rather than after four weeks
 * of infrastructure.
 *
 *   npm run validate -- --help
 */

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';

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
  seed: Number(flags.seed),
  limit: flags.limit === undefined ? undefined : Number(flags.limit),
  stripSuffixes: flags['strip-suffixes']! && !flags['no-strip-suffixes'],
  noiseSample: Number(flags['noise-sample']),
  json: flags.json,
};

if (OPTS.algo !== 'knn' && OPTS.algo !== 'community' && OPTS.algo !== 'kmeans') {
  fail(`unknown --algo "${OPTS.algo}" (expected "knn", "community", or "kmeans")`);
}

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;
const BATCH_SIZE = 32;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One row of whatever the export happened to be, after shape sniffing. */
interface RawVisit {
  url: string;
  title: string;
  /** unix ms */
  lastVisit: number;
  /** absent in per-visit exports; derived by counting rows */
  visitCount?: number;
  typedCount?: number;
}

/** A survivor of the filter chain. */
interface Page {
  url: string;
  normalizedUrl: string;
  domain: string;
  /** as it appeared in history */
  title: string;
  /** what actually gets embedded — boilerplate suffix removed */
  embedText: string;
  lastVisit: number;
  visitCount: number;
  typedCount: number;
}

interface Cluster {
  members: number[];
  centroid: Float32Array;
  /** member index -> cosine similarity to centroid, aligned with `members` */
  sims: number[];
}

// ---------------------------------------------------------------------------
// URL normalization (CLAUDE.md §4)
// ---------------------------------------------------------------------------

/**
 * Tracking params carry no meaning and defeat dedupe. §4 names utm_*; the click
 * ID family is the same class of junk and is stripped alongside it.
 */
const TRACKING_PARAM =
  /^(utm_[a-z_]+|fbclid|gclid|gbraid|wbraid|msclkid|dclid|yclid|igshid|mc_cid|mc_eid|_ga|_gl|ref_src|ref_url|si|spm|scm|share_source)$/i;

function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }

  u.hash = '';
  u.username = '';
  u.password = '';

  const kept = new URLSearchParams();
  for (const [key, value] of u.searchParams) {
    if (!TRACKING_PARAM.test(key)) kept.append(key, value);
  }
  kept.sort(); // param order is not meaningful for identity
  u.search = kept.toString() ? `?${kept.toString()}` : '';

  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u.toString();
}

// ---------------------------------------------------------------------------
// Filters (CLAUDE.md §9, §11)
// ---------------------------------------------------------------------------

function isLocalHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0.0.0.0' || host === 'host.docker.internal') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/**
 * Search engines are a closed, universal set — the same short list for every
 * user, in the spirit of the seed taxonomy (§6). Site-internal search is caught
 * generically by path shape instead, so no per-site knowledge is needed.
 */
const SEARCH_ENGINE_HOST =
  /^(google\.[a-z.]{2,}|bing\.com|duckduckgo\.com|lite\.duckduckgo\.com|search\.yahoo\.[a-z.]{2,}|yandex\.[a-z.]{2,}|baidu\.com|ecosia\.org|startpage\.com|search\.brave\.com|search\.marginalia\.nu|qwant\.com|ask\.com|searx\.[a-z.]{2,}|perplexity\.ai)$/i;

const SEARCH_QUERY_KEY = new Set(['q', 'query', 'search_query', 'p', 'wd', 'text', 'k', 'searchterm']);
const SEARCH_PATH_SEGMENT = new Set(['search', 'results', 'search_results']);

function isSearchResultPage(u: URL): boolean {
  const host = u.hostname.replace(/^www\./, '');
  const hasQueryKey = [...u.searchParams.keys()].some((key) => SEARCH_QUERY_KEY.has(key.toLowerCase()));

  if (SEARCH_ENGINE_HOST.test(host)) {
    // Engine roots and redirect hops are navigation, never destinations.
    if (u.pathname === '/' || u.pathname === '') return true;
    if (/^\/(search|url|imgres|maps\/search|s)\b/.test(u.pathname)) return true;
    if (hasQueryKey) return true;
  }

  // Generic site search: /search?q=..., /results?search_query=...
  const segments = u.pathname.toLowerCase().split('/').filter(Boolean);
  if (hasQueryKey && segments.some((s) => SEARCH_PATH_SEGMENT.has(s))) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Title cleanup
// ---------------------------------------------------------------------------

/**
 * Separators must be surrounded by whitespace: " : r/guitar" is site chrome,
 * but "Rust: ownership" is content. The frequency test below is the real
 * safeguard — a tail is only ever stripped if it recurs across many titles.
 */
const TITLE_SEPARATOR = /\s+[|–—·•:»~\-]\s+/;
/** "(3) Inbox" — unread counters from mail/social tabs. */
const UNREAD_PREFIX = /^\(\d+\)\s*/;

function tidyTitle(title: string): string {
  return title.replace(UNREAD_PREFIX, '').replace(/\s+/g, ' ').trim();
}

/**
 * Site boilerplate ("- YouTube", "| Hacker News") makes every page from one
 * domain look alike, and §4 is explicit that a domain is not a category. Rather
 * than hardcode a list — which §6 forbids — derive it: a trailing segment that
 * recurs across many otherwise-unrelated titles is chrome, not content.
 */
function deriveBoilerplateSuffixes(titles: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const title of titles) {
    const parts = title.split(TITLE_SEPARATOR);
    if (parts.length < 2) continue;
    const tail = parts[parts.length - 1]!.trim();
    if (tail.length === 0 || tail.length > 40) continue;
    counts.set(tail.toLowerCase(), (counts.get(tail.toLowerCase()) ?? 0) + 1);
  }

  const minOccurrences = Math.max(5, Math.round(titles.length * 0.003));
  const boilerplate = new Map<string, number>();
  for (const [tail, count] of counts) {
    if (count >= minOccurrences) boilerplate.set(tail, count);
  }
  return boilerplate;
}

function stripBoilerplate(title: string, boilerplate: Map<string, number>): string {
  let out = title;
  // Loop: "Some Post - r/docker - Reddit" has two layers of chrome.
  for (let pass = 0; pass < 3; pass++) {
    const parts = out.split(TITLE_SEPARATOR);
    if (parts.length < 2) break;
    const tail = parts[parts.length - 1]!.trim();
    if (!boilerplate.has(tail.toLowerCase())) break;
    const remainder = parts.slice(0, -1).join(' - ').trim();
    if (remainder.length < 8) break; // stripping would leave nothing to embed
    out = remainder;
  }
  return out;
}

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

// ---------------------------------------------------------------------------
// Filter chain
// ---------------------------------------------------------------------------

interface FilterStats {
  raw: number;
  droppedNoUrl: number;
  droppedScheme: number;
  droppedLocal: number;
  droppedSearch: number;
  droppedShortTitle: number;
  droppedDuplicate: number;
  kept: number;
}

function filterHistory(visits: RawVisit[], perVisit: boolean): { pages: Page[]; stats: FilterStats } {
  const stats: FilterStats = {
    raw: visits.length,
    droppedNoUrl: 0,
    droppedScheme: 0,
    droppedLocal: 0,
    droppedSearch: 0,
    droppedShortTitle: 0,
    droppedDuplicate: 0,
    kept: 0,
  };

  // Pass 1 — structural filters, keyed by normalized URL.
  interface Candidate {
    url: string;
    normalizedUrl: string;
    domain: string;
    title: string;
    lastVisit: number;
    visitCount: number;
    typedCount: number;
  }
  const byUrl = new Map<string, Candidate>();

  for (const visit of visits) {
    if (!visit.url) {
      stats.droppedNoUrl++;
      continue;
    }

    let parsed: URL;
    try {
      parsed = new URL(visit.url);
    } catch {
      stats.droppedNoUrl++;
      continue;
    }

    // chrome://, about:, file:, extension pages, javascript: — §9 never captures these.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      stats.droppedScheme++;
      continue;
    }
    if (isLocalHost(parsed.hostname.toLowerCase())) {
      stats.droppedLocal++;
      continue;
    }
    if (isSearchResultPage(parsed)) {
      stats.droppedSearch++;
      continue;
    }

    const normalized = normalizeUrl(visit.url);
    if (normalized === null) {
      stats.droppedNoUrl++;
      continue;
    }

    const title = tidyTitle(visit.title ?? '');
    const existing = byUrl.get(normalized);

    if (existing === undefined) {
      byUrl.set(normalized, {
        url: visit.url,
        normalizedUrl: normalized,
        domain: parsed.hostname.toLowerCase().replace(/^www\./, ''),
        title,
        lastVisit: visit.lastVisit,
        // Per-visit exports carry no count; each row is one visit.
        visitCount: visit.visitCount ?? 1,
        typedCount: visit.typedCount ?? 0,
      });
      continue;
    }

    stats.droppedDuplicate++;

    if (perVisit) {
      // Each duplicate row is another visit — this is where visitCount comes from.
      existing.visitCount += 1;
    } else if ((visit.visitCount ?? 1) > existing.visitCount) {
      // §11: on collision keep the entry with the highest visitCount.
      existing.visitCount = visit.visitCount ?? 1;
      existing.url = visit.url;
      if (title.length > 0) existing.title = title;
    }

    existing.lastVisit = Math.max(existing.lastVisit, visit.lastVisit);
    existing.typedCount = Math.max(existing.typedCount, visit.typedCount ?? 0);
    if (existing.title.length === 0 && title.length > 0) existing.title = title;
  }

  // Pass 2 — derive boilerplate suffixes from the surviving titles, then apply
  // the length filter to the text that will actually be embedded.
  const candidates = [...byUrl.values()];
  const boilerplate = OPTS.stripSuffixes
    ? deriveBoilerplateSuffixes(candidates.map((c) => c.title))
    : new Map<string, number>();

  const pages: Page[] = [];
  for (const candidate of candidates) {
    const embedText = OPTS.stripSuffixes
      ? stripBoilerplate(candidate.title, boilerplate)
      : candidate.title;

    if (embedText.length < 15) {
      stats.droppedShortTitle++;
      continue;
    }
    pages.push({ ...candidate, embedText });
  }

  // Newest first (§10): a truncated run should still be a recent run.
  pages.sort((a, b) => b.lastVisit - a.lastVisit);
  stats.kept = pages.length;

  reportBoilerplate(boilerplate);
  return { pages, stats };
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
// Embedding — §11: titles only, batches of 32
// ---------------------------------------------------------------------------

async function embedTitles(texts: string[]): Promise<Float32Array> {
  const { pipeline, env } = await import('@xenova/transformers');
  env.cacheDir = './.models';

  console.log(`  loading ${MODEL} (quantized, ~23MB — downloaded once)…`);
  const extractor = await pipeline('feature-extraction', MODEL, { quantized: true });

  const matrix = new Float32Array(texts.length * DIM);
  const startedAt = performance.now();
  const isTty = process.stdout.isTTY === true;
  let done = 0;

  for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
    const batch = texts.slice(offset, offset + BATCH_SIZE);
    const output = await extractor(batch, { pooling: 'mean', normalize: true });
    const data = output.data as Float32Array;
    matrix.set(data.subarray(0, batch.length * DIM), offset * DIM);

    done += batch.length;
    const elapsed = (performance.now() - startedAt) / 1000;
    const rate = done / elapsed;
    const eta = (texts.length - done) / rate;
    const line = `  [embed] ${done}/${texts.length} (${((done / texts.length) * 100).toFixed(1)}%) · ${rate.toFixed(1)} titles/s · eta ${eta.toFixed(0)}s`;

    if (isTty) process.stdout.write(`\r${line.padEnd(78)}`);
    else if (offset % (BATCH_SIZE * 10) === 0 || done === texts.length) console.log(line);
  }
  if (isTty) process.stdout.write('\n');

  return matrix;
}

// ---------------------------------------------------------------------------
// Vector helpers — Float32Array only (§13)
// ---------------------------------------------------------------------------

/** Vectors come out of MiniLM L2-normalized, so cosine similarity is a dot product. */
function dot(matrix: Float32Array, i: number, j: number): number {
  const a = i * DIM;
  const b = j * DIM;
  let sum = 0;
  for (let d = 0; d < DIM; d++) sum += matrix[a + d]! * matrix[b + d]!;
  return sum;
}

function dotVec(matrix: Float32Array, i: number, vec: Float32Array): number {
  const a = i * DIM;
  let sum = 0;
  for (let d = 0; d < DIM; d++) sum += matrix[a + d]! * vec[d]!;
  return sum;
}

function centroidOf(matrix: Float32Array, members: number[]): Float32Array {
  const centroid = new Float32Array(DIM);
  for (const index of members) {
    const base = index * DIM;
    for (let d = 0; d < DIM; d++) centroid[d]! += matrix[base + d]!;
  }
  let norm = 0;
  for (let d = 0; d < DIM; d++) norm += centroid[d]! * centroid[d]!;
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < DIM; d++) centroid[d]! /= norm;
  return centroid;
}

function describeCluster(matrix: Float32Array, members: number[]): Cluster {
  const centroid = centroidOf(matrix, members);
  const scored = members
    .map((index) => ({ index, sim: dotVec(matrix, index, centroid) }))
    .sort((a, b) => b.sim - a.sim);
  return {
    members: scored.map((s) => s.index),
    sims: scored.map((s) => s.sim),
    centroid,
  };
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

/**
 * Shared-nearest-neighbour clustering (Jarvis–Patrick) over a mutual-kNN graph.
 *
 * Two pages are linked when each is in the other's top-k *and* they share at
 * least `sharedMin` neighbours. Both tests are rank-based, so this adapts to
 * however tightly or loosely a given user's browsing happens to embed rather
 * than depending on an absolute cosine cutoff — which measurement shows is
 * dataset-specific and sits far lower than intuition suggests.
 *
 * The shared-neighbour test is what stops chaining. Mutual-kNN alone will link
 * an accidental Kubernetes/sourdough pair and connected components then welds
 * two unrelated topics together permanently; requiring shared context breaks
 * exactly those bridges, because a genuine bridge pair has no mutual crowd.
 *
 * Components below `minClusterSize` fall out as noise: the discovery queue of
 * §5, not a failure.
 *
 * Chosen over HDBSCAN, which needs a dimensionality-reduction step to behave on
 * 384 dims and has no trustworthy JS implementation. See CLAUDE.md §14.
 */
function clusterByMutualKnn(
  matrix: Float32Array,
  count: number,
  k: number,
  floor: number,
  sharedMin: number,
  minClusterSize: number
): { clusters: Cluster[]; noise: number[] } {
  // Top-k per node, kept sorted descending by similarity. k is small, so
  // insertion into a plain array beats a heap.
  const topIndex: number[][] = Array.from({ length: count }, () => []);
  const topSim: number[][] = Array.from({ length: count }, () => []);

  const offer = (node: number, other: number, sim: number): void => {
    const sims = topSim[node]!;
    if (sims.length === k && sim <= sims[k - 1]!) return;
    const indices = topIndex[node]!;
    let position = sims.length;
    while (position > 0 && sims[position - 1]! < sim) position--;
    sims.splice(position, 0, sim);
    indices.splice(position, 0, other);
    if (sims.length > k) {
      sims.pop();
      indices.pop();
    }
  };

  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const sim = dot(matrix, i, j);
      if (sim < floor) continue;
      offer(i, j, sim);
      offer(j, i, sim);
    }
  }

  // Union-find over mutual edges only.
  const parent = new Int32Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[x] !== root) {
      const next = parent[x]!;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  const neighbourSets = topIndex.map((list) => new Set(list));
  const sharedNeighbours = (a: number, b: number): number => {
    const setB = neighbourSets[b]!;
    let shared = 0;
    for (const n of topIndex[a]!) if (n !== b && setB.has(n)) shared++;
    return shared;
  };

  let mutualEdges = 0;
  let bridgesCut = 0;
  for (let i = 0; i < count; i++) {
    for (const j of topIndex[i]!) {
      if (j <= i || !neighbourSets[j]!.has(i)) continue;
      if (sharedNeighbours(i, j) < sharedMin) {
        bridgesCut++;
        continue;
      }
      union(i, j);
      mutualEdges++;
    }
  }

  const components = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    const bucket = components.get(root);
    if (bucket === undefined) components.set(root, [i]);
    else bucket.push(i);
  }

  const clusters: Cluster[] = [];
  const noise: number[] = [];
  for (const members of components.values()) {
    if (members.length < minClusterSize) noise.push(...members);
    else clusters.push(describeCluster(matrix, members));
  }

  clusters.sort((a, b) => b.members.length - a.members.length);
  noise.sort((a, b) => a - b);
  console.log(
    `  graph: ${mutualEdges} edges kept, ${bridgesCut} bridges cut by the shared-neighbour test, ${components.size} components`
  );
  return { clusters, noise };
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

function printClusters(pages: Page[], clusters: Cluster[], noise: number[]): void {
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`CLUSTERS — ${clusters.length} found, 8 nearest-centroid titles each`);
  console.log('═'.repeat(78));

  clusters.forEach((cluster, position) => {
    const size = cluster.members.length;
    console.log(
      `\n[${String(position + 1).padStart(2)}] ${size} page${size === 1 ? '' : 's'}  ·  ${topDomains(pages, cluster.members)}`
    );
    cluster.members.slice(0, 8).forEach((index, rank) => {
      const page = pages[index]!;
      const revisits = page.visitCount > 1 ? `  (${page.visitCount}×)` : '';
      // Display the original title, not embedText. Stripping a suffix that is
      // also the topic — react.dev titles every page "… – React" — would leave
      // a cluster reading "Quick Start / useEffect / Managing State" with no
      // sign of what it is about, and a human reading these is the whole point
      // of Phase 0. What gets embedded is unchanged.
      console.log(`     ${cluster.sims[rank]!.toFixed(3)}  ${truncate(page.title, 62)}${revisits}`);
    });
    if (size > 8) console.log(`            … and ${size - 8} more`);
  });

  console.log(`\n${'═'.repeat(78)}`);
  console.log(`NOISE — ${noise.length} unclustered pages`);
  console.log('═'.repeat(78));
  if (noise.length > 0 && OPTS.noiseSample > 0) {
    for (const index of noise.slice(0, OPTS.noiseSample)) {
      console.log(`     ${truncate(pages[index]!.title, 68)}`);
    }
    if (noise.length > OPTS.noiseSample) console.log(`     … and ${noise.length - OPTS.noiseSample} more`);
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
  let { pages, stats } = filterHistory(visits, perVisit);
  timings.push(['filter', performance.now() - mark]);
  printFilterReport(stats, shape);

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

  // 4. Cluster
  console.log(`\n  pairwise similarity: ${similarityProfile(matrix, pages.length)}`);

  const k = OPTS.k ?? Math.min(60, Math.max(2, Math.round(Math.sqrt(pages.length / 2))));
  const settings =
    OPTS.algo === 'kmeans'
      ? `kmeans · k=${k} · min-sim=${OPTS.minSim} · min-cluster-size=${OPTS.minClusterSize} · seed=${OPTS.seed}`
      : OPTS.algo === 'community'
        ? `community · threshold=${OPTS.threshold} · min-cluster-size=${OPTS.minClusterSize}`
        : `mutual-kNN + shared-neighbour · k=${OPTS.knn} · shared=${OPTS.shared} · min-sim=${OPTS.minSim} · min-cluster-size=${OPTS.minClusterSize}`;
  console.log(`  clustering: ${settings}`);

  mark = performance.now();
  const result =
    OPTS.algo === 'kmeans'
      ? clusterByKMeans(matrix, pages.length, k, OPTS.minSim, OPTS.minClusterSize, OPTS.seed)
      : OPTS.algo === 'community'
        ? clusterByCommunity(matrix, pages.length, OPTS.threshold, OPTS.minClusterSize)
        : clusterByMutualKnn(matrix, pages.length, OPTS.knn, OPTS.minSim, OPTS.shared, OPTS.minClusterSize);
  timings.push(['cluster', performance.now() - mark]);

  // 5. Report
  printClusters(pages, result.clusters, result.noise);

  const clustered = pages.length - result.noise.length;
  console.log(`\n${'─'.repeat(78)}`);
  console.log('SUMMARY');
  console.log(`  raw rows          ${stats.raw}`);
  console.log(`  after filtering   ${stats.kept}${OPTS.limit !== undefined ? ` (embedded ${pages.length})` : ''}`);
  console.log(`  clusters          ${result.clusters.length}`);
  console.log(
    `  clustered         ${clustered} (${((clustered / pages.length) * 100).toFixed(1)}%)   noise ${result.noise.length} (${((result.noise.length / pages.length) * 100).toFixed(1)}%)`
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
          clusters: result.clusters.map((cluster) => ({
            size: cluster.members.length,
            topDomains: topDomains(pages, cluster.members, 5),
            pages: cluster.members.map((index, rank) => ({
              title: pages[index]!.title,
              embedded: pages[index]!.embedText,
              url: pages[index]!.normalizedUrl,
              visitCount: pages[index]!.visitCount,
              simToCentroid: Number(cluster.sims[rank]!.toFixed(4)),
            })),
          })),
          noise: result.noise.map((index) => ({
            title: pages[index]!.title,
            embedded: pages[index]!.embedText,
            url: pages[index]!.normalizedUrl,
          })),
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
