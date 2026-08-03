import { useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ClusterRecord, PageRecord } from '../lib/storage.js';

/**
 * §12: "the most visually impressive thing in the build." Recharts is the
 * dependency this step earns — the per-card sparklines on the grid below stay
 * hand-rolled SVG because a single topic's own shape does not need a charting
 * library, but comparing 8+ topics on one shared weekly axis, stacked, with a
 * legend and a tooltip, is exactly what one is for.
 */
const TOP_TOPICS = 8;
const OTHER_KEY = 'other';

/** A fixed qualitative palette, sized to `TOP_TOPICS` so no hue repeats
 *  across the bands that actually get their own colour. "Other" always uses
 *  `var(--muted)` instead — it is an overflow bucket, not a topic, and
 *  should never compete visually with a real one. */
const PALETTE = ['#4C6EF5', '#12B886', '#F59F00', '#E64980', '#7048E8', '#15AABF', '#FA5252', '#82C91E'];

function startOfWeek(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const daysSinceMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - daysSinceMonday);
  return d.getTime();
}

function formatWeek(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface Series {
  key: string;
  label: string;
  color: string;
}

/**
 * Builds one row per week, one column per series. Two population decisions,
 * both deliberate:
 *
 *  - Only **labelled** clusters can hold their own band (§14: a cluster never
 *    displays a name it did not derive, and a legend has no room for an
 *    unlabelled cluster's fallback of three titles anyway) — unlabelled
 *    clusters fold into "Other" regardless of size.
 *  - Pages with no `clusterId` at all (§5's discovery queue — never
 *    clustered, not a small topic) are **excluded entirely**, not folded into
 *    "Other". "Other" means "a real topic that didn't make the top N"; a page
 *    with no topic at all is a different fact, and blending the two would
 *    make "Other" answer two different questions at once.
 */
function buildWeeklyData(
  clusters: ClusterRecord[],
  pages: PageRecord[]
): { data: Array<Record<string, number | string>>; series: Series[] } {
  const pagesByCluster = new Map<string, PageRecord[]>();
  for (const page of pages) {
    if (page.clusterId === undefined) continue;
    const list = pagesByCluster.get(page.clusterId);
    if (list === undefined) pagesByCluster.set(page.clusterId, [page]);
    else list.push(page);
  }

  const labelledSized = clusters
    .filter((c): c is ClusterRecord & { label: string } => c.label !== null)
    .map((cluster) => ({ cluster, count: pagesByCluster.get(cluster.id)?.length ?? 0 }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);

  const top = labelledSized.slice(0, TOP_TOPICS);
  const topIds = new Set(top.map((entry) => entry.cluster.id));

  const weekTotals = new Map<number, Map<string, number>>();
  let otherCount = 0;
  for (const page of pages) {
    if (page.clusterId === undefined) continue; // no topic at all — excluded, not "Other"
    const seriesKey = topIds.has(page.clusterId) ? page.clusterId : OTHER_KEY;
    if (seriesKey === OTHER_KEY) otherCount++;
    const week = startOfWeek(page.lastVisit);
    let bucket = weekTotals.get(week);
    if (bucket === undefined) {
      bucket = new Map();
      weekTotals.set(week, bucket);
    }
    bucket.set(seriesKey, (bucket.get(seriesKey) ?? 0) + 1);
  }

  const series: Series[] = top.map((entry, index) => ({
    key: entry.cluster.id,
    label: entry.cluster.label,
    color: PALETTE[index % PALETTE.length]!,
  }));
  // Only a real fact about the data, not a fixture of the top-N mechanism: a
  // corpus with `TOP_TOPICS` or fewer named topics and no unlabelled overflow
  // has nothing to put in "Other", and a legend swatch for a band that is
  // zero in every week would claim a category exists that does not.
  if (otherCount > 0) series.push({ key: OTHER_KEY, label: 'Other', color: 'var(--muted)' });

  const weeks = [...weekTotals.keys()].sort((a, b) => a - b);
  const data = weeks.map((week) => {
    const bucket = weekTotals.get(week)!;
    const row: Record<string, number | string> = { week: formatWeek(week) };
    for (const s of series) row[s.key] = bucket.get(s.key) ?? 0;
    return row;
  });

  return { data, series };
}

/**
 * A custom renderer rather than the default legend: Recharts' built-in text
 * colour does not follow this app's light/dark theme variables, and fighting
 * that with `!important` overrides is worse than owning the ~10 lines of
 * markup outright.
 */
const renderLegend: NonNullable<React.ComponentProps<typeof Legend>['content']> = (props) => {
  const payload = props.payload ?? [];
  return (
    <ul className="topics-chart-legend">
      {payload.map((entry, index) => (
        <li key={index}>
          <span className="topics-chart-swatch" style={{ background: entry.color }} />
          {entry.value}
        </li>
      ))}
    </ul>
  );
};

export function TopicsOverTimeChart({
  clusters,
  pages,
}: {
  clusters: ClusterRecord[];
  pages: PageRecord[];
}): React.JSX.Element | null {
  const { data, series } = useMemo(() => buildWeeklyData(clusters, pages), [clusters, pages]);

  // Nothing clustered yet — the grid's own empty state already covers this
  // message, so the chart just stays absent rather than rendering an empty axis.
  if (data.length === 0) return null;

  return (
    <div className="topics-chart">
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="week"
            tick={{ fill: 'var(--muted)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--line)' }}
            tickLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fill: 'var(--muted)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--line)' }}
            tickLine={false}
            label={{ value: 'Pages', angle: -90, position: 'insideLeft', fill: 'var(--muted)', fontSize: 12 }}
          />
          <Tooltip
            contentStyle={{
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: '0.8125rem',
            }}
            labelStyle={{ color: 'var(--fg)', fontWeight: 600 }}
            itemStyle={{ color: 'var(--fg)' }}
          />
          <Legend content={renderLegend} />
          {series.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stackId="topics"
              stroke={s.color}
              fill={s.color}
              fillOpacity={0.85}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      <p className="detail topics-chart-caption">
        Pages per week, by topic — top {TOP_TOPICS} by page count, everything else grouped as "Other".
        Backfilled pages carry only their <em>last</em> visit (§15), so a page read across several weeks
        appears as a single point in its most recent week, not spread across the weeks it was actually
        read — this is a last-touch timeline, not a reading timeline.
      </p>
    </div>
  );
}
