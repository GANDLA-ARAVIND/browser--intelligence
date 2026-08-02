/**
 * URL normalization and structural filters (CLAUDE.md §4, §9).
 *
 * Browser-safe: `URL` and `URLSearchParams` are standard in both Node and the
 * extension runtime, so nothing here needs a shim.
 */

/**
 * Tracking params carry no meaning and defeat dedupe. §4 names utm_*; the click
 * ID family is the same class of junk and is stripped alongside it.
 */
export const TRACKING_PARAM =
  /^(utm_[a-z_]+|fbclid|gclid|gbraid|wbraid|msclkid|dclid|yclid|igshid|mc_cid|mc_eid|_ga|_gl|ref_src|ref_url|si|spm|scm|share_source)$/i;

export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }

  u.hash = '';
  u.username = '';
  u.password = '';

  const kept = new URLSearchParams();
  for (const [key, value] of u.searchParams) {
    if (!TRACKING_PARAM.test(key)) kept.append(key, value);
  }
  kept.sort(); // param order is not meaningful for identity
  u.search = kept.toString() ? `?${kept.toString()}` : '';

  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u.toString();
}

/**
 * Query params a media player rewrites *during* playback without the page
 * becoming a different page.
 *
 * Not a tracking concern — these are stripped for a different reason and at a
 * different point than `TRACKING_PARAM`, which is about storage identity. This
 * set exists for **navigation detection**: the content script decides "is this
 * still the same page" by comparing `pathname + search`, and YouTube rewrites
 * `t` as the user seeks and `pp` as it cycles player flags. Every rewrite read
 * as a navigation, which reset the dwell clock, so the 30s capture gate was
 * never reached on exactly the long videos most worth capturing — a silent
 * suppression, symptomless in the way §14 warns about.
 *
 * Deliberately general rather than YouTube-specific: `t`, `start`,
 * `time_continue` and `end` are the common spelling of playback position
 * across HTML5 players, Vimeo and Twitch.
 *
 * `v` is emphatically **not** here — it is the video's identity, and stripping
 * it would make every video on YouTube look like the same page, turning this
 * fix into a far worse version of the bug it repairs.
 */
export const VOLATILE_PLAYBACK_PARAM = /^(t|start|end|time_continue|pp|ab_channel|feature)$/i;

/**
 * `search` with playback-position params removed, for same-page comparison.
 * Returns '' rather than '?' when nothing survives, so the empty case matches
 * a URL that never had a query string.
 */
export function stableSearch(search: string): string {
  if (search.length <= 1) return '';
  const kept = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(search)) {
    if (!VOLATILE_PLAYBACK_PARAM.test(key)) kept.append(key, value);
  }
  const rest = kept.toString();
  return rest.length > 0 ? `?${rest}` : '';
}

export function isLocalHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0.0.0.0' || host === 'host.docker.internal') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/**
 * Search engines are a closed, universal set — the same short list for every
 * user, in the spirit of the seed taxonomy (§6). Site-internal search is caught
 * generically by path shape instead, so no per-site knowledge is needed.
 */
export const SEARCH_ENGINE_HOST =
  /^(google\.[a-z.]{2,}|bing\.com|duckduckgo\.com|lite\.duckduckgo\.com|search\.yahoo\.[a-z.]{2,}|yandex\.[a-z.]{2,}|baidu\.com|ecosia\.org|startpage\.com|search\.brave\.com|search\.marginalia\.nu|qwant\.com|ask\.com|searx\.[a-z.]{2,}|perplexity\.ai)$/i;

export const SEARCH_QUERY_KEY = new Set(['q', 'query', 'search_query', 'p', 'wd', 'text', 'k', 'searchterm']);
export const SEARCH_PATH_SEGMENT = new Set(['search', 'results', 'search_results']);

export function isSearchResultPage(u: URL): boolean {
  const host = u.hostname.replace(/^www\./, '');
  const hasQueryKey = [...u.searchParams.keys()].some((key) => SEARCH_QUERY_KEY.has(key.toLowerCase()));

  if (SEARCH_ENGINE_HOST.test(host)) {
    // Engine roots and redirect hops are navigation, never destinations.
    if (u.pathname === '/' || u.pathname === '') return true;
    if (/^\/(search|url|imgres|maps\/search|s)\b/.test(u.pathname)) return true;
    if (hasQueryKey) return true;
  }

  // Generic site search: /search?q=..., /results?search_query=...
  const segments = u.pathname.toLowerCase().split('/').filter(Boolean);
  if (hasQueryKey && segments.some((s) => SEARCH_PATH_SEGMENT.has(s))) return true;

  return false;
}
