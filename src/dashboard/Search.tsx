import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { FORMATS, type Format } from '../lib/format.js';
import { getAllClusters, getAllPages, openDatabase } from '../lib/storage.js';
import { sendMessage } from '../platform/browser.js';
import type { SearchFilters, SearchHit, SearchResponse } from '../platform/messages.js';
import { faviconUrl } from './favicon.js';

const LIMIT = 20;
/** How many domains to offer in the filter's suggestion list — the corpus can hold hundreds. */
const DOMAIN_SUGGESTIONS = 40;

interface FilterState {
  startTime: string; // datetime-local string; '' = unset
  endTime: string;
  format: Format | '';
  topicClusterId: string;
  domain: string; // free text, matched as a substring
}

const EMPTY_FILTERS: FilterState = { startTime: '', endTime: '', format: '', topicClusterId: '', domain: '' };

function toSearchFilters(state: FilterState): SearchFilters | undefined {
  const filters: SearchFilters = {};
  const start = state.startTime.length > 0 ? new Date(state.startTime).getTime() : NaN;
  const end = state.endTime.length > 0 ? new Date(state.endTime).getTime() : NaN;
  if (!Number.isNaN(start)) filters.startTime = start;
  if (!Number.isNaN(end)) filters.endTime = end;
  if (state.format !== '') filters.format = state.format;
  if (state.topicClusterId !== '') filters.topicClusterId = state.topicClusterId;
  if (state.domain.trim() !== '') filters.domain = state.domain.trim();
  return Object.keys(filters).length > 0 ? filters : undefined;
}

interface TopicFacet {
  id: string;
  label: string;
  size: number;
}

/**
 * Phase 4 step 1 — the real search UI (§12).
 *
 * The query and every filter travel to the offscreen document, which owns the
 * index and does the scan — §14 records that keeping synchronous work out of
 * the dashboard is what kept the UI alive while 87% of a backfill blocked.
 * "More like this" is the same isolation rule applied to a second endpoint:
 * it is a vector-neighbour lookup, not a new embedding, but the scan is still
 * synchronous, so it stays on that side of the boundary too.
 */
