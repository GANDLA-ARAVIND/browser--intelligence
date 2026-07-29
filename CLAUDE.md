# Browser Intelligence Platform

A local-first Chrome MV3 extension that turns browsing history into a
searchable personal knowledge base.

**One-line purpose:** your browser remembers where you went; this remembers
what you got.

---

## 0. How to use this file

This is the standing spec. Read it at the start of every session.

- Constraints in §2 are **non-negotiable**. If a task appears to require
  breaking one, stop and say so rather than working around it.
- Build phases in §11 are ordered. Do not start a phase before the previous
  phase's exit criteria are met.
- When a decision is made that isn't captured here, append it to §14
  (Decision Log) in the same commit.

---

## 1. The problem

Browsers store navigation, not comprehension. A user solves a problem across
fourteen tabs, closes them, and three weeks later solves it again from
scratch. Existing history is a list of URLs — unsearchable by meaning,
unorganised, and stripped of everything that made the pages useful.

Two user needs, with very different confidence levels:

| Need | Evidence | Priority |
|---|---|---|
| "Where did I read that?" | Verified, recurs weekly | **Primary — never compromise** |
| "What have I been learning?" | Plausible, unproven retention | Secondary — the demo surface |

**Search is the feature that retains users. Analytics is the feature that
impresses on install.** When they conflict, search wins.

---

## 2. Hard constraints

1. **No backend.** Everything runs client-side. No user data leaves the
   machine. This is the product's differentiator, not an implementation
   detail.
2. **The dashboard is an extension page** (`chrome-extension://<id>/dashboard.html`),
   never a hosted web app.
3. **Embeddings run on-device** via `@xenova/transformers` with
   `Xenova/all-MiniLM-L6-v2` (384-dim, ~23MB, quantized).
4. **Storage is IndexedDB.** No vector database. Brute-force cosine over
   10k documents is ~12ms — see §5 for the arithmetic.
5. **The topic taxonomy is derived from user data**, never hardcoded beyond
   a small universal seed list.
6. **Browser-specific APIs stay behind `src/platform/`** so a Firefox port
   is a few days rather than a refactor.
7. **Never block the user's browsing.** All heavy work is queued and drained
   during idle.

### Explicitly rejected — do not build these

- Productivity scores, skill-level percentages, streaks, user comparisons
- Auto-generated learning paths (v1)
- Any hosted server component (v1)
- A vector database
- An "Analyze" button as the primary path (see §7)

Rationale: invented scores are arbitrary, users detect that immediately, and
the loss of trust contaminates every honest feature next to them. The product
is **descriptive, never evaluative**.

---

## 3. Architecture

Four MV3 contexts, all sharing one origin and therefore one IndexedDB.

| Context | Role | Runs inference? |
|---|---|---|
| `src/content/` | Injected into visited pages. Extracts text via Readability. | No — would freeze the user's page |
| `src/background/` | Service worker. Alarms, job queue, message routing. Dies after ~30s idle. | No — ephemeral, no DOM |
| `src/offscreen/` | Hidden page via `chrome.offscreen`. **Inference host.** Has DOM + WebGPU. | **Yes — the workhorse** |
| `src/dashboard/` | React app in a full tab. | Yes, for on-demand queries |

Because all four share an origin, they communicate through **shared IndexedDB
state**, not an API layer. The offscreen document writes vectors; the
dashboard reads them directly.

```
src/
  content/      Readability extraction, per-site adapters
  background/   service worker: alarms, queue, routing
  offscreen/    transformers.js — embedding + inference
  dashboard/    React dashboard (extension page)
  lib/          embeddings, clustering, storage, similarity, sessions
  platform/     browser shims: getHistory(), runInference(), schedule()
scripts/
  validate.ts   standalone validation harness
```

---

## 4. Data model

```ts
interface PageRecord {
  id: string;              // normalized URL hash
  url: string;
  normalizedUrl: string;   // utm_* and #fragments stripped
  title: string;
  text: string;            // extracted body, capped ~8000 chars
  summary?: string;        // LLM-generated, OPTIONAL — never block on this
  vector: Float32Array;    // 384 dims

  format: Format;          // from domain rules
  topics: string[];        // from zero-shot similarity
  intent?: Intent;         // hybrid: domain + dwell + return count
  extractionTier: 1|2|3|4; // which ladder rung handled it — see §8

  firstVisit: number;
  lastVisit: number;
  visitCount: number;      // return visits = strongest relevance signal
  activeSeconds: number;   // see §9 on what counts
  sessionId?: string;
}

type Format = 'video'|'docs'|'forum'|'article'|'code'|'social'|'shopping'|'other';
type Intent = 'learning'|'debugging'|'job-hunting'|'shopping'|'entertainment'|'reference';

interface Session {
  id: string;
  start: number;
  end: number;
  pageIds: string[];
  label: string;           // LLM-generated, e.g. "Docker networking"
  topics: string[];
  provisional: boolean;    // true while still open
}

interface Topic {
  name: string;
  vector: Float32Array;    // centroid
  tier: 'seed'|'derived';
  pageCount: number;
  createdAt: number;
}
```

