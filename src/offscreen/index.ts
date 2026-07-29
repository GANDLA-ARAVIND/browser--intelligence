/**
 * Offscreen document — the inference host (CLAUDE.md §3).
 *
 * This page has a DOM, outlives the service worker, and is the only context
 * where blocking for a minute is acceptable. So it owns the whole heavy half of
 * the backfill: filter, embed, collapse, write.
 *
 * It announces nothing at load and holds progress in module scope. The service
 * worker asks when someone wants to know (§14) — a push would land in whichever
 * worker instance happened to be alive, which is usually the wrong one.
 */

import { idleProgress, runBackfill, type BackfillProgress } from '../lib/backfill.js';
import { onMessage, resourceUrl } from '../platform/browser.js';
import type { Message, Response } from '../platform/messages.js';

const loadedAt = Date.now();

let progress: BackfillProgress = idleProgress();
let running = false;

function setStatusLine(): void {
  const status = document.querySelector('#status');
  if (status === null) return;
  status.textContent =
    progress.stage === 'idle'
      ? `loaded at ${new Date(loadedAt).toISOString()}`
      : `${progress.stage} — ${progress.done}/${progress.total} — ${progress.detail}`;
}

function handle(message: Message): Response | undefined {
  switch (message.type) {
    case 'PING':
      console.log(`[offscreen] ping from ${message.from}`);
      return { ok: true, from: 'offscreen', at: Date.now() };

    case 'GET_BACKFILL_PROGRESS':
      return { ok: true, progress };

    case 'RUN_BACKFILL': {
      if (running) return { ok: true, accepted: false, reason: 'a backfill is already running' };
      running = true;

      // Acknowledge now, work later. The caller is a service worker that may be
      // torn down long before this finishes, so the reply cannot wait on it.
      void runBackfill({
        visits: message.visits,
        onProgress: (next) => {
          progress = next;
          setStatusLine();
        },
        blockedCategories: message.blockedCategories,
        embedder: {
          // MV3 forbids remote code, so ORT's runtime is served from the
          // package; a single thread avoids SharedArrayBuffer and blob workers,
          // which the extension CSP also blocks.
          wasmPaths: resourceUrl('ort/'),
          numThreads: 1,
          // Weights ship in the package. This also switches transformers.js to
          // local-only, so no network request is possible.
          localModelPath: resourceUrl('models/'),
        },
      })
        .then((summary) => {
          console.log('[offscreen] backfill complete', summary);
        })
        .catch((error: unknown) => {
          console.error('[offscreen] backfill failed', error);
        })
        .finally(() => {
          running = false;
        });

      return { ok: true, accepted: true };
    }

    default:
      return undefined;
  }
}

onMessage('offscreen', handle);
setStatusLine();

console.log('[offscreen] loaded and listening');
