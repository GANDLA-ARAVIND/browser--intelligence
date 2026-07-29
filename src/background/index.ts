/**
 * Service worker — routing stub only (CLAUDE.md §3).
 *
 * No alarms, no job queue, no capture. Those arrive in later phases. This
 * exists to prove the four contexts can find each other.
 *
 * The worker is torn down after ~30s idle and restarted on demand, so it holds
 * **no state about other contexts**. An earlier version cached an
 * "offscreen ready" flag set by an announcement at offscreen load; the flag
 * died with the worker instance that received it, the offscreen document only
 * announced once, and nothing short of reinstalling could set it true again.
 * Readiness is now measured on demand instead of remembered.
 */

import {
  delay,
  ensureOffscreenDocument,
  onActionClicked,
  onInstalled,
  onMessage,
  onStartup,
  openDashboard,
  sendMessage,
} from '../platform/browser.js';
import type { Message, Response, StatusResponse } from '../platform/messages.js';

const serviceWorkerStartedAt = Date.now();

console.log('[background] service worker started', new Date(serviceWorkerStartedAt).toISOString());

/**
 * Ask the offscreen document whether it is alive, creating it if not.
 *
 * `createDocument` resolves once the page exists, which is earlier than its
 * script registering `onMessage` — so a single ping right after creation can
 * miss. Retrying briefly covers that gap without any shared state.
 */
async function probeOffscreen(): Promise<StatusResponse['offscreen']> {
  await ensureOffscreenDocument();

  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Typed as PongResponse | null. The null check is the only guard needed —
    // sendMessage has already rejected anything that is not a valid pong.
    const reply = await sendMessage({ target: 'offscreen', type: 'PING', from: 'background' });
    if (reply !== null) {
      return { reachable: true, respondedAt: reply.at, attempts: attempt };
    }
    if (attempt < maxAttempts) await delay(100);
  }
  return { reachable: false, respondedAt: null, attempts: maxAttempts };
}

function handle(message: Message): Promise<Response> | Response | undefined {
  switch (message.type) {
    case 'PING':
      console.log(`[background] ping from ${message.from}`);
      return { ok: true, from: 'background', at: Date.now() };

    case 'GET_STATUS':
      return probeOffscreen().then((offscreen) => {
        console.log(`[background] offscreen probe: reachable=${offscreen.reachable} attempts=${offscreen.attempts}`);
        return { ok: true, serviceWorkerStartedAt, offscreen } satisfies StatusResponse;
      });

    default:
      return undefined;
  }
}

onMessage('background', handle);

/** The offscreen document is created lazily by probeOffscreen, but warming it
 *  on wake means the first dashboard query is not the one paying for it. */
async function wake(reason: string): Promise<void> {
  try {
    await ensureOffscreenDocument();
    console.log(`[background] offscreen document ensured (${reason})`);
  } catch (error) {
    console.error(`[background] could not create offscreen document (${reason})`, error);
  }
}

onInstalled(() => {
  console.log('[background] onInstalled');
  void wake('onInstalled');
});

onStartup(() => {
  console.log('[background] onStartup');
  void wake('onStartup');
});

onActionClicked(() => {
  void openDashboard();
});

void wake('worker start');
