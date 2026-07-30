import { useCallback, useEffect, useState } from 'react';
import type { QueueItem } from '../lib/capture.js';
import { assessExtraction } from '../lib/quality.js';
import { getAllPages, getQueue, openDatabase, type PageRecord } from '../lib/storage.js';

const TIER_LABEL: Record<number, string> = {
  1: 'tier 1 · site adapter',
  2: 'tier 2 · Readability',
  3: 'tier 3 · title + meta',
  4: 'tier 4 · domain rule',
};

/**
 * Live-captured pages, newest first, with the extracted text visible.
 *
 * The point is judging extraction quality on real sites — §8 says to log the
 * tier on every record so coverage can be measured rather than guessed, and a
 * tier number means nothing without the text beside it.
 */
export function Captures(): React.JSX.Element {
  const [captured, setCaptured] = useState<PageRecord[]>([]);
  const [queued, setQueued] = useState<QueueItem[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const db = await openDatabase();
      const [pages, queue] = await Promise.all([getAllPages(db), getQueue(db)]);
      // Backfilled records have no text; only live captures do.
      setCaptured(pages.filter((page) => page.text.length > 0).sort((a, b) => b.lastVisit - a.lastVisit));
      setQueued(queue);
    } catch {
      setCaptured([]);
      setQueued([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  const byTier = captured.reduce<Record<number, number>>((acc, page) => {
    acc[page.extractionTier] = (acc[page.extractionTier] ?? 0) + 1;
    return acc;
  }, {});

  // Corpus-wide, across backfilled *and* captured pages. This is the number
  // §14 flags as a hidden ranking bias, so it needs to be visible.
  const [mix, setMix] = useState<{ title: number; text: number }>({ title: 0, text: 0 });
  useEffect(() => {
    void (async () => {
      try {
        const db = await openDatabase();
        const pages = await getAllPages(db);
        setMix({
          title: pages.filter((p) => p.vectorSource === 'title').length,
          text: pages.filter((p) => p.vectorSource === 'text').length,
        });
      } catch {
        setMix({ title: 0, text: 0 });
      }
    })();
  }, [captured.length]);

  return (
    <section className="panel">
      <h2>Captured pages</h2>

      <p className="detail">
        Corpus vectors: {mix.title.toLocaleString()} from titles ·{' '}
        {mix.text.toLocaleString()} from body text
      </p>
      <p className="detail">
        {captured.length} captured
        {queued.length > 0 ? ` · ${queued.length} queued, embedding within a minute` : ''}
        {Object.keys(byTier).length > 0
          ? ` · ${Object.entries(byTier)
              .map(([tier, n]) => `${n} at tier ${tier}`)
              .join(', ')}`
          : ''}
      </p>

      {captured.length === 0 && queued.length === 0 && (
        <p className="detail">
          Nothing yet. Browse a page and stay on it for 30 seconds — capture is
          gated on focused dwell, so a quick glance is deliberately ignored.
        </p>
      )}

      <ol className="captures">
        {captured.slice(0, 25).map((page) => (
          <li key={page.id}>
            <div className="capture-head">
              <strong>{page.title || '(untitled)'}</strong>
              {/* Re-scored live from the stored text, so a metric change is
                  visible as drift instead of silently applying only to new
                  captures. `coverage` is not recomputed — the page's own text
                  length was a capture-time measurement and is not stored. */}
              {(() => {
                const now = assessExtraction(page.text, 0);
                const before = page.extractionQuality;
                if (before === undefined) return <span className="verdict">rescored: {now.verdict} · {now.score.toFixed(2)}</span>;
                if (before.verdict === now.verdict) return null;
                return (
                  <span className={`verdict verdict-${now.verdict}`}>
                    verdict changed: {before.verdict} {before.score.toFixed(2)} → {now.verdict} {now.score.toFixed(2)}
                  </span>
                );
              })()}
              {page.extractionQuality !== undefined && (
                <span className={`verdict verdict-${page.extractionQuality.verdict}`}>
                  {page.extractionQuality.verdict} · {page.extractionQuality.score.toFixed(2)}
                  {page.extractionQuality.stopwordRatio !== null
                    ? ` · stopwords ${page.extractionQuality.stopwordRatio.toFixed(2)}`
                    : ' · non-Latin'}
                  {` · ${page.extractionQuality.terminatorsPer100Words.toFixed(1)} term/100w`}
                  {` · coverage ${(page.extractionQuality.coverage * 100).toFixed(0)}%`}
                </span>
              )}
              <span className="detail">
                {TIER_LABEL[page.extractionTier] ?? `tier ${page.extractionTier}`} · vector from{' '}
                <strong>{page.vectorSource}</strong> · {page.text.length.toLocaleString()} chars ·{' '}
                {page.activeSeconds}s active ·{' '}
                {new Date(page.lastVisit).toLocaleTimeString()}
                {page.visitCount > 1 ? ` · ${page.visitCount}×` : ''}
              </span>
            </div>
            <p className="capture-text">
              {expanded === page.id ? page.text : `${page.text.slice(0, 320)}${page.text.length > 320 ? '…' : ''}`}
            </p>
            {page.text.length > 320 && (
              <button
                type="button"
                className="linkish"
                onClick={() => setExpanded(expanded === page.id ? null : page.id)}
              >
                {expanded === page.id ? 'show less' : 'show full text'}
              </button>
            )}
          </li>
        ))}
      </ol>

      {queued.length > 0 && (
        <p className="detail">
          Queued: {queued.map((item) => item.title || item.url).slice(0, 5).join(' · ')}
        </p>
      )}
    </section>
  );
}