**Keep format, topic, and intent as three independent axes.** "YouTube" is not
a category — a Kubernetes talk and a comedy set share a domain and nothing
else.

---

## 5. The pipeline

```
capture → extract → embed → classify → store
                                ↓
                    [weekly] cluster → label → promote to topics
```

**Categorisation requires no LLM.** It is cosine arithmetic against
pre-embedded label vectors. Only *prose summaries* and *cluster naming* need
a language model, and both are optional and batched.

### Zero-shot classification

Embed topic labels once. Every page then cosine-matches against them:

```ts
similarity(pageVec, topics['Docker'])     // → 0.81  ✓ tag it
similarity(pageVec, topics['Networking']) // → 0.67  ✓ tag it
similarity(pageVec, topics['React'])      // → 0.09  ✗
```

Threshold ~0.40. Sub-threshold pages go to the **unclassified pool** — this
is not a failure, it is the discovery queue.

### Clustering

HDBSCAN (or k-means as a fallback) over the unclassified pool, weekly.
`min_cluster_size` of 5–10. Clusters above that get LLM-named from their 8
nearest-centroid titles and are promoted to real topics. Below that, they stay
noise — which is exactly what makes brief anomalous browsing (a sibling
borrowing the laptop) harmless.

Trigger early if the unclassified pool exceeds ~50 items.

**Full recompute weekly. Do not attempt incremental clustering** — it takes
seconds at this scale and incremental variants are a bug factory.

### Why no vector database

10,000 pages × 384 dims × 4 bytes = **~15 MB**. Loads into memory instantly.
A brute-force cosine scan is ~4M multiply-adds — 5–15ms in plain JS with typed
arrays. A vector DB is pure overhead until well past 100k pages, which is
years of browsing.

---

## 6. Taxonomy — two tiers

**Tier 1 — universal seeds (~25 labels, shipped).** programming, health,
finance, travel, cooking, sports, news, education, shopping, entertainment,
design, science, legal, career, etc. Every user has these on day one, so
nothing is ever fully unclassified.

**Tier 2 — derived.** Built from the user's own data via clustering. Docker,
Rust, guitar gear, visa paperwork — whatever they actually browse.

The install-time history backfill (§10) is a **bootstrap, not a definition**.
The taxonomy is never frozen; new interests surface through the unclassified
pool within days.

Critically: **nothing in the pipeline contains domain knowledge.** Extraction
is universal, embeddings were trained on the whole web, clustering is
unsupervised, labels come from reading what's there. A cardiologist, a law
student, and a woodworker each get a working product without anyone having
anticipated them.

---

## 7. Cadence

Separate **when it's computed** from **when it's shown**.

| Layer | When | Work | Cost |
|---|---|---|---|
| Capture | tab close / dwell > 30s | extract, dedupe, store | ~10ms |
| Embed | immediately after capture | MiniLM → 384-dim → IndexedDB | ~50ms |
| Summarise | idle ≥ 5 min, batched | LLM 2-line summary + tags | off critical path |
| Sessions | debounced, ~2 min after last capture | group + label today's sessions | ms |
| Clusters | weekly | full recompute, promote topics | seconds |
| Search | on demand | cosine over all vectors | ~12ms |

30 videos in a day is 30 × 50ms = **1.5 seconds of total compute.** This is not
a batch-processing problem and never was.

**Do not defer today's rollup to midnight.** A user opening the dashboard at
3pm must see this afternoon's sessions, not an empty screen. Sessions still
open are `provisional: true`; a 30-minute activity gap closes one.

Keep a manual **"Re-analyze"** in settings as an escape hatch — never as the
front door.

### Scheduling gotchas

- **`chrome.alarms` do not fire when the browser is closed.** Persist
  `lastDailyRun`; on every service-worker wake, if > 24h has elapsed, run the
  catch-up immediately.
