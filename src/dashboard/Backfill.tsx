import { useCallback, useEffect, useRef, useState } from 'react';
import { idleProgress, TIMED_STAGES, type BackfillProgress, type BackfillStage } from '../lib/backfill.js';
import { summariseBlocking } from '../lib/blocking.js';
import { getMeta, openDatabase, type BackfillSummary, type ClusteringSummary } from '../lib/storage.js';
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
/**
 * Imported, never re-declared. This file used to carry its own copy of the
 * stage list, and when `cluster` was added to the pipeline the copy was not
 * updated — clustering ran, recorded its duration, produced 104 clusters, and
 * the table filtered the row out. The stage was invisible while working
 * perfectly (§14).
 */
const STAGE_ORDER = TIMED_STAGES;

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
  const [clustering, setClustering] = useState<ClusteringSummary | null>(null);
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
      // Read separately: clustering owns its own summary precisely because it
      // can fail without failing the backfill, so its outcome is not in the
      // backfill record.
      setClustering(await getMeta<ClusteringSummary>(db, 'clustering'));
    } catch {
      setSummary(null); // no database yet — nothing has run
      setClustering(null);
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

      {summary !== null && <Timings summary={summary} clustering={clustering} />}
    </section>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

const pctOf = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`;

/**
 * Clustering results, **with every count carrying its unit**.
 *
 * Nodes and pages are different units and a percentage in one is not
 * comparable to a percentage in the other. An earlier version printed
 * "104 clusters over 2,724 nodes · 2,414 pages unclustered" on one line and
 * was immediately misread as 87% noise — the same unit-mixing error as the
 * blocklist audit that reported 18 rows beside a 59-page difference (§14).
 * Each row below states its unit, and the two are never adjacent unlabelled.
 *
 * `pagesNeverConsidered` is broken out because it is the bucket that makes the
 * page figure look worse than the harness: pages sitting in the database that
 * this run never had as input cannot cluster, and counting them as noise
 * compares two different things.
 */
function ClusteringBreakdown({ clustering }: { clustering: ClusteringSummary | null }): React.JSX.Element | null {
  if (clustering === null) return null;

  if (clustering.error !== undefined) {
    return (
      <p className="error-note">
        Clustering failed: {clustering.error}. The corpus is still stored and searchable; the next run
        retries.
      </p>
    );
  }

  // A summary written before the unit split has `nodes` as a plain number.
  if (typeof clustering.nodes !== 'object') {
    return <p className="detail">Clustering ran, but before the unit breakdown existed. Re-run to see it.</p>;
  }

  const { nodes, pages } = clustering;
  return (
    <div className="timings">
      <h3>Clustering</h3>
      <table>
        <thead>
          <tr>
            <th>unit</th>
            <th>total</th>
            <th>clustered</th>
            <th>noise</th>
            <th>noise %</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>nodes (collapsed)</td>
            <td>{nodes.total.toLocaleString()}</td>
            <td>{nodes.clustered.toLocaleString()}</td>
            <td>{nodes.noise.toLocaleString()}</td>
            <td>{pctOf(nodes.noise, nodes.total)}</td>
          </tr>
          <tr>
            <td>pages (this run)</td>
            <td>{pages.considered.toLocaleString()}</td>
            <td>{pages.clustered.toLocaleString()}</td>
            <td>{pages.noise.toLocaleString()}</td>
            <td>{pctOf(pages.noise, pages.considered)}</td>
          </tr>
        </tbody>
      </table>
      <p className="detail">
        {clustering.clusters} clusters. Noise is §5&rsquo;s discovery queue, not a failure.
        {clustering.pagesNeverConsidered > 0 && (
          <>
            {' '}
            A further <strong>{clustering.pagesNeverConsidered.toLocaleString()} pages</strong> in the
            database were not part of this run&rsquo;s input (live captures since the last backfill, or
            pages outside the history window), so they are unclustered without having been considered —
            counted in the {clustering.unclusteredPages.toLocaleString()} the re-cluster trigger watches,
            but not in the noise figures above.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * Enumerates every *expected* stage and marks the missing ones, rather than
 * enumerating only what was found (§14).
 *
 * The distinction is the whole point of this component. A table built from
 * `Object.keys(stageMs)` — or filtered through a stale allowlist — can only
 * ever show presence. A stage that ran and was omitted, a stage that threw,
 * and a stage never reached all render as the same blank space, and the report
 * silently stops describing the pipeline.
 */
function Timings({
  summary,
  clustering,
}: {
  summary: BackfillSummary;
  clustering: ClusteringSummary | null;
}): React.JSX.Element {
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
          {STAGE_ORDER.map((stage) => {
            const mine = summary.stageMs[stage];
            const node = NODE_BASELINE_MS[stage];

            // A stage with no recorded duration is reported as such, with
            // whatever reason is available, never dropped from the table.
            if (mine === undefined) {
              const why =
                stage === 'cluster' && clustering?.error !== undefined
                  ? `failed: ${clustering.error}`
                  : 'did not run';
              return (
                <tr key={stage} data-missing="true">
                  <td>{stage}</td>
                  <td className="stage-missing" colSpan={3}>
                    {why}
                  </td>
                </tr>
              );
            }

            return (
              <tr key={stage}>
                <td>
                  {stage}
                  {stage === 'cluster' && clustering?.error !== undefined && (
                    <span className="stage-missing"> · failed</span>
                  )}
                </td>
                <td>{formatMs(mine)}</td>
                <td>{node === undefined ? '—' : formatMs(node)}</td>
                <td>{node === undefined || node === 0 ? '—' : `${(mine / node).toFixed(2)}×`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <ClusteringBreakdown clustering={clustering} />
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
