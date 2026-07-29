/**
 * Downloads the MiniLM weights into ./.models so the build can bundle them.
 *
 * This is a *build-time* download, run once by the developer. The shipped
 * extension performs no network requests at all — which is the point: a
 * runtime fetch would contradict "nothing leaves your machine" and would need
 * a host permission sitting next to "read your browsing history".
 *
 *   npm run fetch-model
 */

import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const BASE = `https://huggingface.co/${MODEL}/resolve/main`;
const OUT = fileURLToPath(new URL('../.models', import.meta.url));

/** Exactly what transformers.js needs for a quantized feature-extraction run. */
const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];

console.log(`\n  fetching ${MODEL} into .models/\n`);

let total = 0;
for (const file of FILES) {
  const target = join(OUT, MODEL, file);
  if (existsSync(target)) {
    const size = statSync(target).size;
    total += size;
    console.log(`  cached   ${file.padEnd(28)} ${(size / 1e6).toFixed(2)} MB`);
    continue;
  }

  mkdirSync(dirname(target), { recursive: true });
  const response = await fetch(`${BASE}/${file}`);
  if (!response.ok || response.body === null) {
    console.error(`\n  error: ${file} → HTTP ${response.status}\n`);
    process.exit(1);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));

  const size = statSync(target).size;
  total += size;
  console.log(`  fetched  ${file.padEnd(28)} ${(size / 1e6).toFixed(2)} MB`);
}

console.log(`\n  ${(total / 1e6).toFixed(2)} MB total — run \`npm run build\` to bundle it\n`);
