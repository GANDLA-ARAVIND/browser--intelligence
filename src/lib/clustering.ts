/**
 * Shared-nearest-neighbour clustering (Jarvis–Patrick) over a mutual-kNN graph.
 *
 * Two pages are linked when each is in the other's top-k *and* they share at
 * least `sharedMin` neighbours. Both tests are rank-based, so this adapts to
 * however tightly or loosely a given user's browsing happens to embed rather
 * than depending on an absolute cosine cutoff — which measurement shows is
 * dataset-specific and sits far lower than intuition suggests (same-topic pairs
 * median 0.194, cross-topic 0.021).
 *
 * The shared-neighbour test is what stops chaining. Mutual-kNN alone will link
 * an accidental Kubernetes/sourdough pair and connected components then welds
 * two unrelated topics together permanently; requiring shared context breaks
 * exactly those bridges, because a genuine bridge pair has no mutual crowd.
 *
 * Components below `minClusterSize` fall out as noise: the discovery queue of
 * §5, not a failure.
 *
 * Chosen over HDBSCAN, which needs a dimensionality-reduction step to behave on
 * 384 dims and has no trustworthy JS implementation. See CLAUDE.md §14.
 */

import { BackfillCancelledError, createSlicer, DEFAULT_SLICE_MS } from './chunk.js';
import { centroidOf, dot, dotVec } from './vectors.js';

export interface Cluster {
  members: number[];
  centroid: Float32Array;
  /** member index -> cosine similarity to centroid, aligned with `members` */
  sims: number[];
}

export interface ClusterResult {
  clusters: Cluster[];
  noise: number[];
}

export interface KnnOptions {
  k: number;
  /** Neighbours two nodes must share to keep their edge. */
  sharedMin: number;
  /** Edges below this similarity are never considered. */
  minSim: number;
  minClusterSize: number;
}

export function describeCluster(matrix: Float32Array, members: number[]): Cluster {
  const centroid = centroidOf(matrix, members);
  const scored = members
    .map((index) => ({ index, sim: dotVec(matrix, index, centroid) }))
    .sort((a, b) => b.sim - a.sim);
  return {
    members: scored.map((s) => s.index),
    sims: scored.map((s) => s.sim),
    centroid,
  };
}

export function clusterByMutualKnn(
  matrix: Float32Array,
  count: number,
  options: KnnOptions
): ClusterResult & { mutualEdges: number; bridgesCut: number; components: number } {
  const { k, sharedMin, minSim: floor, minClusterSize } = options;

  // Top-k per node, kept sorted descending by similarity. k is small, so
  // insertion into a plain array beats a heap.
  const topIndex: number[][] = Array.from({ length: count }, () => []);
  const topSim: number[][] = Array.from({ length: count }, () => []);

  const offer = (node: number, other: number, sim: number): void => {
    const sims = topSim[node]!;
    if (sims.length === k && sim <= sims[k - 1]!) return;
    const indices = topIndex[node]!;
    let position = sims.length;
    while (position > 0 && sims[position - 1]! < sim) position--;
    sims.splice(position, 0, sim);
    indices.splice(position, 0, other);
    if (sims.length > k) {
      sims.pop();
      indices.pop();
    }
  };

  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const sim = dot(matrix, i, j);
      if (sim < floor) continue;
      offer(i, j, sim);
      offer(j, i, sim);
    }
  }

  // Union-find over mutual edges only.
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
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  const neighbourSets = topIndex.map((list) => new Set(list));
  const sharedNeighbours = (a: number, b: number): number => {
    const setB = neighbourSets[b]!;
    let shared = 0;
    for (const n of topIndex[a]!) if (n !== b && setB.has(n)) shared++;
    return shared;
  };

  let mutualEdges = 0;
  let bridgesCut = 0;
  for (let i = 0; i < count; i++) {
    for (const j of topIndex[i]!) {
      if (j <= i || !neighbourSets[j]!.has(i)) continue;
      if (sharedNeighbours(i, j) < sharedMin) {
        bridgesCut++;
        continue;
      }
      union(i, j);
      mutualEdges++;
    }
  }

  const components = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    const bucket = components.get(root);
    if (bucket === undefined) components.set(root, [i]);
    else bucket.push(i);
  }

  const clusters: Cluster[] = [];
  const noise: number[] = [];
  for (const members of components.values()) {
    if (members.length < minClusterSize) noise.push(...members);
    else clusters.push(describeCluster(matrix, members));
  }

  clusters.sort((a, b) => b.members.length - a.members.length);
  noise.sort((a, b) => a - b);
  return { clusters, noise, mutualEdges, bridgesCut, components: components.size };
}

/**
 * Chunked mutual-kNN — identical output to `clusterByMutualKnn`, yielding
 * between outer iterations (§14, src/lib/chunk.ts).
 *
 * The extension path; the synchronous version above is the reference the
 * chunked one is asserted against on the real corpus. Measured 3.4s unbroken
 * before chunking.
 *
 * Both O(n²) phases are sliced — the top-k scan and the mutual-edge/shared-
 * neighbour pass. The second is cheaper but still quadratic in the worst case,
 * and §14's rule is about *any* whole-corpus synchronous pass, not just the
 * expensive one.
 */
