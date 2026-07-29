import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));
const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * The manifest stays at the project root, where a reviewer looks for it, and is
 * copied into dist at build time. Using Vite's `public/` would work too but
 * buries the most important file in the project.
 */
function copyManifest(): Plugin {
  return {
    name: 'copy-manifest',
    apply: 'build',
    closeBundle() {
      copyFileSync(at('manifest.json'), at('dist/manifest.json'));
      this.info?.('manifest.json → dist/');
    },
  };
}

/**
 * onnxruntime-web fetches its `.wasm` runtime from a CDN by default. MV3
 * forbids remotely hosted code, so the runtime ships inside the package and
 * `env.backends.onnx.wasm.wasmPaths` is pointed at it at load time.
 */
function copyOnnxRuntime(): Plugin {
  return {
    name: 'copy-onnx-runtime',
    apply: 'build',
    closeBundle() {
      const from = at('node_modules/onnxruntime-web/dist');
      const to = at('dist/ort');
      rmSync(to, { recursive: true, force: true });
      mkdirSync(to, { recursive: true });
      // Only the single-threaded builds. `numThreads: 1` means the `-threaded`
      // variants are never loaded, and they are ~19MB of the package.
      let copied = 0;
      let bytes = 0;
      for (const file of readdirSync(from)) {
        if (!file.endsWith('.wasm') || file.includes('threaded')) continue;
        copyFileSync(join(from, file), join(to, file));
        bytes += statSync(join(from, file)).size;
        copied++;
      }
      this.info?.(`onnxruntime wasm → dist/ort/ (${copied} files, ${(bytes / 1e6).toFixed(1)} MB)`);
    },
  };
}

/**
 * Bundles the MiniLM weights into the package. The extension therefore makes
 * no network request on first load — no host permission, no second scary line
 * in the install prompt, and "nothing leaves your machine" stays literally true.
 *
 * Only the quantized build ships; the fp32 copy in .models exists solely for
 * the sanity harness's pooling comparison.
 */
const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

function copyModel(): Plugin {
  return {
    name: 'copy-model',
    apply: 'build',
    closeBundle() {
      const from = at(`.models/${MODEL_ID}`);
      const to = at(`dist/models/${MODEL_ID}`);
      let bytes = 0;

      for (const file of MODEL_FILES) {
        const source = join(from, file);
        if (!existsSync(source)) {
          this.error(
            `missing model file ${file}\n` +
              `  The extension bundles its weights rather than downloading them.\n` +
              `  Run: npm run fetch-model`
          );
        }
        mkdirSync(join(to, file, '..'), { recursive: true });
        copyFileSync(source, join(to, file));
        bytes += statSync(source).size;
      }
      this.info?.(`${MODEL_ID} → dist/models/ (${(bytes / 1e6).toFixed(1)} MB)`);
    },
  };
}

export default defineConfig({
  root,
  plugins: [react(), copyManifest(), copyOnnxRuntime(), copyModel()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Chrome shows minified extension source in devtools; sourcemaps make the
    // service worker debuggable at chrome://extensions.
    sourcemap: true,
    target: 'chrome116',
    rollupOptions: {
      input: {
        dashboard: at('dashboard.html'),
        offscreen: at('offscreen.html'),
        background: at('src/background/index.ts'),
      },
      output: {
        // The manifest names background.js literally, so entry filenames must
        // be stable and unhashed.
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
