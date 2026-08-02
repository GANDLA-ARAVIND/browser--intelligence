/**
 * Pause-toggle storage (CLAUDE.md §9). `chrome.storage.local`, same reasoning
 * as settings.ts: this describes what may be captured on *this* machine, and
 * syncing a "paused" flag to other devices is the wrong default.
 *
 * A separate key from `settings` (not folded into it) because the content
 * script reads it on every page load and settings.ts's shape is a different
 * concern — a preference vs. a transient runtime state.
 */

import { notPaused, type PauseState, type PauseUntil } from '../lib/pause.js';

const KEY = 'pauseState';

export async function loadPauseState(): Promise<PauseState> {
  const stored = await chrome.storage.local.get(KEY);
  const raw = stored[KEY] as { until?: unknown } | undefined;
  if (raw === undefined) return notPaused();

  const until = raw.until;
  if (until === 'indefinite' || typeof until === 'number') return { until };
  return notPaused();
}

async function savePauseState(state: PauseState): Promise<void> {
  await chrome.storage.local.set({ [KEY]: state });
}

export async function pauseFor(ms: number): Promise<PauseState> {
  const state: PauseState = { until: Date.now() + ms };
  await savePauseState(state);
  return state;
}

export async function pauseIndefinitely(): Promise<PauseState> {
  const state: PauseState = { until: 'indefinite' as PauseUntil };
  await savePauseState(state);
  return state;
}

export async function resumeCapture(): Promise<PauseState> {
  const state = notPaused();
  await savePauseState(state);
  return state;
}