- **Define the day as starting at 04:00, not midnight.** Someone debugging
  until 1:30am considers that the previous day's work.
- **Every job must be idempotent.** Safe to run twice on the same data.
  Recovery should be "run it again," not reconciliation logic.
- Hold the summarise queue when on battery below ~30%.

---

## 8. Extraction ladder

Only extraction is site-specific. Everything after it is universal. Never fail
hard — always fall through.

| Tier | Method | Coverage | Quality |
|---|---|---|---|
| 1 | Custom adapters (YouTube transcript, Reddit, GitHub, Stack Overflow) | ~15% | Best |
| 2 | `@mozilla/readability` | ~70% | Good |
| 3 | Title + `<meta description>` + `og:` tags | ~99% | Adequate |
| 4 | Domain rule only | 100% | Weak but never empty |

Tier 3 is load-bearing: every page has a title, and titles alone embed well
enough to categorise. That is why the history backfill works with no page
content at all.

Write 5–8 adapters maximum, and only for domains that coverage stats show are
**both frequent and failing**. Log `extractionTier` on every record so the
settings screen can report "94% of pages categorized" — that metric tells you
which adapter to write next instead of guessing.

---

## 9. Privacy — build in phase 2, not at the end

This is the first question any technical reviewer asks. It is also what makes
the shared-machine problem tractable.

- **Never capture:** incognito windows, `chrome://`, localhost, and a
  sensitive-category blocklist (banking, health, email, adult, internal
  corporate tools). Exclude *before* extraction — never embed them.
- **Encryption at rest** for stored content.
- **No unencrypted copy of user history may be written outside the project
  directory** — never to `os.tmpdir()`, `%TEMP%`, `/tmp`, or any other shared
  location, which on a multi-user machine is world-readable and outlives the
  process. Any scratch copy goes in the gitignored `./.scratch/` and must be
  swept on **both startup and exit**, including crash and signal paths. This
  applies to tooling and scripts, not just the extension: a debug artifact
  leaks exactly the same data as a shipped feature.
- **Pause toggle** in the toolbar popup: 30 min / 1 hr / until re-enabled.
- **Retroactive removal:** select a time range or session → "this wasn't me"
  → delete and re-cluster. This is the control people actually use, because
  nobody remembers to hit pause.
- **Export** as JSON and Markdown. **Delete range.** Both in settings.
- Onboarding should state plainly: *sharing a computer? use a separate Chrome
  profile* — extension storage is per-profile, which solves it completely.

The `history` permission triggers a blunt "Read your browsing history" install
warning. Address it head-on in the store listing and first-run screen: read
locally, nothing transmitted, source is public.

### Active engagement, not screen time

Only count time when the tab is focused **and** there has been scroll or mouse
activity in the last ~60 seconds. A tab left open overnight must never register
as 8 hours of study — one bad number makes every number in the app
untrustworthy. Present as fact ("2h 40m across 4 sessions"), never as judgment.

---

## 10. History backfill

`chrome.history` retains **~90 days** in Chrome (older entries are pruned and
unrecoverable). Firefox retains far longer. Plan for ~3 months.

```ts
// Walk backwards in 7-day windows. A single unbounded search()
// silently truncates and you will think the user browses 100 pages a quarter.
for (let i = 0; i < 13; i++) {
  const items = await chrome.history.search({
    text: '',
    startTime: now - (i + 1) * 7 * DAY,
    endTime:   now - i * 7 * DAY,
    maxResults: 10000
  });
  // dedupe by normalized URL, keep highest visitCount
}
```

Yields `url`, `title`, `lastVisitTime`, `visitCount`, `typedCount` — **no page
content**. Use `chrome.history.getVisits({url})` for the full visit sequence
with transition types (`link`, `typed`, `reload`), which is a usable intent
signal.

Filter aggressively: ~13,000 raw rows typically collapse to 4,000–5,000
meaningful items. Embed in **batches of 32** (several times faster than one at
a time) → realistically **1–3 minutes**. Process newest-first, show a progress
bar, and stream results into the UI as they land.

**Design the screen for 60 seconds after install.** Topic cards and the
over-time chart will already hold months of data. That moment decides whether
the extension survives.

---

## 11. Build phases

### Phase 0 — Validation (3–4 days) ← START HERE

`scripts/validate.ts`, standalone Node, **no extension code**.

Load a Chrome history JSON export from `./history-export.json` → filter
(`chrome://`, localhost, search-result pages, titles < 15 chars, dupes after
normalization) → embed titles with MiniLM in batches of 32 → cluster → print
each cluster with its 8 nearest-centroid titles.

