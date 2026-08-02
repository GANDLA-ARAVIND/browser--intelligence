/**
 * History backfill pipeline (CLAUDE.md §10).
 *
 * Browser-safe and side-effect free apart from IndexedDB: it takes raw rows and
 * a progress callback, and reuses the same filter / embed / collapse modules the
 * Phase 0 harness validated. Nothing here is reimplemented.
 *
 * Reading `chrome.history` is *not* done here — that is a browser API and lives
 * behind src/platform (§2.6). This module only receives the rows.
 */

import { DEFAULT_BLOCKED_CATEGORIES, type SensitiveCategory } from './blocklist.js';
import { startBlockingMonitor, type BlockingEvent } from './blocking.js';
import { clusterByMutualKnnChunked } from './clustering.js';
import { collapseNearDuplicatesChunked, DEFAULT_DUPLICATE_THRESHOLD, expandGroups } from './dedupe.js';
import { createEmbedder, EMBEDDING_BATCH_SIZE, EMBEDDING_DIM, type EmbedderOptions } from './embeddings.js';
import { filterHistory, summariseAudit, type FilterAuditSummary } from './filter.js';
import { classifyFormat } from './format.js';
import {
  clearGroups,
  countUnclusteredPages,
  hashId,
  openDatabase,
  putGroups,
  putMeta,
  putPages,
  replaceClusters,
  type BackfillSummary,
  type ClusterRecord,
  type ClusteringSummary,
  type GroupRecord,
  type PageRecord,
} from './storage.js';
import type { Page, RawVisit } from './types.js';

export type BackfillStage =
  | 'idle'
  | 'reading-history'
  | 'filtering'
  | 'loading-model'
  | 'embedding'
  | 'collapsing'
  | 'writing'
  | 'clustering'
  | 'done'
  | 'error';

/**
 * Clustering parameters (§5). Swept on the real mixed corpus and left at the
 * Phase 0 defaults: 91 clusters / 34.3% noise / largest 4.8%.
 *
 * **Do not tune these on noise alone** (§14). `shared=3` at `k=10` improves
 * noise to 22.5% and simultaneously lets one cluster take 47.4% of the graph —
 * the chaining failure the shared-neighbour test exists to prevent.
 */
const CLUSTER_KNN = 10;
const CLUSTER_SHARED = 4;
const CLUSTER_MIN_SIM = 0.2;
const CLUSTER_MIN_SIZE = 5;

export interface BackfillProgress {
  stage: BackfillStage;
  done: number;
  total: number;
  /** Human-readable detail for the current stage. */
  detail: string;
  /** Filled in progressively so the dashboard can stream counts as they land. */
  counts: {
    rawRows: number;
    kept: number;
    blocked: number;
    stored: number;
    uniqueNodes: number;
  };
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export function idleProgress(): BackfillProgress {
  return {
    stage: 'idle',
    done: 0,
    total: 0,
    detail: '',
    counts: { rawRows: 0, kept: 0, blocked: 0, stored: 0, uniqueNodes: 0 },
    startedAt: 0,
    finishedAt: null,
    error: null,
  };
}

export interface BackfillOptions {
  visits: RawVisit[];
  onProgress: (progress: BackfillProgress) => void;
  /** Node only; the extension leaves this unset and uses the browser cache. */
  cacheDir?: string;
  dupThreshold?: number;
  /**
   * Runtime knobs the caller must supply because they are environment-specific
   * — the extension passes an extension:// URL for the ORT wasm directory,
   * which this module has no way to construct.
   */
  embedder?: Pick<EmbedderOptions, 'wasmPaths' | 'numThreads' | 'localModelPath'>;
  /** §9 categories to exclude. Defaults to all of them. */
  blockedCategories?: readonly SensitiveCategory[];
}

/** §4: history gives a title and nothing else — no body text to extract. */
const TITLE_ONLY_TIER = 3;
/** §8 tier 4: no title at all, topic derived from the URL path. */
const PATH_DERIVED_TIER = 4;

export async function runBackfill(options: BackfillOptions): Promise<BackfillSummary> {
  const { visits, onProgress } = options;
  const startedAt = Date.now();
  const stageMs: Record<string, number> = {};
  const progress = idleProgress();
  progress.startedAt = startedAt;
  progress.counts.rawRows = visits.length;

  // Started before any work so WASM init and the collapse loop are both
  // inside the observation window.
  const monitor = startBlockingMonitor();

  const emit = (patch: Partial<BackfillProgress>): void => {
    Object.assign(progress, patch);
    if (patch.stage !== undefined) monitor.setStage(patch.stage);
    onProgress({ ...progress, counts: { ...progress.counts } });
  };

  const time = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    const began = performance.now();
    const result = await fn();
    stageMs[name] = Math.round(performance.now() - began);
    return result;
  };

