/**
 * Brute-force semantic search (CLAUDE.md §2.4, §5).
 *
 * No vector database, deliberately: 10k pages × 384 dims × 4 bytes is ~15MB,
 * which loads into memory instantly, and a full scan is ~4M multiply-adds. A
 * vector DB is pure overhead until well past 100k pages.
 *
 * The scan is a single pass over one contiguous Float32Array with a partial
 * top-k selection — no sort of the full score array, no intermediate objects
 * per row.
 */

import { EMBEDDING_DIM } from './vectors.js';

export interface ScoredIndex {
  index: number;
  score: number;
}

/**
 * Top-k by cosine similarity. Vectors are L2-normalized by the embedder, so a
 * dot product *is* the cosine — no division, no norms recomputed per row.
 *
 * Keeps a k-sized insertion-sorted list rather than sorting n scores: k is 20
 * and n is thousands, so this is O(n·k) worst case but O(n) in practice, since
 * most rows fail the single comparison against the current k-th best.
 *
 * `filter`, when given, excludes a row **before** scoring is compared into the
 * top-k list — a hard filter (time range, format, domain, topic) must narrow
 * the candidate pool the ranking draws from, not be applied after the fact to
 * an already-decided top k. Filtering after selection can silently return
 * fewer than k results even when more matches exist elsewhere in the corpus.
 */
export function topKByCosine(
  matrix: Float32Array,
  count: number,
  query: Float32Array,
  k: number,
  filter?: (row: number) => boolean
): ScoredIndex[] {
  const bestIndex = new Int32Array(k).fill(-1);
  const bestScore = new Float32Array(k).fill(Number.NEGATIVE_INFINITY);
  let filled = 0;

  for (let row = 0; row < count; row++) {
    if (filter !== undefined && !filter(row)) continue;

    const base = row * EMBEDDING_DIM;
    let score = 0;
    for (let d = 0; d < EMBEDDING_DIM; d++) score += matrix[base + d]! * query[d]!;

    // The common case: one comparison and move on.
    if (filled === k && score <= bestScore[k - 1]!) continue;

    let position = Math.min(filled, k - 1);
    while (position > 0 && bestScore[position - 1]! < score) {
      bestScore[position] = bestScore[position - 1]!;
      bestIndex[position] = bestIndex[position - 1]!;
      position--;
    }
    bestScore[position] = score;
    bestIndex[position] = row;
    if (filled < k) filled++;
  }

  const out: ScoredIndex[] = [];
  for (let i = 0; i < filled; i++) out.push({ index: bestIndex[i]!, score: bestScore[i]! });
  return out;
}

/**
 * Caps how many results one domain may contribute (Phase 4 search backlog
 * item 2, CLAUDE.md §11). **Not a lower collapse threshold** — collapse
 * merges near-*identical* pages before ranking even runs, and lowering it
 * would over-merge genuinely distinct ones (§14). This is the same
 * neighbourhood-saturation problem recurring one layer up: there it starved
 * the kNN graph, here it starves the result list, so the fix is diversity in
 * *ranking*, not deduplication.
 *
 * `candidates` must already be sorted by score descending and must be a
 * strictly larger pool than `limit` — the caller draws a wider top-k first
 * (see `search()`) so there is somewhere for the cap to draw a replacement
 * from. Never returns fewer than `min(limit, candidates.length)`: a capped
 * domain's excess is not discarded, it is deferred to the end, so search
 * still returns k results whenever k exist (§11's "no empty state" rule —
 * the count must not silently shrink because one domain was popular).
 */
export function applyDomainDiversity(
  candidates: ScoredIndex[],
  domainOf: (row: number) => string,
  limit: number,
  cap: number
): ScoredIndex[] {
  const perDomain = new Map<string, number>();
  const chosen: ScoredIndex[] = [];
  const overflow: ScoredIndex[] = [];

  for (const candidate of candidates) {
    const domain = domainOf(candidate.index);
    const used = perDomain.get(domain) ?? 0;
    if (used < cap) {
      chosen.push(candidate);
      perDomain.set(domain, used + 1);
    } else {
      overflow.push(candidate);
    }
    if (chosen.length >= limit) return chosen;
  }

  // Fewer than `limit` distinct domains cleared the cap — backfill from the
  // capped excess rather than return short. A backfilled item can score
  // higher than something already chosen (it was only excluded for being the
  // 4th from an already-well-represented domain), so the merge is re-sorted
  // rather than assumed to still be in score order.
  for (const candidate of overflow) {
    if (chosen.length >= limit) break;
    chosen.push(candidate);
  }
  return chosen.sort((a, b) => b.score - a.score);
}
