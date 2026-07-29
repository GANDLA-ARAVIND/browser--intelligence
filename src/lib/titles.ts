/**
 * Title normalization and data-derived boilerplate stripping.
 */

/**
 * Separators must be surrounded by whitespace: " : r/guitar" is site chrome,
 * but "Rust: ownership" is content. The frequency test below is the real
 * safeguard — a tail is only ever stripped if it recurs across many titles.
 */
export const TITLE_SEPARATOR = /\s+[|–—·•:»~\-]\s+/;

/** "(3) Inbox" — unread counters from mail/social tabs. */
export const UNREAD_PREFIX = /^\(\d+\)\s*/;

export function tidyTitle(title: string): string {
  return title.replace(UNREAD_PREFIX, '').replace(/\s+/g, ' ').trim();
}

/**
 * Site boilerplate ("- YouTube", "| Hacker News") makes every page from one
 * domain look alike, and §4 is explicit that a domain is not a category. Rather
 * than hardcode a list — which §6 forbids — derive it: a trailing segment that
 * recurs across many otherwise-unrelated titles is chrome, not content.
 *
 * The threshold is relative to corpus size, so it transfers between users
 * rather than being tuned to one history.
 */
export function deriveBoilerplateSuffixes(titles: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const title of titles) {
    const parts = title.split(TITLE_SEPARATOR);
    if (parts.length < 2) continue;
    const tail = parts[parts.length - 1]!.trim();
    if (tail.length === 0 || tail.length > 40) continue;
    counts.set(tail.toLowerCase(), (counts.get(tail.toLowerCase()) ?? 0) + 1);
  }

  const minOccurrences = Math.max(5, Math.round(titles.length * 0.003));
  const boilerplate = new Map<string, number>();
  for (const [tail, count] of counts) {
    if (count >= minOccurrences) boilerplate.set(tail, count);
  }
  return boilerplate;
}

export function stripBoilerplate(title: string, boilerplate: Map<string, number>): string {
  let out = title;
  // Loop: "Some Post - r/docker - Reddit" has two layers of chrome.
  for (let pass = 0; pass < 3; pass++) {
    const parts = out.split(TITLE_SEPARATOR);
    if (parts.length < 2) break;
    const tail = parts[parts.length - 1]!.trim();
    if (!boilerplate.has(tail.toLowerCase())) break;
    const remainder = parts.slice(0, -1).join(' - ').trim();
    if (remainder.length < 8) break; // stripping would leave nothing to embed
    out = remainder;
  }
  return out;
}
