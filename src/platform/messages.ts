/**
 * The message contract between the four MV3 contexts (CLAUDE.md §3).
 *
 * `chrome.runtime.sendMessage` is a **broadcast**, not a channel: every
 * listener in every context receives every message. A dashboard PING was
 * arriving at both the background and the offscreen document, and whichever
 * replied first won.
 *
 * So `target` is part of every variant rather than an optional field — a
 * message is not constructible without one, and `onMessage` filters on it
 * centrally so no listener has to remember to.
 */

import type { BackfillProgress } from '../lib/backfill.js';
import type { SensitiveCategory } from '../lib/blocklist.js';
import type { CapturedPage } from '../lib/capture.js';
import type { Format } from '../lib/format.js';
import type { RawVisit } from '../lib/types.js';

export type Context = 'background' | 'offscreen' | 'dashboard' | 'content';

/**
 * §12: time range, format, topic, domain. All optional and independent — an
 * absent field means "no constraint on this axis", never a default value that
 * could silently narrow a query the user did not ask to narrow.
 *
 * `topicClusterId`, never a topic *label*: labels are for display, and a
 * label is not guaranteed unique or stable in the way an id is (§5, §6 — only
 * a derived cluster is a real topic, seed labels are never one).
 */
export interface SearchFilters {
  startTime?: number;
  endTime?: number;
  format?: Format;
  topicClusterId?: string;
  /** Case-insensitive substring match, not exact — "google" should find every Google property. */
  domain?: string;
}

export type Message =
  | { target: 'background'; type: 'GET_STATUS' }
  | { target: 'background'; type: 'PING'; from: Context }
  | { target: 'offscreen'; type: 'PING'; from: Context }
  // Backfill. The dashboard talks only to the background, which routes to the
  // offscreen document — §3 gives the service worker the routing role.
  | { target: 'background'; type: 'START_BACKFILL' }
  | { target: 'background'; type: 'GET_BACKFILL_PROGRESS' }
  // Settings travel with the job: offscreen documents are restricted to
  // chrome.runtime, so they cannot read chrome.storage themselves.
  | { target: 'offscreen'; type: 'RUN_BACKFILL'; visits: RawVisit[]; blockedCategories: SensitiveCategory[] }
  | { target: 'offscreen'; type: 'GET_BACKFILL_PROGRESS' }
  // Search. Runs in the offscreen document, never the dashboard: §14 records
  // that context isolation is what kept the UI alive while a thread blocked.
  | { target: 'background'; type: 'SEARCH'; query: string; limit: number; filters?: SearchFilters }
  | { target: 'offscreen'; type: 'SEARCH'; query: string; limit: number; filters?: SearchFilters }
  // §12's "more like this" — a vector-neighbour lookup seeded from a page
  // already in the index, not a new embedding. Same isolation rule: the scan
  // is short but still synchronous, so it stays in the offscreen document.
  | { target: 'background'; type: 'MORE_LIKE_THIS'; id: string; limit: number }
  | { target: 'offscreen'; type: 'MORE_LIKE_THIS'; id: string; limit: number }
  // Live capture. The content script never embeds — it extracts and hands off.
  | { target: 'background'; type: 'CAPTURE_PAGE'; page: CapturedPage }
  | { target: 'offscreen'; type: 'DRAIN_QUEUE' }
  // §9 retroactive removal. The search index is offscreen-document-local state
  // (searchIndex.ts's module-scope `index` variable) — a delete in the
  // dashboard is invisible to it until told, so every delete path sends this
  // afterward. Without it, a "removed" page keeps appearing in search results
  // until the next backfill happens to rebuild the index.
  | { target: 'background'; type: 'INVALIDATE_SEARCH' }
  // Sec 7: sessions recompute on a ~2min debounce after the last capture, never
  // deferred to midnight - the dashboard at 3pm must show this afternoon.
  | { target: 'background'; type: 'REBUILD_SESSIONS' }
  | { target: 'offscreen'; type: 'REBUILD_SESSIONS' }
  | { target: 'offscreen'; type: 'INVALIDATE_SEARCH' };

export interface PongResponse {
  ok: true;
  from: Context;
  at: number;
}

export interface StatusResponse {
  ok: true;
  serviceWorkerStartedAt: number;
  /**
   * Measured on demand, never remembered. The worker is torn down after ~30s
   * idle, so any readiness flag it holds is a lie the moment it sleeps.
   */
  offscreen: {
    reachable: boolean;
    respondedAt: number | null;
    attempts: number;
  };
}

export interface AcceptedResponse {
  ok: true;
  accepted: boolean;
  /** Why it was refused, when accepted is false. */
  reason?: string;
}

