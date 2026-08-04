import { useEffect, useMemo, useState } from 'react';
import { getAllClusters, getAllPages, openDatabase, type ClusterRecord, type PageRecord } from '../lib/storage.js';
import { PageRow } from './PageRow.js';
import { TopicsOverTimeChart } from './TopicsOverTimeChart.js';

/** §14: a cluster never displays a name it did not derive — this many of its
 *  most-visited titles stand in for one that labelling could not name. */
const FALLBACK_TITLE_COUNT = 3;

/** Buckets a topic's own page timestamps are grouped into for its sparkline. */
const SPARKLINE_BUCKETS = 20;

/** How many top-visited pages count as "best resources" in the detail view. */
const BEST_RESOURCES_LIMIT = 10;

interface TopicCard {
  cluster: ClusterRecord;
  /** The pages currently linked to this cluster — see the note in the loader
   *  below on why this, and not `cluster.size` or `cluster.memberIds.length`,
   *  is the number this page treats as ground truth. */
  pages: PageRecord[];
  name: string;
  isFallbackName: boolean;
  lastTouched: number;
  buckets: number[];
}

/** §14: never "Cluster 7", never "Untitled" — the cluster's own most-visited
 *  titles, which can only ever say what is actually there. */
function fallbackName(pages: PageRecord[]): string {
  const byVisits = [...pages].sort((a, b) => b.visitCount - a.visitCount);
  const top = byVisits.slice(0, FALLBACK_TITLE_COUNT).map((page) => page.title || '(untitled)');
  const rest = pages.length - top.length;
  return rest > 0 ? `${top.join(' · ')} +${rest} more` : top.join(' · ');
}

/** Buckets `lastVisit` timestamps across the topic's own range — a per-card
 *  sparkline, not the Phase 4 step 4 topics-over-time chart, which compares
 *  across all topics on one shared timeline and is a separate piece of work. */
function bucketActivity(pages: PageRecord[], bucketCount: number): number[] {
  const buckets = new Array(bucketCount).fill(0) as number[];
  if (pages.length === 0) return buckets;
  const times = pages.map((page) => page.lastVisit);
  const min = Math.min(...times);
  const max = Math.max(...times);
  if (min === max) {
    buckets[bucketCount - 1] = pages.length;
    return buckets;
  }
  const span = max - min;
  for (const t of times) {
    const index = Math.min(bucketCount - 1, Math.floor(((t - min) / span) * bucketCount));
    buckets[index] = (buckets[index] ?? 0) + 1;
  }
  return buckets;
}

/**
 * Phase 4 step 3 (§12): a grid of derived topics, and a detail view per topic.
 * Clusters and their labels already exist from Phase 3 — this is the first
 * thing that reads them.
 *
 * A direct IndexedDB read on mount, same as Search's facet lists and
 * RemovePages' listing — rendering support, not the compute §3 keeps out of
 * the dashboard.
 */
