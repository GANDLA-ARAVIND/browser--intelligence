/**
 * chrome.history access (CLAUDE.md §2.6, §10).
 *
 * Behind src/platform because it is the most browser-specific thing in the
 * project: Firefox's equivalent has the same shape but far longer retention.
 *
 * Deliberately *not* scripts/export-history.mjs, which reads Chrome's SQLite
 * file directly. That is dev tooling with no retention limit; this is the
 * shipped path — titles only, ~90 days, and it never sees incognito history
 * because Chrome does not record it (§9).
 */

import type { RawVisit } from '../lib/types.js';

const DAY_MS = 86_400_000;

/** §10: Chrome prunes at ~90 days, so 13 weekly windows covers everything. */
export const BACKFILL_WINDOWS = 13;
export const WINDOW_DAYS = 7;
export const MAX_RESULTS_PER_WINDOW = 10_000;

export interface HistoryReadProgress {
  window: number;
  totalWindows: number;
  rowsSoFar: number;
}

/**
 * Walks backwards in 7-day windows.
 *
 * A single unbounded `search()` silently truncates — it caps results and gives
 * no indication it did so, which reads as "this user browses 100 pages a
 * quarter" rather than as an error. Windowing is what makes the count real.
 *
 * Windows overlap at the edges and a URL visited across several weeks appears
 * in each, but `visitCount` from the API is the lifetime total regardless of
 * window, so the normalized-URL dedupe downstream keeps one row with the right
 * count.
 */
export async function readHistoryWindows(
  onProgress?: (progress: HistoryReadProgress) => void,
  now: number = Date.now()
): Promise<RawVisit[]> {
  const visits: RawVisit[] = [];

  for (let i = 0; i < BACKFILL_WINDOWS; i++) {
    const items = await chrome.history.search({
      text: '',
      startTime: now - (i + 1) * WINDOW_DAYS * DAY_MS,
      endTime: now - i * WINDOW_DAYS * DAY_MS,
      maxResults: MAX_RESULTS_PER_WINDOW,
    });

    for (const item of items) {
      if (item.url === undefined) continue;
      visits.push({
        url: item.url,
        title: item.title ?? '',
        lastVisit: item.lastVisitTime ?? 0,
        visitCount: item.visitCount ?? 1,
        typedCount: item.typedCount ?? 0,
      });
    }

    onProgress?.({ window: i + 1, totalWindows: BACKFILL_WINDOWS, rowsSoFar: visits.length });

    if (items.length >= MAX_RESULTS_PER_WINDOW) {
      // Not fatal, but it means this window truncated and some history is
      // invisible. Worth knowing rather than silently under-reporting.
      console.warn(
        `[history] window ${i + 1} returned the full ${MAX_RESULTS_PER_WINDOW} rows — it may be truncated`
      );
    }
  }

  return visits;
}
