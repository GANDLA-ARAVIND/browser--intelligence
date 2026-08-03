import { useCallback, useEffect, useState } from 'react';
import { sendMessage } from '../platform/browser.js';

type Probe = { label: string; state: 'checking' | 'ok' | 'fail'; detail: string };

const CHECKING: Probe[] = [
  { label: 'service worker', state: 'checking', detail: '…' },
  { label: 'offscreen document', state: 'checking', detail: '…' },
];

/**
 * Phase 1's wiring probes (CLAUDE.md §11). Moved out of the primary path into
 * Diagnostics — a working extension does not need to prove its four contexts
 * can find each other every time someone wants to search, but the check is
 * still worth keeping: every check is live, so "Re-check" after a 60s idle is
 * a real test of whether the wiring survives the worker being torn down.
 */
export function SkeletonWiring(): React.JSX.Element {
  const [probes, setProbes] = useState<Probe[]>(CHECKING);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  const runProbes = useCallback(async () => {
    setProbes(CHECKING);

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
        <span className="detail">{checkedAt === null ? '' : `checked ${checkedAt.toLocaleTimeString()}`}</span>
      </div>
    </section>
  );
}
