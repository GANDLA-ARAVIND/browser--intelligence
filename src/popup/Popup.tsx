import { useCallback, useEffect, useState } from 'react';
import { dayStart } from '../lib/day.js';
import { formatRemaining, isPaused, remainingMs, type PauseState } from '../lib/pause.js';
import { getAllPages, openDatabase } from '../lib/storage.js';
import { openDashboard } from '../platform/browser.js';
import { loadPauseState, pauseFor, pauseIndefinitely, resumeCapture } from '../platform/pause.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The toolbar popup. Deliberately three things and nothing else — this is the
 * one surface the user sees on every click, so it stays a glance, not a
 * second dashboard. Search, the timeline, topic cards: all one click away
 * through the dashboard link, never duplicated here.
 */
export function Popup(): React.JSX.Element {
  const [todayCount, setTodayCount] = useState<number | null>(null);
  const [pause, setPause] = useState<PauseState | null>(null);
  const [, forceTick] = useState(0);

  const loadCount = useCallback(async () => {
    try {
      const db = await openDatabase();
      const pages = await getAllPages(db);
      // §7's day boundary, not midnight. Counts any page last visited today,
      // live-captured or not — a backfill re-run today would inflate this,
      // but that is a rare, self-explanatory edge case for a glance-only stat.
      const start = dayStart();
      setTodayCount(pages.filter((p) => p.lastVisit >= start).length);
    } catch {
      setTodayCount(null);
    }
  }, []);

  const loadPause = useCallback(async () => {
    setPause(await loadPauseState());
  }, []);

  useEffect(() => {
    void loadCount();
    void loadPause();
    // Re-render every 30s so a countdown or an expired timed-pause updates
    // without the user having to close and reopen the popup.
    const timer = window.setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [loadCount, loadPause]);

  const paused = pause !== null && isPaused(pause);
  const remaining = pause !== null ? remainingMs(pause) : null;

  const doPauseFor = useCallback(async (ms: number) => {
    setPause(await pauseFor(ms));
  }, []);
  const doPauseIndefinitely = useCallback(async () => {
    setPause(await pauseIndefinitely());
  }, []);
  const doResume = useCallback(async () => {
    setPause(await resumeCapture());
  }, []);

  return (
    <main className="popup">
      <h1>Browser Intelligence</h1>

      <p className="popup-stat">
        {todayCount === null ? '…' : todayCount} page{todayCount === 1 ? '' : 's'} captured today
      </p>

      <section className="popup-pause">
        {paused ? (
          <>
            <p className="popup-paused-line">
              <strong>Paused</strong>
              {remaining === null ? ' until you turn it back on' : ` · ${formatRemaining(remaining)} left`}
            </p>
            <button type="button" onClick={() => void doResume()}>
              Resume capturing
            </button>
          </>
        ) : (
          <>
            <p className="detail">Pause capturing</p>
            <div className="popup-pause-buttons">
              <button type="button" onClick={() => void doPauseFor(30 * 60 * 1000)}>
                30 min
              </button>
              <button type="button" onClick={() => void doPauseFor(HOUR_MS)}>
                1 hour
              </button>
              <button type="button" onClick={() => void doPauseIndefinitely()}>
                Until I turn it back on
              </button>
            </div>
          </>
        )}
      </section>

      <button type="button" className="popup-dashboard-link" onClick={() => void openDashboard()}>
        Open dashboard →
      </button>
    </main>
  );
}
