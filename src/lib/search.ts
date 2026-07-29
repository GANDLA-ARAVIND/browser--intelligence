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
 */
export function topKByCosine(
  matrix: Float32Array,
  count: number,
  query: Float32Array,
  k: number
): ScoredIndex[] {
  const bestIndex = new Int32Array(k).fill(-1);
  const bestScore = new Float32Array(k).fill(Number.NEGATIVE_INFINITY);
  let filled = 0;

  for (let row = 0; row < count; row++) {
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
