import { useEffect, useMemo, useState } from 'react';
import { dayStart } from '../lib/day.js';
import { PROVISIONAL_WITHIN_MS, type Session, type SessionProvenance } from '../lib/sessions.js';
import { getAllPages, getAllSessions, openDatabase, type PageRecord } from '../lib/storage.js';
import { PageRow } from './PageRow.js';

/** §14: a session never displays a name it did not derive — this many of its
 *  own earliest pages stand in for one the c-TF-IDF labeller could not name. */
const FALLBACK_TITLE_COUNT = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

const PROVENANCE_LABEL: Record<SessionProvenance, string> = {
  exact: 'Live',
  approximate: 'Reconstructed',
  mixed: 'Partly reconstructed',
};

/**
 * §14: never "Session 7", never "Untitled" — the session's own earliest
 * pages, which can only ever say what is actually there.
 *
 * Chronological rather than by-visits (the ordering Topics' own fallback
 * uses): `pageIds` is already stored in the order pages were last touched
 * within the session (`buildSessions` derives it from the same sort), and a
 * session is a slice of one sitting, not a topic spanning months — what
 * someone opened first is the more useful stand-in for "what was this" than
 * whichever page they happened to return to most.
 */
function fallbackName(pageIds: string[], pagesById: Map<string, PageRecord>): string {
  const top = pageIds.slice(0, FALLBACK_TITLE_COUNT).map((id) => pagesById.get(id)?.title || '(untitled)');
  const rest = pageIds.length - top.length;
  return rest > 0 ? `${top.join(' · ')} +${rest} more` : top.join(' · ');
}

function formatClock(ts: number): { hour: number; minute: string; suffix: 'am' | 'pm' } {
  const d = new Date(ts);
  const suffix: 'am' | 'pm' = d.getHours() >= 12 ? 'pm' : 'am';
  const hour = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  return { hour, minute: String(d.getMinutes()).padStart(2, '0'), suffix };
}

/**
 * Local-midnight calendar-date start — deliberately *not* `dayStart()`'s
 * 04:00 boundary. This is only asking "does the clock-face reading of `end`
 * need a date to disambiguate it from `start`," which is a fact about when
 * midnight passed, not about which §7 "app day" bucket the session belongs
 * to. Reusing `dayStart()` here would say a 2am end needs no disambiguation
 * (same app-day as an 11pm start), which is true for grouping and false for
 * reading a 12-hour clock: "11pm–2am" without a marker still reads as the
 * same evening.
 */
function calendarDayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * "2:10–3:40pm" — one suffix when both ends share it, matching §12's own
 * example. Bug fixed here: the previous version formatted `start` and `end`
 * as bare clock faces with no date, so a session ending the *next* calendar
 * day rendered identically to one ending earlier the *same* evening —
 * "8:21pm–8:13am" and "8:21pm–8:13am (next day)" were indistinguishable, and
 * a session that genuinely ran past midnight read as if it had ended before
 * it began. Reported live: the timeline bar (which uses the real epoch
 * values directly, unaffected by this) and the text label (which went
 * through this function) disagreed about the same session — the
 * displayed-state-vs-actual-state class again (§14), this time between two
 * views of one record rather than two records. `end` is never actually
 * before `start` — `buildSessions` computes `end` as the max `lastVisit` and
 * `start` as the min `firstVisit` across the session's own pages, which is
 * structurally guaranteed to be non-negative as long as every individual
 * page satisfies `firstVisit <= lastVisit`. The `end < start` check below is
 * defensive for exactly that invariant being violated upstream — flagged
 * rather than rendered as a plausible-looking same-evening range. It checks
 * the actual epoch values directly rather than the calendar-day difference:
 * a same-day reversal (end eight minutes before start, both Aug 2) has a
 * `dayDiff` of exactly 0, so a day-diff-only check would have missed it —
 * caught by this file's own verification pass before shipping.
 */
