/**
 * Offscreen document — the inference host (CLAUDE.md §3).
 *
 * Skeleton only: it loads and answers pings. transformers.js is not wired up
 * yet. This page has a DOM and outlives the service worker, which is why the
 * model will live here rather than in the worker.
 *
 * It deliberately announces nothing at load. It used to send an
 * OFFSCREEN_READY message, but that fires exactly once, into whichever worker
 * instance happened to be alive at the time — and that instance is usually
 * dead by the time anyone asks. Being reachable is the only claim worth
 * making, and answering a ping is how it is made.
 */

import { onMessage } from '../platform/browser.js';
import type { Message, Response } from '../platform/messages.js';

const loadedAt = Date.now();

function handle(message: Message): Response | undefined {
  if (message.type === 'PING') {
    console.log(`[offscreen] ping from ${message.from}`);
    return { ok: true, from: 'offscreen', at: Date.now() };
  }
  return undefined;
}

onMessage('offscreen', handle);

const status = document.querySelector('#status');
if (status !== null) status.textContent = `loaded at ${new Date(loadedAt).toISOString()}`;

console.log('[offscreen] loaded and listening');
