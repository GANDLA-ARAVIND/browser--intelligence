/**
 * The filter chain (CLAUDE.md §9, §11).
 *
 * Pure: takes rows, returns rows plus counts. Reporting and IO belong to the
 * caller — the same function serves the Phase 0 CLI and the extension backfill.
 */

import { isSensitive, type SensitiveCategory } from './blocklist.js';
import { isJunkTitle } from './junk.js';
import { deriveBoilerplateSuffixes, stripBoilerplate, tidyTitle } from './titles.js';
import { isLocalHost, isSearchResultPage, normalizeUrl } from './url.js';
import type { FilterStats, Page, RawVisit } from './types.js';

/** Titles shorter than this embed too weakly to categorise. */
export const MIN_TITLE_LENGTH = 15;

export interface FilterOptions {
  /** Strip data-derived site boilerplate before embedding. */
  stripSuffixes: boolean;
  /**
   * §9 categories to exclude. Omitted or empty means no blocking, which keeps
   * the Phase 0 harness byte-reproducible against its recorded baseline. The
   * extension passes the user's current settings, defaulting to all
   * categories.
   */
  blockedCategories?: readonly SensitiveCategory[];
}

export interface FilterResult {
  pages: Page[];
  stats: FilterStats;
  /** Suffix -> occurrences, for reporting what was stripped. */
  boilerplate: Map<string, number>;
  /** Titles the junk filter removed. It deletes real user data, so it must be
   *  auditable: a bad pattern silently removing genuine pages is worse than a
   *  missed interstitial. */
  junkDropped: string[];
}

interface Candidate {
  url: string;
  normalizedUrl: string;
  domain: string;
  title: string;
  lastVisit: number;
  visitCount: number;
  typedCount: number;
}

export function filterHistory(visits: RawVisit[], perVisit: boolean, options: FilterOptions): FilterResult {
  const stats: FilterStats = {
    raw: visits.length,
    droppedNoUrl: 0,
    droppedScheme: 0,
    droppedLocal: 0,
    droppedSearch: 0,
    droppedBlocked: 0,
    droppedJunkTitle: 0,
    droppedShortTitle: 0,
    droppedDuplicate: 0,
    kept: 0,
  };
  const junkDropped: string[] = [];
  const blockedCategories = options.blockedCategories ?? [];

  // Pass 1 — structural filters, keyed by normalized URL.
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
    // §9: exclude *before* extraction — these must never reach the embedder.
    if (blockedCategories.length > 0 && isSensitive(visit.url, blockedCategories)) {
      stats.droppedBlocked++;
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
  const boilerplate = options.stripSuffixes
    ? deriveBoilerplateSuffixes(candidates.map((c) => c.title))
    : new Map<string, number>();

  const pages: Page[] = [];
  for (const candidate of candidates) {
    const embedText = options.stripSuffixes
      ? stripBoilerplate(candidate.title, boilerplate)
      : candidate.title;

    // Checked against both forms: the suffix stripper turns "Sign in - Google
    // Accounts" into "Sign in", and either spelling is junk.
    if (isJunkTitle(candidate.title) || isJunkTitle(embedText)) {
      stats.droppedJunkTitle++;
      junkDropped.push(candidate.title);
      continue;
    }
    if (embedText.length < MIN_TITLE_LENGTH) {
      stats.droppedShortTitle++;
      continue;
    }
    pages.push({ ...candidate, embedText });
  }

  // Newest first (§10): a truncated run should still be a recent run.
  pages.sort((a, b) => b.lastVisit - a.lastVisit);
  stats.kept = pages.length;

  return { pages, stats, boilerplate, junkDropped };
}
