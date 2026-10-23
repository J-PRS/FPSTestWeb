#!/usr/bin/env node
// _tools/health.mjs — repo health report, LLM-readable markdown.
//
//   node _tools/health.mjs                # full census + audits → latest.md
//   node _tools/health.mjs --if-stale 24  # skip if latest.md is <24h old
//   node _tools/health.mjs --fast         # census only, skip knip/jscpd/madge
//
// Sections:
//   repo census — procs, git dirtiness, stale branches, cycles vs
//                 baseline, TODO/FIXME, disk hogs  (cheap, every run)
//   knip        — dead files / unused exports / unused deps (client)
//   jscpd       — duplicate code across client/src + server_bun/src + shared
//
// Output: _tools/health/latest.md (gitignored — regenerated, not history).
// Advisory, not a gate: knip reports candidates, not proof of death.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
  // shell only for .cmd shims (npx); git/node run bare so %(fmt) survives
  const needsShell = process.platform === 'win32' && (cmd === 'npx' || /\.(cmd|bat)$/i.test(cmd));
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26, timeout: timeoutMs, shell: needsShell }) };
  } catch (e) { return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`, err: e.message }; }
};

const FAST = process.argv.includes('--fast');
const L = [];
L.push(`# repo health — ${new Date().toISOString()}`);
L.push('');

const mb = (n) => (n / 1e6).toFixed(1);

/* ---------- repo census ---------- */
L.push('## census');
L.push('');
{
  // zombie census — advisory list only, never kills here
  const p = run('node', ['_tools/procs.mjs'], REPO, 60e3);
  const killable = (p.out.match(/\n\s+pid=/g) ?? []).length;
  const kept = (p.out.match(/\[kept\]/g) ?? []).length;
  L.push(`- **processes**: ${killable} repo-rooted killable, ${kept} kept (dev stack/infra) — \`npm run procs\` for detail`);

  // git dirtiness + freshness
  const st = run('git', ['status', '--porcelain'], REPO);
  const dirty = st.out.split('\n').filter(Boolean).length;
  const last = run('git', ['log', '-1', '--format=%cr'], REPO).out.trim();
  const ahead = run('git', ['rev-list', '--count', 'origin/master..HEAD'], REPO).out.trim();
  L.push(`- **git**: ${dirty} uncommitted paths, ${ahead} commits unpushed, last commit ${last}`);

  // stale branches (>30d since last commit)
  const refs = run('git', ['for-each-ref', '--format=%(refname:short)|%(committerdate:unix)', 'refs/heads/'], REPO);
  const stale = refs.out.split('\n').filter(Boolean)
    .map((l) => { const [n, t] = l.split('|'); return { n, age: (Date.now() / 1e3 - Number(t)) / 86400 }; })
    .filter((b) => b.age > 30);
  L.push(`- **branches**: ${stale.length} stale >30d${stale.length ? ` — ${stale.map((b) => `${b.n} (${b.age.toFixed(0)}d)`).join(', ')}` : ''}`);

  // TODO/FIXME/HACK census over the three source trees
  let todos = 0; const todoRe = /TODO|FIXME|HACK|XXX/;
  const srcWalk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) srcWalk(p);
      else if (/\.tsx?$/.test(e.name)) {
        const m = readFileSync(p, 'utf8').match(new RegExp(todoRe, 'g'));
        if (m) {todos += m.length;}
      }
    }
  };
  for (const d of ['client/src', 'server_bun/src', 'shared']) {srcWalk(join(REPO, d));}
  L.push(`- **markers**: ${todos} TODO/FIXME/HACK/XXX across src`);

  // disk hogs — fixed list of known growable dirs
  const dirSize = (dir) => {
    let s = 0;
    const w = (d) => { try { for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) w(p); else s += statSync(p).size;
    } } catch { /* */ } };
    w(dir); return s;
  };
  const hogs = [];
  for (const d of ['client/node_modules', 'server_bun/node_modules', 'node_modules',
      'screenshots', '_tools/e2e/shots', '_tools/poseshot/shots', '_tools/tershot',
      'client/shots', '_scratch']) {
    const p = join(REPO, d);
    if (existsSync(p)) {const s = dirSize(p); if (s > 50e6) {hogs.push(`${d} ${mb(s)}MB`);}}
  }
  L.push(`- **disk**: ${hogs.join(' · ') || 'no dirs >50MB'}`);
  L.push('');
}

if (!FAST) {
/* ---------- cycles ---------- */
L.push('## cycles vs baseline');
L.push('');
{
  const r = run('node', ['_tools/check-cycles.mjs'], REPO, 360e3);
  const lines = r.out.split('\n').filter((l) => l.startsWith('[cycles]'));
  L.push('```', ...lines, '```', '');
}

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
} // !FAST

L.push('');
L.push('_Advisory: knip lists candidates (re-exports, plugin indirection,');
L.push('_tools probes), not proof of death — verify before deleting._');

writeFileSync(REPORT, L.join('\n'));
console.log(`[health] wrote ${REPORT}`);
