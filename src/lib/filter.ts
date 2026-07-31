/**
 * The filter chain (CLAUDE.md §9, §11).
 *
 * Pure: takes rows, returns rows plus counts. Reporting and IO belong to the
 * caller — the same function serves the Phase 0 CLI and the extension backfill.
 */

import { isSensitive, type SensitiveCategory } from './blocklist.js';
import { isBareUrlTitle, isJunkTitle } from './junk.js';
import { pathWords, MIN_PATH_WORDS } from './pathwords.js';
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
  /** Every drop, with the reason — the data behind §9's inspectable-filter
   *  requirement. Suppression is symptomless (§14), so it has to be visible. */
  audit: FilterAudit;
}

export type DropReason =
  | 'no-url'
  | 'scheme'
  | 'localhost'
  | 'blocked'
  | 'search'
  | 'duplicate'
  | 'junk-title'
  | 'short-title';

/**
 * **The unit each count is measured in.**
 *
 * Pass 1 runs before deduplication and counts *raw history rows*; pass 2 runs
 * after and counts *unique pages*. Mixing them is how a blocklist that removed
 * 212 rows got reported next to a 59-page difference in the kept total — the
 * numbers were both right and not comparable. Any surface that shows these
 * must state which unit it is showing.
 */
export const DROP_UNIT: Record<DropReason, 'rows' | 'pages'> = {
  'no-url': 'rows',
  scheme: 'rows',
  localhost: 'rows',
  blocked: 'rows',
  search: 'rows',
  duplicate: 'rows',
  'junk-title': 'pages',
  'short-title': 'pages',
};

export interface FilterAudit {
  /** reason -> title/url -> count */
  drops: Record<DropReason, Record<string, number>>;
  /** Bare-URL titles rescued by tier-4 path extraction, with the words used. */
  pathRescued: Array<{ url: string; words: string }>;
  /** Bare-URL titles whose path yielded nothing usable. */
  pathDropped: string[];
}

/** Compact, storable form of the audit. */
export interface FilterAuditSummary {
  raw: number;
  kept: number;
  counts: Record<DropReason, number>;
  units: Record<DropReason, 'rows' | 'pages'>;
  /** Most frequent distinct values per reason, capped for storage. */
  samples: Record<DropReason, Array<[string, number]>>;
  pathRescued: number;
  pathDropped: string[];
  /**
   * Every dropped row must be accounted for by exactly one reason. If this is
   * false a filter is removing pages that nothing reports, which is the
   * suppression failure the audit exists to prevent — surface it, never
   * swallow it.
   */
  reconciles: boolean;
  /** raw − kept − sum(counts). Zero when it reconciles. */
  unaccounted: number;
}

export function summariseAudit(result: FilterResult, sampleLimit = 200): FilterAuditSummary {
  const s = result.stats;
  const counts: Record<DropReason, number> = {
    'no-url': s.droppedNoUrl,
    scheme: s.droppedScheme,
    localhost: s.droppedLocal,
    blocked: s.droppedBlocked,
    search: s.droppedSearch,
    duplicate: s.droppedDuplicate,
    'junk-title': s.droppedJunkTitle,
    'short-title': s.droppedShortTitle,
  };

  const samples = {} as Record<DropReason, Array<[string, number]>>;
  for (const reason of Object.keys(counts) as DropReason[]) {
    samples[reason] = Object.entries(result.audit.drops[reason])
      .sort((a, b) => b[1] - a[1])
      .slice(0, sampleLimit);
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const unaccounted = s.raw - s.kept - total;

  return {
    raw: s.raw,
    kept: s.kept,
    counts,
    units: DROP_UNIT,
    samples,
    pathRescued: result.audit.pathRescued.length,
    pathDropped: result.audit.pathDropped,
    reconciles: unaccounted === 0,
    unaccounted,
  };
}

function emptyAudit(): FilterAudit {
  return {
    drops: {
      'no-url': {}, scheme: {}, localhost: {}, blocked: {},
      search: {}, duplicate: {}, 'junk-title': {}, 'short-title': {},
    },
    pathRescued: [],
    pathDropped: [],
  };
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
  const audit = emptyAudit();
  const note = (reason: DropReason, key: string): void => {
    const bucket = audit.drops[reason];
    bucket[key] = (bucket[key] ?? 0) + 1;
  };
  const blockedCategories = options.blockedCategories ?? [];

  // Pass 1 — structural filters, keyed by normalized URL.
  const byUrl = new Map<string, Candidate>();

  for (const visit of visits) {
    if (!visit.url) {
      stats.droppedNoUrl++;
      note('no-url', '(empty)');
      continue;
    }

    let parsed: URL;
    try {
      parsed = new URL(visit.url);
    } catch {
      stats.droppedNoUrl++;
      note('no-url', visit.url.slice(0, 80));
      continue;
    }

    // chrome://, about:, file:, extension pages, javascript: — §9 never captures these.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      stats.droppedScheme++;
      note('scheme', parsed.protocol);
      continue;
    }
    if (isLocalHost(parsed.hostname.toLowerCase())) {
      stats.droppedLocal++;
      note('localhost', parsed.hostname.toLowerCase());
      continue;
    }
    // §9: exclude *before* extraction — these must never reach the embedder.
    if (blockedCategories.length > 0 && isSensitive(visit.url, blockedCategories)) {
      stats.droppedBlocked++;
      note('blocked', parsed.hostname.toLowerCase().replace(/^www\./, ''));
      continue;
    }
    if (isSearchResultPage(parsed)) {
      stats.droppedSearch++;
      note('search', parsed.hostname.toLowerCase().replace(/^www\./, ''));
      continue;
    }

    const normalized = normalizeUrl(visit.url);
    if (normalized === null) {
      stats.droppedNoUrl++;
      note('no-url', visit.url.slice(0, 80));
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
    note('duplicate', existing.domain);

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

    // §8 tier 4, applied where it belongs. A bare-URL title means the page
    // served no <title> — but the *path* often still names the topic
    // ("skill-up-python", "Software-Development-Engineer"). The junk filter
    // used to run before the ladder, so tier 4 never got a chance at these.
    // Derive first; drop only when derivation yields nothing.
    if (isBareUrlTitle(candidate.title)) {
      const derived = pathWords(candidate.url);
      if (derived.pathOnly.length >= MIN_PATH_WORDS) {
        audit.pathRescued.push({ url: candidate.url, words: derived.text });
        pages.push({ ...candidate, embedText: derived.text });
        continue;
      }
      stats.droppedJunkTitle++;
      junkDropped.push(candidate.title);
      audit.pathDropped.push(candidate.title);
      note('junk-title', candidate.title);
      continue;
    }

    // Checked against both forms: the suffix stripper turns "Sign in - Google
    // Accounts" into "Sign in", and either spelling is junk. The original is
    // passed too, so a stripped-only exact match cannot create a drop.
    if (isJunkTitle(candidate.title) || isJunkTitle(embedText, candidate.title)) {
      stats.droppedJunkTitle++;
      junkDropped.push(candidate.title);
      note('junk-title', candidate.title);
      continue;
    }
    if (embedText.length < MIN_TITLE_LENGTH) {
      stats.droppedShortTitle++;
      note('short-title', candidate.title);
      continue;
    }
    pages.push({ ...candidate, embedText });
  }

  // Newest first (§10): a truncated run should still be a recent run.
  pages.sort((a, b) => b.lastVisit - a.lastVisit);
  stats.kept = pages.length;

  return { pages, stats, boilerplate, junkDropped, audit };
}
