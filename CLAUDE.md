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
- **This file is the spec. [DECISIONS.md](DECISIONS.md) is the record.** Here:
  what is true now and what you must do. There: why, and what was measured.
  §14 holds only the binding rules; everything else moved.
- **When a decision corrects an earlier section, update that section in the
  same edit — and this applies across both files.** A DECISIONS.md row that
  corrects a CLAUDE.md section still requires updating that section. A reader
  going top-down must never hit stale guidance, and the record grows
  monotonically, so an uncorrected section stays wrong forever while looking
  authoritative.
- New decisions go to DECISIONS.md. Promote a row into §14 only when it
  constrains future work rather than explaining a past choice.

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
   10k documents is a measured 7.3ms — see §5.
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
| `src/dashboard/` | React app in a full tab. Renders; never computes. | **No** — see below |

Because all four share an origin, they communicate through **shared IndexedDB
state**, not an API layer. The offscreen document writes vectors; the
dashboard reads them directly.

**Keep all inference and every synchronous whole-corpus pass out of the
dashboard, permanently.** This was originally written as "dashboard: yes, for
on-demand queries" and is now measured: 87% of a backfill run had a thread
blocked while the dashboard stayed fully responsive, purely because the work
was in the offscreen document. Search runs there too, for the same reason —
the scan is short, but it is still synchronous (§14).

```
src/
  content/      Readability extraction, dwell + engagement, per-site adapters
  background/   service worker: alarms, capture queue, routing
  offscreen/    transformers.js — embedding, search index, queue drain
  dashboard/    React dashboard (extension page)
  lib/          browser-safe pipeline: filter, junk, titles, url, quality,
                embeddings, vectors, dedupe, clustering, search, blocklist,
                format, backfill, capture, blocking, storage, types
  platform/     browser shims: browser, history, settings, messages
scripts/
  validate.ts        Phase 0 harness — thin CLI over src/lib
  sanity.ts          embedding-path assertions
  export-history.mjs Chrome SQLite → history-export.json (dev only)
  fetch-model.mjs    downloads weights into .models for bundling
  check-extension.mjs static preflight on dist/
```

`src/lib` is browser-safe and isomorphic — no `node:*`, no `fs`, no `process` —
so the Phase 0 CLI and the extension run the identical pipeline. `storage.ts`
and `backfill.ts` are the exception: they need IndexedDB, so they are
browser-only and deliberately not re-exported from `lib/index.ts`.

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
  vectorSource: 'title'|'text';  // which field the vector came from — see §14

  format: Format;          // from domain rules
  topics: string[];        // from derived clusters ONLY — never a seed label (§5, §6)
  intent?: Intent;         // hybrid: domain + dwell + return count
  extractionTier: 1|2|3|4; // which rung SUPPLIED the text — see §8
  extractionQuality?: ExtractionQuality;  // absent on backfill: nothing to assess

  firstVisit: number;
  lastVisit: number;
  visitCount: number;      // return visits = strongest relevance signal
  activeSeconds: number;   // see §9 on what counts
  sessionId?: string;
}

type Format = 'video'|'docs'|'forum'|'article'|'code'|'social'|'shopping'|'other';
type Intent = 'learning'|'debugging'|'job-hunting'|'shopping'|'entertainment'|'reference';

interface ExtractionQuality {   // structural, not semantic — see §8 and §14
  units: number;                // CJK chars + non-CJK tokens, script-neutral
  coverage: number;             // extracted ÷ page text — completeness only
  stopwordRatio: number|null;   // over the UNIQUE token set; null on non-Latin
  terminatorsPer100Words: number;
  typeTokenRatio: number;
  score: number;
  verdict: 'good'|'weak'|'poor';
}

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

**Categorisation requires no LLM.** Topics come from unsupervised clustering
over embeddings. Only *prose summaries* and *cluster naming* need a language
model, and both are optional and batched.

### Seed labels are a weak prior, never a classifier

**Clustering is the classification mechanism.** An earlier design matched each
page against ~25 pre-embedded seed labels and tagged anything over ~0.40. That
was measured across 5,374 real pages and **the whole approach was rejected, not
just the number** (§14, DECISIONS.md).

The short version: page→label cosine produces *confidently wrong* answers, so
no threshold and no ranking rule fixes it.

- At 0.40, **13.3%** of the corpus classifies. The other 87% lands in the
  "discovery queue", which means the queue is the corpus.
- Lowering it does not help. Correct-label scores span **0.091 to 0.473**, so
  no cutoff separates right from wrong — 0.25 rejects three correct top-1
  matches while admitting confident errors.
- Rank-and-margin does not rescue it either, which is the trap, because that
  *is* the fix that worked for clustering. `Application History | Mynaukri`
  scores **0.467 on `history` with a 0.277 margin** — above every threshold
  considered and in the top decile of margins — purely from the word "History".
  Margin measures separation, not correctness.

So seeds do exactly one job: **keep day one non-empty.** They may inform
ordering or act as a tie-break hint on an otherwise-unlabelled page. They are
**never displayed to the user as a topic**, never stored as a confirmed
`topics[]` entry, and never treated as ground truth by anything downstream.

**Only a derived cluster becomes a displayed topic** (§6).

### Clustering

**Shared-nearest-neighbour clustering (Jarvis–Patrick) over a mutual-kNN
graph**, weekly. Two pages are linked when each is in the other's top-`k` *and*
they share at least `shared` neighbours; connected components below
`min-cluster-size` fall out as noise.

| Parameter | Default | Role |
|---|---|---|
| `--knn` | 10 | neighbours considered per node |
| `--shared` | 4 | neighbours two nodes must share to keep their edge |
| `--min-cluster-size` | 5 | smaller components become noise |
| `--min-sim` | 0.20 | edge floor — measured **inert**, see §14 |

Both tests are rank-based, not threshold-based, which is the whole point: the
absolute cosine scale is dataset-specific (§14), so a fixed cutoff does not
transfer between users. The shared-neighbour test is what stops chaining —
mutual-kNN alone welds two topics together through one accidental link.

Clusters are named from their 8 nearest-centroid titles and promoted to real
topics. Below `min-cluster-size` they stay noise — which is exactly what makes
brief anomalous browsing (a sibling borrowing the laptop) harmless.

### Naming: a degradation ladder, not an LLM

An earlier draft said clusters are "LLM-named". That was written before §2.1
had teeth, and it does not survive contact with it: those 8 titles are the
*most* identifying data in the corpus — a real name, an employer shortlist, a
job-search timeline — so any cloud call would make the README's central claim
false. **Cloud naming is rejected outright** (DECISIONS.md). Each rung below
is independently sufficient, and every user gets at least rung 2:

1. **On-device LLM** — an optional upgrade where one is available (Chrome's
   built-in Prompt API, or a local runtime the user already runs). Nothing
   leaves the machine. Never required.
2. **Derived keyphrase (default, always available).** Class-based TF-IDF over
   the cluster's own titles: `src/lib/labels.ts`. A term wins only if it is
   frequent *inside* the cluster and rare *across* the others, which makes it
   **structurally incapable of producing "Technology"** — a word common
   corpus-wide cannot win anywhere. That is the §11 Phase 0 failure mode
   eliminated by arithmetic rather than by a banned-word list.
3. **Top titles plus a count** — the floor. A cluster with no name is still
   useful, which is exactly how Phase 0's exit criterion was judged in the
   first place: by reading the 8 nearest titles, with no label involved.

