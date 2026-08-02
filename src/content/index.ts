/**
 * Content script — extraction only (CLAUDE.md §3, §8).
 *
 * Runs in the page. Never embeds: inference here would freeze the user's tab,
 * which is the whole reason §3 puts the model in the offscreen document.
 *
 * §9 exclusions are checked **before** Readability runs, not after. Extracting
 * a banking page and then discarding it still means the text existed in memory
 * and could be sent; the rule is that excluded pages are never read at all.
 */

import { Readability } from '@mozilla/readability';
import { isSensitive, type SensitiveCategory } from '../lib/blocklist.js';
import {
  ACTIVITY_WINDOW_MS,
  capText,
  DWELL_THRESHOLD_MS,
  TIER_ADAPTER,
  TIER_DOMAIN_ONLY,
  TIER_METADATA,
  TIER_READABILITY,
  type CapturedPage,
  type ExtractionTier,
} from '../lib/capture.js';
import { assessExtraction, type ExtractionQuality } from '../lib/quality.js';
import { isLocalHost, stableSearch } from '../lib/url.js';
import { tryYouTubeTranscript } from './youtube.js';

/**
 * Injection marker.
 *
 * `console.log`, not `console.debug`, and that distinction is load-bearing
 * throughout this file: Chrome renders `console.debug` at **Verbose** level,
 * which is hidden unless the user has ticked that box in the DevTools level
 * dropdown. A full diagnostic round was spent on "the console shows nothing"
 * when the real answer was that every line this file emitted was filtered out
 * of the default view. Capture-path diagnostics are `log`; unrecoverable
 * failures are `error`.
 */
console.log('[content] script injected', location.href);

// --- §9 gate ----------------------------------------------------------------

async function blockedCategories(): Promise<SensitiveCategory[]> {
  try {
    const stored = await chrome.storage.local.get('settings');
    const raw = stored['settings'] as { blockedCategories?: unknown } | undefined;
    return Array.isArray(raw?.blockedCategories) ? (raw.blockedCategories as SensitiveCategory[]) : [];
  } catch {
    return [];
  }
}

async function isExcluded(): Promise<string | null> {
  // Incognito never reaches storage or the queue. Content scripts do not run in
  // incognito unless the user allows it, so this is belt and braces.
  if (chrome.extension?.inIncognitoContext === true) return 'incognito';

  const url = location.href;
  if (!/^https?:$/.test(location.protocol)) return 'scheme';
  if (isLocalHost(location.hostname.toLowerCase())) return 'localhost';

  const categories = await blockedCategories();
  if (categories.length > 0 && isSensitive(url, categories)) return 'blocklist';

  // A page still loading its title is not worth capturing yet; the dwell timer
  // gives it 30s to settle regardless.
  return null;
}

// --- dwell and active engagement --------------------------------------------

let focusedMs = 0;
let activeMs = 0;
let lastTick = performance.now();
let lastInput = Date.now();
let captured = false;

/**
 * Set once `chrome.runtime` has gone away underneath this script.
 *
 * Reloading or updating the extension orphans every content script already
 * injected into an open tab. The script keeps running — timers tick, dwell
 * accrues, extraction still works — but every `chrome.*` call throws
 * "Extension context invalidated" from then on, permanently, for the life of
 * that tab. Nothing short of a tab reload recovers, so once this is true the
 * only correct behaviour is to stop and say so loudly.
 */
let contextInvalidated = false;

/**
 * SPA navigation.
 *
 * YouTube, LinkedIn, Reddit, GitHub and most modern sites change URL through
 * `history.pushState` without a document load, so a content script that only
 * captures at load time silently misses every page after the first.
 *
 * Three options were considered:
 *
 *  1. `chrome.webNavigation.onHistoryStateUpdated` in the service worker.
 *     Authoritative, but needs the `webNavigation` permission and a round trip
 *     to tell this script to reset.
 *  2. Monkey-patching `history.pushState` / `replaceState`. **Does not work
 *     from a content script**: content scripts run in an isolated world with
 *     their own `history` binding, so the page's calls are never intercepted.
 *     Making it work needs a MAIN-world injection, which many sites' CSP
 *     blocks outright.
 *  3. Comparing `location.href` on a timer.
 *
 * Chose 3. A 1-second dwell tick is *already running*, so the check costs one
 * string comparison and no new timer, no new permission, and no new failure
 * mode. It also catches every navigation mechanism — pushState, replaceState,
 * popstate, hash routing, or a framework router doing something exotic —
 * because it observes the result rather than the cause. One second of latency
 * is irrelevant against a 30-second dwell threshold.
 */
