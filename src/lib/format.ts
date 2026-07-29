/**
 * Format classification from domain rules (CLAUDE.md §4, §8 tier 4).
 *
 * Format is explicitly *not* a topic. §4: "a Kubernetes talk and a comedy set
 * share a domain and nothing else." This answers "what kind of thing is it",
 * and is the one axis where domain knowledge is the correct tool — §8 names
 * "domain rule only" as the last rung of the extraction ladder.
 */

export type Format = 'video' | 'docs' | 'forum' | 'article' | 'code' | 'social' | 'shopping' | 'other';

const DOMAIN_RULES: Array<[RegExp, Format]> = [
  [/(^|\.)(youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|dailymotion\.com)$/i, 'video'],
  [/(^|\.)(github\.com|gitlab\.com|bitbucket\.org|codepen\.io|codesandbox\.io|replit\.com|leetcode\.com|neetcode\.io|hackerrank\.com|codeforces\.com)$/i, 'code'],
  [/(^|\.)(stackoverflow\.com|stackexchange\.com|superuser\.com|serverfault\.com|askubuntu\.com|reddit\.com|quora\.com|discourse\.)/i, 'forum'],
  [/(^|\.)(docs\.|developer\.|devdocs\.io|readthedocs\.io|mdn\.|developer\.mozilla\.org|w3schools\.com|geeksforgeeks\.org)/i, 'docs'],
  [/(^|\.)(amazon\.|ebay\.|etsy\.com|flipkart\.com|myntra\.com|aliexpress\.com|walmart\.com|argos\.co\.uk)/i, 'shopping'],
  [/(^|\.)(twitter\.com|x\.com|linkedin\.com|facebook\.com|instagram\.com|threads\.net|mastodon\.|bsky\.app|pinterest\.)/i, 'social'],
  [/(^|\.)(medium\.com|substack\.com|dev\.to|hashnode\.|blogspot\.com|wordpress\.com|nytimes\.com|bbc\.co\.uk|theguardian\.com)$/i, 'article'],
];

/** Path shapes that beat the domain rule — docs live under many hostnames. */
const PATH_RULES: Array<[RegExp, Format]> = [
  [/^\/(docs?|documentation|reference|api|guide|manual)(\/|$)/i, 'docs'],
  [/^\/(blog|posts?|articles?)(\/|$)/i, 'article'],
  [/^\/(watch|video|embed)(\/|$)/i, 'video'],
];

export function classifyFormat(url: string): Format {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'other';
  }
  const host = parsed.hostname.toLowerCase();

  for (const [pattern, format] of DOMAIN_RULES) {
    if (pattern.test(host)) return format;
  }
  for (const [pattern, format] of PATH_RULES) {
    if (pattern.test(parsed.pathname)) return format;
  }
  return 'other';
}
