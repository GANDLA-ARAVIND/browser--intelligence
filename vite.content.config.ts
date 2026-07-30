import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Separate build for the content script.
 *
 * MV3 content scripts are not ES modules — Chrome loads them as classic
 * scripts, so an `import` statement is a syntax error at injection time. The
 * main build emits ESM with shared chunks, which is right for the extension
 * pages and wrong here, and Rollup cannot mix output formats within one build.
 *
 * So this config emits a single self-contained IIFE. It duplicates whatever it
 * shares with src/lib into that bundle, which is the cost of the format.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    // The main build owns dist/; this one only adds to it.
    emptyOutDir: false,
    sourcemap: true,
    target: 'chrome116',
    lib: {
      entry: at('src/content/index.ts'),
      formats: ['iife'],
      name: 'BrowserIntelligenceContent',
      fileName: () => 'content.js',
    },
    rollupOptions: {
      output: {
        // A content script shares the page's global scope. Nothing may leak.
        extend: false,
        inlineDynamicImports: true,
      },
    },
  },
});
