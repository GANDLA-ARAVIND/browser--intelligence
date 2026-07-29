/**
 * Main-thread blocking monitor.
 *
 * The offscreen document is single-threaded. Any synchronous loop inside it
 * stops `chrome.runtime.onMessage` from being serviced at all — the dashboard's
 * progress poll gets no reply, and the UI freezes on its last known value.
 *
 * This measures the block rather than inferring it from stage durations: a
 * timer set to fire every `tickMs` can only fire late if the thread was busy,
 * so the lateness *is* the block.
 *
 * Two things make naive versions of this lie, both found by measuring a stage
 * known to block for 19s and getting zero events back:
 *
 *  1. **Attribution.** The late tick fires *after* the block, by which time the
 *     stage label has usually already advanced. Reading "the current stage"
 *     blames the wrong one. So stage changes are timestamped and each gap is
 *     attributed by interval overlap.
 *  2. **The final block is missed.** `clearInterval` immediately after the last
 *     stage kills the pending late tick before it can fire, discarding the
 *     largest measurement. `stop()` therefore waits one tick before clearing.
 *
 * Matters beyond cosmetics: §7 puts capture and embedding on the live browsing
 * path in later phases, where §2.7 — "never block the user's browsing" — makes
 * a multi-second block a correctness problem, not a UI one.
 */

export interface BlockingEvent {
  stage: string;
  /** Milliseconds the thread was unresponsive beyond the expected tick. */
  ms: number;
  at: number;
  /**
   * Where in the stage the stall began. This is what distinguishes a one-off
   * initialisation cost from a recurring one: a large stall at ~0ms is lazy
   * setup being charged to the first unit of work, the same stall at 60s is
   * something else entirely (GC, throttling, a pathological input).
   */
  sinceStageStartMs: number;
}

export interface BlockingMonitor {
  setStage(stage: string): void;
  /** Waits for any in-flight late tick, then stops. */
  stop(): Promise<BlockingEvent[]>;
  events(): BlockingEvent[];
}

export interface BlockingMonitorOptions {
  tickMs?: number;
  /** Ignore scheduler jitter below this; only real blocks are interesting. */
  thresholdMs?: number;
}

interface Transition {
  stage: string;
  at: number;
}

export function startBlockingMonitor(options: BlockingMonitorOptions = {}): BlockingMonitor {
  const tickMs = options.tickMs ?? 100;
  const thresholdMs = options.thresholdMs ?? 250;

  const found: BlockingEvent[] = [];
  const transitions: Transition[] = [{ stage: 'startup', at: performance.now() }];
  let last = performance.now();

  /**
   * Which stage occupied most of [from, to], and when *that occurrence* of it
   * began.
   *
   * Returning the segment start rather than looking the stage up by name
   * afterwards is what keeps the offset honest. A gap almost always straddles
   * the boundary — the tick before a long block fires a few ms before the stage
   * switches — so a name lookup can return an earlier occurrence and yield a
   * negative offset, which is not a thing that can happen.
   */
  const attribute = (from: number, to: number): { stage: string; segmentStart: number } => {
    let best = transitions[0]!;
    let bestOverlap = -1;
    for (let i = 0; i < transitions.length; i++) {
      const start = transitions[i]!.at;
      const end = i + 1 < transitions.length ? transitions[i + 1]!.at : Number.POSITIVE_INFINITY;
      const overlap = Math.min(to, end) - Math.max(from, start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = transitions[i]!;
      }
    }
    return { stage: best.stage, segmentStart: best.at };
  };

  const tick = (): void => {
    const now = performance.now();
    const late = now - last - tickMs;
    if (late >= thresholdMs) {
      const { stage, segmentStart } = attribute(last, now);
      found.push({
        stage,
        ms: Math.round(late),
        at: Date.now(),
        // Clamped: a gap that starts a few ms before the boundary belongs to
        // the stage that owns almost all of it, at offset zero.
        sinceStageStartMs: Math.max(0, Math.round(last - segmentStart)),
      });
    }
    last = now;
  };

  const timer = setInterval(tick, tickMs);

  return {
    setStage(next: string): void {
      transitions.push({ stage: next, at: performance.now() });
    },
    events(): BlockingEvent[] {
      return [...found];
    },
    async stop(): Promise<BlockingEvent[]> {
      // Let the pending late tick fire; it carries the largest gap.
      await new Promise((resolve) => setTimeout(resolve, tickMs * 2));
      clearInterval(timer);
      return [...found];
    },
  };
}

export interface BlockingByStage {
  stage: string;
  count: number;
  totalMs: number;
  longestMs: number;
}

export function summariseBlocking(events: BlockingEvent[]): BlockingByStage[] {
  const byStage = new Map<string, BlockingByStage>();
  for (const event of events) {
    const entry = byStage.get(event.stage) ?? { stage: event.stage, count: 0, totalMs: 0, longestMs: 0 };
    entry.count++;
    entry.totalMs += event.ms;
    entry.longestMs = Math.max(entry.longestMs, event.ms);
    byStage.set(event.stage, entry);
  }
  return [...byStage.values()].sort((a, b) => b.longestMs - a.longestMs);
}