let currentKey = navigationKey();

/**
 * What counts as "a different page".
 *
 * Fragments are excluded because `normalizeUrl` strips them at storage time —
 * `#section-2` and `#section-3` collapse to one record, so treating an anchor
 * click as a new page would inflate visitCount for no benefit. Hash *routes*
 * (`#/inbox`) are real navigation and are kept.
 *
 * Playback-position params are excluded for a sharper reason (see
 * `stableSearch`): YouTube rewrites `?t=` while a video plays, which read as a
 * navigation on every seek, reset the dwell clock, and meant the 30s gate was
 * never reached on a long video. `v` survives stripping, so switching videos
 * still registers as a new page — verified below.
 */
function navigationKey(): string {
  const route = location.hash.startsWith('#/') ? location.hash : '';
  return location.pathname + stableSearch(location.search) + route;
}

function resetForNewPage(): void {
  focusedMs = 0;
  activeMs = 0;
  lastInput = Date.now();
  captured = false;
}

/**
 * Both halves are load-bearing. `visibilityState` catches a backgrounded tab;
 * `document.hasFocus()` catches the whole Chrome window losing focus to
 * another application, where the tab stays `visible` and `visibilitychange`
 * never fires. Dropping either one leaks dwell.
 */
const isFocused = (): boolean => document.visibilityState === 'visible' && document.hasFocus();

/**
 * Restart the elapsed clock whenever the *window or tab* focus state changes.
 *
 * `elapsed` is wall time since the previous tick, but Chrome throttles
 * `setInterval` in a hidden tab to roughly once a minute. Without this, the
 * first tick after refocusing credits the entire throttled gap as focused
 * time: measured, one tick turned ~0.5s of real attention into 60s of dwell
 * and tripped the 30s gate instantly.
 *
 * Deliberately **not** `capture: true`. Element `focus`/`blur` do not bubble,
 * but a capture-phase window listener still sees them, so every click into a
 * text field reset the clock and truncated that interval. Measured on a
 * form-heavy page: 22% of dwell lost, and the 30s gate reached 25 seconds
 * late. Window-targeted focus/blur reach a plain window listener at the target
 * phase, which is exactly the scope wanted.
 *
 * `visibilitychange` fires at the document, so it is registered there.
 */
const restartElapsedClock = (): void => {
  lastTick = performance.now();
};
addEventListener('focus', restartElapsedClock, { passive: true });
addEventListener('blur', restartElapsedClock, { passive: true });
document.addEventListener('visibilitychange', restartElapsedClock, { passive: true });

/**
 * `isTrusted` excludes synthetic events — the YouTube transcript adapter
 * below dispatches a real `click()` on the page to open the transcript panel,
 * and without this check that self-inflicted click would mark the user as
 * "active" for the next `ACTIVITY_WINDOW_MS`, inflating `activeSeconds` on
 * attention the user never gave (§9).
 */
function markInput(event: Event): void {
  if (event.isTrusted) lastInput = Date.now();
}

for (const event of ['scroll', 'mousemove', 'keydown', 'click', 'wheel', 'touchstart']) {
  addEventListener(event, markInput, { passive: true, capture: true });
}

const TICK_MS = 1000;

/**
 * Dwell gates capture; activity gates the *number* we store. They differ
 * deliberately — a page can be focused and unread, and §9 is explicit that one
 * inflated duration makes every duration untrustworthy.
 */
