/**
 * Dumps the local Chrome/Edge/Brave history database to ./history-export.json
 * in the shape chrome.history.search() returns, so Phase 0 has something to
 * chew on without waiting on a Google Takeout request.
 *
 * Zero dependencies — node:sqlite is built into Node 22.5+.
 * Everything stays on this machine (CLAUDE.md §2.1).
 *
 *   npm run export-history
 *   npm run export-history -- --list
 *   npm run export-history -- --profile "Profile 15"
 *   npm run export-history -- --profile "C:/.../User Data/Profile 1"
 *
 * Ordering matters here: the export file is written before any temp cleanup is
 * attempted, so a cleanup failure can never cost us data we already read.
 */

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * Scratch copies live inside the project, never in the OS temp folder.
 * A plaintext dump of someone's entire browsing history sitting in a
 * world-readable shared directory is a privacy hole, not a housekeeping
 * detail — see CLAUDE.md §9. The directory is gitignored and swept on both
 * startup and exit.
 */
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRATCH_DIR = join(PROJECT_ROOT, '.scratch');
const SCRATCH_PREFIX = 'bi-history-';

const { values: flags } = parseArgs({
  options: {
    profile: { type: 'string' },
    out: { type: 'string', default: './history-export.json' },
    list: { type: 'boolean', default: false },
  },
  strict: true,
});

/**
 * Chrome stores time as microseconds since 1601-01-01, which lands around
 * 1.3e16 — past Number.MAX_SAFE_INTEGER (9.0e15). node:sqlite refuses to
 * narrow those to a JS number and throws, so the timestamp columns are read as
 * BigInt and divided down to milliseconds before conversion, where the value
 * is small enough to be exact.
 */
const WEBKIT_EPOCH_OFFSET_MS = 11_644_473_600_000;

function toUnixMs(value) {
  if (value === null || value === undefined) return 0;
  const usec = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value) || 0));
  if (usec <= 0n) return 0;
  return Number(usec / 1000n) - WEBKIT_EPOCH_OFFSET_MS;
}

/** Counts also arrive as BigInt once setReadBigInts is on. */
const toCount = (value) => (value === null || value === undefined ? 0 : Number(value));

const HISTORY_QUERY = `
  SELECT u.url             AS url,
         u.title           AS title,
         u.visit_count     AS visitCount,
         u.typed_count     AS typedCount,
         u.last_visit_time AS lastVisitTime,
         MIN(v.visit_time) AS firstVisitTime
  FROM urls u
  LEFT JOIN visits v ON v.url = u.id
  WHERE u.last_visit_time > 0
  GROUP BY u.id
  ORDER BY u.last_visit_time DESC`;

// ---------------------------------------------------------------------------
// Profile discovery
// ---------------------------------------------------------------------------