**A cluster never displays a name it did not derive** (§14). `label` stays
`null` rather than becoming "Cluster 7" or "Miscellaneous".

HDBSCAN was the original choice and was rejected: it needs a UMAP step to
behave on 384 dims and has no trustworthy JS port. `--algo community` and
`--algo kmeans` remain in `scripts/validate.ts` as comparison arms only.

Near-duplicate pages are collapsed to one weighted node **before** clustering,
or twenty near-identical LeetCode rows saturate each other's neighbourhoods
(§14).

### When clustering runs

**First run is a backfill stage, not a trigger.** With seeds demoted to a weak
prior, a fresh install has *no* topics until clustering has run once — and §10
requires a populated screen 60 seconds after install. Backfill already computes
`repMatrix` (the collapsed representatives) and used to discard it; clustering
consumes exactly that, so running it there costs one pass over data already in
memory instead of a separate job that would reload every vector and repeat the
12-second collapse to rebuild it.

That stage is **non-fatal**. Backfill's deliverable is an embedded, stored,
searchable corpus, and by the time clustering starts that is already complete.
A clustering failure is caught, recorded in the clustering summary, and leaves
`clusterId` unset — indistinguishable from "not yet clustered", which is what
the retries below already handle. **A clustering bug must never discard a
finished embed run.**

**Re-run when either is true:**

- the unclustered pool has **grown by ~50 pages since the last run**, or
- **7 days** have passed.

The growth clause is the load-bearing one, and it is measured against a
baseline stored by the previous run (`ClusteringSummary.unclusteredPages`).
Defining the pool as "pages with no topic" — the obvious reading — is now
**permanently satisfied**, because noise pages legitimately have no topic and
there are ~1,700 of them; that version of the trigger fires forever. Growth
since the baseline is zero immediately after a run and only rises as new pages
arrive, which is the behaviour intended. The 7-day clause is the floor, so a
light-browsing week still refreshes; the growth clause is what stops live
captures waiting a full week after install.

**Full recompute. Do not attempt incremental clustering** — it takes seconds at
this scale and incremental variants are a bug factory.

Both O(n²) passes are **time-sliced** (`src/lib/chunk.ts`): unbroken, they
block for 15.2s combined, and the offscreen document services no messages for
that entire window. Sliced at 75ms the longest stall is ~125ms, for +40%
wall-clock. Chunked output is asserted byte-identical to the synchronous
reference rather than assumed.

### Why no vector database

10,000 pages × 384 dims × 4 bytes = **~15 MB**. Loads into memory instantly.
A brute-force cosine scan is ~4M multiply-adds.

**Measured**, top-20 over L2-normalized vectors, median of three runs:

| nodes | scan | vectors |
|---|---|---|
| 2,670 | **2.17 ms** | 3.9 MB |
| 5,747 | **4.51 ms** | 8.4 MB |
| 10,000 | **7.31 ms** | 14.6 MB |
| 50,000 | **33.67 ms** | 73.2 MB |

Linear in node count. The original estimate of ~12ms at 10k was conservative by
1.6×. At 50,000 nodes the scan is still under half a frame, so a vector DB
remains pure overhead well past any realistic corpus — years of browsing.

---

## 6. Taxonomy — two tiers

**Tier 1 — universal seeds (~25 labels, shipped, `src/lib/topics.ts`).**
programming, health, finance, travel, cooking, sports, news, education,
shopping, entertainment, design, science, legal, career, etc.

**They are a prior, not a taxonomy.** Measurement showed page→label cosine is
confidently wrong often enough that a seed label cannot be shown as fact (§5,
§14). Their whole job is that day one is not empty: something to order an
otherwise-unlabelled corpus by, and a hint the derived tier can use. A seed
name never appears in the UI as a topic, and never lands in `topics[]` as a
confirmed assignment.

**Tier 2 — derived, and the only real taxonomy.** Built from the user's own
data via clustering. Docker, Rust, guitar gear, visa paperwork — whatever they
actually browse. **A topic exists only once a cluster produced it.** This is
the mechanism, not a refinement layered on top of one.

The install-time history backfill (§10) is a **bootstrap, not a definition**.
The taxonomy is never frozen; new interests surface through the unclassified
pool within days.

**The seed list stays universal, and expanding it is not the fix.** Writing
richer label text ("programming, software development, writing code") was
measured: judged accuracy rose 12/20 → 14/20, but the distribution did not lift
and programming got *worse*. It also starts smuggling domain knowledge into the
one hardcoded list this section forbids from carrying any (DECISIONS.md).

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
| Capture | dwell > 30s focused, or pagehide | extract, assess quality, enqueue | ~10ms |
| Embed | drained off the capture path, ~1 min alarm | MiniLM → 384-dim → IndexedDB | ~25ms/page (measured) |
| Summarise | idle ≥ 5 min, batched | LLM 2-line summary + tags | off critical path |
| Sessions | debounced, ~2 min after last capture | group + label today's sessions | ms |
| Clusters | weekly | full recompute, promote topics | seconds |
| Search | on demand | cosine over all vectors | 2ms at 2.7k, 7ms at 10k (measured) |

30 videos in a day is 30 × 25ms = **under a second of total compute.** This is
not a batch-processing problem and never was.

Embedding is **queued and drained on an alarm**, not run inline at capture.
Per page the work is trivial, but the queue survives the service worker being
torn down and keeps §2.7 true by construction rather than by luck. The rule
that matters is not per-stage but per-batch: any *synchronous pass over the
whole corpus* is the thing that blocks, whatever stage it sits in (§14).

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
| 1 | Custom adapters — **none. Measured need is zero; see below** | — | — |
| 2 | `@mozilla/readability` | ~70% | Good |
| 3 | Title + `<meta description>` + `og:` tags | ~99% | Adequate |
| 4 | Domain rule only | 100% | Weak but never empty |

Tier 3 is load-bearing: every page has a title, and titles alone embed well
enough to categorise. That is why the history backfill works with no page
content at all.

**The adapter budget is measured at zero, down from "5–8 maximum".** All three
candidates were proposed from a single observed failure each and all three were
then eliminated by measurement: **GitHub** (repo pages score good 0.87 at 82%
coverage; only profile and sub-tab pages fail, which the ladder already
demotes), **NeetCode** (tier 3's meta description carries the actual problem
statement, good 0.74), and **YouTube** (three rounds, three distinct DOM
failure modes — stale segment selector, overflow-menu variant, and two
successes that were both auto-captioned Telugu videos). Reddit and Stack
Overflow were named in the original draft and were never more than guesses.

The reason is structural, not luck: **every adapter was proposed before the
quality-driven fall-through existed** (§8 below, DECISIONS.md). A ladder that
silently accepted `poor` output made each site look like it needed a bespoke
extractor; once a rung is rejected on its quality verdict, tier 2/3 handles
these sites without help. Tier 1 remains in the type and in this table as a
deliberate extension point, and the bar for adding one is now high: a site
must be **frequent, measurably failing after the ladder has fallen through**,
and fixable without an ongoing maintenance commitment against someone else's
UI redesigns.

**The tier alone is not a coverage metric.** It records which rung *supplied*
the text, not whether the text is usable — every page in the first capture test
reported tier 2 while a third was worthless. `extractionQuality` is stored
alongside it, and the quality verdict is what drives fall-through: a rung is
accepted the moment it is not `poor`. Report coverage from the quality verdict,
never from the tier (§14).

