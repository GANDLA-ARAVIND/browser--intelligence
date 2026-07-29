/**
 * Content-free interstitials: auth walls, bot checks, error pages, redirects.
 * They carry no topic, they recur in the hundreds under many different URLs
 * (so the normalized-URL dedupe never sees them), and once embedded they form
 * dense identical neighbourhoods that crowd out every real neighbour.
 *
 * Most of these are also auth pages, which §9 says must never be captured at
 * all — this list is the standing implementation of that rule.
 *
 * Three tiers, because one flat list was measurably wrong in both directions:
 * a bare `/^error/` ate a real Rust doc page, while a length-capped prefix rule
 * alone missed "Sign in to Navigate Opportunities | Infosys Careers" (51 chars)
 * and every "SiteName — Sign In" where the product name leads.
 */

/** Whole-title matches. Always applied, any length. */
export const JUNK_TITLE_EXACT: RegExp[] = [
  /^(new tab|untitled|home|index|dashboard|welcome|error|errors?\s*page)$/i,
  /^google accounts?$/i,
  /^(sign|log)\s?(in|out|on|up)$/i,
  /^(signin|login|logout|signup|register)$/i,
  /^pre-?login$/i,
  /^(bad request|forbidden|unauthorized|not found|access denied)$/i,
  /^(apply )?confirmation$/i,
  /^confirm access$/i,
  /^password (checkup|reset)$/i,
  // Titles with no letter or digit in ANY script — punctuation, emoji, blanks.
  // Must be Unicode-aware: JS `\W` is ASCII-only, so /^\W*$/ classifies every
  // title written entirely in Telugu, Hindi, Chinese, Arabic or Cyrillic as an
  // empty shell and silently deletes it.
  /^[^\p{L}\p{N}]*$/u,
];

/**
 * Unambiguous auth phrasing, matched at any length. "Sign in to X" and
 * "… | Sign In" are never article titles, so the length cap below must not
 * apply to them.
 */
export const JUNK_TITLE_STRONG: RegExp[] = [
  /^(sign|log)\s?(in|on)\s+(to|with)\b/i,
  /^(multi|two)[- ]?factor authentication/i,
  /^authentication required/i,
  /^(verify|verifying) (your |that )?(identity|email|account|phone|mobile)/i,
  /^(confirm|confirming) your (email|account|identity)/i,
  /^session (has )?expired/i,
  /^(verifying|verify) (that )?you'?re human/i,
  /^verifying you are human/i,
  // Auth phrase trailing after a separator: "Career Opportunities: Sign In".
  /[-–—|·:/]\s*(sign\s?in|sign\s?on|log\s?in|login|signin|sign\s?up|signup)\s*$/i,
  /[-–—|·:/]\s*((multi|two)[- ]?factor authentication|password reset|(email|phone|mobile) verification)\s*$/i,
];

/**
 * Prefix patterns, applied only to short titles. An interstitial announces
 * itself in a handful of words; a real article does not. Length is what keeps
 * "Error handling with Result and the question mark operator" — a Rust doc
 * page — out of the same bucket as "Error 404 (Not Found)".
 */
export const JUNK_TITLE_PREFIX: RegExp[] = [
  // Bot checks and CDN interstitials
  /^just a moment/i,
  /^(please )?wait\b/i,
  /^one moment/i,
  /^checking your browser/i,
  /^attention required/i,
  /^(are you a robot|captcha|verify you are human)/i,
  /^ddos[- ]guard/i,
  /^security check/i,

  // Auth walls — §9 says never capture these
  /^(sign|log)\s?(in|out|on|up)\s*[-–—|·:]/i,
  /^(signin|login|logout|signup)\s*[-–—|·:]/i,
  /^2[- ]step verification/i,
  /^account (verification|confirmation|recovery)/i,
  /^(email|phone|mobile) verification/i,
  /^reset your password/i,
  /^password (checkup|reset|manager)\b/i,
  /^(choose|select) an account/i,
  /^confirm(ation)?\b/i,
  /^accounts?\.google\.com/i,

  // Errors and status pages — a digit or separator must follow, so that
  // "Error handling…" is not mistaken for "Error 500 — Server".
  /^(error\s*)?[45]\d{2}\b/i,
  /^error\s*[-–—|·:#]/i,
  /^(bad request|forbidden|unauthorized|access denied)\b/i,
  /^page not found/i,
  /^(site|server) (is )?(down|unavailable)/i,
  /^service unavailable/i,
  /^privacy error/i,
  /^this site can'?t be reached/i,
  /^problem loading page/i,

  // Transient states
  /^(loading|redirecting|connecting|processing|submitting)\b/i,
  /^please enable javascript/i,
];

/** Above this length a title is descriptive enough to be real content. */
export const JUNK_PREFIX_MAX_LENGTH = 40;

/** Below this, a spaceless string is short enough that the length filter handles it. */
const BARE_URL_MIN_LENGTH = 30;

/** Printable ASCII with no whitespace anywhere. */
const NO_WHITESPACE_ASCII = /^[!-~]+$/;

/**
 * A title that is really just a URL.
 *
 * Chrome falls back to the URL when a page serves no `<title>`, so these are
 * pages with no title at all — no title means no topic, the same rationale as
 * every other tier here.
 *
 * They also cost disproportionately: a URL tokenizes into hundreds of
 * wordpieces, and since every title in a batch pads to the longest one, a
 * single 875-token URL made its batch 30× the median cost. Measured r = 0.992
 * between padded width and batch duration.
 *
 * The ASCII requirement is load-bearing and not cosmetic. Chinese, Japanese and
 * Thai titles legitimately contain no whitespace, and a rule keyed on
 * "no spaces" alone would delete them wholesale — the same class of bug as the
 * ASCII-only `\W` that once ate every Telugu title.
 */
/** `host.tld/…` — a dotted host followed by a path. */
const HOST_WITH_PATH = /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+\//i;
/** Query-string and percent-encoding punctuation. */
const URL_QUERY = /[?&=%]/;
/** A content-hash filename: `b100e504478166a8308fc52412ef279f.pdf`. */
const HASH_FILENAME = /^[a-f0-9]{16,}\.[a-z0-9]{2,5}$/i;

export function isBareUrlTitle(title: string): boolean {
  if (title.length < BARE_URL_MIN_LENGTH) return false;
  if (!NO_WHITESPACE_ASCII.test(title)) return false;

  // A slash alone is not enough. GitHub titles pages "owner/repo", which is
  // spaceless ASCII containing a slash but is one of the most informative
  // titles in the corpus — "GANDLA-ARAVIND/WATT-WISE-PROJECT" names a real
  // project. Requiring a *dotted host* before the slash separates a URL from a
  // repository path.
  return HOST_WITH_PATH.test(title) || URL_QUERY.test(title) || HASH_FILENAME.test(title);
}

export function isJunkTitle(title: string): boolean {
  const candidate = title.trim();
  if (candidate.length === 0) return true;
  if (JUNK_TITLE_EXACT.some((pattern) => pattern.test(candidate))) return true;
  if (JUNK_TITLE_STRONG.some((pattern) => pattern.test(candidate))) return true;
  if (isBareUrlTitle(candidate)) return true;
  if (candidate.length > JUNK_PREFIX_MAX_LENGTH) return false;
  return JUNK_TITLE_PREFIX.some((pattern) => pattern.test(candidate));
}