export interface SearchHit {
  id: string;
  url: string;
  title: string;
  /** First ~160 chars of the page's own text (or title, if extraction gave nothing) for the card preview. */
  textPreview: string;
  /** False on a page with no captured text (most backfilled pages) — `textPreview` is then just the title, truncated, and must not be shown as if it were a preview of something else. */
  hasCapturedText: boolean;
  domain: string;
  format: Format;
  /** Derived-cluster name, or `null` — never a seed label, and never invented (§5, §6, §14). */
  topicLabel: string | null;
  score: number;
  lastVisit: number;
  /** How many near-identical pages this node stands for. */
  collapsed: number;
  /** The representative's own return-visit count — surfaced as "revisited N×" when > 1. */
  visitCount: number;
}

export interface SearchResponse {
  ok: true;
  hits: SearchHit[];
  /** Unique nodes scanned. */
  scanned: number;
  timings: { loadMs: number; embedMs: number; scanMs: number; totalMs: number };
}

export interface DrainResponse {
  ok: true;
  processed: number;
  remaining: number;
}

export interface ProgressResponse {
  ok: true;
  progress: BackfillProgress;
}

export type ErrorResponse = { ok: false; error: string };

export type Response =
  | PongResponse
  | StatusResponse
  | AcceptedResponse
  | ProgressResponse
  | SearchResponse
  | DrainResponse
  | ErrorResponse;

/**
 * Which reply belongs to which request. `sendMessage` uses this to type its
 * return, so no call site needs a cast — and a cast is what turned a benign
 * version skew into a crash: `as StatusResponse` told the compiler to trust a
 * value that had crossed an untyped process boundary.
 */
export interface ReplyMap {
  PING: PongResponse;
  GET_STATUS: StatusResponse;
  START_BACKFILL: AcceptedResponse;
  RUN_BACKFILL: AcceptedResponse;
  GET_BACKFILL_PROGRESS: ProgressResponse;
  SEARCH: SearchResponse;
  CAPTURE_PAGE: AcceptedResponse;
  DRAIN_QUEUE: DrainResponse;
  INVALIDATE_SEARCH: AcceptedResponse;
  REBUILD_SESSIONS: AcceptedResponse;
  MORE_LIKE_THIS: SearchResponse;
}

export type ReplyFor<M extends Message> = ReplyMap[M['type']];

// --- runtime validation ------------------------------------------------------
// The wire is untyped. A stale service worker from a previous build answers
// with whatever shape it was compiled with, so replies are checked, not
// assumed.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isPongResponse(value: unknown): value is PongResponse {
  return isRecord(value) && value['ok'] === true && typeof value['from'] === 'string' && typeof value['at'] === 'number';
}

export function isStatusResponse(value: unknown): value is StatusResponse {
  if (!isRecord(value) || value['ok'] !== true) return false;
  if (typeof value['serviceWorkerStartedAt'] !== 'number') return false;
  const offscreen = value['offscreen'];
  return isRecord(offscreen) && typeof offscreen['reachable'] === 'boolean' && typeof offscreen['attempts'] === 'number';
}

export function isAcceptedResponse(value: unknown): value is AcceptedResponse {
  return isRecord(value) && value['ok'] === true && typeof value['accepted'] === 'boolean';
}

export function isProgressResponse(value: unknown): value is ProgressResponse {
  if (!isRecord(value) || value['ok'] !== true) return false;
  const progress = value['progress'];
  return isRecord(progress) && typeof progress['stage'] === 'string' && isRecord(progress['counts']);
}

export function isSearchResponse(value: unknown): value is SearchResponse {
  return isRecord(value) && value['ok'] === true && Array.isArray(value['hits']) && isRecord(value['timings']);
}

export function isDrainResponse(value: unknown): value is DrainResponse {
  return isRecord(value) && value['ok'] === true && typeof value['processed'] === 'number';
}

export const REPLY_GUARDS: { [K in Message['type']]: (value: unknown) => boolean } = {
  PING: isPongResponse,
  GET_STATUS: isStatusResponse,
  START_BACKFILL: isAcceptedResponse,
  RUN_BACKFILL: isAcceptedResponse,
  GET_BACKFILL_PROGRESS: isProgressResponse,
  SEARCH: isSearchResponse,
  CAPTURE_PAGE: isAcceptedResponse,
  DRAIN_QUEUE: isDrainResponse,
  INVALIDATE_SEARCH: isAcceptedResponse,
  REBUILD_SESSIONS: isAcceptedResponse,
  MORE_LIKE_THIS: isSearchResponse,
};
