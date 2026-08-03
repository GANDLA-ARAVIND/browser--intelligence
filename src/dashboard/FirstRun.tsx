import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackfillStage } from '../lib/backfill.js';
import { getAllClusters, openDatabase } from '../lib/storage.js';
import { sendMessage } from '../platform/browser.js';
import { useBackfillProgress } from './useBackfillProgress.js';

const STAGE_LABEL: Record<BackfillStage, string> = {
  idle: 'Starting…',
  'reading-history': 'Reading your browser history',
  filtering: 'Filtering out low-value pages',
  'loading-model': 'Loading the embedding model',
  embedding: 'Reading titles and finding what they mean',
  collapsing: 'Collapsing near-duplicate pages',
  writing: 'Saving to your local index',
  clustering: 'Finding topics in what you’ve browsed',
  done: 'Done',
  cancelled: 'Cancelled',
  error: 'Something went wrong',
};

const FINISHED: BackfillStage[] = ['done', 'cancelled', 'error'];

/** How often the independent topic-count poll runs, matching the progress poll. */
const TOPIC_POLL_MS = 400;

/**
 * How long the "done" state sits on screen before landing on Search. Long
 * enough to read the final topic count, short enough that it does not feel
 * like a second confirmation step the user has to click through (§10 — the
 * screen 60 seconds after install is what decides whether this survives, and
 * that budget is better spent already in Search than staring at "Done").
 */
const AUTO_ADVANCE_MS = 1400;

/**
 * The screen a genuine fresh install lands on (§10, §14). Explains what is
 * about to happen *before* it starts — the `history` permission warning
 * already fired at install, so this is the first chance to say why — then
 * streams progress and topic counts as the backfill actually runs, rather
 * than holding everything back for a single "done" screen at the end.
 *
 * Cancel is genuine, not cosmetic: it sends `CANCEL_BACKFILL`, which reaches
 * a cooperative check inside `runBackfill` itself (CLAUDE.md §14's honesty
 * standard — a "cancel" that only hid this screen while the run kept going
 * underneath would not do what it claims).
 */
export function FirstRun({ onComplete }: { onComplete: () => void }): React.JSX.Element {
  const progress = useBackfillProgress();
  const [namedTopics, setNamedTopics] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const advanceTimer = useRef<number | null>(null);

  useEffect(() => {
    let stopped = false;
    const poll = async (): Promise<void> => {
      try {
        const db = await openDatabase();
        const clusters = await getAllClusters(db);
        // Only named clusters count as topics — an unlabelled shape is not a
        // claim about what the user was doing (§5, §6, §14).
        if (!stopped) setNamedTopics(clusters.filter((c) => c.label !== null).length);
      } catch {
        // Backfill may not have written anything yet; leave the count as-is.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), TOPIC_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (progress.stage !== 'done') return;
    advanceTimer.current = window.setTimeout(onComplete, AUTO_ADVANCE_MS);
    return () => {
      if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
    };
  }, [progress.stage, onComplete]);

  const cancel = useCallback(async () => {
    setCancelling(true);
    await sendMessage({ target: 'background', type: 'CANCEL_BACKFILL' });
    onComplete();
  }, [onComplete]);

  const isFinished = FINISHED.includes(progress.stage);
  const percent = progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;
  const { counts } = progress;

  return (
    <div className="first-run">
      <div className="first-run-card">
        <h1>Setting up your index</h1>
        <p className="first-run-copy">
          Reading the last ~90 days of your Chrome history — titles only, nothing else. This is why
          Chrome showed the &ldquo;read your browsing history&rdquo; warning when you installed: read
          locally, nothing transmitted, source is public. Everything below happens on this machine and
          takes roughly one to three minutes.
        </p>

        <div className="actions" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
          <span className="detail first-run-stage">{STAGE_LABEL[progress.stage]}</span>
          {progress.detail !== '' && <span className="detail"> · {progress.detail}</span>}
        </div>

        <div
          className="bar"
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={STAGE_LABEL[progress.stage]}
        >
          <div
            className="bar-fill"
            data-stage={progress.stage}
            style={{ width: `${progress.stage === 'done' ? 100 : percent}%` }}
          />
        </div>
        <p className="detail bar-caption">
          {progress.total > 0 ? `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}` : ' '}
        </p>

        <dl className="counts">
          <div className="count">
            <dt>Pages kept</dt>
            <dd>{counts.kept === 0 ? '—' : counts.kept.toLocaleString()}</dd>
          </div>
          <div className="count">
            <dt>Indexed</dt>
            <dd>{counts.stored === 0 ? '—' : counts.stored.toLocaleString()}</dd>
          </div>
          <div className="count">
            <dt>Topics found</dt>
            <dd>{namedTopics === 0 ? '—' : namedTopics.toLocaleString()}</dd>
          </div>
        </dl>

        {progress.stage === 'error' && (
          <p className="error-note">
            {progress.error ?? 'The backfill failed.'} Anything already indexed above is still stored and
            searchable — you can retry from Settings.
          </p>
        )}

        {progress.stage === 'cancelled' && (
          <p className="detail" style={{ marginTop: '1rem' }}>
            Cancelled. Anything already indexed above is stored and searchable now; run the rest later from
            Settings.
          </p>
        )}

        <div className="actions">
          {!isFinished && (
            <button type="button" onClick={() => void cancel()} disabled={cancelling}>
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          {isFinished && (
            <button type="button" onClick={onComplete}>
              Go to Search
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
