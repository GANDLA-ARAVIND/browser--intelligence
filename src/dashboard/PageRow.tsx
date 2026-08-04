import type { PageRecord } from '../lib/storage.js';
import { faviconUrl } from './favicon.js';

/**
 * One page: favicon, title link, format, last-visit date, and an optional
 * "revisited N×" badge — the same row shape `Search.tsx`'s result cards
 * introduced. Shared by Topics' detail view and Today's session detail
 * (a third call site is where duplicating this stopped being cheaper than
 * extracting it, the same threshold `faviconUrl` was pulled out at).
 */
export function PageRow({ page, showVisitBadge }: { page: PageRecord; showVisitBadge?: boolean }): React.JSX.Element {
  return (
    <li className="result-card">
      <img className="result-favicon" src={faviconUrl(page.url)} alt="" width={16} height={16} />
      <div className="result-body">
        <div className="result-headline">
          <a className="result-title" href={page.url} target="_blank" rel="noreferrer">
            {page.title || '(untitled)'}
          </a>
          {showVisitBadge === true && page.visitCount > 1 && (
            <span className="result-badge">revisited {page.visitCount}×</span>
          )}
        </div>
        <div className="result-meta">
          <span>{page.format}</span>
          <span aria-hidden="true">·</span>
          <span>{new Date(page.lastVisit).toLocaleDateString()}</span>
        </div>
      </div>
    </li>
  );
}
