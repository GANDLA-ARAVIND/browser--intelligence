import { useCallback, useEffect, useState } from 'react';
import { Backfill } from './Backfill.js';
import { CaptureHealth } from './CaptureHealth.js';
import { Captures } from './Captures.js';
import { DataSettings } from './DataSettings.js';
import { PrivacySettings } from './PrivacySettings.js';
import { RemovePages } from './RemovePages.js';
import { WhatWasDropped } from './WhatWasDropped.js';
import { Search } from './Search.js';
import { sendMessage } from '../platform/browser.js';

type Probe = { label: string; state: 'checking' | 'ok' | 'fail'; detail: string };

const CHECKING: Probe[] = [
  { label: 'service worker', state: 'checking', detail: '…' },
  { label: 'offscreen document', state: 'checking', detail: '…' },
];

/**
 * Placeholder dashboard (CLAUDE.md §11, phase 1 step 1). No search, no
 * timeline, no topics — those are phase 4.
 *
 * It does run the wiring probes, so the phase-1 exit criterion is visible here
 * rather than only in the devtools console. Every check is live: nothing is
 * cached by the worker, so "Re-check" after a 60s idle is a real test of
 * whether the wiring survives the worker being torn down.
 */
export function App(): React.JSX.Element {
  const [probes, setProbes] = useState<Probe[]>(CHECKING);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  const runProbes = useCallback(async () => {
    setProbes(CHECKING);

    // Both replies are `… | null`. Null is an ordinary state — the worker is
    // asleep, was killed mid-request, or answered from an older build — so it
    // renders as a red row, never as an exception.
    const pong = await sendMessage({ target: 'background', type: 'PING', from: 'dashboard' });
    const status = await sendMessage({ target: 'background', type: 'GET_STATUS' });

    const workerProbe: Probe =
      pong === null
        ? { label: 'service worker', state: 'fail', detail: 'no response' }
        : { label: 'service worker', state: 'ok', detail: 'responded to PING' };

    let offscreenProbe: Probe;
    if (status === null) {
      offscreenProbe = { label: 'offscreen document', state: 'fail', detail: 'worker did not respond' };
    } else if (!status.offscreen.reachable) {
      offscreenProbe = {
        label: 'offscreen document',
        state: 'fail',
        detail: `unreachable after ${status.offscreen.attempts} attempts`,
      };
    } else {
      const { attempts } = status.offscreen;
      offscreenProbe = {
        label: 'offscreen document',
        state: 'ok',
        detail: `replied in ${attempts} attempt${attempts === 1 ? '' : 's'}`,
      };
    }

    setProbes([workerProbe, offscreenProbe]);
    setCheckedAt(new Date());
  }, []);

  useEffect(() => {
    void runProbes();
  }, [runProbes]);

  return (
    <main>
      <h1>Browser Intelligence</h1>
      <p className="tagline">
        Your browser remembers where you went. This remembers what you got.
      </p>

      <section className="panel">
        <h2>Skeleton wiring</h2>
        <ul className="probes">
          {probes.map((probe) => (
            <li key={probe.label} data-state={probe.state}>
              <span className="dot" aria-hidden="true" />
              <span className="label">{probe.label}</span>
              <span className="detail">{probe.detail}</span>
            </li>
          ))}
        </ul>
        <div className="actions">
          <button type="button" onClick={() => void runProbes()}>
            Re-check
          </button>
          <span className="detail">
            {checkedAt === null ? '' : `checked ${checkedAt.toLocaleTimeString()}`}
          </span>
        </div>
      </section>

      <Search />

      <CaptureHealth />

      <Captures />

      <Backfill />

      <RemovePages />

      <PrivacySettings />

      <DataSettings />

      <WhatWasDropped />

      <p className="note">
        Phase 2, step 1 — live capture, backfill and bare search. Search, the session timeline and topic
        cards arrive in later phases. Everything runs on this machine; nothing
        is transmitted.
      </p>
    </main>
  );
}
