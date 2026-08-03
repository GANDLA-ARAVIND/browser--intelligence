/**
 * Phase 4 step 3 (§12): page count, hours, sparkline, trend vs last week, last
 * touched, per topic. Clusters and their derived labels already exist —
 * Phase 3 built the data this view will read — but the cards themselves are
 * not built yet.
 */
export function TopicsPage(): React.JSX.Element {
  return (
    <section className="panel placeholder-page">
      <h2>Topics</h2>
      <p className="detail">
        Not built yet. This will show your derived topics as cards — page count, time spent, a trend
        against last week, and when you last touched each one — ranked by how much you've actually
        browsed, not a hand-picked list.
      </p>
    </section>
  );
}