---

## 9. Privacy — build in phase 2, not at the end

This is the first question any technical reviewer asks. It is also what makes
the shared-machine problem tractable.

- **Never capture:** incognito windows, `chrome://`, localhost, and a
  sensitive-category blocklist (banking, health, email, adult, internal
  corporate tools). Exclude *before* extraction — never embed them.
- **Storage is unencrypted, deliberately.** The index lives in extension-local
  IndexedDB inside the Chrome profile directory, protected by the same OS file
  permissions and profile boundary as Chrome's own history. Anyone who can read
  it can already read Chrome's `History` SQLite, saved passwords and session
  cookies — all higher-value than this index. Encrypting our store while those
  sit beside it in plaintext is security theatre, and there is no key we could
  hold that such an attacker could not: with no user passphrase in the product,
  the key would live in `chrome.storage`, same profile, same permissions. That
  is obfuscation, and shipping it labelled "encrypted" is worse than shipping
  nothing, because it invites trust it cannot earn. See §14 — this is a
  conscious downgrade, not an overlooked requirement.
- **What actually protects the user** is everything else in this section: the
  blocklist applied *before* extraction, the pause toggle, retroactive delete,
  and a separate Chrome profile on a shared machine.
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

**No tier-1 adapters were built, and none are needed** (§8). All three
candidates — GitHub, NeetCode, YouTube — were measured and eliminated; the
quality-driven fall-through handles every one of them. The YouTube transcript
adapter was built, tested over three rounds and **removed**: it hit three
distinct DOM failure modes and fixing them meant opening the overflow menu
with synthetic clicks on a page the user is watching *and* chasing a segment
selector across A/B variants — permanent maintenance against someone else's UI,
for one site. YouTube now falls to Readability like everything else, which
captures the description and player chrome rather than the transcript (§15).

Confirmed good without an adapter: Medium, job-listing pages, and **GitHub repo
pages** — `GANDLA-ARAVIND/NUTRILENS` scored good 0.87 at 7,412 chars with 82%
coverage, and `MoonshotAI/Kimi-K3` returned 7,998 chars of real README. Only
profile and sub-tab pages fail there, and the ladder already demotes them (the
Agents tab correctly fell to tier 3 at 0.68), so no adapter is warranted.

**Step 2's measurement is done, and the cap stays at 64 tokens.** The corpus
holds title- and text-derived vectors side by side (§14), but both truncate to
the same 64-token window before embedding, so the short-title-vs-long-text gap
this step set out to measure turned out not to exist at the shipped cap.
Three conditions were compared on the same 107 pages — title@64, text@64
(current), text@256/512 — and raising the cap made things worse, not better:
peak query similarity fell monotonically (0.942 → 0.788) while the bulk of the
distribution barely moved, and embedding cost scaled to ~12 minutes at 512
tokens for a corpus the size already measured for blocking (§14), 12× the
64-token cost for a worse best match on most queries. **`EMBEDDING_MAX_TOKENS`
is not changing.** The 0.97 collapse threshold is verified safe across all four
conditions (0.35–0.45 margin in every case). The 0.194/0.021 within-/cross-topic
medians remain uncalibrated for text vectors in production — the 107-page
sample used here is too small and topically narrow to set a production
threshold from directly; recalibrate once real captures accumulate at scale.
See DECISIONS.md for the full measurement.

### Phase 3 — Intelligence (week 3)
Clustering, cluster labeling, topic promotion, session reconstruction.

**Step 1 is complete, with a negative result.** Zero-shot classification was
measured before being built and **rejected outright** — not retuned (§5, §14,
DECISIONS.md). Its deliverable is a design decision, not a classifier: the ~25
seed labels ship in `src/lib/topics.ts` as a **weak prior** that keeps day one
non-empty, and never appear to the user as a topic.

**Clustering is therefore the primary classification mechanism, not a
supplement to zero-shot.** Nothing downstream may assume a page arrives with a
usable label; the unclassified pool is the normal state until a cluster forms.
This raises the stakes on the two warnings below — they are no longer one
signal among several.

**Step 2 is complete.** Clustering runs in the offscreen document as a backfill
stage over the collapsed representatives, time-sliced so neither O(n²) pass
blocks (§5, §7). It writes `ClusterRecord`s and stamps `PageRecord.clusterId`;
**it does not write `topics`** — a cluster is a shape, a topic is a *name*, and
naming is step 3. An unnamed cluster must never surface as a topic.

**Step 4 is complete.** Sessions group by a 30-minute activity gap, are labelled by the same c-TF-IDF labeller as clusters, and rebuild on a ~2 minute debounce after the last capture (§7) — never deferred to midnight. §7's 04:00 boundary assigns a session to a *day*; it does not cut one, because splitting a continuous 03:50–04:10 run would invent a boundary the user never experienced. Sessions are counted in **pages, not collapsed nodes** (§14): twenty visits to one problem are twenty moments of an afternoon, and collapsing them would erase its shape. See §15 for what backfilled sessions can and cannot tell you.

**Detect passive-media SESSIONS, not passive pages.** Signature: multiple
sequential pages, same domain, `activeSeconds` ~0 across all of them, and short
per-page duration. A single long page with `activeSeconds` ~0 is *attention* —
a watched conference talk — while twenty short ones in a row are autoplay.
**`activeSeconds` is one input, never the test.** Capture keeps everything and
defers this judgement here, because Phase 3 is the first place with session
structure to judge it with; a per-page filter cannot make the distinction at
all and would silently drop the watched-talk case (DECISIONS.md).

**Boilerplate will pollute the taxonomy if nothing is done first.** Privacy
notices, cookie policies and recruitment-fraud warnings score at the *top* of
the quality scale — they are perfect prose — while carrying nothing about what
the user was doing. Structural quality cannot detect wrong-topic prose
(DECISIONS.md). Clustering these produces a "privacy policy" topic spanning
twenty unrelated employers that looks entirely legitimate. Decide the handling
before promoting any topic.

### Phase 4 — Dashboard (week 4)
React UI. v1 surfaces only — see §12.

**Step 1 (search UI) is complete**, and now includes the navigation
restructure that had to precede the rest of Phase 4. Query box with
time/format/topic/domain filters (collapsed behind a disclosure until opened),
result cards (favicon, 2-line preview, topic from the page's cluster,
"revisited N×"), and "more like this" as a second, filter-free vector-neighbour
endpoint. Both the ranking scan and the neighbour lookup run in the offscreen
document (§3, §14) — a dashboard-side filter dropdown reads corpus metadata
directly from IndexedDB the same way other panels do, which is rendering
support, not the compute the isolation rule keeps out of this context.

**Four surfaces behind top-level navigation** — Search (default), Topics,
Today, Settings — replacing a single scrolling page that put wiring probes,
stage timings, a stall table and a filter-drop audit ahead of the primary
surface §1 names. All four are built; Today (step 2) and Topics (step 3) are
below.
Settings holds backfill, blocked categories, retroactive removal, export and
delete-range — the controls someone actually reaches for — plus a collapsed
**Diagnostics** section (`Diagnostics.tsx`) holding everything that moved out
of the primary path: skeleton wiring, per-stage timings, main-thread stalls,
the capture-quality inspector, and the drop audit. **Nothing was deleted**,
only relocated — every panel this project has built up through Phase 3 is
still reachable, one click away instead of first.

