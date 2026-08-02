import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deletePages,
  deletePagesInRange,
  getAllPages,
  getPageIdsInRange,
  openDatabase,
  type PageRecord,
} from '../lib/storage.js';
import { sendMessage } from '../platform/browser.js';
import { fromLocalInputValue, toLocalInputValue } from './dateInput.js';

/** How many of the most recent pages are offered for individual selection. */
const LIST_LIMIT = 100;

/**
 * §9's retroactive removal — "select a time range or session → 'this wasn't
 * me' → delete." Sessions arrive in Phase 3; a time range and individual
 * pages are what Phase 2 has to work with. This is the control §9 calls "the
 * one people actually use, because nobody remembers to hit pause".
 *
 * Every delete here goes through the same `lib/storage.ts` path the pause
 * toggle and settings' delete-range use, and every one is followed by an
 * INVALIDATE_SEARCH message — the search index is offscreen-document-local
 * state, invisible to a delete that happened in this tab, so a "removed" page
 * would otherwise keep surfacing in search until the next backfill.
 */
export function RemovePages(): React.JSX.Element {
  const [pages, setPages] = useState<PageRecord[] | null>(null);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const [rangeStart, setRangeStart] = useState(() => toLocalInputValue(Date.now() - 24 * 60 * 60 * 1000));
  const [rangeEnd, setRangeEnd] = useState(() => toLocalInputValue(Date.now()));
  const [rangePreview, setRangePreview] = useState<number | null>(null);
  const [confirmSelection, setConfirmSelection] = useState(false);
  const [confirmRange, setConfirmRange] = useState(false);

  const load = useCallback(async () => {
    try {
      const db = await openDatabase();
      const all = await getAllPages(db);
      all.sort((a, b) => b.lastVisit - a.lastVisit);
      setTotal(all.length);
      setPages(all.slice(0, LIST_LIMIT));
    } catch {
      setPages([]);
      setTotal(0);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const start = useMemo(() => fromLocalInputValue(rangeStart), [rangeStart]);
  const end = useMemo(() => fromLocalInputValue(rangeEnd), [rangeEnd]);
  const rangeValid = start !== null && end !== null && start <= end;

  useEffect(() => {
    setConfirmRange(false);
    if (!rangeValid) {
      setRangePreview(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const db = await openDatabase();
        const ids = await getPageIdsInRange(db, start!, end!);
        if (!cancelled) setRangePreview(ids.length);
      } catch {
        if (!cancelled) setRangePreview(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [start, end, rangeValid]);

  const invalidateSearch = useCallback(async () => {
    await sendMessage({ target: 'background', type: 'INVALIDATE_SEARCH' });
  }, []);

  const toggle = useCallback((id: string) => {
    setConfirmSelection(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const deleteSelected = useCallback(async () => {
    if (!confirmSelection) {
      setConfirmSelection(true);
      return;
    }
    setBusy(true);
    try {
      const db = await openDatabase();
      const ids = [...selected];
      await deletePages(db, ids);
      await invalidateSearch();
      setResult(`Deleted ${ids.length} page${ids.length === 1 ? '' : 's'}.`);
      setSelected(new Set());
      await load();
    } finally {
      setBusy(false);
      setConfirmSelection(false);
    }
  }, [confirmSelection, selected, invalidateSearch, load]);

  const deleteRange = useCallback(async () => {
    if (!rangeValid) return;
    if (!confirmRange) {
      setConfirmRange(true);
      return;
    }
    setBusy(true);
    try {
      const db = await openDatabase();
      const count = await deletePagesInRange(db, start!, end!);
      await invalidateSearch();
      setResult(`Deleted ${count} page${count === 1 ? '' : 's'} in range.`);
      setRangePreview(0);
      await load();
    } finally {
      setBusy(false);
      setConfirmRange(false);
    }
  }, [rangeValid, confirmRange, start, end, invalidateSearch, load]);

  return (
    <section className="panel">
      <h2>Remove pages</h2>
      <p className="detail settings-intro">
        This wasn't me. Select a time range, or individual pages below, and delete them. Deletion is
        immediate and removes the page from search as well as storage — there is no undo.
      </p>

      <div className="remove-range">
        <label>
          From
          <input
            type="datetime-local"
            value={rangeStart}
            onChange={(e) => setRangeStart(e.target.value)}
          />
        </label>
        <label>
          To
          <input type="datetime-local" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
        </label>
        <button type="button" disabled={!rangeValid || busy || rangePreview === 0} onClick={() => void deleteRange()}>
          {confirmRange
            ? `Confirm delete ${rangePreview ?? '…'}?`
            : `Delete ${rangeValid ? (rangePreview ?? '…') : ''} in range`}
        </button>
      </div>
      {!rangeValid && <p className="detail">Pick a start on or before the end.</p>}

      {result !== null && <p className="detail">{result}</p>}

      <h3 className="drop-heading">
        Individual pages — {pages === null ? '…' : `showing ${pages.length} most recent of ${total}`}
      </h3>

      {pages !== null && (
        <>
          <ul className="remove-list">
            {pages.map((page) => (
              <li key={page.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(page.id)}
                    onChange={() => toggle(page.id)}
                  />
                  <span className="remove-title">{page.title || '(untitled)'}</span>
                  <span className="detail">{new Date(page.lastVisit).toLocaleString()}</span>
                </label>
              </li>
            ))}
          </ul>

          <div className="actions">
            <button type="button" disabled={selected.size === 0 || busy} onClick={() => void deleteSelected()}>
              {confirmSelection ? `Confirm delete ${selected.size}?` : `Delete ${selected.size} selected`}
            </button>
            {selected.size > 0 && (
              <button type="button" onClick={() => setSelected(new Set())}>
                Clear selection
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
