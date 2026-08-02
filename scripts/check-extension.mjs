/**
 * Static preflight for the built extension.
 *
 * Does not replace loading it at chrome://extensions — it cannot tell you the
 * service worker booted. It catches the failures that produce a red "errors"
 * badge before you get that far: a manifest that does not parse, a
 * service_worker path that was renamed by a hashed build, an HTML entry that
 * never made it into dist.
 *
 *   npm run build && npm run check-extension
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const failures = [];
const notes = [];

const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${detail}`);
  if (!ok) failures.push(label);
};

/** Every file under `dir`, recursively. */
const walkFiles = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walkFiles(full) : [full];
  });

console.log('\nExtension preflight');
console.log('─'.repeat(74));

if (!existsSync(DIST)) {
  console.error('\n  error: no dist/ — run `npm run build` first\n');
  process.exit(1);
}

// --- manifest ---------------------------------------------------------------
const manifestPath = join(DIST, 'manifest.json');
check(existsSync(manifestPath), 'manifest.json present in dist');
if (!existsSync(manifestPath)) process.exit(1);

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  check(true, 'manifest.json parses as JSON');
} catch (error) {
  check(false, 'manifest.json parses as JSON', error.message);
  process.exit(1);
}

check(manifest.manifest_version === 3, 'manifest_version is 3', String(manifest.manifest_version));

// JSON has no comments. Chrome logs unrecognised keys as manifest errors, so a
// "//explanation" key is a visible defect, not a harmless annotation.
const commentKeys = Object.keys(manifest).filter((key) => key.startsWith('//'));
check(commentKeys.length === 0, 'no comment-style keys in manifest', commentKeys.join(', ') || 'none');

