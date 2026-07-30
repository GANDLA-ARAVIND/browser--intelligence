import type { ExtractionQuality } from './quality.js';

/**
 * Shapes for live page capture (CLAUDE.md §4, §7, §8).
 *
 * Browser-safe. The queue lives in IndexedDB rather than in the service
 * worker, because the worker is torn down after ~30s idle and anything it
 * holds in memory is lost (§14).
 */

/** §8's extraction ladder. Step 1 implements tiers 2 and 3 only. */
export type ExtractionTier = 1 | 2 | 3 | 4;

export const TIER_ADAPTER = 1;
export const TIER_READABILITY = 2;
export const TIER_METADATA = 3;
export const TIER_DOMAIN_ONLY = 4;

/** §4: extracted body, capped ~8000 chars. */
export const MAX_TEXT_CHARS = 8000;

/** §7: capture at tab close or dwell > 30s. */
export const DWELL_THRESHOLD_MS = 30_000;

/**
 * §9: only count time when the tab is focused *and* there has been input in
 * the last ~60s. A tab left open overnight must never register as 8 hours.
 */
export const ACTIVITY_WINDOW_MS = 60_000;

/** What the content script sends once a page qualifies. */
export interface CapturedPage {
  url: string;
  title: string;
  /** Readability output, or the metadata fallback. Capped. */
  text: string;
  extractionTier: ExtractionTier;
  /** Focused milliseconds on the page. */
  dwellMs: number;
  /** Focused *and* recently active, per §9. */
  activeSeconds: number;
  capturedAt: number;
  /** Structural assessment of the extracted text — see §8 and src/lib/quality. */
  quality: ExtractionQuality;
}

/** A queued capture awaiting embedding. */
export interface QueueItem extends CapturedPage {
  /** Normalized-URL hash; also the PageRecord id it will become. */
  id: string;
  queuedAt: number;
}

export function capText(text: string, max = MAX_TEXT_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  // Cut at a word boundary so the last token is not a fragment.
  const slice = collapsed.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return lastSpace > max * 0.9 ? slice.slice(0, lastSpace) : slice;
}
