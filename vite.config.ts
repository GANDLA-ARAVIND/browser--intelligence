import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

export default defineConfig({
  root,
  plugins: [react(), copyManifest()],
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