// The ONNX runtime cannot instantiate without this under MV3.
const csp = manifest.content_security_policy?.extension_pages ?? '';
check(csp.includes("'wasm-unsafe-eval'"), "CSP declares 'wasm-unsafe-eval'", csp || '(unset)');
check(!/https?:\/\//.test(csp), 'CSP allows no remote script origins', csp || '(unset)');

// The no-network guarantee: nothing outside the package.
check(
  manifest.host_permissions === undefined,
  'no host_permissions (model ships in-package)',
  (manifest.host_permissions ?? []).join(', ') || 'none'
);

const REQUIRED_PERMISSIONS = ['history', 'storage', 'offscreen', 'alarms'];
const permissions = manifest.permissions ?? [];
for (const permission of REQUIRED_PERMISSIONS) {
  check(permissions.includes(permission), `permission: ${permission}`);
}
const extra = permissions.filter((p) => !REQUIRED_PERMISSIONS.includes(p));
if (extra.length > 0) notes.push(`extra permissions beyond the phase-1 set: ${extra.join(', ')}`);

// --- files the manifest points at -------------------------------------------
const serviceWorker = manifest.background?.service_worker;
check(typeof serviceWorker === 'string', 'background.service_worker declared', serviceWorker ?? '(missing)');
if (serviceWorker) {
  check(existsSync(join(DIST, serviceWorker)), `service worker file exists`, serviceWorker);
}
check(manifest.background?.type === 'module', 'service worker is type: module', manifest.background?.type ?? '(unset)');

for (const page of ['offscreen.html', 'dashboard.html']) {
  check(existsSync(join(DIST, page)), `page exists: ${page}`);
}

// Content scripts are classic scripts, not modules. An `import` statement in
// the emitted file is a syntax error the moment Chrome injects it, and the
// failure is silent from the extension's side — the page just never captures.
/**
 * Behaviour the content script must still contain after bundling.
 *
 * Existence and syntax checks alone would pass a truncated, empty or
 * half-tree-shaken content.js — and a content script that loads but does
 * nothing is the worst possible failure here, because capture stops with no
 * error anywhere and a page that was never captured looks exactly like a page
 * never visited (§14). These are the four things whose absence means capture
 * cannot happen at all.
 *
 * Matched against the *minified* output, so every pattern keys on a string
 * literal or an API name that survives minification — never on an identifier,
 * which gets renamed.
 */
const CONTENT_ENTRY_MARKERS = [
  [/setInterval\s*\(/, 'dwell timer registered'],
  [/["'`]pagehide["'`]/, 'pagehide capture listener'],
  [/["'`]CAPTURE_PAGE["'`]/, 'CAPTURE_PAGE delivery message'],
  [/["'`]visibilitychange["'`]/, 'focus/visibility tracking'],
];

for (const entry of manifest.content_scripts ?? []) {
  for (const file of entry.js ?? []) {
    const path = join(DIST, file);
    check(existsSync(path), `content script exists: ${file}`);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, 'utf8');
    check(!/^\s*import\s/m.test(source), `${file} is not an ES module`, 'no top-level import');
    check(!/^\s*export\s/m.test(source), `${file} has no export statements`);

    for (const [pattern, label] of CONTENT_ENTRY_MARKERS) {
      check(pattern.test(source), `${file} contains ${label}`);
    }

    // A content build that silently emitted almost nothing would satisfy every
    // marker above only by accident; a size floor catches the rest.
    const kb = statSync(path).size / 1024;
    check(kb > 5, `${file} is not truncated`, `${kb.toFixed(1)} KB`);

    // Stale-build guard. `npm run build` runs two vite passes and the content
    // pass is the second; a failure there leaves the *previous* content.js in
    // place while the main build's output is fresh, so dist/ looks built and
    // the extension runs yesterday's capture logic.
    const SRC = fileURLToPath(new URL('../src', import.meta.url));
    const newestSource = walkFiles(SRC)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .reduce((newest, f) => Math.max(newest, statSync(f).mtimeMs), 0);
    const builtAt = statSync(path).mtimeMs;
    check(
      builtAt >= newestSource,
      `${file} is newer than its sources`,
      builtAt >= newestSource
        ? `built ${new Date(builtAt).toLocaleTimeString()}`
        : `STALE — source changed at ${new Date(newestSource).toLocaleTimeString()}, build is from ${new Date(builtAt).toLocaleTimeString()}`
    );
  }
}

// --- every local src/href in the built HTML resolves -------------------------
for (const page of ['offscreen.html', 'dashboard.html']) {
  const file = join(DIST, page);
  if (!existsSync(file)) continue;
  const html = readFileSync(file, 'utf8');
  const refs = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((ref) => !/^(https?:)?\/\//.test(ref) && !ref.startsWith('data:'));
  for (const ref of refs) {
    const resolved = ref.startsWith('/') ? join(DIST, ref) : join(dirname(file), ref);
    check(existsSync(resolved), `${page} → ${ref}`);
  }
  // A module script that never emitted would leave the page inert.
  check(/<script[^>]+type="module"/.test(html), `${page} has a module script`);
}

// --- nothing that would trip Chrome's MV3 loader -----------------------------
const built = walkFiles(DIST);
const jsFiles = built.filter((file) => file.endsWith('.js'));
check(jsFiles.length > 0, 'javascript emitted', `${jsFiles.length} files`);

// MV3 forbids remotely hosted code; a stray CDN import fails review and, for
// the service worker, fails at load.
const remoteImport = jsFiles.find((file) =>
  /\bimport\s*\(?["']https?:\/\//.test(readFileSync(file, 'utf8'))
);
check(remoteImport === undefined, 'no remote imports in emitted JS', remoteImport ?? '');

// A service worker has no DOM. Vite's modulepreload polyfill touches
// `document`, and pulling it — or any DOM-using module — into the worker's
// import graph kills the worker at load with an opaque error. Follow the real
// graph rather than scanning dist wholesale.
if (typeof serviceWorker === 'string' && existsSync(join(DIST, serviceWorker))) {
  const graph = new Set();
  const queue = [join(DIST, serviceWorker)];
  while (queue.length > 0) {
    const file = queue.shift();
    if (graph.has(file) || !existsSync(file)) continue;
    graph.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s*["']([^"']+)["']/g)) {
      if (match[1].startsWith('.')) queue.push(join(dirname(file), match[1]));
    }
  }

  const domAccess = /(^|[^.\w])(document|window|localStorage|XMLHttpRequest)\s*\./;
  const offender = [...graph].find((file) => domAccess.test(readFileSync(file, 'utf8')));
  check(offender === undefined, 'service worker graph touches no DOM globals', offender ?? `${graph.size} modules`);
}

const totalKb = built.reduce((sum, file) => sum + statSync(file).size, 0) / 1024;
console.log(`\n  ${built.length} files, ${totalKb.toFixed(0)} KB total`);
for (const note of notes) console.log(`  note: ${note}`);

console.log('─'.repeat(74));
if (failures.length === 0) {
  console.log('PREFLIGHT PASSED — load dist/ at chrome://extensions (Developer mode → Load unpacked)\n');
} else {
  console.log(`${failures.length} CHECK(S) FAILED\n`);
  process.exitCode = 1;
}