function tick(): void {
  // Orphaned scripts cannot deliver anything; ticking on would only accrue
  // dwell nobody can ever receive. The interval is cleared when this is set,
  // so this guard is belt and braces against a tick already in flight.
  if (contextInvalidated) return;

  const now = performance.now();
  // Clamped as well as reset on refocus: a throttled or descheduled tick must
  // never contribute more than the interval it represents.
  const elapsed = Math.min(now - lastTick, TICK_MS * 1.5);
  lastTick = now;

  // Checked before the focus guard: an in-page navigation while the tab is
  // backgrounded still means the previous page's dwell must not carry over.
  const key = navigationKey();
  if (key !== currentKey) {
    console.log(`[content] in-page navigation, dwell reset: ${currentKey} → ${key}`);
    currentKey = key;
    resetForNewPage();
    return;
  }

  if (!isFocused()) return;
  focusedMs += elapsed;
  if (Date.now() - lastInput <= ACTIVITY_WINDOW_MS) activeMs += elapsed;

  if (!captured && focusedMs >= DWELL_THRESHOLD_MS) {
    captured = true;
    void capture('dwell');
  }
}

const tickTimer = setInterval(tick, TICK_MS);

// --- extraction -------------------------------------------------------------

interface Attempt {
  text: string;
  tier: ExtractionTier;
  quality: ExtractionQuality;
}

/**
 * Readability, mutating a clone. Parsing the live DOM would visibly rearrange
 * the user's page.
 */
function tryReadability(): string {
  try {
    const clone = document.cloneNode(true) as Document;
    return new Readability(clone).parse()?.textContent?.trim() ?? '';
  } catch (error) {
    console.log('[content] readability threw, falling through', error);
    return '';
  }
}

/** §8 tier 3: title + meta description + og:. */
function tryMetadata(): string {
  const parts = [
    document.title,
    document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '',
    document.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? '',
  ].filter((part) => part.trim().length > 0);
  return parts.join('. ');
}

/** §8 tier 4: domain rule only. Weak, but never empty. */
function tryDomain(): string {
  const words = location.pathname.split(/[/\-_.]+/).filter((part) => /^[a-z0-9]{2,}$/i.test(part));
  return [location.hostname.replace(/^www\./, ''), ...words].join(' ');
}

/**
 * Walks §8's ladder, **using the quality verdict as the fall-through
 * condition**. Recording quality without acting on it was the bug: Readability
 * returned 519 characters of navigation chrome and month names for a GitHub
 * profile, scored it `poor`, and embedded it anyway.
 *
 * A rung is accepted the moment it is not `poor`. If every rung is poor, the
 * highest-scoring one wins rather than the last one attempted — for that
 * GitHub page the metadata description scores far above the nav bar even
 * though both sit under the length floor.
 *
 * The returned tier is the one that actually **supplied** the text.
 *
 * Tier 1 is awaited before the synchronous rungs run, not raced against them:
 * it is the only rung that opens UI to read (the transcript panel), so it
 * needs to resolve — or time out — before anything else touches the page.
 * `tryYouTubeTranscript` already no-ops on every non-YouTube page, so this
 * costs nothing there.
 *
 * `allowSiteAdapter` is false on the `pagehide` path. That capture is racing
 * page teardown with no fixed budget — Chrome can discard the page at any
 * point after the event fires — and the adapter's up-to-2.5s wait for the
 * transcript panel to render would burn exactly the window `sendMessage`
 * needs. Losing tier 1 there still leaves Readability; losing the whole
 * capture would not, and would do it silently (§14).
 */
async function extract(pageTextLength: number, allowSiteAdapter: boolean): Promise<Attempt> {
  const attempts: Attempt[] = [];

  console.log(`[content] extract: allowSiteAdapter=${allowSiteAdapter}`);
  const transcript = allowSiteAdapter ? capText(await tryYouTubeTranscript()) : '';
  if (transcript.length > 0) {
    const quality = assessExtraction(transcript, pageTextLength);
    const attempt: Attempt = { text: transcript, tier: TIER_ADAPTER, quality };
    if (quality.verdict !== 'poor') return attempt;
    attempts.push(attempt);
  }

  // Thunks, not values: a rung must not run unless the ladder reaches it.
  const rungs: Array<[ExtractionTier, () => string]> = [
    [TIER_READABILITY, tryReadability],
    [TIER_METADATA, tryMetadata],
    [TIER_DOMAIN_ONLY, tryDomain],
  ];

  for (const [tier, produce] of rungs) {
    const trimmed = capText(produce());
    if (trimmed.length === 0) continue;

    const quality = assessExtraction(trimmed, pageTextLength);
    const attempt: Attempt = { text: trimmed, tier, quality };
    if (quality.verdict !== 'poor') return attempt;
    attempts.push(attempt);
  }

  // Everything was poor. Emit the best available rather than the last tried.
  attempts.sort((a, b) => b.quality.score - a.quality.score);
  return (
    attempts[0] ?? { text: '', tier: TIER_DOMAIN_ONLY, quality: assessExtraction('', pageTextLength) }
  );
}