**First-run experience is complete.** Before this, backfill only ran when
someone clicked the button in Settings, so a fresh install showed an empty
product — directly against §10's "design the screen for 60 seconds after
install." `chrome.runtime.onInstalled`'s `reason` field is the one signal
that distinguishes a genuine first install from an update or a developer
reload (both also fire `onInstalled`); on `reason === 'install'` the service
worker writes an `OnboardingState` marker, opens the dashboard, and starts the
backfill itself, with no separate confirmation step (DECISIONS.md has the
automatic-vs-ask reasoning). `FirstRun.tsx` is a full-screen takeover the
dashboard renders instead of the normal four-tab layout whenever an
`OnboardingState` record exists and no `BackfillSummary` does yet — it states
what is happening (90 days of history, titles only), reuses §9's exact
permission framing ("read locally, nothing transmitted, source is public"),
and streams progress, stored-page counts and **named** topic counts live via
the same `useBackfillProgress` poll hook `Backfill.tsx` uses, plus an
independent poll of the cluster store so topics fill in during the run rather
than only at the end. Cancel is genuinely cooperative, not cosmetic: it rides
the same `Slicer` yield-checkpoints the chunked collapse/cluster passes
already yield at (§14), via a `BackfillCancelledError` sentinel and a
`shouldCancel` callback threaded through `runBackfill`, `collapseNearDuplicatesChunked`
and `clusterByMutualKnnChunked`; a cancelled run returns `null` rather than a
fabricated `BackfillSummary`. The manual "Start backfill" / "Run again" button
in Settings is unaffected and stays the only re-run path — first-run never
shows a second time once a `BackfillSummary` exists.

**Step 3 (Topics) is complete.** A grid of topic cards — derived label, page
count, last touched, a per-card sparkline of activity over its own time range
— and a detail view per card: every page chronologically, and a "best
resources" list ranked by `visitCount`, the strongest relevance signal §4
names. Sorted by page count, descending, by default, per §12.

Two §14 rules apply directly to this surface, not just to the pipeline that
feeds it:

- **A cluster never displays a name it did not derive.** An unlabelled
  cluster's card shows its three most-visited titles plus a count of the rest
  (`"X · Y · Z +92 more"`) instead of a name, set apart in the card and the
  detail header by weight and colour so it never reads as a confident,
  chosen name the way a real label does — never "Cluster 7", never
  "Untitled".
- **State the unit.** This is the fifth unit-mixing instance §14 already
  records elsewhere, applied here before it could happen a sixth time: a
  topic's page count comes from grouping `PageRecord.clusterId` directly,
  never from `ClusterRecord.size` (a snapshot from the last clustering run
  that a retroactive deletion can go stale against) and never from
  `memberIds.length` (the collapsed-node count, one per near-duplicate group,
  not one per page). Every count on this surface is pages, and says so.

**Cluster #1 — the ~323-page temple/Google-Maps cluster §14 documents as the
proper-noun over-merge — renders exactly like every other topic, unfixed and
un-special-cased.** Its ugly label is the diagnostic that the failure mode is
real, and hiding it here would remove the one place a user could notice the
same thing this project already noticed from the same evidence.

**Step 4 (topics-over-time chart) is complete**, placed above the card grid
on the Topics tab. A Recharts stacked area chart, weeks on the X axis, pages
on the Y axis (labelled explicitly — constraint 1 of this step, and the same
unit rule step 3 already applies to the cards) — one band per topic, the top
8 by page count. **Recharts is the dependency this step earns**: the
per-card sparklines stay hand-rolled SVG because one topic's own shape does
not need a charting library, but comparing 8 topics on a shared weekly axis,
stacked, with a legend and a tooltip, is exactly what one is for — added as a
real `dependencies` entry (`TopicsOverTimeChart.tsx`), not a dev-only or
optional one, since it ships in the built dashboard bundle. A stacked area is
the deliberate exception to §12's general "prefer horizontal bars over pie
charts" — this is a case a stacked area is the *correct* chart, not the one
being reached for by habit.

**"Other" is not drawn, on real-corpus evidence.** The first version stacked
everything past the top 8 into a ninth "Other" band, and the real corpus
broke it on first use: 92 of 100 clusters fold into "Other," so its page
volume dwarfed the eight named ones and compressed them into a strip at the
bottom of the chart — the one thing the chart exists to show (which topics
rose and fell) became the hardest thing to see in it. Two fixes were
prototyped side by side against synthetic data shaped like the same skew
before picking one (DECISIONS.md has the comparison): raising the cap to 15
moved named topics from ~8–13% of chart height to ~10–17% — a real change,
not a fix, since almost any fixed N leaves a long tail dominant; drawing
"Other" as an unstacked outline instead of a filled band didn't help at all,
because it still shares the Y axis with everything else — the axis has to
stretch to fit its raw value whether it is filled or stroked, so the named
bands end up exactly as compressed either way. The domination is an
**axis-domain** problem, not a fill-style one, so "Other" is excluded from
the chart's data entirely rather than restyled: only the top 8 labelled
clusters are plotted, and the axis autoscales to their own range. A caption
line states what was excluded as a number — pages and a percentage of
clustered browsing — rather than drawing it, so the omission is stated, not
silent. Only **labelled** clusters can ever hold a band — an unlabelled
cluster is excluded the same as any smaller labelled one, never given the
cards' three-titles-plus-count fallback here, since a legend swatch has no
room for it (§14).

**The categorical palette is the dataviz skill's validated default, not
hand-picked.** The first version used eight hex values chosen by eye; run
through `validate_palette.js` after the fact, they failed the lightness-band
check outright and warned on contrast for half the set — the exact
"eyeballing colorblind-safety" anti-pattern the skill warns against. Replaced
with the documented default order (blue, orange, aqua, yellow, magenta,
green, violet, red), stored as `--series-1`..`--series-8` in `index.css`
alongside every other theme token, stepped separately for light and dark and
validated in both.

Small print beneath the chart states the same last-touch-vs-reading-timeline
caveat §15 already documents for sessions, applied here: a backfilled page's
`firstVisit === lastVisit`, so a page actually read across three weeks
appears as a single point in whichever week it was last touched, not spread
across the weeks it was actually read.

**Step 2 (the session timeline) is complete — the last step of Phase 4.** The
Today tab: horizontal blocks across the day (§12's own example format,
"2:10–3:40pm · Docker networking · 9 pages"), a day picker built from the
distinct `day` values actually present in stored sessions rather than a
free-form date input (picking an arbitrary calendar date could land on a day
with nothing in it; the picker only ever offers days that have data), and a
session list below the bar with the same detail expandable per row via a
native `<details>`-style toggle.

**Provenance is marked, not blended (§15's central requirement for this
surface).** Every session shows an explicit "Live" / "Reconstructed" / "Partly
reconstructed" badge, and the encoding is never colour-alone: the timeline
bar's border style differs too (solid / dashed / dotted), matching the badge
exactly, so a reconstructed session cannot be mistaken for a live one even
under a colour-vision deficiency. A day-level banner appears when
reconstructed sessions outnumber live ones for the day on screen, stating the
count plainly rather than letting the timeline imply more precision than the
data backing it has. Unlabelled sessions fall back to their own earliest
titles (§14) — chronological order, not by-visits: a session is a slice of
one sitting, not a topic spanning months, so what someone opened first is the
more useful stand-in than whichever page they returned to most.

