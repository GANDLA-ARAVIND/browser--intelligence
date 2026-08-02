/**
 * Tier-1 universal seed labels (CLAUDE.md §6).
 *
 * **A weak prior, not a classifier.** Matching pages against these by cosine
 * was measured over 5,374 real pages and rejected outright (§5, §14): §5's old
 * ~0.40 threshold classified 13.3% of the corpus, no lower cutoff separates
 * right from wrong (correct-label scores span 0.091–0.473), and rank-and-margin
 * does not rescue it because the errors are *confident* — `Application History`
 * scores 0.467 on `history` with a 0.277 margin from pure lexical overlap.
 *
 * So these exist only to keep day one non-empty. **A seed name must never be
 * displayed to the user as a topic, and never written into `PageRecord.topics`
 * as a confirmed assignment** — only a derived cluster earns that.
 *
 * §6 names fourteen explicitly and ends with "etc." to ~25. The eleven added
 * here cover common browsing none of the fourteen would absorb.
 *
 * **These are the only hardcoded topics in the product.** Everything else is
 * derived from the user's own data; §2.5 makes this small universal list the
 * one permitted exception. Adding a domain-specific label (`kubernetes`,
 * `oncology`) violates that — it belongs in tier 2, discovered, not shipped.
 * Expanding the labels into richer phrases was also measured and rejected:
 * judged accuracy rose 12/20 → 14/20 but the distribution did not lift,
 * programming got worse, and per-label authoring smuggles in domain knowledge.
 */

/** The `name` is what gets embedded; nothing else is stored per seed yet. */
export const SEED_TOPICS: readonly string[] = [
  // The fourteen §6 names outright.
  'programming',
  'health',
  'finance',
  'travel',
  'cooking',
  'sports',
  'news',
  'education',
  'shopping',
  'entertainment',
  'design',
  'science',
  'legal',
  'career',
  // Filling out "etc." to ~25, chosen for coverage rather than taste.
  'music',
  'gaming',
  'fitness',
  'business',
  'politics',
  'history',
  'art',
  'photography',
  'home improvement',
  'automotive',
  'parenting',
];
