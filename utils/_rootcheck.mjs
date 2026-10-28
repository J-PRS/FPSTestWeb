#!/usr/bin/env node
/**
 * Root-clutter gate — the repository and first-party project roots have
 * committed entry manifests. Ignored build/local artifacts are excluded.
 *
 * Any unignored add/remove fails. Nothing is deleted; new intentional
 * entries are accepted by updating the relevant manifest and committing it.
 *
 *   node utils/_rootcheck.mjs [--update]
 *   node utils/_rootcheck.mjs --scope client|server_bun [--update]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scopeAt = process.argv.indexOf('--scope');
const scope = scopeAt < 0 ? '' : process.argv[scopeAt + 1];
const scopes = new Set(['client', 'server_bun']);
if (scopeAt >= 0 && !scopes.has(scope)) {
  console.error('[rootcheck] --scope must be one of: client, server_bun');
  process.exit(2);
}
const TARGET = scope ? join(ROOT, scope) : ROOT;
const INDEX = join(TARGET, 'index_root.txt');
const UPDATE = process.argv.includes('--update') || process.argv.includes('--accept');
const FORCE = process.argv.includes('--force');

// Entries that are almost certainly scratch/accidents, not real top-level
// files. These fail the gate EVEN WHEN INDEXED — the index is for genuine
// new top-level entries, not for silencing scratch. Real homes: ZZZ_ROOT
// (archive), _scratch, logs/, or a subfolder. --force overrides --update only.
const JUNK = [
  /\.log$/i,                                   // stray logs → logs/
  /\.txt$/i,                                   // stray dumps (allowlist below)
  /[$'"()]/,                                   // shell-quoting accidents ($null, e.includes('lights'))
  /^nul$/i,                                    // windows nul redirection artifact
  /^[a-z]\./i,                                 // fragment files like e.targetType
];
const TXT_ALLOWLIST = new Set(['index_root.txt', 'changelog.txt']);
const isJunk = (n) => JUNK.some((re) => re.test(n)) && !TXT_ALLOWLIST.has(n);

const entries = readdirSync(TARGET).sort();
// Ignore generated/local-only entries according to the repo's .gitignore.
// This keeps node_modules/dist and local logs out of committed baselines,
// while unignored untracked root entries still fail the gate.
const ignoredResult = spawnSync('git', ['check-ignore', '--stdin', '-z'], {
  cwd: ROOT,
  input: entries.map((entry) => scope ? `${scope}/${entry}` : entry).join('\0') + '\0',
  encoding: 'utf8',
});
if (ignoredResult.error) {
  console.error(`[rootcheck] git check-ignore failed: ${ignoredResult.error.message}`);
  process.exit(2);
}
const ignored = new Set(ignoredResult.stdout.split('\0').filter(Boolean)
  .map((entry) => scope ? entry.slice(scope.length + 1) : entry));
const actual = entries.filter((entry) => !ignored.has(entry));
const junkPresent = actual.filter(isJunk);
if (junkPresent.length) {
  console.log(`\n[rootcheck] scratch-looking ${scope || 'repository'} root entries — do NOT index these:`);
  for (const f of junkPresent) console.log(`    ! ${f}`);
  console.log('Move them into ZZZ_ROOT/ (archive), _scratch/, logs/, or a proper subfolder.');
  if (!FORCE) {process.exit(1);}
  console.log('(--force: continuing anyway)');
}

if (UPDATE) {
  if (junkPresent.length && !FORCE) {
    // unreachable — junk exits above — but keep the guard explicit.
    process.exit(1);
  }
  writeFileSync(INDEX, actual.join('\n') + '\n');
  console.log(`[rootcheck] wrote ${actual.length} entries to ${scope ? `${scope}/` : ''}index_root.txt`);
  process.exit(0);
}

let declared = [];
try {
  declared = readFileSync(INDEX, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
} catch {
  console.log(`[rootcheck] ${scope ? `${scope}/` : ''}index_root.txt missing — run with --scope ${scope || '<scope>'} --update`);
  process.exit(1);
}

const declaredSet = new Set(declared);
const actualSet = new Set(actual);
const added = actual.filter((n) => !declaredSet.has(n));
const removed = declared.filter((n) => !actualSet.has(n));

if (added.length === 0 && removed.length === 0) {
  console.log(`[rootcheck] ${scope || 'repository'} root matches its index (${actual.length} entries)`);
  process.exit(0);
}

console.log(`\n[rootcheck] ${scope || 'repository'} root differs from ${scope ? `${scope}/` : ''}index_root.txt:`);
if (added.length) {
  console.log('  added (not in index_root.txt):');
  for (const f of added) console.log(`    + ${f}`);
}
if (removed.length) {
  console.log('  removed (in index_root.txt but not on disk):');
  for (const f of removed) console.log(`    - ${f}`);
}
console.log(`\nIf intentional: node utils/_rootcheck.mjs${scope ? ` --scope ${scope}` : ''} --update, then git add ${scope ? `${scope}/` : ''}index_root.txt`);
console.log('If not: move the entry into a subfolder (do not delete).\n');
process.exit(1);