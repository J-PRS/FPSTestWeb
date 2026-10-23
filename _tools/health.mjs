#!/usr/bin/env node
// _tools/health.mjs — repo health report, LLM-readable markdown.
//
//   node _tools/health.mjs              # run both audits, write latest.md
//   node _tools/health.mjs --if-stale 24  # skip if latest.md is <24h old
//
// Audits:
//   knip  — dead files / unused exports / unused deps (client workspace)
//   jscpd — duplicate code across client/src + server_bun/src + shared
//
// Output: _tools/health/latest.md (gitignored — regenerated, not history).
// Advisory, not a gate: knip reports candidates, not proof of death.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT = join(REPO, '_tools/health');
const REPORT = join(OUT, 'latest.md');
const staleH = Number(process.argv[process.argv.indexOf('--if-stale') + 1]) || 0;

if (staleH > 0 && existsSync(REPORT)
    && (Date.now() - statSync(REPORT).mtimeMs) < staleH * 3600e3) {
  console.log(`[health] report fresh (<${staleH}h) — skipping`);
  process.exit(0);
}
mkdirSync(OUT, { recursive: true });

const run = (cmd, args, cwd, timeoutMs = 300e3) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26, timeout: timeoutMs, shell: process.platform === 'win32' }) };
  } catch (e) { return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`, err: e.message }; }
};

const L = [];
L.push(`# repo health — ${new Date().toISOString()}`);
L.push('');

/* ---------- knip ---------- */
L.push('## knip — dead files / unused exports / unused deps (client)');
L.push('');
{
  const r = run('node', ['node_modules/knip/bin/knip.js', '--reporter', 'json'], join(REPO, 'client'));
  let j = null;
  try { j = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { /* knip found nothing or crashed */ }
  if (!r.ok && !j) {
    L.push('```', r.out.slice(-1500) || r.err, '```');
  } else if (j) {
    const files = j.files ?? [];
    L.push(`**unused files: ${files.length}**`);
    for (const f of files.slice(0, 20)) {L.push(`- ${f}`);}
    if (files.length > 20) {L.push(`- … +${files.length - 20} more`);}
    L.push('');
    const issues = j.issues ?? {};
    for (const [kind, label] of [['exports', 'unused exports'], ['types', 'unused types'],
        ['dependencies', 'unused dependencies'], ['devDependencies', 'unused devDependencies'],
        ['unlisted', 'imports not listed as deps'], ['duplicates', 'duplicate exports']]) {
      const byFile = issues[kind] ?? {};
      const items = [];
      for (const [file, names] of Object.entries(byFile)) {
        for (const n of Object.keys(names)) {items.push(`${file}: ${n}`);}
      }
      if (items.length === 0) {continue;}
      L.push(`**${label}: ${items.length}**`);
      for (const i of items.slice(0, 15)) {L.push(`- ${i}`);}
      if (items.length > 15) {L.push(`- … +${items.length - 15} more`);}
      L.push('');
    }
  }
}

/* ---------- jscpd ---------- */
L.push('## jscpd — duplicate code (client/src + server_bun/src + shared)');
L.push('');
{
  const jd = join(OUT, 'jscpd');
  rmSync(jd, { recursive: true, force: true });
  const r = run('npx', ['-y', 'jscpd@4', 'client/src', 'server_bun/src', 'shared',
    '--min-lines', '20', '--min-tokens', '60', '--reporters', 'json', '--output', jd], REPO, 600e3);
  const jf = join(jd, 'jscpd-report.json');
  if (!existsSync(jf)) {
    L.push('```', (r.out || r.err).slice(-1500), '```');
  } else {
    const j = JSON.parse(readFileSync(jf, 'utf8'));
    const t = j.statistics?.total ?? {};
    L.push(`**duplication: ${t.percentage ?? '?'}% — ${t.clones ?? 0} clones, ${t.duplicatedLines ?? '?'} lines over ${t.sources ?? '?'} files**`);
    L.push('');
    const dups = (j.duplicates ?? [])
      .sort((a, b) => (b.lines - a.lines) || (b.tokens - a.tokens))
      .slice(0, 15);
    for (const d of dups) {
      const a = `${d.firstFile.name}:${d.firstFile.start}-${d.firstFile.end}`;
      const b = `${d.secondFile.name}:${d.secondFile.start}-${d.secondFile.end}`;
      L.push(`- ${d.lines}L/${d.tokens}t  ${a}  <->  ${b}`);
    }
    if ((j.duplicates ?? []).length > 15) {L.push(`- … +${j.duplicates.length - 15} more`);}
  }
}

L.push('');
L.push('_Advisory: knip lists candidates (re-exports, plugin indirection,');
L.push('_tools probes), not proof of death — verify before deleting._');

writeFileSync(REPORT, L.join('\n'));
console.log(`[health] wrote ${REPORT}`);
