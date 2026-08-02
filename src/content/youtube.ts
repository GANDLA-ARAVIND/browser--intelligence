/**
 * YouTube transcript adapter (CLAUDE.md §8 tier 1).
 *
 * The only tier-1 candidate that survived measurement — GitHub and NeetCode
 * were both named from a single failing page each and eliminated once the
 * quality-driven ladder existed (DECISIONS.md). YouTube is different in kind:
 * Readability and the metadata rung can only ever return the video
 * *description*, and DECISIONS.md already measured that failure mode —
 * `coverage` scored a watch page good 0.91 at 100% coverage while the text was
 * the description plus sidebar recommendations, well-formed prose about the
 * wrong subject. No structural signal can tell "good prose, wrong topic" from
 * "good prose, right topic" (§14). Only the transcript is actually about the
 * video.
 *
 * Reads the DOM transcript panel rather than YouTube's caption API: no extra
 * host permission, no network call this project would have to justify next to
 * "reads your browsing history, nothing leaves the machine" (§9). The panel is
 * normally closed, so this opens it, scrapes it, and closes it again — the one
 * place in the extraction path that visibly touches the page, unlike
 * Readability's clone-first-never-touch approach. Kept to a ~2.5s budget
 * because there is no way to read a lazily-rendered panel without rendering
 * it.
 */

/**
 * Diagnostic build (2 of 9 real videos hit tier 1; both successes were the
 * same class of video). Widened from the original 2.5s so the logging below
 * can actually tell "segments never rendered" from "segments rendered late" —
 * shipping a tighter number is a decision for once the real failure step is
 * known, not before.
 */
const TRANSCRIPT_WAIT_MS = 6000;
const POLL_INTERVAL_MS = 150;

// console.log, not console.debug — Verbose is hidden by default in Chrome
// DevTools, and a whole diagnostic round was lost to logs nobody could see.
const log = (...args: unknown[]): void => console.log('[youtube-transcript]', ...args);

function isWatchPage(): boolean {
  const result = location.hostname.endsWith('youtube.com') && location.pathname === '/watch';
  log('isWatchPage', `hostname=${location.hostname}`, `pathname=${location.pathname}`, `result=${result}`);
  return result;
}

/**
 * Only reads what is already in the DOM — does not open the "..." / "more
 * actions" menu, whose items do not exist in the DOM until that menu itself
 * has been clicked open. This is diagnostic: it reports whether that avenue
 * even looks reachable, without yet acting on it (see the module comment on
 * `tryYouTubeTranscript`).
 */
function moreActionsButtonPresent(): boolean {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('button')).find((button) => {
      const label = button.getAttribute('aria-label') ?? '';
      return /more actions/i.test(label);
    }) !== undefined
  );
}

function findTranscriptButton(): { button: HTMLElement; via: 'direct' | 'fallback' } | null {
  // Stable across recent layouts: the "Show transcript" button sits directly
  // under the description preview, no need to expand it first.
  const direct = document.querySelector<HTMLElement>('ytd-video-description-transcript-section-renderer button');
  if (direct !== null) return { button: direct, via: 'direct' };

  // Layout fallback: any <button> whose label names the feature. Does not
  // search the "..." overflow menu — see moreActionsButtonPresent above.
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('button'));
  const fallback = candidates.find((button) => {
    const label = button.getAttribute('aria-label') ?? button.textContent ?? '';
    return /show transcript/i.test(label);
  });

  if (fallback === undefined) {
    log(
      'button-not-found',
      `buttons-scanned=${candidates.length}`,
      `more-actions-button-present=${moreActionsButtonPresent()}`,
      `logged-in=${document.querySelector('button#avatar-btn, ytd-topbar-menu-button-renderer') !== null}`
    );
    return null;
  }
  return { button: fallback, via: 'fallback' };
}

function findCloseButton(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('ytd-transcript-renderer #dismiss-button button') ??
    document.querySelector<HTMLElement>(
      'ytd-engagement-panel-title-header-renderer #visibility-button button'
    )
  );
}

/**
 * Every query below runs from `document`, never from a scoped parent — the
 * panel may mount anywhere in the tree, and a scoped root was one of the two
 * candidate explanations for `segmentNodes=0`.
 *
 * The other candidate is shadow DOM, which `document.querySelectorAll` cannot
 * see through at all. `deepQueryAll` is the check for that. It is deliberately
 * **not** on the hot path: walking every element looking for shadow roots is
 * expensive on a page as large as a YouTube watch page, so it runs only in the
 * fallback and dump paths, after the cheap selectors have already missed.
 */
