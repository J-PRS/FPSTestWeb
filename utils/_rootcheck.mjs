#!/usr/bin/env node
/**
 * Root-clutter gate — part of `npm run check` in client/.
 *
 * The repo root's entry set is tracked in `index_root.txt` (committed).
 * This script compares the actual root against that manifest: any add or
 * remove fails the gate and asks whether it was intentional. Nothing is
 * ever deleted here — the answer is either "move it into a subfolder"
 * (do not delete) or "accept it" via --update + commit.
 *
 *   node utils/_rootcheck.mjs            # check (exit 1 on diff)
 *   node utils/_rootcheck.mjs --update    # rewrite index_root.txt from
 *                                        # the current root (then git add)
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(ROOT, 'index_root.txt');
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

const actual = readdirSync(ROOT).sort();
const junkPresent = actual.filter(isJunk);
if (junkPresent.length) {
  console.log('\n[rootcheck] scratch-looking root entries — do NOT index these:');
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
  console.log(`[rootcheck] wrote ${actual.length} entries to index_root.txt`);
  process.exit(0);
}

if (UPDATE) {
  writeFileSync(INDEX, actual.join('\n') + '\n');
  console.log(`[rootcheck] wrote ${actual.length} entries to index_root.txt`);
  process.exit(0);
}

let declared = [];
try {
  declared = readFileSync(INDEX, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
} catch {
  console.log('[rootcheck] index_root.txt missing — run with --update to create it');
  process.exit(1);
}

const declaredSet = new Set(declared);
const actualSet = new Set(actual);
const added = actual.filter((n) => !declaredSet.has(n));
const removed = declared.filter((n) => !actualSet.has(n));

if (added.length === 0 && removed.length === 0) {
  console.log(`[rootcheck] root matches index_root.txt (${actual.length} entries)`);
  process.exit(0);
}

console.log('\n[rootcheck] root differs from index_root.txt:');
if (added.length) {
  console.log('  added (not in index_root.txt):');
  for (const f of added) console.log(`    + ${f}`);
}
if (removed.length) {
  console.log('  removed (in index_root.txt but not on disk):');
  for (const f of removed) console.log(`    - ${f}`);
}
console.log('\nIf intentional:  node utils/_rootcheck.mjs --update  then  git add index_root.txt');
console.log('If not: move the entry into a subfolder (do not delete).\n');
process.exit(1);