**Two bugs found on first real use, both from the same root cause: a value
computed once and never revisited was trusted as if it were still current.**

1. **The time-range label could show an end before its start.** Reported
   live: a session's last row read "8:21–8:13pm," and the timeline bar
   plainly disagreed — it drew the block running to nearly 4am, not stopping
   at 8:13pm. The formatter extracted only hour/minute/am-or-pm from each
   timestamp and threw the date away, so a session ending the *next* calendar
   day rendered with the identical clock face as one ending earlier the same
   evening. `end` is never actually before `start` — `buildSessions` computes
   it as the max `lastVisit` across the session's own pages, which is
   structurally guaranteed to be at or after `start` (the min `firstVisit`)
   as long as every individual page satisfies `firstVisit <= lastVisit`, and
   nothing in the capture or backfill pipeline was found able to violate that
   (DECISIONS.md has the trace). Fixed by comparing calendar dates and
   appending "(next day)" / "(+N days)" when they differ — checked against
   local midnight, deliberately not the app's own 04:00 day-boundary, because
   the question here is only "does this clock face need a date to be
   unambiguous," not which day bucket §7 assigns the session to. A defensive
   branch also flags a genuine `end < start` explicitly rather than ever
   rendering a plausible-looking but wrong range — first written checking
   only the calendar-day *difference*, which missed a same-day reversal
   (`dayDiff` is 0 whichever timestamp is larger); caught by this file's own
   verification pass before shipping and fixed to compare the epoch values
   directly.
