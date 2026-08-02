import { useCallback, useEffect, useRef, useState } from 'react';
import { idleProgress, type BackfillProgress, type BackfillStage } from '../lib/backfill.js';
import { summariseBlocking } from '../lib/blocking.js';
import { getMeta, openDatabase, type BackfillSummary } from '../lib/storage.js';
import { sendMessage } from '../platform/browser.js';

/** §10: this screen is what the user sees 60 seconds after install. */
const STAGE_LABEL: Record<BackfillStage, string> = {
  idle: 'Ready',
  'reading-history': 'Reading browser history',
  filtering: 'Filtering',
  'loading-model': 'Loading model (bundled, no download)',
  embedding: 'Embedding titles',
  collapsing: 'Collapsing near-duplicates',
  writing: 'Writing to local storage',
  clustering: 'Finding topics',
  done: 'Complete',
  error: 'Failed',
};

const ACTIVE: BackfillStage[] = [
  'reading-history',
  'filtering',
  'loading-model',
  'embedding',
  'collapsing',
  'writing',
  'clustering',
];

const POLL_MS = 400;

/** Stage order for display; `finish` writes whichever ones ran. */
const STAGE_ORDER = ['filter', 'model', 'embed', 'collapse', 'write-groups'] as const;

/** The Phase 0 harness on the same corpus, for comparison. */
const NODE_BASELINE_MS: Partial<Record<string, number>> = {
  filter: 422,
  embed: 64_020,
  collapse: 20_090,
};

