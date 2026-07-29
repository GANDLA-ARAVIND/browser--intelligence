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

import { createEmbedder, EMBEDDING_MAX_TOKENS, type Embedder } from '../lib/embeddings.js';
import { topKByCosine } from '../lib/search.js';
import { getAllGroups, getAllPages, openDatabase } from '../lib/storage.js';
import { EMBEDDING_DIM } from '../lib/vectors.js';
import { resourceUrl } from '../platform/browser.js';
import type { SearchHit, SearchResponse } from '../platform/messages.js';

interface Index {
  count: number;
  matrix: Float32Array;
  meta: Array<{ id: string; title: string; domain: string; lastVisit: number; collapsed: number }>;
}

let index: Index | null = null;
let embedder: Embedder | null = null;

/** Called after a backfill so the next search reflects the new data. */
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
  const [pages, groups] = await Promise.all([getAllPages(db), getAllGroups(db)]);

  // Representative id -> how many pages it covers. If no backfill has produced
  // groups yet, every page stands only for itself.
  const collapsedBy = new Map<string, number>();
  for (const group of groups) collapsedBy.set(group.representativeId, group.size);
  const representatives = collapsedBy.size > 0 ? pages.filter((page) => collapsedBy.has(page.id)) : pages;

  const matrix = new Float32Array(representatives.length * EMBEDDING_DIM);
  const meta: Index['meta'] = [];
  representatives.forEach((page, row) => {
    matrix.set(page.vector, row * EMBEDDING_DIM);
    meta.push({
      id: page.id,
      title: page.title,
      domain: domainOf(page.normalizedUrl),
      lastVisit: page.lastVisit,
      collapsed: collapsedBy.get(page.id) ?? 1,
    });
  });

  return { count: representatives.length, matrix, meta };
}

export async function search(query: string, limit: number): Promise<SearchResponse> {
  const started = performance.now();

  let loadMs = 0;
  if (index === null) {
    const t = performance.now();
    index = await buildIndex();
    loadMs = performance.now() - t;
  }

  if (embedder === null) {
    embedder = await createEmbedder({
      wasmPaths: resourceUrl('ort/'),
      numThreads: 1,
      localModelPath: resourceUrl('models/'),
    });
  }

  // The query goes through the identical path as the documents — same model,
  // same mean pooling, same normalization, same 64-token cap. Anything else
  // puts the query in a different space from the corpus.
  const embedStart = performance.now();
  const queryVector = await embedder.embed([query.slice(0, EMBEDDING_MAX_TOKENS * 8)]);
  const embedMs = performance.now() - embedStart;

  const scanStart = performance.now();
  const top = topKByCosine(index.matrix, index.count, queryVector, limit);
  const scanMs = performance.now() - scanStart;

  const hits: SearchHit[] = top.map(({ index: row, score }) => {
    const entry = index!.meta[row]!;
    return {
      id: entry.id,
      title: entry.title,
      domain: entry.domain,
      score,
      lastVisit: entry.lastVisit,
      collapsed: entry.collapsed,
    };
  });

  return {
    ok: true,
    hits,
    scanned: index.count,
    timings: {
      loadMs: Math.round(loadMs),
      embedMs: Math.round(embedMs),
      scanMs: Math.round(scanMs * 100) / 100,
      totalMs: Math.round(performance.now() - started),
    },
  };
}