**Exit criteria:** the clusters read like the developer's actual life. If the
labels come out as "Technology" / "Programming" / "Web Development," the core
premise is not working — fix it here, in 100 lines, not after four weeks of
infrastructure.

This is the riskiest assumption in the project. Everything else is known to work.

### Phase 1 — Skeleton (week 1)
Extension loads, service worker + offscreen document wired, history backfill
running, embeddings stored in IndexedDB, search returning results in a bare UI.

### Phase 2 — Capture + privacy (week 2)
Content script, Readability, extraction ladder, dwell filtering, active
engagement tracking, and **all of §9**.

### Phase 3 — Intelligence (week 3)
Zero-shot classification, clustering, cluster labeling, topic promotion,
session reconstruction.

### Phase 4 — Dashboard (week 4)
React UI. v1 surfaces only — see §12.

### Phase 5 — Ship (week 5)
README with a demo GIF in the first screen, architecture diagram, design-
decisions-and-tradeoffs section, honest known-limitations section, landing
page, Chrome Web Store listing.

**Protect the v1 line.** Firefox, cloud sync, digests, and recommendations are
v2, and v2 exists only if v1 shipped.

---

## 12. v1 feature scope

**Search — the primary surface.** Natural-language query box; filters for time
range, format, topic, domain. Result cards show favicon, title, 2-line summary,
topic tags, date, and a **"revisited 4×"** badge. "More like this" on every
result (a vector-neighbour lookup — nearly free, feels like magic). Bind to
`chrome.omnibox` and a global shortcut.

**Session timeline** — horizontal blocks across the day, each labeled
*"2:10–3:40pm · Docker networking · 9 pages."* This is the hero visual and the
demo screenshot.

**Topic cards** — page count, hours, sparkline, trend vs last week, last
touched. Detail view lists every page, chronologically, with best resources
ranked by return visits.

**Topics-over-time** — stacked area chart across weeks. The most visually
impressive thing in the build.

Charts: Recharts. Prefer horizontal bars over pie charts — there will be too
many topics for a pie to be readable.

### Deferred to v2
Patterns view (hour × weekday heatmap, format split, session-length
distribution), Resources view, "Rediscover" (one forgotten thing from 3 months
ago), weekly digest, user-defined targets, Firefox port, encrypted cloud sync.

---

## 13. Conventions

- **Commit at every working step.** Small commits, real messages:
  `feat: title embedding pipeline`, never `update`. The commit graph is part
  of the portfolio.
- Conventional commits: `feat:` `fix:` `chore:` `docs:` `refactor:` `test:`
- TypeScript strict mode on.
- Vitest for tests; GitHub Actions running lint + tests on every PR.
- Typed arrays (`Float32Array`) for all vector math — never plain arrays.
- Keep the main thread responsive; inference belongs in the offscreen document.

---

- NEVER run git or gh commands. No add, commit, push, branch, checkout,
  stash, reset, or PR creation. The developer handles all version control.
  When work is complete, state what changed and stop — do not offer to
  commit, and do not treat a completed task as a reason to commit.

## 14. Decision log

Append new decisions here with a one-line rationale.

