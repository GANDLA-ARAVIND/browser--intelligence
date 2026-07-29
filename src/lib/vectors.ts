/**
 * Vector maths over a flat Float32Array matrix of `count × EMBEDDING_DIM`
 * (CLAUDE.md §13: typed arrays only, never plain arrays).
 *
 * One contiguous buffer rather than an array of arrays: 10k pages is ~15MB and
 * a brute-force scan stays in the millisecond range (§5).
 */

export const EMBEDDING_DIM = 384;

/** Vectors come out of MiniLM L2-normalized, so cosine similarity is a dot product. */
export function dot(matrix: Float32Array, i: number, j: number, dim = EMBEDDING_DIM): number {
  const a = i * dim;
  const b = j * dim;
  let sum = 0;
  for (let d = 0; d < dim; d++) sum += matrix[a + d]! * matrix[b + d]!;
  return sum;
}

export function dotVec(matrix: Float32Array, i: number, vec: Float32Array, dim = EMBEDDING_DIM): number {
  const a = i * dim;
  let sum = 0;
  for (let d = 0; d < dim; d++) sum += matrix[a + d]! * vec[d]!;
  return sum;
}

export function centroidOf(matrix: Float32Array, members: number[], dim = EMBEDDING_DIM): Float32Array {
  const centroid = new Float32Array(dim);
  for (const index of members) {
    const base = index * dim;
    for (let d = 0; d < dim; d++) centroid[d]! += matrix[base + d]!;
  }
  let norm = 0;
  for (let d = 0; d < dim; d++) norm += centroid[d]! * centroid[d]!;
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dim; d++) centroid[d]! /= norm;
  return centroid;
}
