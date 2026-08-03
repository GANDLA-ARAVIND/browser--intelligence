/**
 * Phase 4 step 2 (§12): horizontal blocks across the day, each labelled
 * "2:10–3:40pm · Docker networking · 9 pages." Sessions already exist —
 * Phase 3 step 4 built the grouping, labelling and the exact/approximate
 * distinction (§15) — but the timeline itself is not built yet.
 */
export function TodayPage(): React.JSX.Element {
  return (
    <section className="panel placeholder-page">
      <h2>Today</h2>
      <p className="detail">
        Not built yet. This will show today's browsing as a timeline of sessions — what you were doing,
        when, and for how long — updated within a couple of minutes of your last page, never held back
        until midnight.
      </p>
    </section>
  );
}
