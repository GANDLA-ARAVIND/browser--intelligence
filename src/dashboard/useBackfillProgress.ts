import { useCallback, useEffect, useRef, useState } from 'react';
import { idleProgress, type BackfillProgress } from '../lib/backfill.js';
import { sendMessage } from '../platform/browser.js';

const POLL_MS = 400;

/**
 * Polls `GET_BACKFILL_PROGRESS` on an interval. Shared by `Backfill` (the
 * Settings panel) and `FirstRun` (the install-time screen) — both watch the
 * same offscreen-document state, and duplicating the poll loop would be two
 * copies to keep in sync with the offscreen document's actual stage list.
 */
export function useBackfillProgress(): BackfillProgress {
  const [progress, setProgress] = useState<BackfillProgress>(idleProgress());
  const timer = useRef<number | null>(null);
  // Monotonic request id, same fix as SEARCH's own request race (DECISIONS.md):
  // nothing guarantees these replies resolve in the order they were sent, so a
  // poll delayed behind a slow IndexedDB write can otherwise land *after* a
  // newer one and roll the UI back from 'done' to whatever stage it was
  // carrying — which reads as the run never finishing.
  const latestRequestId = useRef(0);

  const poll = useCallback(async () => {
    const requestId = ++latestRequestId.current;
    const reply = await sendMessage({ target: 'background', type: 'GET_BACKFILL_PROGRESS' });
    // A newer poll was issued while this one was in flight — its reply, once
    // it lands, is the only one allowed to update state.
    if (requestId !== latestRequestId.current) return;
    // Null is ordinary here — the worker may be mid-restart. Keep the last
    // known progress rather than flashing the UI back to idle.
    if (reply !== null) setProgress(reply.progress);
  }, []);

  useEffect(() => {
    void poll();
    timer.current = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, [poll]);

  return progress;
}