function formatTimeRange(start: number, end: number): string {
  const s = formatClock(start);
  const e = formatClock(end);
  const base =
    s.suffix === e.suffix
      ? `${s.hour}:${s.minute}–${e.hour}:${e.minute}${e.suffix}`
      : `${s.hour}:${s.minute}${s.suffix}–${e.hour}:${e.minute}${e.suffix}`;

  if (end < start) return `${base} — end before start (data issue, not a display artifact)`;

  const dayDiff = Math.round((calendarDayStart(end) - calendarDayStart(start)) / DAY_MS);
  if (dayDiff === 0) return base;
  return dayDiff === 1 ? `${base} (next day)` : `${base} (+${dayDiff} days)`;
}

function formatDayLabel(day: number, todayStart: number): string {
  if (day === todayStart) return 'Today';
  if (day === todayStart - DAY_MS) return 'Yesterday';
  return new Date(day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Phase 4 step 2 (§12, last step of Phase 4): the session timeline. Sessions
 * already exist — Phase 3 step 4 built the grouping, the c-TF-IDF labelling,
 * and the exact/approximate/mixed provenance this view exists to surface —
 * this is the first thing that renders them.
 *
 * A direct IndexedDB read on mount, same as every other dashboard panel that
 * lists corpus data.
 */
export function TodayPage(): React.JSX.Element {
  const [raw, setRaw] = useState<{ sessions: Session[]; pagesById: Map<string, PageRecord> } | null>(null);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const db = await openDatabase();
        const [sessions, pages] = await Promise.all([getAllSessions(db), getAllPages(db)]);
        setRaw({ sessions, pagesById: new Map(pages.map((p) => [p.id, p])) });
      } catch {
        setRaw({ sessions: [], pagesById: new Map() });
      }
    })();
  }, []);

  // §7: the day boundary is 04:00, not midnight — `day` on every stored
  // session is already assigned from that boundary, so grouping here just
  // reads it back rather than recomputing anything.
  const availableDays = useMemo(() => {
    if (raw === null) return [];
    return [...new Set(raw.sessions.map((s) => s.day))].sort((a, b) => b - a);
  }, [raw]);

  useEffect(() => {
    if (selectedDay === null && availableDays.length > 0) setSelectedDay(availableDays[0]!);
  }, [availableDays, selectedDay]);

  const daySessions = useMemo(() => {
    if (raw === null || selectedDay === null) return [];
    return raw.sessions.filter((s) => s.day === selectedDay).sort((a, b) => a.start - b.start);
  }, [raw, selectedDay]);

  if (raw === null) {
    return (
      <section className="panel placeholder-page">
        <h2>Today</h2>
        <p className="detail">Loading…</p>
      </section>
    );
  }

  if (availableDays.length === 0) {
    return (
      <section className="panel placeholder-page">
        <h2>Today</h2>
        <p className="detail">
          No sessions yet. Sessions are built from your browsing history and rebuild automatically a
          couple of minutes after each page — run a backfill from Settings, or come back after browsing
          for a bit.
        </p>
      </section>
    );
  }

  const todayStart = dayStart(Date.now());
  const dayIndex = availableDays.indexOf(selectedDay!);

  // Honesty check for the day on screen: if reconstructed sessions outnumber
  // live ones, the surface says so rather than presenting a timeline that
  // looks more precise than the data backing it actually is (§15).
  const exactCount = daySessions.filter((s) => s.provenance === 'exact').length;
  const nonExactCount = daySessions.length - exactCount;
  const mostlyReconstructed = nonExactCount > exactCount;

  return (
    <div className="today-page">
      <h1>Today</h1>
      <p className="tagline">Your browsing as sessions, grouped by activity gap — a day starts at 4am, not midnight.</p>

      <div className="day-picker">
        <button
          type="button"
          disabled={dayIndex >= availableDays.length - 1}
          onClick={() => setSelectedDay(availableDays[dayIndex + 1]!)}
        >
          ← Earlier
        </button>
        <select value={selectedDay!} onChange={(e) => setSelectedDay(Number(e.target.value))}>
          {availableDays.map((day) => (
            <option key={day} value={day}>
              {formatDayLabel(day, todayStart)}
            </option>
          ))}
        </select>
        <button type="button" disabled={dayIndex <= 0} onClick={() => setSelectedDay(availableDays[dayIndex - 1]!)}>
          Later →
        </button>
      </div>

      {mostlyReconstructed && (
        <p className="detail today-honesty-note">
          {nonExactCount} of {daySessions.length} sessions this day are <strong>reconstructed</strong> from
          browsing history, not directly observed — Chrome recorded only when each page was last touched,
          not when it was actually read, so these times and durations are the pipeline's best
          reconstruction. Sessions marked <strong>Live</strong> below are exact.
        </p>
      )}

      <SessionTimeline sessions={daySessions} dayStartMs={selectedDay!} />

      <ol className="session-list">
        {daySessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            pagesById={raw.pagesById}
            expanded={expandedId === session.id}
            onToggle={() => setExpandedId(expandedId === session.id ? null : session.id)}
          />
        ))}
      </ol>
    </div>
  );
}