| Decision | Rationale |
|---|---|
| No backend | Privacy is the differentiator; also removes cost and auth entirely |
| No vector DB | 15MB of vectors, 12ms brute-force scan — a DB is pure overhead |
| Derived taxonomy | A hand-written topic list only ever fits its author |
| No productivity score | Invented metrics are detectable and destroy trust in honest features |
| Extension page, not hosted dashboard | Same React work, zero server, privacy intact |
| Chromium-only v1 | ~75% of desktop users from one build; Firefox is 2–3% |
| Day boundary at 04:00 | Late-night work belongs to the previous day |
| Phase 0 clusters with mutual-kNN + shared-neighbour, not HDBSCAN | HDBSCAN needs a UMAP step to behave on 384 dims and has no trustworthy JS port; `--algo community` and `--algo kmeans` remain as comparison arms |
| Clustering keys on neighbour *rank*, not an absolute cosine cutoff | Measured on MiniLM title embeddings: same-topic pairs median 0.194, cross-topic median 0.021 — the separation is real but the absolute scale is dataset-specific, so a fixed threshold does not transfer |
| Shared-neighbour test on every graph edge | Mutual-kNN alone chains: one accidental link welds two topics into one blob under connected components. Requiring shared context breaks bridges, which by definition have no mutual crowd |
| Boilerplate title suffixes are derived from the data, never hardcoded | "- YouTube" on 800 titles clusters on the suffix, and §4 is explicit that a domain is not a category — but a hardcoded suffix list would violate §6, so frequency across the user's own titles decides |
| `scripts/export-history.mjs` reads Chrome's local SQLite | Takeout takes hours and drops `visitCount`; `node:sqlite` is built in, so this stays zero-dependency and fully local |
| §5's ~0.40 zero-shot threshold is unverified | Title↔title similarity measures far below 0.40. Title↔label is a different distribution, but the 0.40 figure must be measured before Phase 3 depends on it |
| Cluster output displays the original title, embeds the stripped one | react.dev titles every page "… – React", so the suffix stripper removes the one word that identifies the cluster. Measured: stripping costs 0.33 of within-group similarity and 63% of the topic/unrelated gap. Clustering still works; a human reading the output could not tell what the cluster was, which defeats the §11 exit criterion |
| MV3 message passing is a broadcast, not a channel — every message needs an explicit `target` | `chrome.runtime.sendMessage` delivers to *every* listener in every context. A dashboard PING arrived at the background and the offscreen document simultaneously, and since only the first `sendResponse` wins, the caller silently got whichever replied first. `target` is part of every message variant so one cannot be built without it, and `onMessage(self, …)` filters centrally so a new listener cannot reintroduce the bug |
| The service worker holds no state about other contexts | It is torn down after ~30s idle, so anything it remembers about another context is a lie the moment it sleeps. An "offscreen ready" flag set by a push announcement at offscreen load died with the worker instance that received it, and the offscreen document only announced once — the flag could never become true again. Readiness is pulled on demand (create if absent, ping, await reply), which is stateless and therefore sleep-proof |
| An absolute similarity *floor* is the same transferability bug as an absolute clustering *threshold* | `--min-sim` was a fixed 0.20 sitting on the measured within-topic median of 0.194 — the exact failure the rank-based decision above was taken to avoid, reintroduced under a different parameter name. Swept, and on real history it proved **inert**: results are byte-identical across 0.05–0.20 because every node's top-15 neighbours already exceed 0.20. Harmless here, wrong in kind, and it would bite on a sparser corpus |
| Audit of remaining absolute similarity constants | `--min-sim` 0.20 (inert, above); `--threshold` 0.35 (`--algo community` only, a comparison arm); `--dup-threshold` 0.97 (**defensible** — it detects near-*identity*, not topical relatedness: duplicates sit at ~1.0 against a measured cross-topic max of 0.44, so the margin is enormous and scale-stable). §5's 0.40 zero-shot threshold remains unverified. Frequency rules are already scale-relative (`max(5, 0.3%)`) and need no change |
| Junk titles (auth walls, bot checks, error pages) are dropped before embedding | They carry no topic, recur in the hundreds under many distinct URLs so the normalized-URL dedupe never sees them, and once embedded they form dense identical neighbourhoods. Most are auth pages that §9 forbids capturing at all |
| Junk prefix patterns apply only to titles under 40 chars | An interstitial announces itself in a few words. `/^error/` alone eats "Error handling with Result and the question mark operator", a real Rust doc page — length is what separates the two |
| Near-duplicate pages collapse to one weighted node before clustering | LeetCode serves `/problems/two-sum/`, `/description/` and `/submissions/` under one title, so URL dedupe misses them. Twenty copies saturate a page's k nearest neighbours with itself: no related page can link, every problem becomes its own cluster, and unique pages get no mutual edges at all. Measured on real history: 553 clusters, 41% noise, four separate "Sign in" clusters |
| int8 batch-shape drift accepted, not engineered around | A title's vector shifts ~0.993 cosine when its batch has a different padded sequence width. fp32 shows none, so mean pooling masks padding correctly. Padding short batches to 32 rows does not help — width, not row count, is the driver — and top-6 neighbour rank is 100% stable across regroupings, so nothing mutual-kNN reads is affected |

---

## 15. Known limitations — state these honestly in the README

- Measures **exposure, not understanding**. Reading twenty React articles is
  not knowing React, and the product must never imply otherwise.
- Value **compounds**: thin in week one, hard to give up by month six. This is
  precisely why the backfill matters.
- Helps people who browse **with intent**. Pure entertainment has little to
  organise.
- Extraction coverage is imperfect on some sites. Report the real number.
- Chrome history retention caps the backfill at ~90 days.
