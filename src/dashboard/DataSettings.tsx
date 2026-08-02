import { useCallback, useEffect, useMemo, useState } from 'react';
import { toExportJson, toExportMarkdown } from '../lib/exportFormat.js';
import { deletePagesInRange, getAllPages, getPageIdsInRange, openDatabase } from '../lib/storage.js';
import { sendMessage } from '../platform/browser.js';
import { fromLocalInputValue, toLocalInputValue } from './dateInput.js';

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * §9: "Export as JSON and Markdown. Delete range. Both in settings."
 *
 * This delete-range control is deliberately separate from the one on the
 * Remove pages panel, per that instruction, even though both end up calling
 * the same `deletePagesInRange` — this is the bulk, settings-page operation;
 * that one is the contextual "this wasn't me" workflow next to the data
 * itself. Sharing the underlying function means there is still only one place
 * that decides what "delete a range" actually does.
 */
export function DataSettings(): React.JSX.Element {
  const [exporting, setExporting] = useState<'json' | 'markdown' | null>(null);

  const exportAs = useCallback(async (kind: 'json' | 'markdown') => {
    setExporting(kind);
    try {
      const db = await openDatabase();
      const pages = await getAllPages(db);
      const stamp = new Date().toISOString().slice(0, 10);
      if (kind === 'json') {
        download(`browser-intelligence-${stamp}.json`, toExportJson(pages), 'application/json');
      } else {
        download(`browser-intelligence-${stamp}.md`, toExportMarkdown(pages), 'text/markdown');
      }
    } finally {
      setExporting(null);
    }
  }, []);

  const [rangeStart, setRangeStart] = useState(() => toLocalInputValue(Date.now() - 24 * 60 * 60 * 1000));
  const [rangeEnd, setRangeEnd] = useState(() => toLocalInputValue(Date.now()));
  const [preview, setPreview] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const start = useMemo(() => fromLocalInputValue(rangeStart), [rangeStart]);
  const end = useMemo(() => fromLocalInputValue(rangeEnd), [rangeEnd]);
  const valid = start !== null && end !== null && start <= end;

  useEffect(() => {
    setConfirm(false);
    if (!valid) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const db = await openDatabase();
        const ids = await getPageIdsInRange(db, start!, end!);
        if (!cancelled) setPreview(ids.length);
      } catch {
        if (!cancelled) setPreview(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [start, end, valid]);

  const deleteRange = useCallback(async () => {
    if (!valid) return;
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    try {
      const db = await openDatabase();
      const count = await deletePagesInRange(db, start!, end!);
      await sendMessage({ target: 'background', type: 'INVALIDATE_SEARCH' });
      setResult(`Deleted ${count} page${count === 1 ? '' : 's'}.`);
      setPreview(0);
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }, [valid, confirm, start, end]);

  return (
    <section className="panel">
      <h2>Export and delete range</h2>

      <p className="detail settings-intro">
        Export everything stored, as JSON for tooling or Markdown for reading. Vectors and internal
        quality scores are left out — this is what you read, not the model's representation of it.
      </p>
      <div className="actions">
        <button type="button" disabled={exporting !== null} onClick={() => void exportAs('json')}>
          {exporting === 'json' ? 'Exporting…' : 'Export as JSON'}
        </button>
        <button type="button" disabled={exporting !== null} onClick={() => void exportAs('markdown')}>
          {exporting === 'markdown' ? 'Exporting…' : 'Export as Markdown'}
        </button>
      </div>

      <h3 className="drop-heading">Delete range</h3>
      <p className="detail">
        Removes every page whose last visit falls in this range, from storage and search. No undo.
      </p>
      <div className="remove-range">
        <label>
          From
          <input type="datetime-local" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />
        </label>
        <label>
          To
          <input type="datetime-local" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
        </label>
        <button type="button" disabled={!valid || busy || preview === 0} onClick={() => void deleteRange()}>
          {confirm ? `Confirm delete ${preview ?? '…'}?` : `Delete ${valid ? (preview ?? '…') : ''} in range`}
        </button>
      </div>
      {!valid && <p className="detail">Pick a start on or before the end.</p>}
      {result !== null && <p className="detail">{result}</p>}
    </section>
  );
}
