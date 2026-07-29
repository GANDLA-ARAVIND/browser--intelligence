/**
 * The message contract between the four MV3 contexts (CLAUDE.md §3).
 *
 * `chrome.runtime.sendMessage` is a **broadcast**, not a channel: every
 * listener in every context receives every message. A dashboard PING was
 * arriving at both the background and the offscreen document, and whichever
 * replied first won.
 *
 * So `target` is part of every variant rather than an optional field — a
 * message is not constructible without one, and `onMessage` filters on it
 * centrally so no listener has to remember to.
 */

export type Context = 'background' | 'offscreen' | 'dashboard' | 'content';

export type Message =
  | { target: 'background'; type: 'GET_STATUS' }
  | { target: 'background'; type: 'PING'; from: Context }
  | { target: 'offscreen'; type: 'PING'; from: Context };

export interface PongResponse {
  ok: true;
  from: Context;
  at: number;
}

export interface StatusResponse {
  ok: true;
  serviceWorkerStartedAt: number;
  /**
   * Measured on demand, never remembered. The worker is torn down after ~30s
   * idle, so any readiness flag it holds is a lie the moment it sleeps.
   */
  offscreen: {
    reachable: boolean;
    respondedAt: number | null;
    attempts: number;
  };
}

export type ErrorResponse = { ok: false; error: string };

export type Response = PongResponse | StatusResponse | ErrorResponse;

/**
 * Which reply belongs to which request. `sendMessage` uses this to type its
 * return, so no call site needs a cast — and a cast is what turned a benign
 * version skew into a crash: `as StatusResponse` told the compiler to trust a
 * value that had crossed an untyped process boundary.
 */
export interface ReplyMap {
  PING: PongResponse;
  GET_STATUS: StatusResponse;
}

export type ReplyFor<M extends Message> = ReplyMap[M['type']];

// --- runtime validation ------------------------------------------------------
// The wire is untyped. A stale service worker from a previous build answers
// with whatever shape it was compiled with, so replies are checked, not
// assumed.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isPongResponse(value: unknown): value is PongResponse {
  return isRecord(value) && value['ok'] === true && typeof value['from'] === 'string' && typeof value['at'] === 'number';
}

export function isStatusResponse(value: unknown): value is StatusResponse {
  if (!isRecord(value) || value['ok'] !== true) return false;
  if (typeof value['serviceWorkerStartedAt'] !== 'number') return false;
  const offscreen = value['offscreen'];
  return isRecord(offscreen) && typeof offscreen['reachable'] === 'boolean' && typeof offscreen['attempts'] === 'number';
}

export const REPLY_GUARDS: { [K in Message['type']]: (value: unknown) => boolean } = {
  PING: isPongResponse,
  GET_STATUS: isStatusResponse,
};