function deepQueryAll(selector: string, root: Document | ShadowRoot = document, depth = 0): Element[] {
  const found: Element[] = Array.from(root.querySelectorAll(selector));
  if (depth > 4) return found;
  for (const element of Array.from(root.querySelectorAll('*'))) {
    if (element.shadowRoot !== null) found.push(...deepQueryAll(selector, element.shadowRoot, depth + 1));
  }
  return found;
}

const textOf = (nodes: Element[]): string =>
  nodes
    .map((node) => node.textContent?.trim() ?? '')
    .filter((t) => t.length > 0)
    .join(' ');

/** A transcript line opens with a timestamp: "0:34", "12:07", "1:02:55". */
const TIMESTAMP = /^\s*\d{1,2}:\d{2}(:\d{2})?\s/;

/**
 * Strategies in cost order, each named so the log says which one matched.
 *
 * Matching on *structure* rather than exact custom-element names is the point
 * from strategy 3 onward: YouTube renames these elements, and a fix that
 * hardcodes whatever they are called this month will break the same way.
 */
interface SegmentRead {
  text: string;
  segmentNodes: number;
  segmentsWithText: number;
  via: string;
}

function readSegments(): SegmentRead {
  // 1 — the documented names, kept first because they are cheapest and were
  //     correct on the two videos where the adapter did work.
  const known = Array.from(document.querySelectorAll('ytd-transcript-segment-renderer'));
  const knownText = Array.from(document.querySelectorAll('ytd-transcript-segment-renderer .segment-text'));
  if (knownText.length > 0) {
    return { text: textOf(knownText), segmentNodes: known.length, segmentsWithText: knownText.length, via: 'known-selector' };
  }
  // 1b — container found but the inner text class has been renamed.
  if (known.length > 0) {
    return { text: textOf(known), segmentNodes: known.length, segmentsWithText: known.length, via: 'known-container-raw-text' };
  }

  // 2 — any element whose own name says it is a transcript segment.
  const byName = Array.from(document.querySelectorAll('*')).filter((element) => {
    const tag = element.tagName.toLowerCase();
    return tag.includes('transcript') && tag.includes('segment');
  });
  if (byName.length > 0) {
    return { text: textOf(byName), segmentNodes: byName.length, segmentsWithText: byName.length, via: 'tagname-contains-transcript-segment' };
  }

  // 3 — class-based, for a renamed element that kept its styling hooks.
  const byClass = Array.from(document.querySelectorAll('[class*="segment-text"], [class*="transcript-segment"]'));
  if (byClass.length > 0) {
    return { text: textOf(byClass), segmentNodes: byClass.length, segmentsWithText: byClass.length, via: 'class-contains-segment' };
  }

  // 4 — purely structural: a run of sibling elements each opening with a
  //     timestamp is a transcript regardless of what any of it is called.
  const timestamped = Array.from(document.querySelectorAll('*')).filter(
    (element) => element.children.length <= 3 && TIMESTAMP.test(element.textContent ?? '')
  );
  if (timestamped.length >= 5) {
    return { text: textOf(timestamped), segmentNodes: timestamped.length, segmentsWithText: timestamped.length, via: 'timestamp-shaped-rows' };
  }

  // 5 — same as 1, but piercing shadow roots.
  const shadow = deepQueryAll('ytd-transcript-segment-renderer');
  if (shadow.length > 0) {
    return { text: textOf(shadow), segmentNodes: shadow.length, segmentsWithText: shadow.length, via: 'shadow-dom' };
  }

  return { text: '', segmentNodes: 0, segmentsWithText: 0, via: 'none' };
}

/**
 * Dumps what is actually in the DOM when every strategy misses.
 *
 * The point is to *observe the real node names* rather than guess another
 * selector — the same discipline as the last round, where guessing would have
 * cost another full test cycle. Output is capped so a watch page cannot flood
 * the console.
 */
