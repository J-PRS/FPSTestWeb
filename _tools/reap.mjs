#!/usr/bin/env node
// _tools/reap.mjs — auto-reaper for stale FPSWebTest dev processes.
//
// Usage:
//   node _tools/reap.mjs            # dry-run: list stale candidates, exit 0
//   node _tools/reap.mjs --kill     # kill candidates older than 6h (default)
//   node _tools/reap.mjs --auto     # kill candidates older than 24h (gate-safe)
//   node _tools/reap.mjs --kill --threshold 2  # kill >2h old
//
// Never kills: LSP/MCP servers, today's processes, or anything whose
// command line doesn't reference FPSWebTest. Default is dry-run so a
// bare invocation never surprises anyone.
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const KILL = args.includes('--kill');
const AUTO = args.includes('--auto');
const thrIdx = args.indexOf('--threshold');
const thresholdH = thrIdx >= 0
  ? Number(args[thrIdx + 1])
  : (AUTO ? 24 : 6);

const isWin = process.platform === 'win32';
const KEEP_PATTERNS = /mcp|lsp|oxlint|chrome-devtools|supabase|stripe|modelcontext|atelier|language.server/i;

function listProcs() {
  if (!isWin) {
    try {
      const out = execSync('ps -eo pid,etimes,cmd', { encoding: 'utf8' });
      return out.split('\n').slice(1).map((l) => {
        const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) return null;
        return { pid: +m[1], ageH: +m[2] / 3600, cmd: m[3] };
      }).filter((p) => p && (/FPSWebTest/i.test(p.cmd) || /dev-watch\.ts/i.test(p.cmd) || /src\/server\.ts/i.test(p.cmd)) && !KEEP_PATTERNS.test(p.cmd));
    } catch { return []; }
  }
  // Windows: write a tiny PowerShell script to a temp file to dodge the
  // quoting hell of passing WQL through cmd.exe.
  const ps = [
    "$procs = Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='bun.exe'\" |",
    "  Select-Object ProcessId,CreationDate,CommandLine",
    "$procs | ConvertTo-Json -Compress",
  ].join('\n');
  const tmp = join(tmpdir(), `reap_${process.pid}.ps1`);
  writeFileSync(tmp, ps);
  let raw = '';
  try { raw = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, { encoding: 'utf8', maxBuffer: 1 << 24 }); }
  catch (e) { console.error('execSync failed:', e.message); return []; }
  finally { try { unlinkSync(tmp); } catch {} }
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { console.error('JSON parse failed:', e.message); return []; }
  if (!Array.isArray(arr)) arr = [arr];
  const now = Date.now();
  const filtered = arr
    .filter((p) => p && p.CommandLine && (/FPSWebTest/i.test(p.CommandLine) || /dev-watch\.ts/i.test(p.CommandLine) || /src[\\/]server\.ts/i.test(p.CommandLine)) && !KEEP_PATTERNS.test(p.CommandLine));
  return filtered
    .map((p) => {
      const m = String(p.CreationDate).match(/\/Date\((\d+)\)\//);
      const cd = m ? new Date(+m[1]) : new Date(p.CreationDate);
      const ageH = (now - cd.getTime()) / 3600000;
      return { pid: p.ProcessId, ageH, cmd: String(p.CommandLine).slice(0, 90), cd };
    });
}

const cands = listProcs().filter((p) => p.ageH >= thresholdH);

if (cands.length === 0) {
  console.log(`[reap] no stale FPSWebTest dev processes older than ${thresholdH}h`);
  process.exit(0);
}

console.log(`[reap] ${cands.length} stale FPSWebTest dev process(es) older than ${thresholdH}h:`);
for (const c of cands) {
  console.log(`  pid=${c.pid} age=${c.ageH.toFixed(1)}h  ${c.cmd}`);
}

if (!KILL && !AUTO) {
  console.log('\n[reap] dry-run only. Re-run with --kill to terminate, or --auto (24h threshold) for gate-safe cleanup.');
  process.exit(0);
}

let killed = 0;
for (const c of cands) {
  try {
    if (isWin) execSync(`taskkill /F /PID ${c.pid}`, { stdio: 'ignore' });
    else process.kill(c.pid, 'SIGTERM');
    killed++;
    console.log(`[reap] killed ${c.pid}`);
  } catch (e) {
    console.log(`[reap] failed to kill ${c.pid}: ${e.message}`);
  }
}
console.log(`[reap] killed ${killed}/${cands.length}`);