/**
 * Session reconstruction (CLAUDE.md §4, §7, §11, §15).
 *
 * A session is a run of pages with no gap longer than 30 minutes. Pure and
 * isomorphic: it takes page records and returns sessions, so the Phase 0
 * harness and the extension get identical grouping.
 *
 * **Sessions are measured in PAGES, never nodes** (§14). Clustering collapses
 * near-duplicates before it runs; sessions do not, because twenty visits to
 * one LeetCode problem *are* twenty moments of a research session and
 * collapsing them would erase the shape of the afternoon.
 */

import { dayStart } from './day.js';
import { labelClusters } from './labels.js';

/** §7: a 30-minute activity gap closes a session. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

/**
 * A session whose last page is newer than this is still open, so it is
 * `provisional` — §7 wants the dashboard to show this afternoon's work at 3pm
 * rather than an empty screen until midnight.
 */
export const PROVISIONAL_WITHIN_MS = SESSION_GAP_MS;

/**
 * Passive-media thresholds (§11). **`activeSeconds` is one input, never the
 * test** — a 40-minute conference talk watched attentively also lands at
 * `activeSeconds` ~0, and a per-page filter would drop exactly that case.
 * What distinguishes autoplay is the *shape of the run*: many sequential
 * pages, one domain, each brief.
 */
const PASSIVE_MIN_RUN = 5;
const PASSIVE_ACTIVE_SECONDS = 5;
const PASSIVE_MAX_PAGE_MS = 3 * 60 * 1000;

/**
 * Whether a session's timestamps are real.
 *
 * §15: `chrome.history.search()` returns only `lastVisitTime`, so every
 * backfilled page is stored with `firstVisit === lastVisit` — a page read
 * across three weeks looks like a single instant. Grouping those by time is a
 * *reconstruction*, not a record, and the UI must say so rather than blending
 * them with live captures that carry real first/last times and real
 * engagement.
 */
export type SessionProvenance = 'exact' | 'approximate' | 'mixed';

/** The subset of a page record sessions need. Keeps this module storage-free. */
export interface SessionPage {
  id: string;
  title: string;
  domain: string;
  firstVisit: number;
  lastVisit: number;
  activeSeconds: number;
  /**
   * True when the page came from live capture, which is the only route that
   * produces trustworthy times and engagement. `extractionQuality` is present
   * only on live captures, which is what this is derived from upstream.
   */
  captured: boolean;
}

export interface Session {
  id: string;
  start: number;
  end: number;
  /** **Pages**, not collapsed nodes. */
  pageIds: string[];
  pageCount: number;
  /** Derived, never invented; `null` when nothing was derivable (§14). */
  label: string | null;
  topics: string[];
  /** Still open — the last page is recent enough that more may follow. */
  provisional: boolean;
  provenance: SessionProvenance;
  /**
   * Autoplay-shaped run of passive media.
   *
   * **`null` means undeterminable, not false.** Backfilled pages carry
   * `activeSeconds: 0` because §9 measures engagement live and never infers
   * it — so a wholly backfilled session has no engagement signal at all, and
   * calling it "not passive" would be an invented finding. Only sessions with
   * live-captured pages can answer this.
   */
  passive: boolean | null;
  /** Summed live engagement. 0 across a wholly backfilled session, by definition. */
  activeSeconds: number;
  /** §7's day, starting 04:00. Assigned from `start`. */
  day: number;
}

/**
 * Groups pages into sessions by activity gap.
 *
 * The 04:00 day boundary (§7) assigns a session to a *day*; it does not cut
 * one. Splitting a continuous 03:50–04:10 run in half would invent a boundary
 * the user did not experience — §7's boundary exists so that late-night work
 * rolls up to the previous day, which is a labelling question, not a
 * segmentation one.
 */
export function buildSessions(pages: SessionPage[], now = Date.now()): Session[] {
  if (pages.length === 0) return [];

  const ordered = [...pages].sort((a, b) => a.lastVisit - b.lastVisit || a.id.localeCompare(b.id));

  const runs: SessionPage[][] = [];
  let current: SessionPage[] = [ordered[0]!];
  for (let i = 1; i < ordered.length; i++) {
    const page = ordered[i]!;
    const previous = ordered[i - 1]!;
    if (page.lastVisit - previous.lastVisit > SESSION_GAP_MS) {
      runs.push(current);
      current = [];
    }
    current.push(page);
  }
  runs.push(current);

  const labels = new Map(
    labelClusters(
      runs.map((run, index) => ({ id: String(index), titles: run.map((p) => p.title) }))
    ).map((l) => [l.id, l.label])
  );

  return runs.map((run, index) => {
    const start = Math.min(...run.map((p) => p.firstVisit));
    const end = Math.max(...run.map((p) => p.lastVisit));
    const capturedCount = run.filter((p) => p.captured).length;

    const provenance: SessionProvenance =
      capturedCount === run.length ? 'exact' : capturedCount === 0 ? 'approximate' : 'mixed';

    return {
      id: `s${start}-${run.length}`,
      start,
      end,
      pageIds: run.map((p) => p.id),
      pageCount: run.length,
      label: labels.get(String(index)) ?? null,
      topics: [],
      provisional: now - end < PROVISIONAL_WITHIN_MS,
      provenance,
      passive: detectPassiveMedia(run),
      activeSeconds: run.reduce((sum, p) => sum + p.activeSeconds, 0),
      day: dayStart(start),
    };
  });
}

/**
 * Detects a passive-media *session*, not a passive page (§11).
 *
 * Looks for a run of consecutive pages that are all on one domain, all barely
 * engaged with, and all brief. Length is what separates autoplay from
 * attention: one long unengaged page is a watched talk, twenty short ones are
 * a playlist playing itself.
 *
 * Returns `null` when the session contains no live-captured page, because
 * `activeSeconds` is then structurally 0 and carries no information — see the
 * note on `Session.passive`.
 */
export function detectPassiveMedia(run: SessionPage[]): boolean | null {
  if (!run.some((page) => page.captured)) return null;
  if (run.length < PASSIVE_MIN_RUN) return false;

  let longest = 0;
  let length = 0;
  for (let i = 0; i < run.length; i++) {
    const page = run[i]!;
    const next = run[i + 1];
    const brief = next === undefined || next.lastVisit - page.lastVisit <= PASSIVE_MAX_PAGE_MS;
    const unengaged = page.activeSeconds <= PASSIVE_ACTIVE_SECONDS;
    const sameDomain = i === 0 || run[i - 1]!.domain === page.domain;

    if (unengaged && brief && (length === 0 || sameDomain)) {
      length++;
      longest = Math.max(longest, length);
    } else {
      length = unengaged && brief ? 1 : 0;
    }
  }

  // The run has to dominate the session, not merely occur in it — otherwise a
  // short autoplay detour would relabel an afternoon of real research.
  return longest >= PASSIVE_MIN_RUN && longest >= run.length / 2;
}