export async function clusterByMutualKnnChunked(
  matrix: Float32Array,
  count: number,
  options: KnnOptions,
  sliceMs: number = DEFAULT_SLICE_MS,
  shouldCancel?: () => boolean
): Promise<ClusterResult & { mutualEdges: number; bridgesCut: number; components: number }> {
  const { k, sharedMin, minSim: floor, minClusterSize } = options;

  const topIndex: number[][] = Array.from({ length: count }, () => []);
  const topSim: number[][] = Array.from({ length: count }, () => []);

  const offer = (node: number, other: number, sim: number): void => {
    const sims = topSim[node]!;
    if (sims.length === k && sim <= sims[k - 1]!) return;
    const indices = topIndex[node]!;
    let position = sims.length;
    while (position > 0 && sims[position - 1]! < sim) position--;
    sims.splice(position, 0, sim);
    indices.splice(position, 0, other);
    if (sims.length > k) {
      sims.pop();
      indices.pop();
    }
  };

  const slicer = createSlicer(sliceMs);
  for (let i = 0; i < count; i++) {
    if (slicer.due()) {
      await slicer.yieldNow();
      if (shouldCancel?.()) throw new BackfillCancelledError();
    }
    for (let j = i + 1; j < count; j++) {
      const sim = dot(matrix, i, j);
      if (sim < floor) continue;
      offer(i, j, sim);
      offer(j, i, sim);
    }
  }

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
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  const neighbourSets = topIndex.map((list) => new Set(list));
  const sharedNeighbours = (a: number, b: number): number => {
    const setB = neighbourSets[b]!;
    let shared = 0;
    for (const n of topIndex[a]!) if (n !== b && setB.has(n)) shared++;
    return shared;
  };

  let mutualEdges = 0;
  let bridgesCut = 0;
  for (let i = 0; i < count; i++) {
    if (slicer.due()) {
      await slicer.yieldNow();
      if (shouldCancel?.()) throw new BackfillCancelledError();
    }
    for (const j of topIndex[i]!) {
      if (j <= i || !neighbourSets[j]!.has(i)) continue;
      if (sharedNeighbours(i, j) < sharedMin) {
        bridgesCut++;
        continue;
      }
      union(i, j);
      mutualEdges++;
    }
  }

  const components = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    const bucket = components.get(root);
    if (bucket === undefined) components.set(root, [i]);
    else bucket.push(i);
  }

  const clusters: Cluster[] = [];
  const noise: number[] = [];
  for (const members of components.values()) {
    if (members.length < minClusterSize) noise.push(...members);
    else clusters.push(describeCluster(matrix, members));
  }

  clusters.sort((a, b) => b.members.length - a.members.length);
  noise.sort((a, b) => a - b);
  return { clusters, noise, mutualEdges, bridgesCut, components: components.size };
}

// ---------------------------------------------------------------------------
// Neighbour cache — for sweeping many parameter sets over one corpus
// ---------------------------------------------------------------------------

/**
 * A parameter sweep runs the same clustering ~90 times. Recomputing every
 * pairwise dot product each run would be ~90 O(n²) passes, so the neighbour
 * lists are built once at the largest k in the grid and every combination is
 * derived from them.
 *
 * This is exact rather than approximate. `clusterByMutualKnn` applies its floor
 * before selecting top-k, so its list is the k highest neighbours at or above
 * the floor. Slicing a floor-free top-`maxK` list by the same floor and
 * truncating to k yields that identical set, provided k ≤ maxK.
 */
export interface NeighbourCache {
  topIndex: number[][];
  topSim: number[][];
}

export function buildNeighbourCache(matrix: Float32Array, count: number, maxK: number): NeighbourCache {
  const topIndex: number[][] = Array.from({ length: count }, () => []);
  const topSim: number[][] = Array.from({ length: count }, () => []);

  // Insertion identical to clusterByMutualKnn's `offer`, including tie handling.
  const offer = (node: number, other: number, sim: number): void => {
    const sims = topSim[node]!;
    if (sims.length === maxK && sim <= sims[maxK - 1]!) return;
    const indices = topIndex[node]!;
    let position = sims.length;
    while (position > 0 && sims[position - 1]! < sim) position--;
    sims.splice(position, 0, sim);
    indices.splice(position, 0, other);
    if (sims.length > maxK) {
      sims.pop();
      indices.pop();
    }
  };

  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const sim = dot(matrix, i, j);
      offer(i, j, sim);
      offer(j, i, sim);
    }
  }
  return { topIndex, topSim };
}

/**
 * Same rule as `clusterByMutualKnn`, reading the cache instead of the matrix.
 * Returns raw components; a sweep only needs sizes, so no centroids.
 */
export function componentsFromCache(
  cache: NeighbourCache,
  count: number,
  options: KnnOptions
): { components: number[][]; noise: number[] } {
  const { k, sharedMin, minSim: floor, minClusterSize } = options;

  const topIndex: number[][] = [];
  const neighbourSets: Array<Set<number>> = [];
  for (let i = 0; i < count; i++) {
    const sims = cache.topSim[i]!;
    const indices = cache.topIndex[i]!;
    const list: number[] = [];
    for (let position = 0; position < indices.length && list.length < k; position++) {
      if (sims[position]! < floor) break; // sorted descending
      list.push(indices[position]!);
    }
    topIndex.push(list);
    neighbourSets.push(new Set(list));
  }

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
    for (const j of topIndex[i]!) {
      if (j <= i || !neighbourSets[j]!.has(i)) continue;
      let shared = 0;
      const setJ = neighbourSets[j]!;
      for (const n of topIndex[i]!) if (n !== j && setJ.has(n)) shared++;
      if (shared < sharedMin) continue;
      const rootI = find(i);
      const rootJ = find(j);
      if (rootI !== rootJ) parent[rootJ] = rootI;
    }
  }

  const buckets = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    const bucket = buckets.get(root);
    if (bucket === undefined) buckets.set(root, [i]);
    else bucket.push(i);
  }

  const components: number[][] = [];
  const noise: number[] = [];
  for (const members of buckets.values()) {
    if (members.length < minClusterSize) noise.push(...members);
    else components.push(members);
  }
  components.sort((a, b) => b.length - a.length);
  noise.sort((a, b) => a - b);
  return { components, noise };
}
