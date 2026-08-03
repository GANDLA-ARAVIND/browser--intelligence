/**
 * Cooperative time-slicing for the O(n²) passes (CLAUDE.md §2.7, §14).
 *
 * §14's rule is that the danger is *any synchronous pass over the whole
 * corpus*, whatever stage it sits in. Collapse and clustering are both exactly
 * that: measured at 12.0s and 3.4s on 5,374 pages, 15.4s combined and unbroken.
 * The offscreen document is single-threaded, so for that whole window it
 * services no messages at all — a `SEARCH` arriving mid-collapse simply waits.
 *
 * The fix is to yield to the event loop often enough that no single block is
 * user-visible. Two things this deliberately does *not* do:
 *
 *  - **It does not change iteration order.** Chunking inserts suspension points
 *    between iterations and nothing else, so a chunked pass produces output
 *    byte-identical to the synchronous one. That is asserted against the real
 *    corpus rather than assumed.
 *  - **It does not use `queueMicrotask`.** Microtasks drain *before* timers and
 *    before message delivery, so yielding to one would satisfy the letter of
 *    "yield" while leaving the thread just as unresponsive. It has to be a
 *    macrotask.
 *
 * Budget rather than a fixed iteration count: the cost of one outer iteration
 * varies with corpus size and machine, so "every 500 rows" blocks for wildly
 * different durations on different inputs. Wall-clock is what the user feels.
 */

/**
 * Target slice.
 *
 * Swept on the real 5,374-page corpus against the blocking monitor, **three
 * runs, median** (§14 — single numbers here span 2×, and an earlier one-shot
 * sweep of this same parameter gave a different winner). The monitor reports
 * *lateness beyond a tick*, so the true unresponsive window is `tickMs + late`:
 *
 * ```
 *   config        wall     unresponsive     cost
 *   sync         15.2s          15,218ms       —
 *   chunked  50ms 25.7s              50ms    +69%
 *   chunked  75ms 21.3s             125ms    +40%   ← chosen
 *   chunked 100ms 21.2s             149ms    +40%
 * ```
 *
 * 75ms and 100ms cost the same wall-clock, so the smaller stall wins for free.
 * 50ms buys a further 75ms of responsiveness for another 29 points of runtime,
 * which is not worth it — 125ms is already well inside the ~200ms target.
 *
 * **The +40% is real and is the price of the trade**: ~6s more wall-clock in
 * exchange for a thread that answers messages throughout, rather than 15.2s
 * during which the offscreen document services nothing at all. For a
 * background stage that is the right side of it; this constant should not be
 * raised to claw back seconds without re-measuring the stall.
 */
export const DEFAULT_SLICE_MS = 75;

/**
 * A macrotask yield. `setTimeout(0)` is clamped to ~4ms once nesting passes a
 * few levels, which is the cost of this approach — measured against ~15s of
 * work it is single-digit percent, and it is what actually lets the message
 * queue and the blocking monitor's own timer run.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Split into a synchronous `due()` and an async `yieldNow()` rather than a
 * single `await slicer.tick()`, and that split is worth ~3 seconds.
 *
 * A single awaited method allocates a promise and schedules a microtask on
 * *every* outer iteration — ~11,000 of them across collapse and clustering —
 * even on the >99% of iterations that do not yield. Measured: overhead sat at
 * ~21% regardless of slice budget, which is the tell that the cost was per
 * iteration rather than per yield. Checking a boolean first and awaiting only
 * when actually yielding removes it.
 *
 * Usage: `if (slicer.due()) await slicer.yieldNow();`
 */
export interface Slicer {
  /** Cheap, synchronous: has this slice run past budget? */
  due(): boolean;
  /** Hand the thread back and start a new slice. */
  yieldNow(): Promise<void>;
  /** How many times the loop actually yielded — reported, not guessed. */
  yields(): number;
}

/**
 * Thrown from inside a chunked loop when a cancellation was requested at a
 * yield checkpoint. A cooperative cancel is only checkable *between*
 * iterations — JS is single-threaded, so nothing can set the flag mid-batch —
 * which is exactly where `yieldNow()` already returns control to the caller.
 * `runBackfill` catches this specifically and treats it as neither success
 * nor failure: a genuinely cancelled run, distinct from an error, because a
 * "cancel" button that only hides the screen while the work keeps running
 * underneath would not actually do what it claims (CLAUDE.md §14's honesty
 * standard applied to a UI control, not a report).
 */
export class BackfillCancelledError extends Error {
  constructor() {
    super('backfill cancelled');
    this.name = 'BackfillCancelledError';
  }
}

export function createSlicer(budgetMs: number = DEFAULT_SLICE_MS): Slicer {
  let sliceStart = performance.now();
  let count = 0;
  return {
    due(): boolean {
      return performance.now() - sliceStart >= budgetMs;
    },
    async yieldNow(): Promise<void> {
      await yieldToEventLoop();
      sliceStart = performance.now();
      count++;
    },
    yields(): number {
      return count;
    },
  };
}