export function Search(): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null);
  const [moreLike, setMoreLike] = useState<{ seedTitle: string; result: SearchResponse } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [topics, setTopics] = useState<TopicFacet[]>([]);
  const [domains, setDomains] = useState<string[]>([]);

  /**
   * Guards against out-of-order replies (§14's displayed-state-drift class,
   * DECISIONS.md). Filter changes auto-rerun the search — correct on its
   * own — but nothing stopped an *earlier*, slower request's reply from
   * landing after a *later*, correct one and overwriting it: the box would
   * show the new filter, the results would silently belong to the old one.
   * Each call to `runSearch` claims the next id; a reply is applied only if
   * its id is still the most recent one issued, so a stale response is
   * discarded rather than displayed.
   */
  const requestSeq = useRef(0);
  /** The exact query text the currently-displayed results answer. `null` = nothing has been searched yet. */
  const answeredQuery = useRef<string | null>(null);

  // Facet lists for the filter dropdowns. A direct IndexedDB read, same as
  // every other dashboard panel that lists corpus data (Captures, RemovePages)
  // — this is rendering support, not the compute §3 keeps out of this context.
  useEffect(() => {
    void (async () => {
      try {
        const db = await openDatabase();
        const [pages, clusters] = await Promise.all([getAllPages(db), getAllClusters(db)]);

        setTopics(
          clusters
            .filter((c): c is typeof c & { label: string } => c.label !== null)
            .map((c) => ({ id: c.id, label: c.label, size: c.size }))
            .sort((a, b) => b.size - a.size)
        );

        const counts = new Map<string, number>();
        for (const page of pages) {
          try {
            const domain = new URL(page.normalizedUrl).hostname.replace(/^www\./, '');
            counts.set(domain, (counts.get(domain) ?? 0) + 1);
          } catch {
            /* unparseable url, skip */
          }
        }
        setDomains(
          [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, DOMAIN_SUGGESTIONS)
            .map(([domain]) => domain)
        );
      } catch {
        setTopics([]);
        setDomains([]);
      }
    })();
  }, []);

  const runSearch = useCallback(async (q: string, state: FilterState) => {
    const trimmed = q.trim();
    if (trimmed === '') return;

    const seq = ++requestSeq.current;
    answeredQuery.current = trimmed;

    setBusy(true);
    setError(null);
    setMoreLike(null);
    const filters = toSearchFilters(state);
    const reply = await sendMessage({
      target: 'background',
      type: 'SEARCH',
      query: trimmed,
      limit: LIMIT,
      ...(filters === undefined ? {} : { filters }),
    });

    // A newer request (a later filter change, a resubmit) has started since
    // this one was issued — its reply, whenever it arrives, is the one that
    // gets to update the screen. Applying this one anyway is exactly the
    // "screen shows something that no longer matches its own state" bug.
    if (seq !== requestSeq.current) return;

    setBusy(false);
    if (reply === null) {
      setError('No response. Run a backfill first, or reload the extension.');
      setSearchResult(null);
      return;
    }
    setSearchResult(reply);
  }, []);

  const onSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      void runSearch(query, filters);
    },
    [query, filters, runSearch]
  );

  // Changing a filter re-runs the last query automatically, but only once a
  // search has actually been run — an unsubmitted query box should never
  // fire a search just because a select changed.
  const onFilterChange = useCallback(
    (patch: Partial<FilterState>) => {
      const next = { ...filters, ...patch };
      setFilters(next);
      if (searchResult !== null && query.trim() !== '') void runSearch(query, next);
    },
    [filters, searchResult, query, runSearch]
  );

  const clearFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    if (searchResult !== null && query.trim() !== '') void runSearch(query, EMPTY_FILTERS);
  }, [searchResult, query, runSearch]);

  const runMoreLike = useCallback(async (id: string, title: string) => {
    // Shares the sequence counter with runSearch: both write to `shown`
    // (via searchResult/moreLike), so a slow reply from either kind of
    // request must not be allowed to clobber a faster, later one of the
    // other kind.
    const seq = ++requestSeq.current;

    setBusy(true);
    setError(null);
    const reply = await sendMessage({ target: 'background', type: 'MORE_LIKE_THIS', id, limit: LIMIT });

    if (seq !== requestSeq.current) return;

    setBusy(false);
    if (reply === null) {
      setError('No response finding related pages.');
      return;
    }
    setMoreLike({ seedTitle: title, result: reply });
  }, []);

  /**
   * §14's displayed-state-drift class: the screen must never show results for
   * a query that is no longer in the box. Typing does not issue a new search
   * (only submit does), so between keystrokes there is no request to race —
   * the fix here is to clear rather than let the mismatch sit unmarked.
   */
  const onQueryChange = useCallback((value: string) => {
    setQuery(value);
    if (value.trim() !== answeredQuery.current) {
      setSearchResult(null);
      setMoreLike(null);
      setError(null);
    }
  }, []);

  const activeFilterCount = Object.values(filters).filter((value) => value !== '').length;
  const shown = moreLike?.result ?? searchResult;
  const isEmpty = shown === null;

  return (
    <div className={`search-page${isEmpty ? ' search-page-empty' : ''}`}>
      <form onSubmit={onSubmit} className="search-hero-form">
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="what were you reading about?"
          aria-label="Search your history"
          className="search-input search-input-hero"
          autoFocus
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>

      <p className="search-smallprint">Ranked by similarity — always returns results, even weak ones.</p>

      <details className="search-filters-disclosure">
        <summary>Filters{activeFilterCount > 0 ? ` · ${activeFilterCount} active` : ''}</summary>
        <div className="search-filters">
          <label>
            From
            <input
              type="datetime-local"
              value={filters.startTime}
              max={filters.endTime || undefined}
              onChange={(event) => onFilterChange({ startTime: event.target.value })}
            />
          </label>
          <label>
            To
            <input
              type="datetime-local"
              value={filters.endTime}
              min={filters.startTime || undefined}
              onChange={(event) => onFilterChange({ endTime: event.target.value })}
            />
          </label>
          <label>
            Format
            <select value={filters.format} onChange={(event) => onFilterChange({ format: event.target.value as Format | '' })}>
              <option value="">Any</option>
              {FORMATS.map((format) => (
                <option key={format} value={format}>
                  {format}
                </option>
              ))}
            </select>
          </label>
          <label>
            Topic
            <select value={filters.topicClusterId} onChange={(event) => onFilterChange({ topicClusterId: event.target.value })}>
              <option value="">Any</option>
              {topics.map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {topic.label} ({topic.size})
                </option>
              ))}
            </select>
          </label>
          <label>
            Domain
            <input
              list="search-domain-suggestions"
              value={filters.domain}
              onChange={(event) => onFilterChange({ domain: event.target.value })}
              placeholder="e.g. github.com"
            />
            <datalist id="search-domain-suggestions">
              {domains.map((domain) => (
                <option key={domain} value={domain} />
              ))}
            </datalist>
          </label>
          {activeFilterCount > 0 && (
            <button type="button" className="linkish search-clear-filters" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      </details>

      {error !== null && <p className="error-note">{error}</p>}

      {moreLike !== null && (
        <p className="detail search-more-like-banner">
          More like <strong>{moreLike.seedTitle || '(untitled)'}</strong>
          {' — '}
          <button type="button" className="linkish" onClick={() => setMoreLike(null)}>
            back to search results
          </button>
        </p>
      )}

      {/* The distinction from Chrome's own history search is the product, and
          nothing else on screen says it — shown once, before the first
          search, rather than as permanent chrome once results take over. */}
      {isEmpty && error === null && (
        <p className="search-value-prop">
          Unlike Chrome's built-in history search, which matches text in a page's title or URL, this
          searches what the page was actually about. Try something like <em>"that article about staying
          calm during interviews"</em> — it can surface a page titled "5 Tips Before Your Technical
          Round" even though none of those words appear in the title.
        </p>
      )}

      {shown !== null && (
        <>
          <p className="detail search-meta-line">
            {shown.hits.length} of {shown.scanned.toLocaleString()} unique nodes · scan {shown.timings.scanMs} ms
            {shown.timings.embedMs > 0 ? ` · query embed ${shown.timings.embedMs} ms` : ''}
            {shown.timings.loadMs > 0 ? ` · index load ${shown.timings.loadMs} ms` : ''}
          </p>

          {shown.hits.length === 0 && activeFilterCount > 0 && (
            <p className="detail">No pages match these filters. Try widening the time range or clearing one.</p>
          )}
          {shown.hits.length === 0 && activeFilterCount === 0 && shown.scanned === 0 && (
            <p className="detail">Nothing indexed yet — run a backfill first.</p>
          )}

          <ol className="results">
            {shown.hits.map((hit) => (
              <ResultCard key={hit.id} hit={hit} onMoreLike={(id, title) => void runMoreLike(id, title)} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function ResultCard({ hit, onMoreLike }: { hit: SearchHit; onMoreLike: (id: string, title: string) => void }): React.JSX.Element {
  return (
    <li className="result-card">
      <img className="result-favicon" src={faviconUrl(hit.url)} alt="" width={16} height={16} />
      <div className="result-body">
        <div className="result-headline">
          <a className="result-title" href={hit.url} target="_blank" rel="noreferrer">
            {hit.title || '(untitled)'}
          </a>
          {hit.visitCount > 1 && <span className="result-badge">revisited {hit.visitCount}×</span>}
        </div>

        {/* Hidden, never replaced with an invented placeholder, when there is
            no real preview to show: a page with no captured text has a
            `textPreview` that is just its own title, truncated, and showing
            that under the title as if it were a second, independent line is
            misleading rather than merely redundant. */}
        {hit.hasCapturedText && hit.textPreview.trim() !== hit.title.trim() && (
          <p className="result-preview">{hit.textPreview}</p>
        )}

        <div className="result-meta">
          <span>{hit.format}</span>
          <span aria-hidden="true">·</span>
          <span>{hit.domain}</span>
          <span aria-hidden="true">·</span>
          <span>{new Date(hit.lastVisit).toLocaleDateString()}</span>
          {hit.collapsed > 1 && (
            <>
              <span aria-hidden="true">·</span>
              <span>×{hit.collapsed}</span>
            </>
          )}
          {hit.topicLabel !== null && <span className="result-topic">{hit.topicLabel}</span>}
        </div>

        <div className="result-actions">
          <span className="hit-score">{hit.score.toFixed(3)}</span>
          <button type="button" className="linkish" onClick={() => onMoreLike(hit.id, hit.title)}>
            More like this
          </button>
        </div>
      </div>
    </li>
  );
}