2. **The "Still going" badge could outlive the session it described.**
   `Session.provisional` is computed once, at whatever moment sessions last
   rebuilt (§7's ~2-minute-after-capture debounce), and stored. If no capture
   has triggered a rebuild since, that flag never gets revisited — a session
   that was genuinely open when last written keeps claiming "Still going"
   indefinitely, even days later. The dashboard now recomputes it live
   (`Date.now() - session.end < PROVISIONAL_WITHIN_MS`) at render time instead
   of trusting the stored boolean.

**Search backlog, carried from Phase 1 step 4.** Bare search works and is fast;
these are quality gaps found on real queries. Status as of step 1's full
search UI:

1. **Empty state — still open, deliberately.** Cosine always returns `k`
   results, so the UI cannot tell "no matches" from "your matches". Must be
   **relative, not an absolute cutoff** — measured top scores ranged 0.376 to
   0.892 across five queries, so any fixed floor is the transferability bug of
   §14 again. The signal is distribution *shape*: a high top score with a
   steep drop-off means a real hit, a flat profile means nothing matched. Same
   rank-and-margin principle that replaced the absolute clustering threshold.
   Not solved honestly this step, so it was left rather than papered over with
   an invented confidence label — the UI states plainly that it ranks, not
   matches (§15), and stops there. The one narrower case that *is* honest to
   report — zero results because an active **filter** excluded everything —
   is distinguished from this and shown, since that is a fact about set
   membership, not a fabricated relevance judgement.
2. **Result-level duplicate saturation — resolved.** `applyDomainDiversity`
   caps how many results one domain may contribute, re-ranking a wider
   candidate pool rather than lowering the collapse threshold (which would
   over-merge genuinely distinct pages). Same neighbourhood-saturation problem
   as Phase 0's kNN graph, recurring one layer up in the result list. Verified
   both directions (DECISIONS.md): the cap does cap, and it never returns
   fewer than `min(limit, candidates available)` — a popular domain must not
   silently shrink the result count.
3. **Compositional queries — already resolved, this row was stale.** This
   backlog entry still said "revisit after Phase 2 replaces titles with page
   content." Phase 2 measured that directly and found the opposite: embedding
   more text made compositional matching *worse* (§15, DECISIONS.md). Nothing
   to revisit here; the limitation is architectural, not a queue item.

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

**Passphrase-encrypted local storage** is a v2 candidate rather than a missing
v1 feature. A user-supplied passphrase is the only thing that makes real
encryption possible — it is the one key an attacker with profile access does
not have. But it changes the product, not just the storage layer: a locked
index cannot be searched, so it needs an explicit unlock flow, a decision about
what happens to background capture while locked, and an answer for a forgotten
passphrase that is not "your history is gone".

---

## 13. Conventions

- **NEVER run git or gh commands.** No add, commit, push, branch, checkout,
  stash, reset, or PR creation. The developer handles all version control.
  When work is complete, state what changed and stop — do not offer to commit,
  and do not treat a completed task as a reason to commit.
- **The developer commits at every working step.** Small commits, real
  messages: `feat: title embedding pipeline`, never `update`. The commit graph
  is part of the portfolio. This describes *their* workflow — it is not
  authorisation to commit on their behalf, and was misread as such once.
- Conventional commits: `feat:` `fix:` `chore:` `docs:` `refactor:` `test:`
- TypeScript strict mode on.
- Vitest for tests; GitHub Actions running lint + tests on every PR.
- Typed arrays (`Float32Array`) for all vector math — never plain arrays.
- Keep the main thread responsive; inference belongs in the offscreen document.

---

## 14. Standing rules

Binding constraints on future work. Every row here is a rule that, if broken,
reintroduces a bug this project has already had — or names work that must
happen before a later phase can be trusted.

**The record of what was decided and measured lives in [DECISIONS.md](DECISIONS.md).**
That file explains *why*; this section and the ones above it state *what is
true now* and *what you must do*.

| Rule | Why it binds |
|---|---|
| **Proper nouns dominate short-title embeddings — one cause, two opposite symptoms, and no graph parameter fixes either** | Measured on the real corpus. **Over-split:** `Software Engineer - Bengaluru - Capgemini` ~ the same role in Hyderabad at Capgemini = **0.889**, against the same role at Infosys **0.775**, Microsoft **0.509**, UnitedHealth **0.510** — the employer beats the shared role by up to **38 points**, so mutual-kNN forms per-employer neighbourhoods and produces ~15 near-duplicate career clusters. **Over-merge:** cluster #1's weakest internal link (person-name ~ Telangana-place) is **0.358**, against **0.417** for two genuinely related LeetCode pages — so 323 pages of LinkedIn profiles, map lookups and a temple are mutually dense, share neighbours honestly, and `shared>=4` passes correctly. There is no bridge to cut; the shared-neighbour test is working. Both follow from the same fact: where a title is almost entirely transliterated proper nouns, MiniLM has no topical signal to offer and only orthographic similarity remains; where names compete with real content, the name wins. **The lever is the input representation, not the graph.** Tuning `shared`/`knn` to fix one symptom worsens the other — raising `shared` shatters the career clusters further before it touches #1, whose internal density exceeds a genuine on-topic pair's. Do not attempt to tune either symptom away (see also the `largest%` rule above) |
| **Any per-cluster display must state whether it is showing nodes or pages** | Fifth instance of the unit-mixing class, and this one misled a live diagnosis rather than just a reader. The "8 nearest titles" shown per cluster were **node representatives**, so cluster #1 read as a pile of LinkedIn profiles when by page count it is **83% Google Maps** (268 of 323) — 50 nodes standing for 323 pages, and the display silently showed the former while the size beside it counted the latter. Every conclusion drawn from that view was about the wrong population. Clustering operates on collapsed nodes; users think in pages; the two differ by ~2× at this corpus size and by more wherever collapse bit hard. **Label the unit at every surface, and where both appear, give each its own total** — `ClusteringSummary` already separates `nodes {…}` from `pages {…}` for this reason, and a nearest-title list must say it is showing representatives and how many pages each stands for. Same class as the blocklist audit reporting 18 rows beside a 59-page difference (`DROP_UNIT`) |
| **A label that reads badly on an incoherent cluster is DIAGNOSTIC, not a defect** | Cluster #1 — 323 pages of LinkedIn profiles, Telangana map lookups and a temple — was labelled `shri veerabhadreshwara swamy temple · changlera google maps`, which reads terribly *and is why the broken cluster was noticed at all*. An LLM handed those same eight titles would confidently emit something like "Telangana Networking" and the cluster would look coherent while being nothing of the kind. **Any naming layer that smooths over bad clustering removes the only signal that clustering failed** — the ugliness is load-bearing. This is the standing reason derived keyphrases remain the default even if an on-device LLM is added later (§5's ladder): a keyphrase can only report words that are actually there, so it cannot invent a coherence the data does not have. The same argument as §2's rejection of invented scores, applied to prose: a plausible name for an incoherent group is a fabricated summary |
| **A cluster never displays a name it did not derive** | `ClusterRecord.label` stays `null` when naming produces nothing, and the UI falls back to the cluster's top titles and page count (§5's ladder). It must never become "Cluster 7", "Miscellaneous", "Other" or a topic index. **An invented name is the §2 no-invented-metrics problem in another form** — the objection to productivity scores was never that they are imprecise, it is that they are *fabricated*, users detect that immediately, and the loss of trust contaminates every honest feature beside them. A placeholder name asserts the system understood something it did not, on the one surface whose whole job is to say what the user was doing. Null is honest and the fallback is still useful; a made-up name is neither |
| **A report must enumerate what it EXPECTS and mark the missing, never enumerate only what it found** | A report driven by a hardcoded list of what to display, or built from the keys that happen to be present, can show presence but is structurally incapable of showing absence — and absence is the thing worth reporting. **Three instances, same shape:** (1) the "What was dropped" panel scanned *surviving* pages to report what the blocklist removed — but blocked pages are never stored, so it always answered ≈0 and testified that nothing was suppressed; (2) the empty `catch` on the capture-delivery call, where a permanent orphaned-context failure and a transient worker restart were both discarded identically, so total capture loss looked like normal operation; (3) `STAGE_ORDER` in the dashboard held its own copy of the pipeline's stage list, so when `cluster` was added it **ran, recorded its duration and produced 104 clusters while the timings table filtered the row out** — the stage was invisible *while working perfectly*, and three separate causes (ran-but-omitted, threw, never reached) all rendered as the same blank space. In every case the reporting mechanism and the thing reported drifted apart with nothing surfacing the gap. **Enumerate the expected set, render every member, and mark the absent ones with a reason.** Where the expected set is derivable from code, derive it (`TIMED_STAGES` is now the single source of truth, `time()` is typed to it, and preflight asserts the dashboard has not reintroduced a local copy) |
| **Never tune clustering on noise% alone — `largest%` is the alarm** | Noise looks like the obvious objective: lower is better, more pages classified. It is not, and optimising it ships the exact failure the shared-neighbour test exists to prevent. Measured on the real mixed corpus at `k=10`: `shared=4` gives **34.3% noise, largest 4.8%** (the default); `shared=3` gives **22.5% noise, largest 47.4%** — noise improves by twelve points while *one cluster swallows half the graph*. That is chaining, and a tuner watching only noise would ship it as an improvement and call it a win. Worse at `k=15, shared=2`: **3.6% noise, largest 95.6%** — a near-perfect noise score for a single blob containing almost everything, which classifies nothing. **Always report `largest%` beside `noise%`, and treat a rising `largest%` as disqualifying regardless of what noise does.** Noise is not failure — §5 calls the unclustered pool the discovery queue |
| Clustering keys on neighbour *rank*, not an absolute cosine cutoff | Measured on MiniLM title embeddings: same-topic pairs median 0.194, cross-topic median 0.021 — the separation is real but the absolute scale is dataset-specific, so a fixed threshold does not transfer |
| Boilerplate title suffixes are derived from the data, never hardcoded | "- YouTube" on 800 titles clusters on the suffix, and §4 is explicit that a domain is not a category — but a hardcoded suffix list would violate §6, so frequency across the user's own titles decides |
| **Zero-shot page→label matching is DISPROVEN as a classifier — seeds are a weak prior only** | Measured on 5,374 real pages against 25 seed labels. §5's ~0.40 classifies **13.3%** of the corpus, sending 87% to a "discovery queue" that is therefore the corpus. **Lowering it does not help:** correct-label scores span **0.091–0.473**, so no cutoff separates right from wrong — 0.25 rejects the correct label on the biryani page (0.091), the film trailer (0.097) and *"Longest Substring Without Repeating Characters"* (0.140, which ranked #1 correctly). **Rank-and-margin does not rescue it, and this is the trap** — it is the fix that worked for clustering and it will be proposed again: `Application History \| Mynaukri` scores **0.467 on `history` with a 0.277 margin**, above every threshold considered and in the top decile of margins, entirely from lexical overlap with the word "History". Margin measures *separation*, not *correctness*. Clustering's failure was scale drift; this failure is confident wrongness — different problem, same-looking symptom. **Structural reason:** ~1,100 LeetCode/NeetCode pages where `3Sum` → business and `Two Sum` → finance, because those titles are about arithmetic and objects and nothing in them lexically resembles "programming"; a 64-token title has no path to that inference. Seeds now do one job — keep day one non-empty — and are **never displayed as a topic label**. Clustering is the classification mechanism (§5, §6) |
| **Standing rule: any string-based heuristic must be tested against Telugu, Chinese and Arabic before it ships** | Five instances so far, each of which would have silently deleted or misjudged non-English content: (1) the `\W`-based empty-title check — JS `\W` is ASCII-only, so every title written entirely in a non-Latin script matched "no word characters" and was dropped; (2) the bare-URL rule, whose first draft keyed on "no whitespace", which is *normal* in Chinese, Japanese and Thai; (3) the English stopword list in quality scoring, which had to be skipped rather than replaced with a neutral value, or every non-English page reads as navigation chrome. **(4)** the sentence-terminator class, which covered Latin, CJK and Devanagari but not Arabic/Urdu (U+061F, U+06D4) — and Thai, Lao, Khmer and Myanmar end sentences with a *space*, so zero terminator density there is normal prose. **(5)** the 400-*character* usable-content floor: the same paragraph is 123 characters in Chinese and 368 in English, a measured ~3× density difference, so a character floor rejects genuine CJK prose as too short. Replaced with script-neutral **units** (one CJK character, or one whitespace token elsewhere) — the word tokenizer had the mirror bug, matching an entire unspaced Chinese sentence as one token and inflating terminator density to 57 per 100 "words" against 6.7 for the same English. The failure mode is always the same and always silent. **Instances 4 and 5 were caught by this rule during pre-ship testing rather than in production, which is the rule working.** Seven-script audit now passes: Chinese 0.90, Telugu 0.86, Japanese 0.79, Hindi 0.77, Urdu 0.70, Arabic 0.60, Thai 0.45 — none rejected |
| **A score built from fewer components is less trustworthy, and nothing currently says so** | Dropping inapplicable components fixed the *bias* but introduced a *confidence* problem: Thai loses both the stopword and terminator components, so its 0.45 rests on **one** signal, while Chinese 0.90 rests on three — and the two render identically in the UI and compare as equals in the ladder's best-of-poor tie-break. A one-component score is close to "length, renamed". Arabic scoring `weak` at 78 units may be the same artifact rather than a real quality signal. **Not fixed.** Store the contributing-component count alongside the score, display it, and treat a low-component score as weak evidence rather than a measurement — including in the ladder, where a three-component 0.60 should probably beat a one-component 0.64 |
| An inapplicable metric component must be **dropped and its weight redistributed**, never scored as zero | Scoring a signal that does not exist for the input at zero is indistinguishable from measuring it and finding nothing. Thai prose has no sentence terminators at all, so a zeroed terminator component scored real Thai writing at 0.29 and rejected it. The same mistake was made twice in one function: the stopword component was already being excluded for non-Latin text while the terminator component was still being zeroed. Components now carry weights that are summed only over those that apply |
| The good/poor boundary is calibrated on synthetic reconstructions and is **not settled** | Same provenance as the Phase 0 fixture, and the same warning applies: it will need retuning on real captures. Already visibly imperfect — on the NeetCode case the ladder picks tier 2 (0.67) over the more informative tier 3 (0.62), because both fall under the 400-char floor and the shorter announcement banner has punchier sentence structure. Deliberately **not** tuned to fix that, since tuning a threshold against reconstructions is the exact error this row exists to warn about. Retune against stored `extractionQuality` once real captures accumulate |
| **Stopword ratio measures "contains function words", not "is prose" — repetition satisfies the first without the second** | A Naukri page repeating `"Prep for this interview"` five times contributed *for* and *this* ten times and scored **0.324, inside prose range**, for a wall of UI labels. Fixed by computing the ratio over the **unique token set**, so a repeated template contributes each function word once: the same text now scores **0.10**, and the verdict moves `weak 0.568` → `poor 0.24`. The type-token ratio (0.676) was already a repetition signal sitting unused next to a metric being fooled by repetition. **General rule: any frequency-based text metric must be checked for repetition sensitivity** — templated UI is the common case, and it inflates every raw-count statistic |
| **Ingestion-route heterogeneity — measured, no action needed** | Backfilled pages embed a ~10-token title; captured pages store up to 8000 characters but `EMBEDDING_MAX_TOKENS` (64, below) truncates both routes to the same window before embedding. Measured directly over 15 queries × 107 pages: query-to-title and query-to-text pooled similarity distributions are nearly identical (mean 0.164 vs 0.163, median 0.142 vs 0.151). `PageRecord.vectorSource` still records which route a page took, but the ranking bias this row originally warned about does not materialize at the shipped cap. **Resolved.** See DECISIONS.md for the full three-condition measurement and why the cap is staying at 64 |
| The 0.97 collapse threshold does not transfer to body text by assumption — now verified that it does in practice | Title-to-title was the only measurement behind it. Checked directly across title@64, text@64, text@256 and text@512: the threshold holds with 0.35–0.45 margin above the worst cross-topic pair in every condition. **Verified.** The 0.194/0.021 within-/cross-topic medians remain a separate, open question — measured to shift by up to 67% between text@64 and text@512 on the same corpus (DECISIONS.md), so they still need calibrating against real captures at production scale before Phase 3 relies on them |
| Bare-URL titles are junk; a slash alone does not make a URL | Chrome falls back to the URL when a page serves no `<title>`, and those tokenize into hundreds of wordpieces — the 875-token offender was `cf.legacypoint.site/middle.html?cs=…`. No title means no topic, the same rationale as the other junk tiers. **The rule must require a dotted host before the slash:** a first version keyed on "spaceless ASCII containing `/`" also matched `GANDLA-ARAVIND/WATT-WISE-PROJECT`, which is one of the most informative titles in the corpus and anchors a real 136-page cluster. It must also require ASCII, or it deletes every Chinese, Japanese and Thai title — the same trap as the ASCII-only `\W` that once ate Telugu |
| Titles are truncated to 64 tokens at the *token* level, never the word level | A word-level cap measured cosine **1.0000** against the untruncated vector on eight of the ten worst offenders, which looked like a perfect result and was worthless: those titles are unbroken URLs with no whitespace, so it cut nothing. Token-level truncation moves the worst vector to 0.19 cosine — but only on junk URLs, and 0.90–0.99 on real titles. 64 leaves 99.8% of titles untouched. Enforced via `tokenizer.model_max_length` inside `createEmbedder`, so every caller inherits it |
| **Blocking scales with batch size, not with stage** | Measured in the extension at ~5,200 pages. Embed blocks **115.4s of its 133.8s stage — 86% — across 153 stalls, longest 16.5s**; that single stall exceeds collapse's entire 11.6s block. An earlier claim here that embed "never freezes the thread" was **wrong**: the per-batch IndexedDB `await` yields between batches, which prevents *one* continuous freeze but not 153 separate ones. The rule that actually holds: per page, embed is ~25ms (133.8s / 5,216), so live capture of a single page is harmless; a batch of 32 blocks ~0.75s; a synchronous pass over the whole corpus blocks for as long as it takes. **The danger is any synchronous pass over the whole corpus, whatever the stage it sits in.** Collapse is the worst case because it is unbroken *and* quadratic |
| **Test every gate and filter in both directions — suppression is symptomless** | An over-counting bug produces junk you can see; an under-counting one produces *nothing*, and a missing page is indistinguishable from a page never visited. Measured instance: a `capture: true` on a focus listener cost 22% of dwell on form-heavy pages and pushed the 30s gate 25 seconds late, suppressing real captures — and it shipped, was reviewed, and produced no symptom at all. Whenever a threshold, gate, blocklist or filter changes, construct a case that *should* pass and assert it still does, not only a case that should fail. The leaking direction gets found by inspection; the suppressing direction only gets found by asking |
| Run-to-run variance is large enough that a single measurement is worthless | Three runs, identical input. Embed **175.5 / 153.3 / 133.8s, median 153.3**. Collapse **14.5 / 25.4 / 11.7s, median 14.5** — a deterministic loop over identical data varying more than 2×, so the variance is the machine, not the algorithm. **Benchmark with three runs and take the median; never quote a single number.** The rule is validated, not assumed: single numbers here span 2×. Corollary: the Node harness predicted 11.1s for collapse against a 11.7–25.4s spread, so Node estimates set the order of magnitude and nothing finer |
| Blocking is measured by timer lateness, attributed by interval overlap | Two bugs made the first version report zero stalls for a stage that blocked for 19s: `clearInterval` immediately after the last stage killed the pending late tick that carried the largest gap, and reading "the current stage" when the tick finally fires blames whichever stage came *after* the block. `stop()` now waits a tick, and stage changes are timestamped so each gap is attributed by overlap |
| MV3 message passing is a broadcast, not a channel — every message needs an explicit `target` | `chrome.runtime.sendMessage` delivers to *every* listener in every context. A dashboard PING arrived at the background and the offscreen document simultaneously, and since only the first `sendResponse` wins, the caller silently got whichever replied first. `target` is part of every message variant so one cannot be built without it, and `onMessage(self, …)` filters centrally so a new listener cannot reintroduce the bug |
| The service worker holds no state about other contexts | It is torn down after ~30s idle, so anything it remembers about another context is a lie the moment it sleeps. An "offscreen ready" flag set by a push announcement at offscreen load died with the worker instance that received it, and the offscreen document only announced once — the flag could never become true again. Readiness is pulled on demand (create if absent, ping, await reply), which is stateless and therefore sleep-proof |
| An absolute similarity *floor* is the same transferability bug as an absolute clustering *threshold* | `--min-sim` was a fixed 0.20 sitting on the measured within-topic median of 0.194 — the exact failure the rank-based decision above was taken to avoid, reintroduced under a different parameter name. Swept, and on real history it proved **inert**: results are byte-identical across 0.05–0.20 because every node's top-15 neighbours already exceed 0.20. Harmless here, wrong in kind, and it would bite on a sparser corpus |
| **A cancel control must be genuinely cooperative, checked only at an existing yield point — never a separate polling mechanism** | Applied when `runBackfill` gained cancellation: `collapseNearDuplicatesChunked` and `clusterByMutualKnnChunked` already yield via `chunk.ts`'s `Slicer` between iterations of their O(n²) passes (§14 above), so `shouldCancel` is checked immediately after each `yieldNow()` and nowhere else. This is not a style preference — JS's single-threadedness means a flag cannot change mid-iteration regardless of mechanism, so checking anywhere *but* an existing yield point either does nothing extra or requires inventing a new suspension point that the chunking design deliberately does not have. A cancelled run throws a dedicated `BackfillCancelledError`, caught once at the top of `runBackfill` and once more inside clustering's own non-fatal try/catch (which must re-throw it rather than treat it as an ordinary clustering failure) — and returns `null`, never a `BackfillSummary`, because a completed-looking record for a run that did not complete is the same dishonesty the report-enumeration rule above forbids, applied to a control instead of a report |

