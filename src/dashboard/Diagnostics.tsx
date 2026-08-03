import { BackfillDiagnostics } from './Backfill.js';
import { CaptureHealth } from './CaptureHealth.js';
import { Captures } from './Captures.js';
import { SkeletonWiring } from './SkeletonWiring.js';
import { WhatWasDropped } from './WhatWasDropped.js';

/**
 * Everything that used to sit between the user and Search: wiring probes,
 * per-stage timings, main-thread stalls, the capture-quality inspector, and
 * the filter drop audit. All still useful, none of it what someone opens a
 * search tool to look at — collapsed by default, one click away, nothing
 * deleted (per the restructure request).
 *
 * A native `<details>` rather than React state: no controller needed, and its
 * open/closed state persists across re-renders of its parent for free.
 */
export function Diagnostics(): React.JSX.Element {
  return (
    <details className="diagnostics">
      <summary>Diagnostics</summary>
      <div className="diagnostics-body">
        <SkeletonWiring />
        <CaptureHealth />
        <section className="panel">
          <h2>Backfill timings</h2>
          <BackfillDiagnostics />
        </section>
        <Captures />
        <WhatWasDropped />
      </div>
    </details>
  );
}
