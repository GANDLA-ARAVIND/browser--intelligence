/**
 * Dumps the local Chrome/Edge/Brave history database to ./history-export.json
 * in the shape chrome.history.search() returns, so Phase 0 has something to
 * chew on without waiting on a Google Takeout request.
 *
 * Zero dependencies — node:sqlite is built into Node 22.5+.
 * Everything stays on this machine (CLAUDE.md §2.1).
 *
 *   npm run export-history
 *   npm run export-history -- --profile "C:/.../User Data/Profile 1"
 */

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: flags } = parseArgs({
  options: {
    profile: { type: 'string' },
    out: { type: 'string', default: './history-export.json' },
    list: { type: 'boolean', default: false },
  },
  strict: true,
});

/** Chrome stores time as microseconds since 1601-01-01. */
const WEBKIT_EPOCH_OFFSET_MS = 11_644_473_600_000;
const toUnixMs = (webkitUsec) => (webkitUsec > 0 ? Math.round(webkitUsec / 1000 - WEBKIT_EPOCH_OFFSET_MS) : 0);

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
      if (existsSync(db)) found.push({ db, label: `${root.split(/[\\/]/).slice(-2).join('/')}/${entry}`, mtime: statSync(db).mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

function readHistory(dbPath) {
  // Chrome holds an exclusive lock while running, so work on a copy.
  const scratch = join(tmpdir(), `bi-history-${process.pid}.sqlite`);
  copyFileSync(dbPath, scratch);
  try {
    const db = new DatabaseSync(scratch, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT u.url            AS url,
                u.title          AS title,
                u.visit_count    AS visitCount,
                u.typed_count    AS typedCount,
                u.last_visit_time AS lastVisitTime,
                MIN(v.visit_time) AS firstVisitTime
         FROM urls u
         LEFT JOIN visits v ON v.url = u.id
         WHERE u.last_visit_time > 0
         GROUP BY u.id
         ORDER BY u.last_visit_time DESC`
      )
      .all();
    db.close();
    return rows.map((row) => ({
      url: row.url,
      title: row.title ?? '',
      visitCount: Number(row.visitCount ?? 0),
      typedCount: Number(row.typedCount ?? 0),
      lastVisitTime: toUnixMs(Number(row.lastVisitTime ?? 0)),
      firstVisitTime: toUnixMs(Number(row.firstVisitTime ?? 0)),
    }));
  } finally {
    rmSync(scratch, { force: true });
  }
}

const profiles = candidateProfiles();

if (flags.list) {
  if (profiles.length === 0) console.log('  no Chromium profiles found');
  for (const profile of profiles) {
    console.log(`  ${profile.label.padEnd(34)} last used ${new Date(profile.mtime).toISOString().slice(0, 16)}`);
  }
  process.exit(0);
}

const dbPath = flags.profile ? join(flags.profile, 'History') : profiles[0]?.db;
if (!dbPath || !existsSync(dbPath)) {
  console.error(
    `\n  error: no Chrome history database found.\n` +
      `  Run with --list to see detected profiles, or pass --profile "<path to User Data/Default>".\n`
  );
  process.exit(1);
}

const items = readHistory(dbPath);
await writeFile(flags.out, JSON.stringify(items), 'utf8');

const oldest = items.length > 0 ? new Date(Math.min(...items.map((i) => i.firstVisitTime || i.lastVisitTime))) : null;
console.log(`\n  source   ${flags.profile ?? profiles[0].label}`);
console.log(`  rows     ${items.length}`);
if (oldest) console.log(`  oldest   ${oldest.toISOString().slice(0, 10)}`);
console.log(`  wrote    ${flags.out}  (gitignored — this is personal data)\n`);
console.log(`  next:    npm run validate\n`);