## 15. Known limitations — state these honestly in the README

- Measures **exposure, not understanding**. Reading twenty React articles is
  not knowing React, and the product must never imply otherwise.
- Value **compounds**: thin in week one, hard to give up by month six. This is
  precisely why the backfill matters.
- Helps people who browse **with intent**. Pure entertainment has little to
  organise.
- Extraction coverage is imperfect on some sites. Report the real number.
- **YouTube pages are indexed on the video description and player chrome, not
  the transcript — so a video is searchable by how it was *described*, not by
  what was *said* in it.** A transcript adapter was built and removed: across
  three rounds it hit three distinct DOM failure modes (stale segment selector,
  an overflow-menu layout variant, and two successes that were both
  auto-captioned Telugu videos), and making it reliable would have meant
  synthetic clicks to open menus on a page the user is watching plus a selector
  chased across YouTube's A/B variants forever. **There is no planned fix.**
  Structural quality scoring cannot flag this either — the description is
  well-formed prose, so it scores *well* while being about the wrong thing, and
  on one measured page player chrome plus a username scored 0.73 against a real
  transcript's 0.67. Videos are still captured, categorised and searchable;
  they are just represented by their surrounding text.
- Chrome history retention caps the backfill at ~90 days.
- **Your index is stored unencrypted on your machine.** It lives in the
  extension's IndexedDB inside your Chrome profile, protected by the same
  operating-system permissions as Chrome's own browsing history, saved
  passwords and cookies — no more, no less. Nothing is transmitted anywhere.
  We do not encrypt it, and we would rather say so than imply a protection we
  cannot deliver: with no passphrase to derive a key from, any key we held
  would sit in the same profile an attacker already has. If you share a
  machine, use a separate Chrome profile — that is a real boundary, and it is
  the one we recommend.
