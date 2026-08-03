/**
 * Browser-safe ingest pipeline, shared by the Phase 0 CLI and the extension.
 *
 * Nothing under src/lib may import `node:*`, `fs`, or `process` — it all has to
 * run unchanged inside the offscreen document (CLAUDE.md §3). File IO, argument
 * parsing and reporting stay in the caller.
 */

export * from './types.js';
export * from './chunk.js';
export * from './url.js';
export * from './junk.js';
export * from './titles.js';
export * from './filter.js';
export * from './vectors.js';
export * from './embeddings.js';
export * from './dedupe.js';
export * from './clustering.js';
export * from './labels.js';
export * from './blocklist.js';
export * from './format.js';

// NOT re-exported: ./storage.js and ./backfill.js.
//
// Everything above is isomorphic — it runs in Node (the Phase 0 CLI) and in the
// browser (the extension). Those two need IndexedDB, so they are browser-only,
// and re-exporting them here would drag DOM globals into the Node typecheck and
// let scripts/ import something that cannot run there. Extension code imports
// them by path.
