/**
 * The day boundary (CLAUDE.md §7): "someone debugging until 1:30am considers
 * that the previous day's work." Rolling up at midnight would split one real
 * session across two days for exactly the browsing this project is built to
 * capture — late, focused work.
 */
export const DAY_BOUNDARY_HOUR = 4;

/** Start of "today", where today begins at 04:00, not midnight. */
export function dayStart(now = Date.now()): number {
  const start = new Date(now);
  start.setHours(DAY_BOUNDARY_HOUR, 0, 0, 0);
  if (start.getTime() > now) start.setDate(start.getDate() - 1);
  return start.getTime();
}
