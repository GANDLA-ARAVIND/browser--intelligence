/**
 * Drains the capture queue: embed, merge, store.
 *
 * Runs in the offscreen document because embedding belongs there (§3). Per
 * page this is ~25ms, so the batch-size rule in §14 says a handful of pages is
 * harmless — the danger is only a synchronous pass over the whole corpus.
 */

import { capText, type QueueItem } from '../lib/capture.js';
import { createEmbedder, EMBEDDING_BATCH_SIZE, EMBEDDING_DIM, type Embedder } from '../lib/embeddings.js';
import { classifyFormat } from '../lib/format.js';
import {
  getPage,
  getQueue,
  openDatabase,
  putPages,
  removeFromQueue,
  type PageRecord,
  type VectorSource,
} from '../lib/storage.js';
import { resourceUrl } from '../platform/browser.js';
import { invalidateSearchIndex } from './searchIndex.js';

let embedder: Embedder | null = null;

async function getEmbedder(): Promise<Embedder> {
  embedder ??= await createEmbedder({
    wasmPaths: resourceUrl('ort/'),
    numThreads: 1,
    localModelPath: resourceUrl('models/'),
  });
  return embedder;
}

export interface DrainResult {
  processed: number;
  remaining: number;
}

/**
 * Live capture supersedes backfill for the same page. The backfilled record
 * has `firstVisit === lastVisit` and no text (§15); a captured one has real
 * body text, a real extraction tier and real engagement. Merging rather than
 * overwriting keeps the earlier `firstVisit`, which is the one thing the
 * backfill knew and capture does not.
 */
function merge(
  existing: PageRecord | null,
  item: QueueItem,
  vector: Float32Array,
  vectorSource: VectorSource
): PageRecord {
  return {
    id: item.id,
    url: item.url,
    normalizedUrl: existing?.normalizedUrl ?? item.url,
    title: item.title,
    text: capText(item.text),
    vector: new Float32Array(vector),
    vectorSource,
    format: classifyFormat(item.url),
    topics: existing?.topics ?? [],
    extractionTier: item.extractionTier,
    extractionQuality: item.quality,
    firstVisit: existing?.firstVisit ?? item.capturedAt,
    lastVisit: item.capturedAt,
    visitCount: (existing?.visitCount ?? 0) + 1,
    // Accumulates across visits rather than replacing: §9 wants total attention.
    activeSeconds: (existing?.activeSeconds ?? 0) + item.activeSeconds,
    ...(existing?.summary === undefined ? {} : { summary: existing.summary }),
    ...(existing?.intent === undefined ? {} : { intent: existing.intent }),
    ...(existing?.sessionId === undefined ? {} : { sessionId: existing.sessionId }),
  };
}

export async function drainQueue(maxItems = 64): Promise<DrainResult> {
  const db = await openDatabase();
  const queued = await getQueue(db);
  if (queued.length === 0) return { processed: 0, remaining: 0 };

  const batch = queued.slice(0, maxItems);
  const model = await getEmbedder();

  // Embed the extracted text, not the title — that is the whole point of
  // capture. Falls back to the title when extraction produced nothing.
  const done: string[] = [];
  for (let offset = 0; offset < batch.length; offset += EMBEDDING_BATCH_SIZE) {
    const slice = batch.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    // Tracked per item, not derived later: `text` can be stored while the
    // embedding still came from the title, when extraction returned nothing.
    const sources: VectorSource[] = slice.map((item) => (item.text.length > 0 ? 'text' : 'title'));
    const vectors = await model.embed(
      slice.map((item, index) => (sources[index] === 'text' ? item.text : item.title))
    );

    const records: PageRecord[] = [];
    for (const [index, item] of slice.entries()) {
      const existing = await getPage(db, item.id);
      records.push(
        merge(existing, item, vectors.subarray(index * EMBEDDING_DIM, (index + 1) * EMBEDDING_DIM), sources[index]!)
      );
    }
    await putPages(db, records);
    done.push(...slice.map((item) => item.id));
  }

  await removeFromQueue(db, done);
  if (done.length > 0) invalidateSearchIndex();

  return { processed: done.length, remaining: queued.length - done.length };
}