  try {
    // --- filter -------------------------------------------------------------
    emit({ stage: 'filtering', done: 0, total: visits.length, detail: 'applying privacy and quality filters' });

    const filtered = await time('filter', () =>
      // §9 applies here, unlike in the Phase 0 harness. Which categories is the
      // user's call; the caller passes their settings.
      filterHistory(visits, false, {
        stripSuffixes: true,
        blockedCategories: options.blockedCategories ?? DEFAULT_BLOCKED_CATEGORIES,
      })
    );
    const pages = filtered.pages;

    const auditSummary = summariseAudit(filtered);
    if (!auditSummary.reconciles) {
      console.error(
        `[backfill] filter counts do not reconcile: ${auditSummary.unaccounted} rows dropped with no recorded reason. ` +
          `A filter is removing pages that nothing reports.`
      );
    }
    progress.counts.kept = filtered.stats.kept;
    progress.counts.blocked = filtered.stats.droppedBlocked;
    emit({ detail: `${filtered.stats.kept} pages kept of ${visits.length}` });

    if (pages.length === 0) {
      const summary = finish(startedAt, stageMs, filtered.stats.raw, 0, 0, filtered.stats.droppedBlocked, await monitor.stop(), summariseAudit(filtered));
      emit({ stage: 'done', finishedAt: Date.now(), detail: 'nothing to embed' });
      return summary;
    }

    // --- model --------------------------------------------------------------
    // The weights ship inside the package, so there is nothing to download —
    // but reading 22MB and initialising the WASM runtime still takes a few
    // seconds, and an unlabelled gap there reads as a hang (§10).
    emit({ stage: 'loading-model', done: 0, total: 0, detail: 'loading the embedding model from the extension' });

    const embedder = await time('model', () =>
      createEmbedder({
        ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
        ...options.embedder,
      })
    );

    // --- embed + store ------------------------------------------------------
    // Pages arrive newest-first from the filter (§10), so the most recent
    // browsing lands in IndexedDB first and the dashboard fills from the top.
    const db = await openDatabase();

    emit({ stage: 'embedding', done: 0, total: pages.length, detail: 'embedding titles' });

    const matrix = new Float32Array(pages.length * EMBEDDING_DIM);
    let stored = 0;

    await time('embed', async () => {
      for (let offset = 0; offset < pages.length; offset += EMBEDDING_BATCH_SIZE) {
        const slice = pages.slice(offset, offset + EMBEDDING_BATCH_SIZE);
        const vectors = await embedder.embed(slice.map((page) => page.embedText));
        matrix.set(vectors, offset * EMBEDDING_DIM);

        // One transaction per batch of 32, not per page.
        await putPages(
          db,
          slice.map((page, index) => toRecord(page, vectors.subarray(index * EMBEDDING_DIM, (index + 1) * EMBEDDING_DIM)))
        );

        stored += slice.length;
        progress.counts.stored = stored;
        emit({ done: stored, total: pages.length, detail: `${stored} of ${pages.length} embedded and stored` });
      }
    });

    // --- collapse -----------------------------------------------------------
    emit({ stage: 'collapsing', done: 0, total: pages.length, detail: 'collapsing near-duplicates' });

    // `repMatrix` is kept, not discarded. It is exactly what clustering
    // consumes, and it is already in memory here — which is the whole
    // architectural case for clustering as a backfill stage rather than a
    // separate triggered job that would reload every vector and re-run this
    // 12-second pass to rebuild it.
    const { groups, repMatrix } = await time('collapse', () =>
      collapseNearDuplicatesChunked(matrix, pages, options.dupThreshold ?? DEFAULT_DUPLICATE_THRESHOLD)
    );

    progress.counts.uniqueNodes = groups.length;
    emit({ stage: 'writing', done: 0, total: groups.length, detail: `${groups.length} unique nodes` });

    await time('write-groups', async () => {
      // Groups are derived, so a re-run replaces them wholesale rather than
      // merging — merging is where stale membership would accumulate.
      await clearGroups(db);
      const records: GroupRecord[] = groups.map((group) => ({
        representativeId: idFor(pages[group.representative]!),
        memberIds: group.members.map((index) => idFor(pages[index]!)),
        size: group.members.length,
      }));
      for (let offset = 0; offset < records.length; offset += 200) {
        await putGroups(db, records.slice(offset, offset + 200));
      }
    });

    // --- cluster ------------------------------------------------------------
    // §5/§6: clustering is the primary classification mechanism now that seed
    // labels are only a weak prior, so a fresh install has no topics at all
    // until this runs — which is why it lives here rather than on a trigger
    // (§10 needs a populated screen 60s after install).
    //
    // **Non-fatal by construction.** Backfill's deliverable is an embedded,
    // stored, searchable corpus; that is already complete by this point. A
    // clustering bug must never discard a finished two-minute embed run, so
    // this owns its failure, records it, and leaves `clusterId` unset — which
    // is the same state as "not yet clustered" and is what the §7 trigger and
    // the weekly recompute will retry from.
    emit({ stage: 'clustering', done: 0, total: groups.length, detail: `clustering ${groups.length} nodes` });
    try {
      await time('cluster', async () => {
        const { clusters, noise } = await clusterByMutualKnnChunked(repMatrix, groups.length, {
          k: CLUSTER_KNN,
          sharedMin: CLUSTER_SHARED,
          minSim: CLUSTER_MIN_SIM,
          minClusterSize: CLUSTER_MIN_SIZE,
        });

        const records: ClusterRecord[] = [];
        const pageIdToCluster = new Map<string, string>();
        clusters.forEach((cluster, index) => {
          const id = `c${index}-${hashId(cluster.members.join(','))}`;
          const memberPageIndices = expandGroups(groups, cluster.members);
          for (const pageIndex of memberPageIndices) pageIdToCluster.set(idFor(pages[pageIndex]!), id);
          records.push({
            id,
            memberIds: cluster.members.map((groupIndex) => idFor(pages[groups[groupIndex]!.representative]!)),
            size: memberPageIndices.length,
            centroid: new Float32Array(cluster.centroid),
            label: null, // named by the Phase 3 step 3 LLM pass, never before
            createdAt: Date.now(),
          });
        });

        await replaceClusters(db, records, pageIdToCluster);

        const clusteringSummary: ClusteringSummary = {
          key: 'clustering',
          completedAt: Date.now(),
          nodes: groups.length,
          clusters: records.length,
          unclusteredPages: await countUnclusteredPages(db),
          durationMs: stageMs['cluster'] ?? 0,
        };
        await putMeta(db, clusteringSummary);

        emit({
          stage: 'clustering',
          done: groups.length,
          total: groups.length,
          detail: `${records.length} clusters, ${expandGroups(groups, noise).length} pages unclustered`,
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[backfill] clustering failed; the corpus is still stored and searchable', error);
      await putMeta(db, {
        key: 'clustering',
        completedAt: Date.now(),
        nodes: groups.length,
        clusters: 0,
        unclusteredPages: await countUnclusteredPages(db).catch(() => 0),
        durationMs: 0,
        error: message,
      } satisfies ClusteringSummary);
    }

    const summary = finish(
      startedAt,
      stageMs,
      filtered.stats.raw,
      filtered.stats.kept,
      groups.length,
      filtered.stats.droppedBlocked,
      await monitor.stop(),
      summariseAudit(filtered)
    );
    await putMeta(db, summary);

    emit({ stage: 'done', done: pages.length, total: pages.length, finishedAt: Date.now(), detail: 'backfill complete' });
    return summary;
  } catch (error) {
    void monitor.stop();
    const message = error instanceof Error ? error.message : String(error);
    emit({ stage: 'error', error: message, finishedAt: Date.now(), detail: message });
    throw error;
  }
}

function idFor(page: Page): string {
  return hashId(page.normalizedUrl);
}

function toRecord(page: Page, vector: Float32Array): PageRecord {
  return {
    id: idFor(page),
    url: page.url,
    normalizedUrl: page.normalizedUrl,
    title: page.title,
    text: '', // §10: the history API returns no page content
    vector: new Float32Array(vector), // copy: subarray shares the batch buffer
    vectorSource: 'title',
    format: classifyFormat(page.url),
    topics: [], // populated by cluster promotion in phase 3; seeds never land here (§5, §6)
    // A page whose embedText is not its title was rescued by path extraction,
    // which is tier 4 by definition.
    extractionTier: page.embedText === page.title ? TITLE_ONLY_TIER : PATH_DERIVED_TIER,
    // chrome.history.search reports only lastVisitTime. getVisits() would give
    // the true first visit but costs one call per URL — thousands of them.
    firstVisit: page.lastVisit,
    lastVisit: page.lastVisit,
    visitCount: page.visitCount,
    activeSeconds: 0, // §9: engagement is measured live, never inferred
  };
}

function finish(
  startedAt: number,
  stageMs: Record<string, number>,
  rawRows: number,
  kept: number,
  uniqueNodes: number,
  blocked: number,
  blocking: BlockingEvent[],
  filterAudit: FilterAuditSummary
): BackfillSummary {
  return {
    key: 'backfill',
    completedAt: Date.now(),
    rawRows,
    kept,
    uniqueNodes,
    blocked,
    durationMs: Date.now() - startedAt,
    stageMs,
    blocking,
    filterAudit,
  };
}