async function capture(reason: string): Promise<void> {
  // Invariant, re-checked at the point of no return. Both call sites gate on
  // this already; the assertion exists because a leak here is silent — the
  // page is simply indexed on attention it never received, and nothing in the
  // stored record reveals that.
  if (focusedMs < DWELL_THRESHOLD_MS) {
    console.error(
      `[content] capture blocked: dwell ${Math.round(focusedMs)}ms is below the ${DWELL_THRESHOLD_MS}ms threshold (${reason})`
    );
    captured = false; // let a later, legitimate crossing still capture
    return;
  }

  const excluded = await isExcluded();
  if (excluded !== null) {
    console.log(`[content] skipped (${excluded})`);
    return;
  }

  // Compared against the page's own visible text, so "Readability found 500
  // chars" can be distinguished from "the page only had 500 chars".
  const pageTextLength = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().length;
  const allowSiteAdapter = reason !== 'pagehide';
  console.log(`[content] capture(${reason}): allowSiteAdapter=${allowSiteAdapter}`);
  const { text, tier, quality } = await extract(pageTextLength, allowSiteAdapter);

  const payload: CapturedPage = {
    url: location.href,
    title: document.title,
    text,
    extractionTier: tier,
    dwellMs: Math.round(focusedMs),
    activeSeconds: Math.round(activeMs / 1000),
    capturedAt: Date.now(),
    quality,
  };

  // The delivery call. Everything upstream of here is wasted if this fails, so
  // no failure on this path may be silent.
  //
  // This was previously `catch {}` with a comment claiming "the page is not
  // lost — a return visit re-captures it". **That reasoning was wrong for the
  // dominant failure**, and the empty catch is the purest form of the
  // suppression class in §14: the capture vanished with no log, no counter and
  // no UI trace. A worker mid-restart does recover on a return visit; an
  // *invalidated context* never does, because the orphaned script cannot reach
  // the extension again for the life of the tab. Both were being swallowed
  // identically, so a permanent, total capture failure looked exactly like a
  // transient one — measured: every capture between two dev rebuilds was lost
  // with nothing anywhere to show it.
  try {
    await chrome.runtime.sendMessage({ target: 'background', type: 'CAPTURE_PAGE', page: payload });
    console.log(
      `[content] captured via ${reason}: tier ${tier}, ${text.length} chars, quality ${quality.verdict} (${quality.score})`
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    if (/Extension context invalidated|Extension context was invalidated/i.test(detail)) {
      contextInvalidated = true;
      clearInterval(tickTimer);
      // console.error, not log: this is the one failure that must be visible
      // at the console's default level, without Verbose enabled.
      console.error(
        `[content] EXTENSION CONTEXT INVALIDATED — this tab can no longer capture anything. ` +
          `The extension was reloaded or updated after this page loaded, which orphans the ` +
          `content script permanently. Reload this tab to resume capturing. ` +
          `The capture of "${document.title}" was lost.`
      );
      return;
    }

    // Everything else — a worker mid-restart being the common case. Genuinely
    // recoverable on a return visit, but still reported rather than dropped.
    console.error(`[content] capture delivery failed (${reason}), page not stored: ${detail}`);
  }
}

// Re-check on the way out: a page closed at 25s still had 25s of attention, but
// §7 sets the bar at 30s and we honour it rather than special-casing.
addEventListener('pagehide', () => {
  if (contextInvalidated) return;
  if (!captured && focusedMs >= DWELL_THRESHOLD_MS) {
    captured = true;
    void capture('pagehide');
  }
});
