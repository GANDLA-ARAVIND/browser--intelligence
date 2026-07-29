/**
 * Near-duplicate collapse (CLAUDE.md §14).
 *
 * LeetCode serves /problems/two-sum/, /description/ and /submissions/ as three
 * URLs under one title, so the normalized-URL dedupe never sees them. Twenty
 * such copies saturate a page's k nearest neighbours with itself, leaving no
 * room for a related-but-different page to link — every problem becomes its own
 * island and genuinely unique pages get no mutual edges at all.
 *
 * Measured on real history: without this, 553 clusters at 41% noise, with four
 * separate "Sign in" clusters.
 */

import { centroidOf, dot, EMBEDDING_DIM } from './vectors.js';
import type { Page } from './types.js';

export const DEFAULT_DUPLICATE_THRESHOLD = 0.97;

export interface DuplicateGroup {
  /** Index into `pages` of the member that represents the group. */
  representative: number;
  /** Indices into `pages`, representative included, sorted by visitCount desc. */
  members: number[];
}

export interface CollapseResult {
  groups: DuplicateGroup[];
  /** One centroid per group, laid out like the input matrix. */
  repMatrix: Float32Array;
}

/**
 * Union-find over pairs at or above `threshold`. Chaining is possible in
 * principle (a~b, b~c, a≁c) but at 0.97 the transitive slack is negligible.
 *
 * 0.97 is an absolute threshold, unlike everything else in the pipeline, and
 * that is deliberate: it detects near-*identity*, not topical relatedness.
 * Duplicates sit at ~1.0 against a measured cross-topic max of 0.44, so the
 * margin is enormous and scale-stable.
 */
export function collapseNearDuplicates(
  matrix: Float32Array,
  pages: Page[],
  threshold: number = DEFAULT_DUPLICATE_THRESHOLD
): CollapseResult {
  const count = pages.length;
  const parent = new Int32Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[x] !== root) {
      const next = parent[x]!;
      parent[x] = root;
      x = next;
    }
    return root;
  };

  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (dot(matrix, i, j) >= threshold) {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) parent[rootJ] = rootI;
      }
    }
  }

  const buckets = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    const bucket = buckets.get(root);
    if (bucket === undefined) buckets.set(root, [i]);
    else bucket.push(i);
  }

  const groups: DuplicateGroup[] = [];
  for (const members of buckets.values()) {
    // The most-revisited member speaks for the group: §4 calls return visits
    // the strongest relevance signal.
    members.sort((a, b) => {
      const byVisits = pages[b]!.visitCount - pages[a]!.visitCount;
      return byVisits !== 0 ? byVisits : pages[b]!.title.length - pages[a]!.title.length;
    });
    groups.push({ representative: members[0]!, members });
  }

  // Deterministic order, so a rerun produces the same thing.
  groups.sort((a, b) => a.representative - b.representative);

  // A group's vector is its normalized centroid rather than the representative's
  // own — members sit within 0.03 cosine of each other, so this is a marginal
  // but free improvement in stability.
  const repMatrix = new Float32Array(groups.length * EMBEDDING_DIM);
  groups.forEach((group, position) => {
    const centroid = centroidOf(matrix, group.members);
    repMatrix.set(centroid, position * EMBEDDING_DIM);
  });

  return { groups, repMatrix };
}

/** Group indices -> every page they stand for. */
export function expandGroups(groups: DuplicateGroup[], groupIndices: number[]): number[] {
  const pageIndices: number[] = [];
  for (const groupIndex of groupIndices) pageIndices.push(...groups[groupIndex]!.members);
  return pageIndices;
}
