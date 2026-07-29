import { useCallback, useState, type FormEvent } from 'react';
import { sendMessage } from '../platform/browser.js';
import type { SearchHit, SearchResponse } from '../platform/messages.js';

const LIMIT = 20;

/**
 * Phase 1 step 4 — bare semantic search. No filters, no summaries, no
 * "more like this"; those are §12 and phase 4.
 *
 * The query never touches a vector here. It goes to the offscreen document,
 * which owns the index and does the scan, because §14 records that keeping
 * synchronous work out of the dashboard context is what kept the UI alive.
 */
export function Search(): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const trimmed = query.trim();
      if (trimmed === '') return;

      setBusy(true);
      setError(null);
      const reply = await sendMessage({ target: 'background', type: 'SEARCH', query: trimmed, limit: LIMIT });
      setBusy(false);

      if (reply === null) {
        setError('No response. Run a backfill first, or reload the extension.');
        setResult(null);
        return;
      }
      setResult(reply);
    },
    [query]
  );

  return (
    <section className="panel">
      <h2>Search</h2>

      <form onSubmit={(event) => void run(event)} className="actions" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="what were you reading about?"
          aria-label="Search your history"
          className="search-input"
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>

      {error !== null && <p className="error-note">{error}</p>}

      {result !== null && (
        <>
          <p className="detail" style={{ marginTop: '0.9rem' }}>
            {result.hits.length} of {result.scanned.toLocaleString()} unique nodes · scan{' '}
            {result.timings.scanMs} ms · query embed {result.timings.embedMs} ms
            {result.timings.loadMs > 0 ? ` · index load ${result.timings.loadMs} ms` : ''}
          </p>
          <ol className="hits">
            {result.hits.map((hit) => (
              <Hit key={hit.id} hit={hit} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function Hit({ hit }: { hit: SearchHit }): React.JSX.Element {
  return (
    <li>
      <span className="hit-score">{hit.score.toFixed(3)}</span>
      <span className="hit-title">{hit.title}</span>
      <span className="detail">
        {hit.domain} · {new Date(hit.lastVisit).toLocaleDateString()}
        {hit.collapsed > 1 ? ` · ×${hit.collapsed}` : ''}
      </span>
    </li>
  );
}
