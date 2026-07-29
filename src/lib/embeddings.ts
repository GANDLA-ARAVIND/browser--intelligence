/**
 * On-device embedding (CLAUDE.md §2.3).
 *
 * The pooling and normalize options are the whole point of this module: MiniLM
 * was trained with mean pooling, and `normalize: true` is what makes a dot
 * product a cosine — which every consumer in src/lib assumes. Verified by
 * scripts/sanity.ts, whose drift guard reads this file.
 *
 * Browser-safe. `cacheDir` is a Node-only concern and is therefore an argument
 * rather than something this module decides: in the extension, transformers.js
 * caches through the browser and the option is simply not passed.
 */

import { EMBEDDING_DIM } from './vectors.js';

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_BATCH_SIZE = 32;
export { EMBEDDING_DIM };

export interface EmbedderOptions {
  /** Node only: where to cache model weights. Ignored in the browser. */
  cacheDir?: string;
  /** ~23MB int8 build. Fixed by §2.3; exposed for the sanity harness. */
  quantized?: boolean;
}

export type ProgressFn = (done: number, total: number) => void;

export interface Embedder {
  /** Returns a flat `texts.length × EMBEDDING_DIM` matrix. */
  embed(texts: string[], onProgress?: ProgressFn): Promise<Float32Array>;
}

export async function createEmbedder(options: EmbedderOptions = {}): Promise<Embedder> {
  const { pipeline, env } = await import('@xenova/transformers');
  if (options.cacheDir !== undefined) env.cacheDir = options.cacheDir;

  const extractor = await pipeline('feature-extraction', EMBEDDING_MODEL, {
    quantized: options.quantized ?? true,
  });

  return {
    async embed(texts: string[], onProgress?: ProgressFn): Promise<Float32Array> {
      const matrix = new Float32Array(texts.length * EMBEDDING_DIM);
      let done = 0;

      for (let offset = 0; offset < texts.length; offset += EMBEDDING_BATCH_SIZE) {
        const batch = texts.slice(offset, offset + EMBEDDING_BATCH_SIZE);
        const output = await extractor(batch, { pooling: 'mean', normalize: true });
        const data = output.data as Float32Array;
        matrix.set(data.subarray(0, batch.length * EMBEDDING_DIM), offset * EMBEDDING_DIM);

        done += batch.length;
        onProgress?.(done, texts.length);
      }

      return matrix;
    },
  };
}
