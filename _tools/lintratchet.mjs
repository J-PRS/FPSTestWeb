#!/usr/bin/env node
// Diff-aware oxlint ratchet. A commit (or check.sh run) FAILS when the
// diff touches code that already carries lint warnings — the boy-scout
// rule enforced: you can't edit a warned function without cleaning it.
//
// Blame granularity:
//   - function-scoped rules (complexity, max-params, max-depth,
//     max-lines-per-function) blame the WHOLE enclosing function —
//     any edit inside it requires fixing the warning.
//   - every other rule blames the warned line itself, so new warnings
//     on added lines always trip, and touching the exact warned line
//     trips; editing around it doesn't.
//   - eslint(max-lines) is skipped: file size is sizeWatch's job, and
//     blaming a whole file would block every edit to it.
//   - non-local rules (no-unused-vars etc.) blame the whole FILE —
//     deleting the last use fires the warning on the untouched decl
//     line, the eslint-plugin-diff rulesReportedOutsideChangedLines case.
//
// Modes: default = staged diff (pre-commit). --worktree = diff vs HEAD
// (check.sh). Escape hatch: LINTRATCHET=off, or git commit --no-verify.

import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const WORKTREE = process.argv.includes('--worktree');
if (process.env.LINTRATCHET === 'off') {process.exit(0);}

const req = createRequire(new URL('../client/package.json', import.meta.url));
const ts = req('typescript');

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });
const diffArgs = WORKTREE ? ['diff', 'HEAD'] : ['diff', '--cached'];

const files = git([...diffArgs, '--name-only', '--diff-filter=ACM', '--', '*.ts', '*.tsx'])
  .split('\n').map((s) => s.trim()).filter(Boolean)
  .filter((f) => /^(client\/src|server_bun\/src|shared)\//.test(f) && !f.endsWith('.d.ts'));
if (files.length === 0) {process.exit(0);}

// Changed line ranges on the post-image side, per file.
const changedRanges = new Map();
for (const f of files) {
  const d = git([...diffArgs, '-U0', '--', f]);
  const ranges = [];
  for (const m of d.matchAll(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/g)) {
    const start = +m[1], count = m[2] === undefined ? 1 : +m[2];
    ranges.push(count === 0 ? [start, start] : [start, start + count - 1]);
  }
  changedRanges.set(f, ranges);
}

const oxlint = spawnSync(process.execPath,
  ['client/node_modules/oxlint/bin/oxlint', '--format', 'json', ...files],
  { encoding: 'utf8', maxBuffer: 64 << 20 });
let report;
try { report = JSON.parse(oxlint.stdout); } catch {
  console.error('lintratchet: oxlint produced no JSON — skipping ratchet (lint itself still gates).');
  process.exit(0);
}

const FUNCTION_RULES = new Set([
  'eslint(complexity)', 'eslint(max-lines-per-function)',
  'eslint(max-params)', 'eslint(max-depth)', 'eslint(max-statements)',
]);
const SKIP_RULES = new Set(['eslint(max-lines)']); // file size = sizeWatch's job
// Non-local rules: the diagnostic can land on an unchanged line far from
// its cause (delete the last use of a var -> warning fires on the decl).
// eslint-plugin-diff's rulesReportedOutsideChangedLines equivalent:
// blame the whole file so any edit forces the cleanup.
const NONLOCAL_RULES = new Set([
  'eslint(no-unused-vars)', 'typescript(no-unused-vars)',
  'eslint(no-redeclare)', 'eslint(no-dupe-keys)',
]);

const sfCache = new Map();
const sourceFile = (f) => {
  if (!sfCache.has(f)) {
    const text = readFileSync(f, 'utf8');
    sfCache.set(f, ts.createSourceFile(f, text,
      ts.ScriptTarget.Latest, true,
      f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
  }
  return sfCache.get(f);
};

// Innermost function-like node containing `pos`, or null at top level.
function enclosingFunction(sf, pos) {
  let tok = ts.getTokenAtPosition(sf, pos);
  for (let n = tok; n; n = n.parent) {
    if (ts.isFunctionLike(n)) {return n;}
  }
  return null;
}

const hits = [];
for (const d of report.diagnostics ?? []) {
  if (SKIP_RULES.has(d.code)) {continue;}
  const f = d.filename.replaceAll('\\', '/');
  const ranges = changedRanges.get(f);
  if (!ranges) {continue;} // warning in a file the diff didn't touch
  const label = d.labels?.[0];
  if (!label) {continue;}
  const line = label.span.line;
  let blame = [[line, line]];
  let fnName = '';
  if (NONLOCAL_RULES.has(d.code)) {
    const sf = sourceFile(f);
    const e = ts.getLineAndCharacterOfPosition(sf, sf.end).line + 1;
    blame = [[1, e]];
  } else if (FUNCTION_RULES.has(d.code)) {
    const sf = sourceFile(f);
    const fn = enclosingFunction(sf, label.span.offset);
    if (fn) {
      const s = ts.getLineAndCharacterOfPosition(sf, fn.getStart(sf)).line + 1;
      const e = ts.getLineAndCharacterOfPosition(sf, fn.getEnd()).line + 1;
      blame = [[s, e]];
      fnName = fn.name?.getText(sf) ?? '(anonymous)';
    }
  }
  const touch = ranges.some(([a, b]) => blame.some(([c, d2]) => a <= d2 && c <= b));
  if (touch) {hits.push({ f, code: d.code, line, fnName, message: d.message });}
}

if (hits.length === 0) {process.exit(0);}

console.error(`lintratchet: ${hits.length} warning(s) inside code your diff touches — fix them here:`);
const seen = new Set();
for (const h of hits) {
  const key = `${h.f}:${h.code}:${h.line}`;
  if (seen.has(key)) {continue;}
  seen.add(key);
  console.error(`  ${h.f}:${h.line}  ${h.code}${h.fnName ? `  in ${h.fnName}()` : ''}`);
  console.error(`    ${h.message}`);
}
console.error('  Rule: function-scoped warnings blame the whole function; line warnings blame the line.');
console.error('  Escape: fix the warning, or --no-verify / LINTRATCHET=off for a deliberate bypass.');
process.exit(1);
