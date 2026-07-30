/**
 * IndexedDB persistence (CLAUDE.md §2.4, §4).
 *
 * All four MV3 contexts share one origin and therefore one database, which is
 * how they communicate (§3): the offscreen document writes vectors, the
 * dashboard reads them directly. No API layer.
 *
 * Float32Array survives structured clone intact, so vectors are stored as-is —
 * no JSON round-trip, no precision loss, no 4× size blow-up.
 */

import type { BlockingEvent } from './blocking.js';
import type { QueueItem } from './capture.js';
import type { Format } from './format.js';
import type { ExtractionQuality } from './quality.js';

export const DB_NAME = 'browser-intelligence';
export const DB_VERSION = 3;

export const STORE_PAGES = 'pages';
export const STORE_GROUPS = 'groups';
export const STORE_META = 'meta';
export const STORE_QUEUE = 'queue';

export type Intent = 'learning' | 'debugging' | 'job-hunting' | 'shopping' | 'entertainment' | 'reference';

/**
 * What the vector was actually derived from.
 *
 * Backfilled pages are embedded from a ~10-token title; captured pages from up
 * to 8000 characters of body text. Those produce systematically different
 * similarity distributions against the same query, so once both live in one
 * corpus, *how a page was ingested* becomes a ranking signal unrelated to
 * relevance. Recording it does not fix that — it makes the mix measurable
 * instead of invisible. See §14.
 */
export type VectorSource = 'title' | 'text';

/** CLAUDE.md §4. */
export interface PageRecord {
  id: string; // normalized URL hash
  url: string;
  normalizedUrl: string;
  title: string;
  text: string;
  summary?: string;
  vector: Float32Array;
  /** Which field `vector` was computed from. Never inferred from `text`
   *  being non-empty: capture stores body text but falls back to the title
   *  for the embedding when extraction returns nothing. */
  vectorSource: VectorSource;

  format: Format;
  topics: string[];
  intent?: Intent;
  extractionTier: 1 | 2 | 3 | 4;
  /**
   * Optional by design: backfilled pages had no extraction to assess. Present
   * only on live captures. §8's tier says *how* text was obtained; this says
   * whether the result is usable.
   */
  extractionQuality?: ExtractionQuality;

  firstVisit: number;
  lastVisit: number;
  visitCount: number;
  activeSeconds: number;
  sessionId?: string;
}

/** A near-duplicate set collapsed to one node before clustering. */
export interface GroupRecord {
  representativeId: string;
  memberIds: string[];
  size: number;
}

export interface BackfillSummary {
  key: 'backfill';
  completedAt: number;
  rawRows: number;
  kept: number;
  uniqueNodes: number;
  blocked: number;
  durationMs: number;
  stageMs: Record<string, number>;
  /** Main-thread stalls, attributed to the stage that caused them. */
  blocking: BlockingEvent[];
}

/**
 * FNV-1a, 64-bit, hex. Synchronous — `crypto.subtle.digest` is async and would
 * make every id derivation a promise for no benefit. This is a storage key, not
 * a security primitive: it needs to be stable and well-distributed, nothing more.
 */
export function hashId(input: string): string {
  // Two independent 32-bit FNV-1a passes with different primes, concatenated.
  // 64 bits of key space over ~10^4 pages puts collision odds around 10^-11 —
  // and `Math.imul` keeps the multiply exact in 32 bits, which a plain `*`
  // would not once the product exceeds 2^53.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const from = (event as IDBVersionChangeEvent).oldVersion;

      if (!db.objectStoreNames.contains(STORE_PAGES)) {
        const pages = db.createObjectStore(STORE_PAGES, { keyPath: 'id' });
        pages.createIndex('lastVisit', 'lastVisit');
        pages.createIndex('domain', 'normalizedUrl');
        pages.createIndex('format', 'format');
      }
      if (!db.objectStoreNames.contains(STORE_GROUPS)) {
        db.createObjectStore(STORE_GROUPS, { keyPath: 'representativeId' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
      // Capture queue. Keyed by page id so a re-visit before the drain
      // replaces the pending entry instead of queueing the page twice.
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: 'id' });
      }

      // v3 adds vectorSource. Every record written before it came from the
      // history backfill, which embeds titles — so stamping 'title' is a
      // statement of fact, not a default. Doing it here rather than tolerating
      // `undefined` at read time keeps the type honest.
      if (from > 0 && from < 3 && request.transaction !== null) {
        const pages = request.transaction.objectStore(STORE_PAGES);
        pages.openCursor().onsuccess = (cursorEvent) => {
          const cursor = (cursorEvent.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (cursor === null) return;
          const record = cursor.value as PageRecord & { vectorSource?: VectorSource };
          if (record.vectorSource === undefined) {
            record.vectorSource = 'title';
            cursor.update(record);
          }
          cursor.continue();
        };
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open IndexedDB'));
  });
}

