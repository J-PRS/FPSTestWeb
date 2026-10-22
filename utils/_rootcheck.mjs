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

const actual = readdirSync(ROOT).sort();

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