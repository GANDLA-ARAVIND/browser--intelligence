/**
 * Shared shapes for the ingest pipeline.
 *
 * Browser-safe: no `node:*`, no `fs`, no `process`. Everything under src/lib
 * has to run unchanged inside the offscreen document (CLAUDE.md §3).
 */

/** One row of whatever the export happened to be, after shape sniffing. */
export interface RawVisit {
  url: string;
  title: string;
  /** unix ms */
  lastVisit: number;
  /** absent in per-visit exports; derived by counting rows */
  visitCount?: number;
  typedCount?: number;
}

/** A survivor of the filter chain. */
export interface Page {
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

export interface FilterStats {
  raw: number;
  droppedNoUrl: number;
  droppedScheme: number;
  droppedLocal: number;
  droppedSearch: number;
  /** §9 sensitive-category blocklist. */
  droppedBlocked: number;
  droppedJunkTitle: number;
  droppedShortTitle: number;
  droppedDuplicate: number;
  kept: number;
}
