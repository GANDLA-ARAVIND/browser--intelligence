/**
 * In-memory search index, built once from IndexedDB and reused.
 *
 * Lives in the offscreen document, not the dashboard: §14 records that context
 * isolation is what kept the UI responsive while 87% of the backfill had a
 * thread blocked. A brute-force scan is short, but it is still synchronous, and
 * synchronous work belongs on the side of the boundary the user cannot see.
 *
 * Only *representatives* are indexed. Searching all pages would return twenty
 * near-identical rows for one LeetCode problem; searching the collapsed nodes
 * returns twenty distinct things, each carrying how many pages it stands for.
 */

import { capText } from '../lib/capture.js';
import { createEmbedder, EMBEDDING_MAX_TOKENS, type Embedder } from '../lib/embeddings.js';
import type { Format } from '../lib/format.js';
import { applyDomainDiversity, topKByCosine } from '../lib/search.js';
import { getAllClusters, getAllGroups, getAllPages, openDatabase } from '../lib/storage.js';
import { EMBEDDING_DIM } from '../lib/vectors.js';
import { resourceUrl } from '../platform/browser.js';
import type { SearchFilters, SearchHit, SearchResponse } from '../platform/messages.js';

/** How much of the corpus is drawn as candidates before the domain cap runs. */
const CANDIDATE_MULTIPLIER = 6;
/** §11's search backlog item 2 — how many results one domain may contribute. */
const DOMAIN_CAP = 3;
const PREVIEW_CHARS = 160;

interface IndexRow {
  id: string;
  url: string;
  title: string;
  textPreview: string;
  hasCapturedText: boolean;
  domain: string;
  format: Format;
  lastVisit: number;
  collapsed: number;
  visitCount: number;
  clusterId: string | undefined;
  topicLabel: string | null;
}

interface Index {
  count: number;
  matrix: Float32Array;
  meta: IndexRow[];
}

let index: Index | null = null;
let embedder: Embedder | null = null;

/** Called after a backfill, a delete, or a session/cluster rebuild so the next search reflects the new data. */
export function invalidateSearchIndex(): void {
  index = null;
}