/**
 * One transaction for the whole batch, not one per page (§7: capture is ~10ms —
 * a transaction per record would dominate that entirely).
 *
 * `put` on a keyPath store is an upsert, which is what makes re-running the
 * backfill idempotent: the same URL derives the same id and overwrites rather
 * than duplicating.
 */
export async function putPages(db: IDBDatabase, records: PageRecord[]): Promise<void> {
  if (records.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_PAGES, 'readwrite');
    const store = tx.objectStore(STORE_PAGES);
    for (const record of records) store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('page write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('page write aborted'));
  });
}

export async function putGroups(db: IDBDatabase, groups: GroupRecord[]): Promise<void> {
  if (groups.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_GROUPS, 'readwrite');
    const store = tx.objectStore(STORE_GROUPS);
    for (const group of groups) store.put(group);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('group write failed'));
  });
}

export async function clearGroups(db: IDBDatabase): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_GROUPS, 'readwrite');
    tx.objectStore(STORE_GROUPS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('group clear failed'));
  });
}

export async function countPages(db: IDBDatabase): Promise<number> {
  const tx = db.transaction(STORE_PAGES, 'readonly');
  return promisify(tx.objectStore(STORE_PAGES).count());
}

export async function getAllPages(db: IDBDatabase): Promise<PageRecord[]> {
  const tx = db.transaction(STORE_PAGES, 'readonly');
  return promisify(tx.objectStore(STORE_PAGES).getAll() as IDBRequest<PageRecord[]>);
}

export async function getAllGroups(db: IDBDatabase): Promise<GroupRecord[]> {
  const tx = db.transaction(STORE_GROUPS, 'readonly');
  return promisify(tx.objectStore(STORE_GROUPS).getAll() as IDBRequest<GroupRecord[]>);
}

export async function enqueueCapture(db: IDBDatabase, item: QueueItem): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_QUEUE, 'readwrite');
    tx.objectStore(STORE_QUEUE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('enqueue failed'));
  });
}

export async function getQueue(db: IDBDatabase): Promise<QueueItem[]> {
  const tx = db.transaction(STORE_QUEUE, 'readonly');
  return promisify(tx.objectStore(STORE_QUEUE).getAll() as IDBRequest<QueueItem[]>);
}

export async function removeFromQueue(db: IDBDatabase, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_QUEUE, 'readwrite');
    const store = tx.objectStore(STORE_QUEUE);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('dequeue failed'));
  });
}

export async function getPage(db: IDBDatabase, id: string): Promise<PageRecord | null> {
  const tx = db.transaction(STORE_PAGES, 'readonly');
  const value = (await promisify(tx.objectStore(STORE_PAGES).get(id))) as PageRecord | undefined;
  return value ?? null;
}

export async function putMeta<T extends { key: string }>(db: IDBDatabase, value: T): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('meta write failed'));
  });
}

export async function getMeta<T>(db: IDBDatabase, key: string): Promise<T | null> {
  const tx = db.transaction(STORE_META, 'readonly');
  const value = (await promisify(tx.objectStore(STORE_META).get(key))) as T | undefined;
  return value ?? null;
}
