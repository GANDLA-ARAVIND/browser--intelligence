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

export function isJunkTitle(title: string): boolean {
  const candidate = title.trim();
  if (candidate.length === 0) return true;
  if (JUNK_TITLE_EXACT.some((pattern) => pattern.test(candidate))) return true;
  if (JUNK_TITLE_STRONG.some((pattern) => pattern.test(candidate))) return true;
  if (candidate.length > JUNK_PREFIX_MAX_LENGTH) return false;
  return JUNK_TITLE_PREFIX.some((pattern) => pattern.test(candidate));
}
