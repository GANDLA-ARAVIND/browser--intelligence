import { useCallback, useEffect, useState } from 'react';
import { getMeta, openDatabase, type CaptureHealth as HealthRecord } from '../lib/storage.js';

/**
 * Is capture actually working?
 *
 * Nothing else in the UI answers this. Every other panel reports on data that
 * arrived; none can report on data that never did, and a page that was never
 * captured is indistinguishable from a page never visited (§14). Total capture
 * failure was invisible for two rebuilds — the corpus simply stopped growing,
 * which looks identical to not browsing.
 *
 * The hour threshold is deliberately loose. It is not "capture is broken", it
 * is "long enough that you should check", and the copy says so — a warning
 * that cries wolf on a quiet afternoon would be ignored by the time it
 * mattered.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;

function ago(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function CaptureHealth(): React.JSX.Element {
  const [health, setHealth] = useState<HealthRecord | null>(null);
  const [checkedAt, setCheckedAt] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const db = await openDatabase();
      setHealth(await getMeta<HealthRecord>(db, 'capture-health'));
    } catch {
      setHealth(null);
    }
    setCheckedAt(Date.now());
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const lastCapture = health?.lastCaptureAt ?? null;
  const reloadedAt = health?.extensionReloadedAt ?? null;
  const staleMs = lastCapture === null ? null : Date.now() - lastCapture;
  const isStale = staleMs !== null && staleMs > STALE_AFTER_MS;

  // The orphan signature: the extension was reloaded *after* the last capture
  // landed. Any tab open across that reload is running a content script that
  // can no longer reach the extension and never will again.
  const orphanLikely = isStale && lastCapture !== null && reloadedAt !== null && reloadedAt > lastCapture;

  return (
    <section className="panel">
      <h2>Capture health</h2>

      {lastCapture === null ? (
        <p className="detail">
          No capture has ever been recorded. If you have browsed with the
          extension loaded, something is wrong — check the page console for
          <code> [content] </code> lines.
        </p>
      ) : (
        <p className="detail">
          Last capture <strong>{ago(lastCapture)}</strong> ·{' '}
          {new Date(lastCapture).toLocaleString()}
        </p>
      )}

      {isStale && (
        <p className="error-note">
          <strong>Nothing has captured in over an hour.</strong>{' '}
          {orphanLikely ? (
            <>
              The extension was reloaded at{' '}
              {reloadedAt === null ? 'an unknown time' : new Date(reloadedAt).toLocaleTimeString()},
              after the last capture — <strong>your content scripts may be orphaned.</strong>{' '}
              Reloading the extension permanently disconnects the content script in every tab that
              was already open; those tabs keep browsing but can no longer capture anything.{' '}
              <strong>Reload your tabs</strong> to resume capturing.
            </>
          ) : (
            <>
              If you have been browsing normally, capture may have stopped. Reload your open tabs
              first — that fixes the common case. If it persists, check the page console for{' '}
              <code>[content]</code> lines.
            </>
          )}
        </p>
      )}

      {reloadedAt !== null && (
        <p className="detail">
          Extension last reloaded {ago(reloadedAt)} · tabs opened before then cannot capture
        </p>
      )}

      <p className="detail">checked {new Date(checkedAt).toLocaleTimeString()}</p>
    </section>
  );
}
