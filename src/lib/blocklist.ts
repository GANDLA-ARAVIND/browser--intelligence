/**
 * Sensitive-category exclusion (CLAUDE.md §9).
 *
 * "Never capture: incognito windows, chrome://, localhost, and a
 * sensitive-category blocklist (banking, health, email, adult, internal
 * corporate tools). Exclude *before* extraction — never embed them."
 *
 * This is the one place domain knowledge is allowed. §6 forbids it in the
 * *taxonomy* — a hand-written topic list only ever fits its author — but a
 * privacy rule is not a taxonomy, and the cost of asymmetry runs one way: a
 * missed banking domain leaks, a false positive only loses a page.
 *
 * Matched on the registrable-ish suffix, so `login.chase.com` and
 * `www.chase.com` both match `chase.com`.
 */

export type SensitiveCategory = 'banking' | 'health' | 'email' | 'adult' | 'corporate' | 'government-id';

/** Every category, in the order the settings UI shows them. */
export const SENSITIVE_CATEGORIES: readonly SensitiveCategory[] = [
  'banking',
  'health',
  'email',
  'adult',
  'corporate',
  'government-id',
] as const;

/**
 * All categories block by default — §9 is opt-out, not opt-in, because the
 * cost is asymmetric: a missed banking domain leaks, an unwanted block only
 * loses a page.
 *
 * But which categories are actually sensitive is the *user's* judgement, not
 * ours. Someone researching visa paperwork wants their passport pages indexed;
 * that is a real topic in their life, not a secret. So this is a default, and
 * the settings UI can switch any category off.
 */
export const DEFAULT_BLOCKED_CATEGORIES: readonly SensitiveCategory[] = SENSITIVE_CATEGORIES;

export const CATEGORY_LABELS: Record<SensitiveCategory, { label: string; description: string }> = {
  banking: { label: 'Banking & payments', description: 'Bank, card, and payment portals' },
  health: { label: 'Health', description: 'Patient portals, pharmacies, medical records' },
  email: { label: 'Email & messaging', description: 'Webmail and web messenger clients' },
  adult: { label: 'Adult', description: 'Adult content sites' },
  corporate: { label: 'Internal corporate tools', description: 'Intranets, VPN, SSO, ticketing' },
  'government-id': {
    label: 'Government & identity',
    description: 'Passport, national ID, and tax portals',
  },
};

/** Exact host or any subdomain of it. */
const BLOCKED_DOMAINS: Array<[string, SensitiveCategory]> = [
  // Email and messaging — the highest-volume leak by far
  ['mail.google.com', 'email'],
  ['outlook.com', 'email'],
  ['outlook.live.com', 'email'],
  ['outlook.office.com', 'email'],
  ['outlook.office365.com', 'email'],
  ['mail.yahoo.com', 'email'],
  ['mail.proton.me', 'email'],
  ['protonmail.com', 'email'],
  ['mail.zoho.com', 'email'],
  ['roundcube.', 'email'],
  ['web.whatsapp.com', 'email'],
  ['messenger.com', 'email'],

  // Banking and payments
  ['chase.com', 'banking'],
  ['bankofamerica.com', 'banking'],
  ['wellsfargo.com', 'banking'],
  ['citibank.com', 'banking'],
  ['capitalone.com', 'banking'],
  ['hsbc.com', 'banking'],
  ['barclays.co.uk', 'banking'],
  ['lloydsbank.com', 'banking'],
  ['natwest.com', 'banking'],
  ['santander.co.uk', 'banking'],
  ['monzo.com', 'banking'],
  ['revolut.com', 'banking'],
  ['paypal.com', 'banking'],
  ['stripe.com/dashboard', 'banking'],
  ['wise.com', 'banking'],
  ['coinbase.com', 'banking'],
  ['binance.com', 'banking'],
  ['icicibank.com', 'banking'],
  ['hdfcbank.com', 'banking'],
  ['sbi.co.in', 'banking'],
  ['onlinesbi.sbi', 'banking'],
  ['axisbank.com', 'banking'],
  ['kotak.com', 'banking'],
  ['phonepe.com', 'banking'],
  ['paytm.com', 'banking'],
  ['netbanking.', 'banking'],

  // Health
  ['mychart.', 'health'],
  ['mychart.com', 'health'],
  ['patientaccess.com', 'health'],
  ['nhs.uk', 'health'],
  ['zocdoc.com', 'health'],
  ['healthline.com', 'health'],
  ['webmd.com', 'health'],
  ['practo.com', 'health'],
  ['1mg.com', 'health'],
  ['pharmeasy.in', 'health'],

  // Government identity documents
  ['uidai.gov.in', 'government-id'],
  ['resident.uidai.gov.in', 'government-id'],
  ['incometax.gov.in', 'government-id'],
  ['passportindia.gov.in', 'government-id'],
  ['ssa.gov', 'government-id'],
  ['irs.gov', 'government-id'],

  // Adult
  ['pornhub.com', 'adult'],
  ['xvideos.com', 'adult'],
  ['xhamster.com', 'adult'],
  ['redtube.com', 'adult'],
  ['onlyfans.com', 'adult'],
  ['xnxx.com', 'adult'],
];

/**
 * Internal corporate tooling. Matched on host *shape* rather than a company
 * list, since every company's internal hostnames differ — this is the only
 * rule here that generalises rather than enumerating.
 */
const CORPORATE_HOST_PATTERNS: RegExp[] = [
  /(^|\.)(intranet|internal|corp|vpn|sso|okta|onelogin|workday|servicenow)\./i,
  /\.internal(\.|$)/i,
  /(^|\.)(jira|confluence)\.[a-z0-9-]+\.(com|net|io)$/i,
];

export interface BlocklistMatch {
  blocked: boolean;
  category?: SensitiveCategory;
}

export function classifySensitive(url: string): BlocklistMatch {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { blocked: false };
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const hostPath = `${host}${parsed.pathname.toLowerCase()}`;

  for (const [needle, category] of BLOCKED_DOMAINS) {
    if (needle.endsWith('.')) {
      // Prefix form, e.g. "netbanking." matches netbanking.anybank.com
      if (host.startsWith(needle) || host.includes(`.${needle}`)) return { blocked: true, category };
      continue;
    }
    if (needle.includes('/')) {
      if (hostPath.startsWith(needle)) return { blocked: true, category };
      continue;
    }
    if (host === needle || host.endsWith(`.${needle}`)) return { blocked: true, category };
  }

  for (const pattern of CORPORATE_HOST_PATTERNS) {
    if (pattern.test(host)) return { blocked: true, category: 'corporate' };
  }

  return { blocked: false };
}

/**
 * Whether a URL should be excluded, given the categories the user has enabled.
 *
 * `classifySensitive` still reports the category for a URL in a *disabled*
 * category — the classification is a fact about the site, the blocking is a
 * user preference, and keeping them separate is what makes a category
 * switchable without rewriting the rules.
 */
export function isSensitive(url: string, blockedCategories: readonly SensitiveCategory[]): boolean {
  if (blockedCategories.length === 0) return false;
  const match = classifySensitive(url);
  return match.blocked && match.category !== undefined && blockedCategories.includes(match.category);
}
