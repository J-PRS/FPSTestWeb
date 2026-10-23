#!/usr/bin/env node
// _tools/procs.mjs — every process rooted in this repo, listed or killed.
//
//   node _tools/procs.mjs                 # list repo processes (zombie check)
//   node _tools/procs.mjs --kill          # tree-kill ALL matched, no questions
//   node _tools/procs.mjs --kill <regex>  # kill only roots matching <regex>
//                                         # (+ every descendant in their tree)
//
// Roots match on command line (repo path, tool scripts, src/server.ts).
// Descendants are found by walking the ppid map, so a bare `bun test`
// or headless chrome child with no repo path still dies with its root.
// Never kills: this script itself, its caller chain (ppid walk), or
// LSP/MCP/agent-infra processes.
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const KILL = args.includes('--kill');
const matchArg = args.find((a) => !a.startsWith('-'));
const isWin = process.platform === 'win32';
const KEEP = /mcp|lsp|language.server|modelcontext|claude|devin|windsurf|codeium|cursor|copilot|opencode/i;
const REPO = /FPSWebTest|_tools[\\/]|check\.sh|e2e[\\/]|src[\\/]server\.ts|dev-watch|netbot/i;
const rootRe = matchArg ? new RegExp(matchArg, 'i') : REPO;

function listProcs() {
  if (!isWin) {
    try {
      const out = execSync('ps -eo pid,ppid,etimes,cmd', { encoding: 'utf8' });
      return out.split('\n').slice(1).map((l) => {
        const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) return null;
        return { pid: +m[1], ppid: +m[2], ageS: +m[3], cmd: m[4] };
      }).filter(Boolean);
    } catch { return []; }
  }
  const ps = [
    "$procs = Get-CimInstance Win32_Process |",
    "  Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine",
    "$procs | ConvertTo-Json -Compress",
  ].join('\n');
  const tmp = join(tmpdir(), `procs_${process.pid}.ps1`);
  writeFileSync(tmp, ps);
  let raw = '';
  try { raw = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, { encoding: 'utf8', maxBuffer: 1 << 26 }); }
  catch (e) { console.error('procs: enum failed:', e.message); return []; }
  finally { try { unlinkSync(tmp); } catch {} }
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { console.error('procs: parse failed:', e.message); return []; }
  if (!Array.isArray(arr)) arr = [arr];
  const now = Date.now();
  return arr
    .filter((p) => p && p.CommandLine)
    .map((p) => {
      const m = String(p.CreationDate).match(/\/Date\((\d+)\)\//);
      const cd = m ? new Date(+m[1]) : new Date(p.CreationDate);
      return { pid: p.ProcessId, ppid: p.ParentProcessId, ageS: (now - cd.getTime()) / 1000, cmd: String(p.CommandLine) };
    });
}

const all = listProcs();
// Own caller chain (this script + its parent bash + ...) never dies.
const byPid = new Map(all.map((p) => [p.pid, p]));
const protected_ = new Set([process.pid]);
for (let pid = process.ppid; pid && byPid.has(pid) && !protected_.has(pid);) {
  protected_.add(pid);
  pid = byPid.get(pid).ppid;
}

// The live dev stack never dies: whatever owns :5400 (vite client) and
// :8000 (game server) is protected — plus its ancestors and descendants.
const DEV_PORTS = [5400, 8000];
function listenerPids() {
  const pids = new Set();
  try {
    const out = isWin
      ? execSync('netstat -ano -p tcp', { encoding: 'utf8' })
      : execSync(`lsof -nP -iTCP -sTCP:LISTEN -t ${DEV_PORTS.map((p) => `-i:${p}`).join(' ')}`, { encoding: 'utf8' });
    for (const l of out.split('\n')) {
      if (isWin) {
        const m = l.trim().match(/^\S+\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
        if (m && DEV_PORTS.includes(+m[1])) {pids.add(+m[2]);}
      } else if (l.trim()) {pids.add(+l.trim());}
    }
  } catch { /* no listeners / no lsof — nothing protected */ }
  return pids;
}
for (const pid of listenerPids()) {
  for (let p = pid; p && byPid.has(p) && !protected_.has(p);) {
    protected_.add(p);
    p = byPid.get(p).ppid;            // ancestors (cmd wrappers, dev-watch)
  }
}
// Descendants of the dev stack are protected too (vite children etc).
let grewP = true;
while (grewP) {
  grewP = false;
  for (const p of all) {
    if (!protected_.has(p.pid) && protected_.has(p.ppid)) { protected_.add(p.pid); grewP = true; }
  }
}

const roots = all.filter((p) => !protected_.has(p.pid) && rootRe.test(p.cmd) && !KEEP.test(p.cmd));
// Descend the ppid map: children/grandchildren of a matched root are in
// scope even when their own cmdline has no repo path (bun test, chrome).
const tree = new Map();
for (const r of roots) {tree.set(r.pid, r);}
let grew = true;
while (grew) {
  grew = false;
  for (const p of all) {
    if (tree.has(p.pid) || protected_.has(p.pid) || KEEP.test(p.cmd)) {continue;}
    if (tree.has(p.ppid)) { tree.set(p.pid, p); grew = true; }
  }
}
const victims = [...tree.values()].sort((a, b) => a.pid - b.pid);
// Matched-but-protected (dev stack, own chain) — shown as kept so the
// census still reads complete.
const kept = all.filter((p) => protected_.has(p.pid) && rootRe.test(p.cmd) && p.pid !== process.pid);

const fmt = (v) => `  pid=${v.pid} ppid=${v.ppid} age=${v.ageS < 3600 ? v.ageS.toFixed(0) + 's' : (v.ageS / 3600).toFixed(1) + 'h'}  ${v.cmd.slice(0, 110)}`;
for (const v of victims) {console.log(fmt(v));}
for (const k of kept) {console.log(`  [kept]${fmt(k)}`);}

if (victims.length === 0) {
  console.log('[procs] nothing to kill' + (matchArg ? ` matching /${matchArg}/` : ' in this repo'));
  process.exit(0);
}
if (!KILL) {
  console.log(`[procs] ${victims.length} killable (${kept.length} kept — dev stack / caller chain). --kill to terminate.`);
  process.exit(0);
}
let killed = 0;
for (const v of victims) {
  try {
    if (isWin) {execSync(`taskkill /F /PID ${v.pid}`, { stdio: 'ignore' });}
    else {process.kill(v.pid, 'SIGKILL');}
    killed++;
  } catch { /* already dead */ }
}
console.log(`[procs] killed ${killed}/${victims.length}`);
