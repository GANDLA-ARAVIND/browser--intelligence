import { resourceUrl } from '../platform/browser.js';

/**
 * Chrome's local favicon cache, not a network request — the "favicon"
 * permission serves this from what the browser already has for pages the
 * user visited, so it costs nothing against §2.1's "nothing leaves the
 * machine" (no third-party favicon service, which would).
 *
 * Shared by every panel that lists pages (Search's result cards, Topics'
 * card grid and detail view) rather than reimplemented per panel.
 */
export function faviconUrl(pageUrl: string): string {
  return resourceUrl(`_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=32`);
}