function domainOf(normalizedUrl: string): string {
  try {
    return new URL(normalizedUrl).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

async function buildIndex(): Promise<Index> {
  const db = await openDatabase();
  const [pages, groups, clusters] = await Promise.all([getAllPages(db), getAllGroups(db), getAllClusters(db)]);

  const labelById = new Map(clusters.map((cluster) => [cluster.id, cluster.label]));

  // Representative id -> how many pages it covers. If no backfill has produced
  // groups yet, every page stands only for itself.
  const collapsedBy = new Map<string, number>();
  for (const group of groups) collapsedBy.set(group.representativeId, group.size);
  const representatives = collapsedBy.size > 0 ? pages.filter((page) => collapsedBy.has(page.id)) : pages;

  const matrix = new Float32Array(representatives.length * EMBEDDING_DIM);
  const meta: IndexRow[] = [];
  representatives.forEach((page, row) => {
    matrix.set(page.vector, row * EMBEDDING_DIM);
    meta.push({
      id: page.id,
      url: page.url,
      title: page.title,
      textPreview: capText(page.text.length > 0 ? page.text : page.title, PREVIEW_CHARS),
      hasCapturedText: page.text.length > 0,
      domain: domainOf(page.normalizedUrl),
      format: page.format,
      lastVisit: page.lastVisit,
      collapsed: collapsedBy.get(page.id) ?? 1,
      visitCount: page.visitCount,
      clusterId: page.clusterId,
      // `null` whenever there is no cluster, or the cluster has no derived
      // name yet — never a seed label, and never invented (§5, §6, §14).
      topicLabel: page.clusterId === undefined ? null : (labelById.get(page.clusterId) ?? null),
    });
  });

  return { count: representatives.length, matrix, meta };
}

async function ensureIndex(): Promise<Index> {
  if (index === null) index = await buildIndex();
  return index;
}

async function ensureEmbedder(): Promise<Embedder> {
  if (embedder === null) {
    embedder = await createEmbedder({
      wasmPaths: resourceUrl('ort/'),
      numThreads: 1,
      localModelPath: resourceUrl('models/'),
    });
  }
  return embedder;
}

function toHit(row: IndexRow, score: number): SearchHit {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    textPreview: row.textPreview,
    hasCapturedText: row.hasCapturedText,
    domain: row.domain,
    format: row.format,
    topicLabel: row.topicLabel,
    score,
    lastVisit: row.lastVisit,
    collapsed: row.collapsed,
    visitCount: row.visitCount,
  };
}

/**
 * §12's filters — time range, format, topic, domain — applied as a predicate
 * over index rows, never as a post-hoc filter of an already-ranked list (see
 * `topKByCosine`'s doc comment for why that distinction matters).
 */
function buildFilterPredicate(meta: IndexRow[], filters: SearchFilters | undefined): ((row: number) => boolean) | undefined {
  if (filters === undefined) return undefined;
  const { startTime, endTime, format, topicClusterId, domain } = filters;
  if (
    startTime === undefined &&
    endTime === undefined &&
    format === undefined &&
    topicClusterId === undefined &&
    (domain === undefined || domain.trim().length === 0)
  ) {
    return undefined;
  }

  const domainNeedle = domain?.trim().toLowerCase();

  return (row: number): boolean => {
    const entry = meta[row]!;
    if (startTime !== undefined && entry.lastVisit < startTime) return false;
    if (endTime !== undefined && entry.lastVisit > endTime) return false;
    if (format !== undefined && entry.format !== format) return false;
    if (topicClusterId !== undefined && entry.clusterId !== topicClusterId) return false;
    if (domainNeedle !== undefined && domainNeedle.length > 0 && !entry.domain.toLowerCase().includes(domainNeedle)) {
      return false;
    }
    return true;
  };
}

/** Shared by `search()` and `moreLikeThis()`: rank, diversify, map to hits. */
function rankAndDiversify(
  idx: Index,
  queryVector: Float32Array,
  limit: number,
  filter: ((row: number) => boolean) | undefined
): SearchHit[] {
  const candidatePool = Math.min(idx.count, Math.max(limit * CANDIDATE_MULTIPLIER, limit));
  const candidates = topKByCosine(idx.matrix, idx.count, queryVector, candidatePool, filter);
  const diversified = applyDomainDiversity(candidates, (row) => idx.meta[row]!.domain, limit, DOMAIN_CAP);
  return diversified.map(({ index: row, score }) => toHit(idx.meta[row]!, score));
}

export async function search(query: string, limit: number, filters?: SearchFilters): Promise<SearchResponse> {
  const started = performance.now();

  let loadMs = 0;
  if (index === null) {
    const t = performance.now();
    index = await buildIndex();
    loadMs = performance.now() - t;
  }
  const idx = index;

  const model = await ensureEmbedder();

  // The query goes through the identical path as the documents — same model,
  // same mean pooling, same normalization, same 64-token cap. Anything else
  // puts the query in a different space from the corpus.
  const embedStart = performance.now();
  const queryVector = await model.embed([query.slice(0, EMBEDDING_MAX_TOKENS * 8)]);
  const embedMs = performance.now() - embedStart;

  const scanStart = performance.now();
  const hits = rankAndDiversify(idx, queryVector, limit, buildFilterPredicate(idx.meta, filters));
  const scanMs = performance.now() - scanStart;

  return {
    ok: true,
    hits,
    scanned: idx.count,
    timings: {
      loadMs: Math.round(loadMs),
      embedMs: Math.round(embedMs),
      scanMs: Math.round(scanMs * 100) / 100,
      totalMs: Math.round(performance.now() - started),
    },
  };
}

/**
 * §12's "more like this" — nearly free, because the seed is a vector already
 * sitting in the index rather than something to embed. No filters: the point
 * is neighbours of *this* page, not neighbours matching whatever the search
 * box currently holds.
 */
export async function moreLikeThis(id: string, limit: number): Promise<SearchResponse> {
  const started = performance.now();
  const idx = await ensureIndex();

  const seedRow = idx.meta.findIndex((entry) => entry.id === id);
  if (seedRow === -1) {
    return { ok: true, hits: [], scanned: idx.count, timings: { loadMs: 0, embedMs: 0, scanMs: 0, totalMs: 0 } };
  }

  const seedVector = idx.matrix.subarray(seedRow * EMBEDDING_DIM, (seedRow + 1) * EMBEDDING_DIM) as Float32Array;

  const scanStart = performance.now();
  const hits = rankAndDiversify(idx, seedVector, limit, (row) => row !== seedRow);
  const scanMs = performance.now() - scanStart;

  return {
    ok: true,
    hits,
    scanned: idx.count,
    timings: { loadMs: 0, embedMs: 0, scanMs: Math.round(scanMs * 100) / 100, totalMs: Math.round(performance.now() - started) },
  };
}