function dumpTranscriptDom(): void {
  const describe = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    const id = element.id.length > 0 ? `#${element.id}` : '';
    const visible = (element as HTMLElement).offsetParent !== null;
    const chars = (element.textContent ?? '').trim().length;
    return `<${tag}${id}> children=${element.children.length} visible=${visible} textLen=${chars}`;
  };

  log('=== DOM DUMP (every segment strategy missed) ===');

  // Anything that names itself a transcript, however it is spelled.
  const named = Array.from(document.querySelectorAll('*')).filter((element) =>
    element.tagName.toLowerCase().includes('transcript')
  );
  log(`elements with "transcript" in tagName: ${named.length}`);
  for (const element of named.slice(0, 12)) {
    log('  ', describe(element));
    const kids = Array.from(element.children).slice(0, 12).map((c) => c.tagName.toLowerCase());
    if (kids.length > 0) log('      children:', kids.join(', '));
  }

  // The strongest structural tell: transcript segments are many siblings that
  // all share one tag. Whatever that tag is, this finds it by shape.
  const runs: Array<{ parent: string; childTag: string; count: number; sample: string }> = [];
  for (const element of Array.from(document.querySelectorAll('*'))) {
    if (element.children.length < 10) continue;
    const tags = Array.from(element.children).map((c) => c.tagName.toLowerCase());
    const first = tags[0]!;
    if (!tags.every((t) => t === first)) continue;
    runs.push({
      parent: element.tagName.toLowerCase(),
      childTag: first,
      count: tags.length,
      sample: (element.children[0]?.textContent ?? '').trim().slice(0, 70),
    });
  }
  runs.sort((a, b) => b.count - a.count);
  log(`containers with 10+ same-tag children: ${runs.length}`);
  for (const run of runs.slice(0, 10)) {
    log(`   <${run.parent}> → ${run.count} × <${run.childTag}>  sample="${run.sample}"`);
  }

  // Panels, shadow roots and frames — the three ways the panel could exist but
  // sit outside anything queried above.
  const panels = Array.from(document.querySelectorAll('ytd-engagement-panel-section-list-renderer'));
  log(`engagement panels: ${panels.length}`);
  for (const panel of panels.slice(0, 8)) {
    log('  ', describe(panel), `target-id=${panel.getAttribute('target-id') ?? '-'}`, `visibility=${panel.getAttribute('visibility') ?? '-'}`);
  }

  const shadowHosts = Array.from(document.querySelectorAll('*')).filter((e) => e.shadowRoot !== null);
  log(`elements with a shadowRoot: ${shadowHosts.length}`, shadowHosts.slice(0, 8).map((e) => e.tagName.toLowerCase()).join(', '));
  log(`iframes: ${document.querySelectorAll('iframe').length}`);
  log('=== END DUMP ===');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Opens the transcript panel, reads it, closes it again. Returns '' if this
 * is not a watch page, the button never appears, or the panel never populates
 * within budget — every one of those falls through to Readability, per §8.
 * Many videos genuinely have no transcript at all; that is not an error, so
 * every exit path below logs *which* of those it was, to separate "no
 * transcript" from "adapter bug" (2 of 9 real videos hit tier 1 in the first
 * round, both the same class of video, which does not look like the former).
 *
 * Deliberately does not yet try the "..." overflow-menu placement of the
 * button, or change any selector — that is the next step, once the logging
 * below shows which step is actually failing on the videos where a
 * transcript is known to exist.
 */
export async function tryYouTubeTranscript(): Promise<string> {
  log('called', `href=${location.href}`);

  if (!isWatchPage()) return '';

  const found = findTranscriptButton();
  if (found === null) return '';
  log('button-found', `via=${found.via}`, `label=${(found.button.getAttribute('aria-label') ?? found.button.textContent ?? '').trim().slice(0, 60)}`);

  try {
    found.button.click();

    const startedAt = Date.now();
    const deadline = startedAt + TRANSCRIPT_WAIT_MS;
    let result = readSegments();
    while (Date.now() < deadline && result.text.length === 0) {
      await wait(POLL_INTERVAL_MS);
      result = readSegments();
    }
    const elapsedMs = Date.now() - startedAt;

    if (result.text.length === 0) {
      log(
        'panel-empty-at-timeout',
        `elapsedMs=${elapsedMs}`,
        `segmentNodes=${result.segmentNodes}`,
        `segmentsWithText=${result.segmentsWithText}`,
        `via=${result.via}`
      );
      dumpTranscriptDom();
      return '';
    }

    log(
      'success',
      `via=${result.via}`,
      `elapsedMs=${elapsedMs}`,
      `segments=${result.segmentsWithText}`,
      `chars=${result.text.length}`
    );
    return result.text;
  } catch (error) {
    log('threw', error);
    return '';
  } finally {
    // Best effort — a missing close button leaves the panel open, which is
    // cosmetic, not a correctness problem, so this must never throw.
    try {
      findCloseButton()?.click();
    } catch {
      /* ignore */
    }
  }
}
