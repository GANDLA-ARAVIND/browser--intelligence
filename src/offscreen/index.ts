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
import { buildSessions } from '../lib/sessions.js';
import { getAllPages, openDatabase, replaceSessions, toSessionPages } from '../lib/storage.js';
import { drainQueue } from './drain.js';
import { invalidateSearchIndex, search } from './searchIndex.js';
import { onMessage, resourceUrl } from '../platform/browser.js';
import type { Message, Response } from '../platform/messages.js';

const loadedAt = Date.now();

/**
 * Rebuilds every session from stored page timestamps and replaces the store.
 *
 * Full recompute rather than incremental, for the same reason §5 gives for
 * clustering: it is cheap at this scale and incremental variants are a bug
 * factory. It also makes deletion correct for free — a page removed by §9's
 * retroactive delete simply stops appearing in any session.
 */
async function rebuildSessions(): Promise<number> {
  const db = await openDatabase();
  const pages = await getAllPages(db);
  const sessions = buildSessions(toSessionPages(pages));
  await replaceSessions(db, sessions);
  console.log(`[offscreen] rebuilt ${sessions.length} sessions from ${pages.length} pages`);
  return sessions.length;
}

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

function handle(message: Message): Promise<Response> | Response | undefined {
  switch (message.type) {
    case 'PING':
      console.log(`[offscreen] ping from ${message.from}`);
      return { ok: true, from: 'offscreen', at: Date.now() };

    case 'GET_BACKFILL_PROGRESS':
      return { ok: true, progress };

    case 'DRAIN_QUEUE':
      return drainQueue()
        .then((result) => ({ ok: true as const, ...result }))
        .catch((error: unknown) => ({
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        }));

    case 'SEARCH':
      return search(message.query, message.limit).catch((error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }));

    case 'INVALIDATE_SEARCH':
      invalidateSearchIndex();
      return { ok: true, accepted: true };

    // §3 keeps whole-corpus passes out of the dashboard. Sessions are a sort
    // plus a linear scan — far cheaper than clustering — but it is still a
    // pass over every page, so it belongs on this side of the boundary.
    case 'REBUILD_SESSIONS':
      return rebuildSessions()
        .then((count) => ({ ok: true as const, accepted: true, reason: `${count} sessions` }))
        .catch((error: unknown) => ({
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        }));

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
          // The index is a snapshot; new pages mean it is stale.
          invalidateSearchIndex();
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
