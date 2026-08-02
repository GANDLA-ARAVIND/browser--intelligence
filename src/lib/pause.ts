/**
 * Pause-toggle logic (CLAUDE.md §9). Pure — the storage wrapper lives in
 * src/platform/pause.ts, this file only decides what the stored state means.
 *
 * Split the same way as blocklist.ts / settings.ts: the rule that decides
 * "is capture allowed right now" should be identical wherever it is checked
 * (content script, background, popup), and a pure function is the only way to
 * guarantee that without three copies drifting apart.
 */

/**
 * `'indefinite'` is "until I turn it back on" — distinct from a timestamp so
 * far in the future that it would eventually need one, and distinct from
 * `null`, which means "not paused at all". Three states, three values.
 */
export type PauseUntil = number | 'indefinite';

export interface PauseState {
  until: PauseUntil | null;
}

export function notPaused(): PauseState {
  return { until: null };
}

/**
 * A timed pause is over the instant `now` reaches it — there is no separate
 * "clear the flag" step. Anyone checking after that moment sees `isPaused`
 * return false, which is what makes this safe to check from three different
 * contexts without any of them owning a cleanup responsibility.
 */
export function isPaused(state: PauseState, now = Date.now()): boolean {
  if (state.until === null) return false;
  if (state.until === 'indefinite') return true;
  return now < state.until;
}

/** Milliseconds remaining, or `null` for an indefinite pause (nothing to count down) or when not paused. */
export function remainingMs(state: PauseState, now = Date.now()): number | null {
  const { until } = state;
  if (until === null || until === 'indefinite') return null;
  if (!isPaused(state, now)) return null;
  return Math.max(0, until - now);
}

export function formatRemaining(ms: number): string {
  const totalMinutes = Math.ceil(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
