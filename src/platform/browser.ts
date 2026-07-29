/**
 * Every browser-specific API call in the extension goes through this file
 * (CLAUDE.md §2.6). A Firefox port replaces this module and nothing else.
 *
 * Nothing here contains product logic — it is a naming and shape adapter over
 * `chrome.*`, chosen so the seam already exists before there is anything to
 * port.
 */

import { REPLY_GUARDS } from './messages.js';
import type { Context, Message, ReplyFor, Response } from './messages.js';

const OFFSCREEN_PATH = 'offscreen.html';
const DASHBOARD_PATH = 'dashboard.html';

/** Resolves a packaged file to its extension:// URL. */
export function resourceUrl(path: string): string {
  return chrome.runtime.getURL(path);
}

/**
 * Chrome allows exactly one offscreen document per extension, and the service
 * worker is torn down after ~30s idle (§3) — so this runs again on every wake
 * and must be safe to call repeatedly. The in-flight promise is cached because
 * two concurrent callers would otherwise race into a duplicate-creation error.
 */
let creating: Promise<void> | null = null;

export async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;

  if (creating === null) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        // transformers.js runs inference in workers; WORKERS is the closest
        // reason Chrome offers. Revisit if the runtime changes.
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Runs on-device embedding inference off the main thread.',
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

export async function closeOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
}

/** Focuses the dashboard tab if one is already open, rather than stacking tabs. */
export async function openDashboard(): Promise<void> {
  const url = resourceUrl(DASHBOARD_PATH);
  const [existing] = await chrome.tabs.query({ url });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}

/**
 * Send a message and wait for a reply.
 *
 * Returns `ReplyFor<M> | null` — the correct reply type for the request, or
 * null. Null covers all three ordinary failures: nothing listening, the worker
 * dying mid-flight, and a reply that does not match the expected shape. Call
 * sites cannot skip the check, because the type is nullable and there is no
 * cast available to make it otherwise.
 *
 * The shape check matters most during version skew: a rebuilt page talking to
 * a service worker that has not reloaded yet gets a reply from the *previous*
 * message contract. Trusting it crashes the caller at whatever field moved.
 */
export async function sendMessage<M extends Message>(message: M): Promise<ReplyFor<M> | null> {
  let raw: unknown;
  try {
    raw = await chrome.runtime.sendMessage(message);
  } catch {
    return null; // no receiver, or the port closed before replying
  }

  if (raw === undefined || raw === null) return null;

  if (!REPLY_GUARDS[message.type](raw)) {
    const reason =
      isRecord(raw) && raw['ok'] === false && typeof raw['error'] === 'string'
        ? `handler error: ${raw['error']}`
        : 'shape did not match — most likely a stale service worker, reload the extension';
    console.warn(`[platform] discarded reply to ${message.type}: ${reason}`, raw);
    return null;
  }

  // Guarded immediately above; this is the one place the untyped wire is
  // narrowed, which is why it is the only assertion in the codebase.
  return raw as ReplyFor<M>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Register a message handler for one context.
 *
 * The `self` filter is applied here rather than left to each listener.
 * `chrome.runtime.sendMessage` delivers to every context in the extension, so
 * an unfiltered listener answers messages meant for someone else — and since
 * only the first `sendResponse` wins, the caller silently gets the wrong
 * reply. Centralising it means a new listener cannot reintroduce that.
 *
 * Returning a promise from `handler` keeps the response channel open, which is
 * the other easy mistake in this API: the listener must return literal `true`.
 */
export function onMessage(
  self: Context,
  handler: (message: Message) => Promise<Response> | Response | undefined
): void {
  chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
    if (message?.target !== self) return false; // not addressed to us
    const result = handler(message);
    if (result === undefined) return false;
    if (result instanceof Promise) {
      result.then(sendResponse).catch((error: unknown) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
      return true; // keep the channel open for the async reply
    }
    sendResponse(result);
    return false;
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function onInstalled(handler: () => void): void {
  chrome.runtime.onInstalled.addListener(handler);
}

export function onStartup(handler: () => void): void {
  chrome.runtime.onStartup.addListener(handler);
}

export function onActionClicked(handler: () => void): void {
  chrome.action.onClicked.addListener(handler);
}
