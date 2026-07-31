/**
 * Tier-4 extraction: topic words derived from a URL path (CLAUDE.md §8).
 *
 * §8 has always had a "domain rule only — weak but never empty" rung. It was
 * never reachable for the pages that need it most, because the junk filter ran
 * *before* the ladder and dropped bare-URL titles outright. The audit found 27
 * of 30 such drops carried real topic words in the path — a GeeksforGeeks
 * Python course, AWS learning content, Workday listings naming the role.
 *
 * So the rung moves ahead of the drop: derive first, and drop only when
 * derivation yields nothing.
 */

/**
 * Path noise that is structural rather than topical. Kept deliberately small —
 * this is a stopword list for URLs, not a taxonomy, and §6 forbids domain
 * knowledge in the pipeline.
 */
const PATH_STOPWORDS = new Set([
  'http', 'https', 'www', 'com', 'org', 'net', 'io', 'co', 'in', 'html', 'htm', 'php', 'aspx', 'jsp',
  'index', 'default', 'page', 'pages', 'view', 'id', 'ids', 'item', 'items', 'list', 'all',
  'en', 'us', 'uk', 'gb', 'gov', 'edu', 'amp', 'utm', 'ref', 'src', 'lang', 'locale',
  'sites', 'site', 'web', 'app', 'apps', 'api', 'v1', 'v2', 'assets', 'static', 'public',
  'true', 'false', 'null', 'undefined',
]);

/** Opaque identifiers: hex blobs, long digit runs, base64-ish slugs, GUIDs. */
function isOpaque(segment: string): boolean {
  if (/^[0-9]+$/.test(segment)) return true;
  if (/^[a-f0-9]{8,}$/i.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  // Mixed-case alphanumeric with digits and no vowels reads as a token, not a word.
  if (segment.length >= 10 && /[0-9]/.test(segment) && !/[aeiou]/i.test(segment)) return true;
  return false;
}

/** Minimum real words before a path is considered to carry a topic. */
export const MIN_PATH_WORDS = 2;

export interface PathWords {
  /** Host labels plus path words — what gets embedded. */
  words: string[];
  /**
   * Path words only, excluding host labels. **This is what the keep/drop
   * decision counts.**
   *
   * The host is already stored separately on every record, so counting it as a
   * topic word inflates every URL by one or two and lets pure noise through:
   * `cf.legacypoint.site/middle.html` scored 2 on "legacypoint middle" and was
   * wrongly rescued. Excluding the host, it scores 1 and is correctly dropped,
   * while `geeksforgeeks.org/batch/skill-up-python/...` still scores 6.
   */
  pathOnly: string[];
  /** Space-joined `words`, ready to embed. Empty when the path yields nothing. */
  text: string;
}

/**
 * Splits a URL into candidate topic words.
 *
 * Host labels are included — `geeksforgeeks` and `magnaid` are as much a part
 * of what a page is about as its path — but the TLD and `www` are not.
 * Query *values* are included, query *keys* are not: `?keyword=Software+Engineer`
 * is topical, `?locationId=12` is not, and dropping opaque segments handles the
 * difference without enumerating parameter names.
 */
export function pathWords(rawUrl: string): PathWords {
  let host = '';
  let rest = '';
  try {
    const url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
    host = url.hostname;
    rest = `${decodeURIComponent(url.pathname)} ${decodeURIComponent(url.search)}`;
  } catch {
    // Not parseable as a URL — treat the whole string as path-ish.
    rest = rawUrl;
  }

  const raw = `${host} ${rest}`
    .replace(/\+/g, ' ')
    .split(/[/\-_.?&=#%,:;()[\]{}'"\s]+/)
    .filter(Boolean);

  // Split on hyphens as well as dots: the word splitter below breaks
  // `watt-wise-sc5m.onrender.com` into `watt`, `wise`, `sc5m`, so matching only
  // whole dot-separated labels would fail to recognise those as host-derived
  // and would count them as path topic words.
  const hostLabels = new Set(host.toLowerCase().split(/[.\-]/).filter(Boolean));
  const seen = new Set<string>();
  const words: string[] = [];
  const pathOnly: string[] = [];
  for (const segment of raw) {
    const word = segment.trim();
    if (word.length < 3) continue;
    if (!/[a-z]/i.test(word)) continue;
    if (isOpaque(word)) continue;

    const lower = word.toLowerCase();
    if (PATH_STOPWORDS.has(lower)) continue;
    if (seen.has(lower)) continue; // a repeated host label adds nothing
    seen.add(lower);

    // camelCase and PascalCase carry word boundaries the separators missed.
    const fromHost = hostLabels.has(lower);
    for (const part of word.split(/(?<=[a-z])(?=[A-Z])/)) {
      const piece = part.toLowerCase();
      if (piece.length < 3 || PATH_STOPWORDS.has(piece)) continue;
      words.push(piece);
      if (!fromHost) pathOnly.push(piece);
    }
  }

  return { words, pathOnly, text: words.join(' ') };
}

/** Does this URL's path carry enough to be worth embedding? */
export function hasUsablePathWords(rawUrl: string): boolean {
  return pathWords(rawUrl).pathOnly.length >= MIN_PATH_WORDS;
}
