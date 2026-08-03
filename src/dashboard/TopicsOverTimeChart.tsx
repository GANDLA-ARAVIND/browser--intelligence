import { useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ClusterRecord, PageRecord } from '../lib/storage.js';

/**
 * §12: "the most visually impressive thing in the build." Recharts is the
 * dependency this step earns — the per-card sparklines on the grid below stay
 * hand-rolled SVG because a single topic's own shape does not need a charting
 * library, but comparing 8+ topics on one shared weekly axis, stacked, with a
 * legend and a tooltip, is exactly what one is for.
 *
 * **"Other" is not drawn.** An earlier version stacked it in as a ninth band
 * and the real corpus broke it immediately: 92 of 100 clusters fold into
 * "Other," so its page volume dwarfed the eight named ones and compressed
 * them into a strip at the bottom of the chart — the one thing this chart
 * exists to show (which topics rose and fell) became the hardest thing to
 * see in it. Two fixes were tried and rejected before this one (DECISIONS.md
 * has the full comparison): raising the cap to 15 moved the needle from
 * ~8–13% of chart height to ~10–17%, not a fix, because almost any fixed N
 * leaves a long tail dominant; drawing "Other" as an unstacked outline
 * instead of a filled band didn't help either, because it still shares the
 * Y-axis with everything else — the axis has to stretch to fit *its* raw
 * value regardless of whether it is filled or stroked, so the named bands
 * end up exactly as compressed as before. The domination is an axis-domain
 * problem, not a fill-style problem, so the fix drops "Other" from the axis
 * domain entirely rather than restyling it. The caption below states its
 * total as a number instead.
 */
const TOP_TOPICS = 8;

/**
 * The dataviz skill's validated default categorical palette (`palette.md`),
 * referenced through the CSS custom properties defined in `index.css` rather
 * than hardcoded here — `--series-1`..`--series-8` swap their hex per
 * `prefers-color-scheme` the same way every other token in this file does.
 * An earlier version hand-picked eight hex values and never ran them through
 * `validate_palette.js`; they failed the lightness-band check outright and
 * warned on contrast for half the set. This order clears every adjacent CVD
 * and normal-vision gate in both light and dark.
 */
const SERIES_VARS = [
  '--series-1',
  '--series-2',
  '--series-3',
  '--series-4',
  '--series-5',
  '--series-6',
  '--series-7',
  '--series-8',
];

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

interface WeeklyChartData {
  data: Array<Record<string, number | string>>;
  series: Series[];
  /** Clustered pages outside the top `TOP_TOPICS` — smaller named topics and
   *  every unlabelled cluster. Stated in the caption as a number; never drawn
   *  (see the module comment above for why). */
  excludedPages: number;
  excludedPct: number;
}

/**
 * Builds one row per week, one column per series — the top `TOP_TOPICS`
 * labelled clusters by total page count, and nothing else. Two population
 * rules carried over from the first version, still load-bearing:
 *
 *  - Only **labelled** clusters can ever hold a band (§14: a cluster never
 *    displays a name it did not derive) — an unlabelled cluster is excluded
 *    the same as any smaller labelled one, never given a fallback name here.
 *  - Pages with no `clusterId` at all (§5's discovery queue — never
 *    clustered) are excluded from `excludedPages` too, not folded in: that
 *    figure means "a real topic that didn't make the top N," and a page with
 *    no topic at all is a different fact.
 */
function buildWeeklyData(clusters: ClusterRecord[], pages: PageRecord[]): WeeklyChartData {
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
  let totalClustered = 0;
  let excludedPages = 0;
  for (const page of pages) {
    if (page.clusterId === undefined) continue; // no topic at all — not counted either way
    totalClustered++;
    if (!topIds.has(page.clusterId)) {
      excludedPages++;
      continue; // not drawn — see the module comment for why
    }
    const week = startOfWeek(page.lastVisit);
    let bucket = weekTotals.get(week);
    if (bucket === undefined) {
      bucket = new Map();
      weekTotals.set(week, bucket);
    }
    bucket.set(page.clusterId, (bucket.get(page.clusterId) ?? 0) + 1);
  }

  const series: Series[] = top.map((entry, index) => ({
    key: entry.cluster.id,
    label: entry.cluster.label,
    color: `var(${SERIES_VARS[index % SERIES_VARS.length]!})`,
  }));

  const weeks = [...weekTotals.keys()].sort((a, b) => a - b);
  const data = weeks.map((week) => {
    const bucket = weekTotals.get(week)!;
    const row: Record<string, number | string> = { week: formatWeek(week) };
    for (const s of series) row[s.key] = bucket.get(s.key) ?? 0;
    return row;
  });

  return {
    data,
    series,
    excludedPages,
    excludedPct: totalClustered > 0 ? (excludedPages / totalClustered) * 100 : 0,
  };
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
  const { data, series, excludedPages, excludedPct } = useMemo(() => buildWeeklyData(clusters, pages), [clusters, pages]);

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
        Pages per week, for your top {Math.min(TOP_TOPICS, series.length)} topics by page count.
        {excludedPages > 0 && (
          <>
            {' '}
            A further <strong>{excludedPages.toLocaleString()} pages</strong> ({excludedPct.toFixed(0)}% of
            clustered browsing) sit in smaller or unlabelled topics and aren't drawn here — see the cards
            below for those.
          </>
        )}{' '}
        Backfilled pages carry only their <em>last</em> visit (§15), so a page read across several weeks
        appears as a single point in its most recent week, not spread across the weeks it was actually
        read — this is a last-touch timeline, not a reading timeline.
      </p>
    </div>
  );
}