export function TopicsPage(): React.JSX.Element {
  const [raw, setRaw] = useState<{ clusters: ClusterRecord[]; pages: PageRecord[] } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const db = await openDatabase();
        const [clusters, pages] = await Promise.all([getAllClusters(db), getAllPages(db)]);
        setRaw({ clusters, pages });
      } catch {
        setRaw({ clusters: [], pages: [] });
      }
    })();
  }, []);

  // Kept as one derivation from `raw` rather than built inside the fetch
  // effect and discarded: the over-time chart above the grid needs the same
  // clusters/pages, so the raw read happens once and both views share it.
  const cards = useMemo<TopicCard[] | null>(() => {
    if (raw === null) return null;
    const { clusters, pages } = raw;

    // Pages, not nodes — the fifth unit-mixing instance CLAUDE.md §14
    // already records. `clusterId` is stamped on every page a cluster
    // covers once its collapsed representatives are expanded
    // (`replaceClusters` in storage.ts), not just the representatives
    // themselves — those are `memberIds`, one per collapsed near-duplicate
    // group, and displaying *that* count here would be exactly the bug
    // this rule exists to prevent. Grouping on `clusterId` directly also
    // reflects any retroactive deletion since the last clustering run,
    // which `cluster.size` — a snapshot from that run — would not.
    const byCluster = new Map<string, PageRecord[]>();
    for (const page of pages) {
      if (page.clusterId === undefined) continue;
      const list = byCluster.get(page.clusterId);
      if (list === undefined) byCluster.set(page.clusterId, [page]);
      else list.push(page);
    }

    const built: TopicCard[] = [];
    for (const cluster of clusters) {
      const clusterPages = byCluster.get(cluster.id) ?? [];
      // Every page this cluster covered has since been deleted — nothing
      // left to show, and a named card with no content behind it would be
      // its own small dishonesty.
      if (clusterPages.length === 0) continue;
      built.push({
        cluster,
        pages: clusterPages,
        name: cluster.label ?? fallbackName(clusterPages),
        isFallbackName: cluster.label === null,
        lastTouched: Math.max(...clusterPages.map((page) => page.lastVisit)),
        buckets: bucketActivity(clusterPages, SPARKLINE_BUCKETS),
      });
    }

    // §12: page count, descending, by default.
    built.sort((a, b) => b.pages.length - a.pages.length);
    return built;
  }, [raw]);

  const selected = useMemo(() => cards?.find((card) => card.cluster.id === selectedId) ?? null, [cards, selectedId]);

  if (cards === null || raw === null) {
    return (
      <section className="panel placeholder-page">
        <h2>Topics</h2>
        <p className="detail">Loading…</p>
      </section>
    );
  }

  if (selected !== null) {
    return <TopicDetail card={selected} onBack={() => setSelectedId(null)} />;
  }

  if (cards.length === 0) {
    return (
      <section className="panel placeholder-page">
        <h2>Topics</h2>
        <p className="detail">
          No topics yet. Topics are derived entirely from your own browsing (§5, §6) — run a backfill from
          Settings, or wait for the next clustering pass, and they will appear here.
        </p>
      </section>
    );
  }

  return (
    <div className="topics-page">
      <h1>Topics</h1>
      <p className="tagline">
        {cards.length} topic{cards.length === 1 ? '' : 's'}, derived from your own browsing — ranked by page
        count.
      </p>

      <TopicsOverTimeChart clusters={raw.clusters} pages={raw.pages} />

      <ul className="topic-grid">
        {cards.map((card) => (
          <li key={card.cluster.id}>
            <button type="button" className="topic-card" onClick={() => setSelectedId(card.cluster.id)}>
              <span className={`topic-card-name${card.isFallbackName ? ' topic-card-name-fallback' : ''}`}>
                {card.name}
              </span>
              <span className="topic-card-meta">
                <span>{card.pages.length.toLocaleString()} pages</span>
                <span aria-hidden="true">·</span>
                <span>last touched {new Date(card.lastTouched).toLocaleDateString()}</span>
              </span>
              <Sparkline buckets={card.buckets} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Sparkline({ buckets }: { buckets: number[] }): React.JSX.Element {
  const max = Math.max(1, ...buckets);
  const width = 100;
  const height = 26;
  const barWidth = width / buckets.length;
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {buckets.map((count, index) => {
        const barHeight = (count / max) * height;
        return (
          <rect
            key={index}
            x={index * barWidth}
            y={height - barHeight}
            width={Math.max(0, barWidth - 0.6)}
            height={barHeight}
          />
        );
      })}
    </svg>
  );
}

function TopicDetail({ card, onBack }: { card: TopicCard; onBack: () => void }): React.JSX.Element {
  const chronological = useMemo(() => [...card.pages].sort((a, b) => a.lastVisit - b.lastVisit), [card.pages]);

  // §4: return visits are the strongest relevance signal. A page visited
  // once is not a "best resource" by this measure, however good it is.
  const bestResources = useMemo(
    () =>
      [...card.pages]
        .filter((page) => page.visitCount > 1)
        .sort((a, b) => b.visitCount - a.visitCount)
        .slice(0, BEST_RESOURCES_LIMIT),
    [card.pages]
  );

  return (
    <div className="topics-page">
      <button type="button" className="linkish topic-back" onClick={onBack}>
        ← All topics
      </button>

      <h1 className={card.isFallbackName ? 'topic-detail-name-fallback' : undefined}>{card.name}</h1>
      <p className="tagline">
        {card.pages.length.toLocaleString()} pages · last touched {new Date(card.lastTouched).toLocaleDateString()}
      </p>

      {card.isFallbackName && (
        <p className="detail">
          No name was derivable for this cluster (§14) — its most-visited titles are shown above instead of
          an invented one.
        </p>
      )}

      {bestResources.length > 0 && (
        <section className="panel">
          <h2>Best resources</h2>
          <p className="detail settings-intro">
            Ranked by return visits — the strongest relevance signal this app has (§4).
          </p>
          <ol className="results">
            {bestResources.map((page) => (
              <PageRow key={page.id} page={page} showVisitBadge />
            ))}
          </ol>
        </section>
      )}

      <section className="panel">
        <h2>Every page, chronologically</h2>
        <ol className="results">
          {chronological.map((page) => (
            <PageRow key={page.id} page={page} />
          ))}
        </ol>
      </section>
    </div>
  );
}