export function Backfill(): React.JSX.Element {
  const [progress, setProgress] = useState<BackfillProgress>(idleProgress());
  const [starting, setStarting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [summary, setSummary] = useState<BackfillSummary | null>(null);
  const timer = useRef<number | null>(null);

  const poll = useCallback(async () => {
    const reply = await sendMessage({ target: 'background', type: 'GET_BACKFILL_PROGRESS' });
    // Null is ordinary here — the worker may be mid-restart. Keep the last
    // known progress rather than flashing the UI back to idle.
    if (reply !== null) setProgress(reply.progress);
  }, []);

  // §3: all four contexts share one origin and therefore one IndexedDB, so the
  // dashboard reads the summary directly rather than routing it through a
  // message. It also survives the offscreen document being torn down.
  const loadSummary = useCallback(async () => {
    try {
      const db = await openDatabase();
      setSummary(await getMeta<BackfillSummary>(db, 'backfill'));
    } catch {
      setSummary(null); // no database yet — nothing has run
    }
  }, []);

  useEffect(() => {
    void poll();
    void loadSummary();
    timer.current = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, [poll, loadSummary]);

  // Re-read once the run finishes; the summary is only written at the end.
  useEffect(() => {
    if (progress.stage === 'done') void loadSummary();
  }, [progress.stage, loadSummary]);

  const start = useCallback(async () => {
    setStarting(true);
    setNote(null);
    const reply = await sendMessage({ target: 'background', type: 'START_BACKFILL' });
    setStarting(false);
    if (reply === null) setNote('The service worker did not respond. Reload the extension and try again.');
    else if (!reply.accepted) setNote(reply.reason ?? 'Backfill was not accepted.');
    void poll();
  }, [poll]);

  const isActive = ACTIVE.includes(progress.stage);
  const percent = progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;
  const { counts } = progress;

  return (
    <section className="panel">
      <h2>History backfill</h2>

      <div className="actions" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
        <button type="button" onClick={() => void start()} disabled={starting || isActive}>
          {isActive ? 'Running…' : progress.stage === 'done' ? 'Run again' : 'Start backfill'}
        </button>
        <span className="detail">
          {STAGE_LABEL[progress.stage]}
          {progress.detail === '' ? '' : ` · ${progress.detail}`}
        </span>
      </div>

      {(isActive || progress.stage === 'done') && (
        <>
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
            {progress.total > 0 ? `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}` : ''}
          </p>
        </>
      )}

      {/* Counts stream in as they land rather than appearing at the end. */}
      <dl className="counts">
        <Count label="Raw rows" value={counts.rawRows} />
        <Count label="Kept" value={counts.kept} />
        <Count label="Blocked (§9)" value={counts.blocked} />
        <Count label="Stored" value={counts.stored} />
        <Count label="Unique nodes" value={counts.uniqueNodes} />
      </dl>

      {progress.error !== null && <p className="error-note">{progress.error}</p>}
      {note !== null && <p className="error-note">{note}</p>}

      {summary !== null && <Timings summary={summary} />}
    </section>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function Timings({ summary }: { summary: BackfillSummary }): React.JSX.Element {
  const stages = STAGE_ORDER.filter((stage) => summary.stageMs[stage] !== undefined);

  return (
    <div className="timings">
      <h3>
        Last run · {new Date(summary.completedAt).toLocaleString()} · {formatMs(summary.durationMs)} total
      </h3>
      <table>
        <thead>
          <tr>
            <th>stage</th>
            <th>this run</th>
            <th>Node (Phase 0)</th>
            <th>ratio</th>
          </tr>
        </thead>
        <tbody>
          {stages.map((stage) => {
            const mine = summary.stageMs[stage]!;
            const node = NODE_BASELINE_MS[stage];
            return (
              <tr key={stage}>
                <td>{stage}</td>
                <td>{formatMs(mine)}</td>
                <td>{node === undefined ? '—' : formatMs(node)}</td>
                <td>{node === undefined || node === 0 ? '—' : `${(mine / node).toFixed(2)}×`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="detail">
        Node ran multi-threaded native ONNX; this runs single-threaded WASM,
        which MV3&rsquo;s CSP requires.
      </p>

      <BlockingReport summary={summary} />
    </div>
  );
}

/**
 * Main-thread stalls. The offscreen document cannot answer a progress poll
 * while blocked, so anything here is a window in which the extension was
 * unresponsive — and in later phases this same code runs while the user
 * browses, where §2.7 makes it a correctness problem rather than a cosmetic one.
 */
function BlockingReport({ summary }: { summary: BackfillSummary }): React.JSX.Element {
  const blocking = summary.blocking ?? [];
  const byStage = summariseBlocking(blocking);
  const longest = blocking.reduce((max, event) => Math.max(max, event.ms), 0);

  if (byStage.length === 0) {
    return <p className="detail">No main-thread stalls over 250 ms recorded.</p>;
  }

  // The worst stall and where in its stage it happened: a big one at ~0s is
  // lazy initialisation charged to the first unit of work, the same stall
  // later is something else.
  const worst = blocking.reduce<BackfillSummary['blocking'][number] | null>(
    (max, event) => (max === null || event.ms > max.ms ? event : max),
    null
  );

  return (
    <>
      <h3 style={{ marginTop: '1.1rem' }}>
        Main-thread stalls · longest {formatMs(longest)}
      </h3>
      <table>
        <thead>
          <tr>
            <th>stage</th>
            <th>stalls</th>
            <th>longest</th>
            <th>total</th>
          </tr>
        </thead>
        <tbody>
          {byStage.map((entry) => (
            <tr key={entry.stage}>
              <td>{entry.stage}</td>
              <td>{entry.count}</td>
              <td>{formatMs(entry.longestMs)}</td>
              <td>{formatMs(entry.totalMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Offset only. Any interpretation baked in here is written for one
          stage and wrong for the next — "deferred initialisation" made no
          sense for a pure-JS loop with nothing to initialise. */}
      {worst !== null && worst.sinceStageStartMs !== undefined && (
        <p className="detail">
          Worst stall: {formatMs(worst.ms)}, beginning {formatMs(worst.sinceStageStartMs)} into{' '}
          <strong>{worst.stage}</strong>.
        </p>
      )}
    </>
  );
}

function Count({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="count">
      <dt>{label}</dt>
      <dd>{value === 0 ? '—' : value.toLocaleString()}</dd>
    </div>
  );
}
