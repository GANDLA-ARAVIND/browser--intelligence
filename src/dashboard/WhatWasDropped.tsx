import { useCallback, useEffect, useState } from 'react';
import type { DropReason, FilterAuditSummary } from '../lib/filter.js';
import { getMeta, openDatabase, type BackfillSummary } from '../lib/storage.js';

const REASON_LABEL: Record<DropReason, string> = {
  'no-url': 'Unparseable URL',
  scheme: 'Not http/https (chrome://, file:, …)',
  localhost: 'Localhost / private network',
  blocked: 'Blocked by privacy settings (§9)',
  search: 'Search-result page',
  duplicate: 'Duplicate of a page already seen',
  'junk-title': 'Junk title (auth wall, error, interstitial)',
  'short-title': 'Title too short to categorise',
};

/**
 * What the filters removed, and why.
 *
 * Reports the **recorded** result of the last run, not a re-evaluation of the
 * current index. The first version of this panel scanned stored pages and asked
 * "what would the blocklist match" — but blocked pages are never stored, so it
 * reported approximately zero. That is the worst possible failure for a panel
 * whose whole purpose is making suppression visible: the user checks, sees
 * nothing, and concludes nothing was suppressed.
 *
 * Units are stated per row because the pipeline genuinely uses two. Pass 1 runs
 * before deduplication and counts raw history rows; pass 2 runs after and
 * counts unique pages. 212 blocked *rows* collapsed to 59 *pages*, and reading
 * those as the same number is what made an 18-row audit look like it had missed
 * 41 suppressed pages.
 */
export function WhatWasDropped(): React.JSX.Element {
  const [summary, setSummary] = useState<BackfillSummary | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const db = await openDatabase();
      setSummary(await getMeta<BackfillSummary>(db, 'backfill'));
    } catch {
      setSummary(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const audit: FilterAuditSummary | undefined = summary?.filterAudit;

  return (
    <section className="panel">
      <h2>What was dropped</h2>

      <p className="detail settings-intro">
        Filters remove pages silently — a page that was never indexed looks
        exactly like a page you never visited. This is the record of the last
        backfill, so a filter that is wrong can be seen rather than assumed.
      </p>

      {summary === null && <p className="detail">No backfill has run yet.</p>}

      {summary !== null && audit === undefined && (
        <p className="detail">
          The last backfill ran before this record existed. Run it again to see
          the breakdown.
        </p>
      )}

      {audit !== undefined && (
        <>
          {!audit.reconciles && (
            <p className="error-note">
              {Math.abs(audit.unaccounted).toLocaleString()} rows were dropped with no
              recorded reason. A filter is removing pages that nothing reports —
              these counts cannot be trusted.
            </p>
          )}

          <table className="drop-table">
            <thead>
              <tr>
                <th>reason</th>
                <th>count</th>
                <th>unit</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(REASON_LABEL) as DropReason[])
                .filter((reason) => audit.counts[reason] > 0)
                .sort((a, b) => audit.counts[b] - audit.counts[a])
                .map((reason) => (
                  <tr key={reason}>
                    <td>{REASON_LABEL[reason]}</td>
                    <td>{audit.counts[reason].toLocaleString()}</td>
                    <td className="detail">{audit.units[reason]}</td>
                  </tr>
                ))}
              <tr>
                <td>
                  <strong>Kept</strong>
                </td>
                <td>
                  <strong>{audit.kept.toLocaleString()}</strong>
                </td>
                <td className="detail">pages</td>
              </tr>
            </tbody>
          </table>

          <p className="detail bar-caption">
            {audit.raw.toLocaleString()} raw rows in ·{' '}
            {audit.reconciles ? 'every drop accounted for' : 'counts do not reconcile'} ·{' '}
            {audit.pathRescued} page{audit.pathRescued === 1 ? '' : 's'} kept by URL-path
            extraction that would otherwise have been dropped
          </p>

          <button type="button" className="linkish" onClick={() => setOpen(!open)}>
            {open ? 'hide what was dropped' : 'show what was dropped'}
          </button>

          {open && (
            <>
              {(Object.keys(REASON_LABEL) as DropReason[])
                .filter((reason) => audit.samples[reason].length > 0)
                .map((reason) => (
                  <div key={reason}>
                    <h3 className="drop-heading">
                      {REASON_LABEL[reason]} — {audit.counts[reason].toLocaleString()}{' '}
                      {audit.units[reason]}
                    </h3>
                    <ul className="drop-list">
                      {audit.samples[reason].slice(0, 40).map(([value, count]) => (
                        <li key={value}>
                          <span className="hit-score">{count}</span>
                          <span className="hit-title">{value || '(blank)'}</span>
                        </li>
                      ))}
                    </ul>
                    {audit.samples[reason].length > 40 && (
                      <p className="detail">
                        … and {audit.samples[reason].length - 40} more distinct values
                      </p>
                    )}
                  </div>
                ))}

              {audit.pathDropped.length > 0 && (
                <>
                  <h3 className="drop-heading">
                    URL paths that yielded no usable words — {audit.pathDropped.length} pages
                  </h3>
                  <ul className="drop-list">
                    {audit.pathDropped.slice(0, 40).map((url) => (
                      <li key={url}>
                        <span className="hit-score">1</span>
                        <span className="hit-title">{url}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