function candidateProfiles() {
  const home = homedir();
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  const roots =
    process.platform === 'win32'
      ? [
          join(local, 'Google', 'Chrome', 'User Data'),
          join(local, 'Microsoft', 'Edge', 'User Data'),
          join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
          join(local, 'Chromium', 'User Data'),
        ]
      : process.platform === 'darwin'
        ? [
            join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
            join(home, 'Library', 'Application Support', 'Microsoft Edge'),
            join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
          ]
        : [
            join(home, '.config', 'google-chrome'),
            join(home, '.config', 'microsoft-edge'),
            join(home, '.config', 'BraveSoftware', 'Brave-Browser'),
            join(home, '.config', 'chromium'),
          ];

  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (entry !== 'Default' && !entry.startsWith('Profile ')) continue;
      const db = join(root, entry, 'History');
      if (!existsSync(db)) continue;
      found.push({
        db,
        name: entry,
        label: `${root.split(/[\\/]/).slice(-2).join('/')}/${entry}`,
        mtime: statSync(db).mtimeMs,
      });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

/**
 * --profile accepts whichever form is to hand: a bare profile name as printed
 * by --list ("Profile 15"), the directory that contains the History file, or
 * the History file itself.
 */
function resolveProfile(requested, profiles) {
  if (requested === undefined) {
    return profiles[0] ?? null;
  }

  const byName = profiles.find(
    (profile) => profile.name.toLowerCase() === requested.toLowerCase() || profile.label.toLowerCase() === requested.toLowerCase()
  );
  if (byName) return byName;

  // A path: either the profile directory or the History file inside it.
  const asFile = basename(requested) === 'History' ? requested : join(requested, 'History');
  if (existsSync(asFile)) {
    return { db: asFile, name: basename(requested), label: requested, mtime: statSync(asFile).mtimeMs };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Removes scratch copies left by earlier runs. Synchronous and never throws, so
 * it is safe to call at startup and again from a process exit handler. Files
 * belonging to this process are skipped when `keepOwn` is set, so a concurrent
 * run cannot delete the copy we are actively reading.
 */
function sweepScratchDir({ keepOwn = false, announce = false } = {}) {
  if (!existsSync(SCRATCH_DIR)) return 0;
  let removed = 0;
  let stuck = 0;
  for (const entry of readdirSync(SCRATCH_DIR)) {
    if (!entry.startsWith(SCRATCH_PREFIX)) continue;
    if (keepOwn && entry.includes(`-${process.pid}-`)) continue;
    try {
      rmSync(join(SCRATCH_DIR, entry), { force: true });
      removed++;
    } catch {
      // Held by a concurrent run, or by a handle Windows has yet to release.
      // Harmless — the next run sweeps it.
      stuck++;
    }
  }
  if (announce && (removed > 0 || stuck > 0)) {
    console.log(`  swept    ${removed} leftover scratch file(s)${stuck > 0 ? `, ${stuck} still locked` : ''}`);
  }
  return removed;
}

/** Chrome holds an exclusive lock while running, so always work on a copy. */
function copyToScratch(dbPath) {
  mkdirSync(SCRATCH_DIR, { recursive: true });
  // Timestamped: if a previous run left a locked file behind, reusing the name
  // would fail the copy with the very EPERM we are trying to tolerate.
  const scratch = join(SCRATCH_DIR, `${SCRATCH_PREFIX}${process.pid}-${Date.now()}.sqlite`);
  copyFileSync(dbPath, scratch);
  return scratch;
}

function readRows(scratch) {
  const db = new DatabaseSync(scratch, { readOnly: true });
  try {
    const statement = db.prepare(HISTORY_QUERY);
    // Required: Chrome's timestamps exceed MAX_SAFE_INTEGER and node:sqlite
    // throws rather than silently losing precision.
    statement.setReadBigInts(true);
    return statement.all();
  } finally {
    // Must run even when the query throws. On Windows an open handle makes the
    // file undeletable, which is what produced EPERM from the cleanup path.
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Cleanup — best effort, never fatal
// ---------------------------------------------------------------------------

async function removeWithRetry(target, attempts = 3, delayMs = 100) {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(target, { force: true }); // force: absent files are not an error
      return;
    } catch (error) {
      // Windows can release a handle slightly after close returns; a short
      // wait clears it in practice.
      if (attempt >= attempts) throw error;
      await sleep(delayMs);
    }
  }
}

/**
 * Deletes the scratch copy and any SQLite sidecars. Never throws: by the time
 * this runs the export is already on disk, so a stuck file is a warning, not a
 * failure. It is a plaintext copy of the user's history though, so a failure to
 * remove it is reported loudly rather than swallowed silently.
 */
async function cleanupScratch(scratch) {
  for (const target of [scratch, `${scratch}-wal`, `${scratch}-shm`, `${scratch}-journal`]) {
    try {
      await removeWithRetry(target);
    } catch (error) {
      console.warn(`\n  WARNING: could not remove the scratch copy after 3 attempts`);
      console.warn(`           ${target}`);
      console.warn(`           ${error.code ?? error.message}`);
      console.warn(`           This is a plaintext copy of your history. The export itself is`);
      console.warn(`           saved; delete the file above, or re-run to sweep it.\n`);
    }
  }
}

// ---------------------------------------------------------------------------

function oldestVisit(items) {
  // A spread into Math.min blows the stack on a large history, and a heavy
  // browser easily has six figures of rows.
  let oldest = Infinity;
  for (const item of items) {
    const stamp = item.firstVisitTime || item.lastVisitTime;
    if (stamp > 0 && stamp < oldest) oldest = stamp;
  }
  return Number.isFinite(oldest) ? new Date(oldest) : null;
}

const profiles = candidateProfiles();

if (flags.list) {
  if (profiles.length === 0) {
    console.log('\n  no Chromium profiles found\n');
  } else {
    console.log(`\n  ${profiles.length} profile(s), most recently used first:\n`);
    for (const profile of profiles) {
      console.log(`    ${profile.name.padEnd(12)} ${profile.label.padEnd(38)} last used ${new Date(profile.mtime).toISOString().slice(0, 16)}`);
    }
    console.log(`\n  pick one with:  npm run export-history -- --profile "${profiles[0].name}"\n`);
  }
  process.exit(0);
}

const chosen = resolveProfile(flags.profile, profiles);
if (chosen === null || !existsSync(chosen.db)) {
  console.error(
    `\n  error: ${flags.profile === undefined ? 'no Chrome history database found' : `no history database for profile "${flags.profile}"`}.\n\n` +
      `  Run  npm run export-history -- --list  to see detected profiles, then pass\n` +
      `  --profile with a name ("Profile 1") or a path to the profile directory.\n`
  );
  process.exit(1);
}

console.log(`\n  profile  ${chosen.label}`);
console.log(`  reading  ${chosen.db}`);

// Sweep before starting: a previous crash may have stranded a plaintext copy.
sweepScratchDir({ announce: true });

// Last line of defence. Runs synchronously on any exit path the normal cleanup
// misses — an uncaught throw, an early process.exit, Ctrl-C.
process.on('exit', () => sweepScratchDir());
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    sweepScratchDir();
    process.exit(130);
  });
}

const scratch = copyToScratch(chosen.db);

let rows;
try {
  rows = readRows(scratch);
} catch (error) {
  await cleanupScratch(scratch); // nothing read, nothing to lose
  console.error(`\n  error: could not read the history database: ${error.message}\n`);
  process.exit(1);
}

const items = rows.map((row) => ({
  url: row.url,
  title: row.title ?? '',
  visitCount: toCount(row.visitCount),
  typedCount: toCount(row.typedCount),
  lastVisitTime: toUnixMs(row.lastVisitTime),
  firstVisitTime: toUnixMs(row.firstVisitTime),
}));

// Write first. Everything after this point is disposable.
await writeFile(flags.out, JSON.stringify(items), 'utf8');

const oldest = oldestVisit(items);
console.log(`  rows     ${items.length}`);
if (oldest) console.log(`  oldest   ${oldest.toISOString().slice(0, 10)}`);
console.log(`  wrote    ${flags.out}  (gitignored — this is personal data)`);

await cleanupScratch(scratch);

console.log(`\n  next:    npm run validate\n`);
