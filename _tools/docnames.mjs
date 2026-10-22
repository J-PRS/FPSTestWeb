#!/usr/bin/env node
// _docs filename normalizer — convention is YYYY-MM-DD_UPPER_SNAKE.md.
//   node _tools/docnames.mjs          dry run (default)
//   node _tools/docnames.mjs --fix    git mv + rewrite references in *.md
//   node _tools/docnames.mjs --check  CI mode: exit 1 if any file is off-spec
// Undated files get their first git-commit date; KEEP entries stay bare.
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const DOCS = '_docs';
// Living trackers/catalogs, not dated reports — a creation date on these
// would read as staleness. Extend deliberately.
const KEEP = new Set(['INDEX.md', 'NOTES.md', 'TASKS.md', 'CORRECTNESS.md', 'AUDITS.md']);
const args = new Set(process.argv.slice(2));
const FIX = args.has('--fix');
const CHECK = args.has('--check');

const slug = (s) =>
  s.replace(/\.md$/i, '')
   .replace(/[-\s]+/g, '_')
   .replace(/[^A-Za-z0-9_]/g, '')
   .toUpperCase() + '.md';

const firstCommitDate = (f) => {
  try {
    return execSync(`git log --diff-filter=A --follow --format=%cs -- "${DOCS}/${f}"`,
      { encoding: 'utf8' }).trim().split('\n').pop();
  } catch { return null; }
};

const norm = (f) => {
  if (KEEP.has(f)) {return null;}
  let m = f.match(/^(\d{4})-(\d{2})-(\d{2})_(.+)$/);       // dated, maybe bad slug
  if (m) {const t = `${m[1]}-${m[2]}-${m[3]}_${slug(m[4])}`; return t === f ? null : t;}
  m = f.match(/^(\d{4})\.(\d{2})\.(\d{2})-(.+)$/);            // dotted date
  if (m) {return `${m[1]}-${m[2]}-${m[3]}_${slug(m[4])}`;}
  const d = firstCommitDate(f);                              // undated → commit date
  return d ? `${d}_${slug(f)}` : null;
};

const plan = readdirSync(DOCS)
  .filter((f) => f.endsWith('.md'))
  .map((f) => [f, norm(f)])
  .filter(([, t]) => t);

if (CHECK) {
  for (const [f] of plan) {console.log(`off-spec: ${f}`);}
  process.exit(plan.length ? 1 : 0);
}

for (const [f, t] of plan) {console.log(`${f}  ->  ${t}`);}
console.log(`\n${plan.length} rename(s)`);
if (!FIX) {process.exit(0);}

for (const [f, t] of plan) {
  execSync(`git mv "${DOCS}/${f}" "${DOCS}/${t}"`);
}
// Rewrite bare-filename references across repo docs + changelog + INDEX.
const refs = ['_docs', 'concepts', '.agents', 'changelog.txt', 'ROADMAP.md', 'AGENTS.md', 'ARCHITECTURE.md'];
for (const path of refs) {
  let files = [];
  try {
    files = execSync(`git ls-files "${path}"`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch { continue; }
  for (const file of files) {
    if (!/\.(md|txt)$/.test(file)) {continue;}
    let s = readFileSync(file, 'utf8');
    const orig = s;
    for (const [f, t] of plan) {s = s.split(f).join(t);}
    if (s !== orig) {writeFileSync(file, s);}
  }
}
console.log('done — review with: git status');
