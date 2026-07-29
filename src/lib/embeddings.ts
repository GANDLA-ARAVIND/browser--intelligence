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

/**
 * Hard cap on tokens per title.
 *
 * Every title in a batch pads to the longest one, so cost is linear in the
 * batch's padded width — measured r = 0.992 between width and batch duration.
 * A single 875-token title (a URL Chrome used as a fallback title) made its
 * batch 30× the median. Titles are median 10 tokens and p99 36, so 64 leaves
 * 99.8% of them untouched while removing the tail entirely.
 *
 * This must be enforced at the *token* level. A word-level cap looked perfect
 * in testing — cosine 1.0000 on the worst offenders — because those titles are
 * single unbroken URLs with no whitespace, so it cut nothing at all.
 */
export const EMBEDDING_MAX_TOKENS = 64;

export interface EmbedderOptions {
  /** Node only: where to cache model weights. Ignored in the browser. */
  cacheDir?: string;
  /** ~23MB int8 build. Fixed by §2.3; exposed for the sanity harness. */
  quantized?: boolean;
  /**
   * Browser only: directory holding onnxruntime-web's `.wasm` files, served
   * from inside the extension package. MV3 forbids remotely hosted code, and
   * ORT otherwise fetches its runtime from a CDN — which fails the CSP.
   */
  wasmPaths?: string;
  /**
   * Browser only: 1 keeps ORT off SharedArrayBuffer and off blob-URL workers,
   * both of which MV3's CSP blocks. Slower than threaded, but it runs.
   */
  numThreads?: number;
  /**
   * Browser only: directory holding the bundled model, e.g.
   * `chrome-extension://<id>/models/`. Setting this puts transformers.js into
   * local-only mode — remote fetching is disabled outright, so the extension
   * makes no network request even if a file is missing. It fails loudly
   * instead, which is the behaviour we want.
   */
  localModelPath?: string;
}

export type ProgressFn = (done: number, total: number) => void;

export interface Embedder {
  /** Returns a flat `texts.length × EMBEDDING_DIM` matrix. */
  embed(texts: string[], onProgress?: ProgressFn): Promise<Float32Array>;
}

export async function createEmbedder(options: EmbedderOptions = {}): Promise<Embedder> {
  const { pipeline, env } = await import('@xenova/transformers');
  if (options.cacheDir !== undefined) env.cacheDir = options.cacheDir;

  if (options.wasmPaths !== undefined) {
    env.backends.onnx.wasm.wasmPaths = options.wasmPaths;
  }
  if (options.numThreads !== undefined) {
    env.backends.onnx.wasm.numThreads = options.numThreads;
  }
  if (options.localModelPath !== undefined) {
    env.localModelPath = options.localModelPath;
    env.allowLocalModels = true;
    // The hard guarantee: with this false, transformers.js never issues a
    // network request. A missing file becomes an error rather than a silent
    // download, which is what makes "no network on first load" verifiable
    // rather than merely intended.
    env.allowRemoteModels = false;
  }

  const extractor = await pipeline('feature-extraction', EMBEDDING_MODEL, {
    quantized: options.quantized ?? true,
  });

  // The feature-extraction pipeline tokenizes with `{ padding: true,
  // truncation: true }` and takes its limit from the tokenizer, which defaults
  // to the model's 512. Lowering it here caps the padded width of every batch.
  extractor.tokenizer.model_max_length = EMBEDDING_MAX_TOKENS;

  // Fail at init, not at query time. Every downstream assumption — the 0.97
  // duplicate threshold, the measured 0.194/0.021 topic separation, every
  // stride into the flat matrix — is arithmetic on EMBEDDING_DIM. A model
  // swapped for one with a different hidden size would not error anywhere; it
  // would silently produce misaligned vectors and plausible-looking garbage
  // clusters, and the only symptom would be that results got worse.
  const probe = await extractor(['dimension probe'], { pooling: 'mean', normalize: true });
  const probeData = probe.data as Float32Array;
  if (probeData.length !== EMBEDDING_DIM) {
    throw new Error(
      `embedding dimension mismatch: ${EMBEDDING_MODEL} produced ${probeData.length} dimensions, ` +
        `but EMBEDDING_DIM is ${EMBEDDING_DIM}. Every threshold and stride in src/lib assumes ` +
        `${EMBEDDING_DIM}. Either the wrong model is bundled, or EMBEDDING_DIM in src/lib/vectors.ts ` +
        `is stale — do not proceed until they agree.`
    );
  }

  return {
    async embed(texts: string[], onProgress?: ProgressFn): Promise<Float32Array> {
      const matrix = new Float32Array(texts.length * EMBEDDING_DIM);
      let done = 0;

      for (let offset = 0; offset < texts.length; offset += EMBEDDING_BATCH_SIZE) {
        const batch = texts.slice(offset, offset + EMBEDDING_BATCH_SIZE);
        const output = await extractor(batch, { pooling: 'mean', normalize: true });
        const data = output.data as Float32Array;

        // O(1), and it closes the one gap the init probe leaves: `subarray`
        // truncates silently, so a short batch would misalign every vector
        // after it rather than raising anything.
        const expected = batch.length * EMBEDDING_DIM;
        if (data.length !== expected) {
          throw new Error(
            `embedding batch shape mismatch: ${batch.length} texts should give ${expected} floats ` +
              `(${EMBEDDING_DIM} each), got ${data.length}`
          );
        }
        matrix.set(data, offset * EMBEDDING_DIM);

        done += batch.length;
        onProgress?.(done, texts.length);
      }

      return matrix;
    },
  };
}