const HOUR_MARKS = [0, 4, 8, 12, 16, 20, 24];
const HOUR_LABELS = ['4am', '8am', '12pm', '4pm', '8pm', '12am', '4am'];

/**
 * Horizontal blocks across the day (§12). Positioned and sized proportionally
 * to actual clock time within the 04:00–04:00 window; a minimum width keeps a
 * brief session visible and clickable rather than a sliver nobody can hit.
 *
 * Provenance is never colour-only: exact/approximate/mixed differ in border
 * style (solid/dashed/dotted) as well as colour, and every block gets a text
 * badge in the list below — a reconstructed session must never be
 * mistakeable for a live one at a glance (§15).
 */
function SessionTimeline({ sessions, dayStartMs }: { sessions: Session[]; dayStartMs: number }): React.JSX.Element {
  const width = 100;
  const height = 40;
  const minBlockWidth = 0.8;
  const x = (ts: number) => Math.min(width, Math.max(0, ((ts - dayStartMs) / DAY_MS) * width));

  return (
    <div className="session-timeline-wrap">
      <svg className="session-timeline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        {HOUR_MARKS.map((h) => (
          <line key={h} x1={(h / 24) * width} y1={0} x2={(h / 24) * width} y2={height} className="timeline-gridline" />
        ))}
        {sessions.map((session) => {
          const startX = x(session.start);
          const endX = Math.max(startX + minBlockWidth, x(session.end));
          return (
            <rect
              key={session.id}
              x={startX}
              y={6}
              width={endX - startX}
              height={height - 12}
              rx={1}
              className={`timeline-block timeline-${session.provenance}`}
            />
          );
        })}
      </svg>
      <div className="timeline-hours">
        {HOUR_LABELS.map((label, i) => (
          <span key={i}>{label}</span>
        ))}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  pagesById,
  expanded,
  onToggle,
}: {
  session: Session;
  pagesById: Map<string, PageRecord>;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const name = session.label ?? fallbackName(session.pageIds, pagesById);
  const isFallback = session.label === null;

  // Recomputed against the clock at render time, not read from
  // `session.provisional` — that field is fixed at whatever moment sessions
  // last rebuilt (§7's ~2-minute-after-capture debounce), and nothing
  // revisits it afterward. A session that was genuinely still open when it
  // was last stored keeps that flag forever if no further capture has
  // triggered a rebuild since — a "Still going" badge on something that
  // demonstrably ended days ago is exactly the false-claim-on-the-surface
  // problem this app's provenance marking exists to prevent (§14, §15).
  const isProvisional = Date.now() - session.end < PROVISIONAL_WITHIN_MS;

  return (
    <li className="session-row">
      <button type="button" className="session-summary" onClick={onToggle} aria-expanded={expanded}>
        <span className="session-time">{formatTimeRange(session.start, session.end)}</span>
        <span className={`session-name${isFallback ? ' session-name-fallback' : ''}`}>{name}</span>
        <span className="session-count">{session.pageCount.toLocaleString()} pages</span>
        <span className={`provenance-tag provenance-${session.provenance}`}>{PROVENANCE_LABEL[session.provenance]}</span>
        {isProvisional && <span className="provenance-tag provenance-provisional">Still going</span>}
      </button>

      {expanded && (
        <div className="session-detail">
          {isFallback && (
            <p className="detail">
              No name was derivable for this session (§14) — its earliest pages are shown above instead of
              an invented one.
            </p>
          )}
          <ol className="results">
            {session.pageIds.map((id) => {
              const page = pagesById.get(id);
              return page === undefined ? null : <PageRow key={id} page={page} />;
            })}
          </ol>
        </div>
      )}
    </li>
  );
}
