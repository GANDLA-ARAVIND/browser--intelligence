/**
 * Browser-safe ingest pipeline, shared by the Phase 0 CLI and the extension.
 *
 * Nothing under src/lib may import `node:*`, `fs`, or `process` — it all has to
 * run unchanged inside the offscreen document (CLAUDE.md §3). File IO, argument
 * parsing and reporting stay in the caller.
 */

export * from './types.js';
export * from './url.js';
export * from './junk.js';
export * from './titles.js';
export * from './filter.js';
export * from './vectors.js';
export * from './embeddings.js';
export * from './dedupe.js';
export * from './clustering.js';
