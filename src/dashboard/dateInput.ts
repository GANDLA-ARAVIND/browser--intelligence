/** Shared by every `<input type="datetime-local">` in the dashboard — the
 *  range delete in the settings panel and the one on the removal panel both
 *  need the same round trip between a timestamp and the input's local string. */

export function toLocalInputValue(ms: number): string {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export function fromLocalInputValue(value: string): number | null {
  if (value.length === 0) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}