- **Search has no empty state — it always returns results.** Cosine similarity
  ranks; it does not decide relevance. A query for something the user has never
  read still returns 20 rows, confidently ordered. Measured: "docker
  networking" against a corpus with no Docker content returned a full page of
  results topping out at 0.376, all irrelevant. The score is visible in the UI,
  but a score is not an answer to "did you find anything". Until a relative
  confidence signal exists (§11 Phase 4 backlog), the honest framing is that
  search *ranks* rather than *matches*.
- **Near-duplicate pages can still crowd the results.** Collapse merges at 0.97
  cosine, which is near-identity; pages that differ slightly more survive as
  separate nodes and can dominate a result list. Measured: "firebase database
  setup" returned 8 of 20 rows as variants of one page. Lowering the collapse
  threshold is the wrong fix — it would over-merge genuinely distinct pages —
  so this needs diversity in ranking, not in deduplication.
- **Queries are matched term-by-term, not compositionally, and more page
  content does not fix it.** A bi-encoder over short titles has no mechanism to
  bind terms together, so "that DSA video in Telugu" ranked a Telugu music
  channel (0.626) above the actual DSA roadmap videos (0.601): each term
  matched something, and the wrong page matched one term strongly. This was
  once expected to improve once Phase 2 replaced titles with page content;
  measured directly instead (DECISIONS.md), embedding more text made it
  *worse* — "telugu job search youtube video" correctly matched a job-search
  video at title and text@64, then switched to an unrelated personal-finance
  vodcast at text@256/512. This is inherent to the model class and the input
  length, not a gap more context closes. The README should not promise
  natural-language question answering.
- **Backfilled sessions reconstruct the LAST-TOUCH timeline, not the reading
  timeline — and the difference is undetectable from the data.**
  `chrome.history.search()` returns only `lastVisitTime`, so a session is
  "pages whose last touch clustered here", never "pages read together". A page
  first read in May and revisited in July appears **only** in July's session,
  and May's session is missing it entirely. Backfilled sessions therefore
  over-represent recent activity and under-represent the sessions that actually
  happened. This is survivorship bias in the timeline, not fabrication — every
  page in a session really was touched then — and **no statistic over the
  stored data can reveal it**, because the evidence that would is exactly what
  Chrome discarded.
  Measured on 5,812 pages → 448 sessions: the grouping itself is sound.
  Timestamps are genuinely distinct (5,757 distinct values across 5,769
  backfilled pages, max 2 pages sharing one), the gap distribution has real
  structure (p50 24s, p90 20min, 447 gaps over the 30-minute threshold), and
  **89% of multi-page sessions have plausible reading rates** (median 0.43
  pages/min; only 26 of 239 exceed 2/min). So the earlier fear — that collapsed
  timestamps would produce spurious small sessions — did not materialise; the
  real problem is subtler and worse, because it cannot be measured.
  The distortion scales with how many pages carry `visitCount > 1`, which is
  **unmeasured** — worth quantifying before Phase 4 leans on the timeline.
  Pages captured live carry real first/last visit times and real
  `activeSeconds`, so sessions from install onwards are exact. Say which is
  which in the UI rather than blending them silently — `Session.provenance` is
  `exact | approximate | mixed` for this reason. (`chrome.history.getVisits()`
  would give the true sequence but costs one call per URL — thousands on a
  first run.)
- **The passive-media detector is implemented but has never fired.** §11's
  requirement is built (`detectPassiveMedia`), and on the real corpus it
  returned `true` **zero** times — because 434 of 448 sessions contain no
  live-captured page and so return `null`, and only 14 could be evaluated at
  all. `activeSeconds` is 0 by construction on backfilled pages, so a wholly
  backfilled session has no engagement signal and calling it "not passive"
  would be an invented finding. The logic is verified; its behaviour on real
  autoplay is **not**. Treat as untested until live captures accumulate.
