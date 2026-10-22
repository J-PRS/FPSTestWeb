#!/usr/bin/env node
// _tools/check-cycles.mjs - ratchet guard for circular dependencies.
//
// Runs madge on client + server, counts cycles, fails if either exceeds
// the baseline in _tools/cycle-baseline.json. Prevents NEW cycles from
// landing; lowering the baseline requires a deliberate edit (with the
// cycle broken, update the number in the same commit).
//
// Usage: node _tools/check-cycles.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const baseline = JSON.parse(readFileSync(join(ROOT, '_tools', 'cycle-baseline.json'), 'utf8'));

const targets = [
  { name: 'client', cwd: join(ROOT, 'client'), args: ['--extensions', 'ts,tsx', '--ts-config', 'tsconfig.json', '--circular', 'src'] },
  { name: 'server', cwd: join(ROOT, 'server_bun'), args: ['--extensions', 'ts', '--circular', 'src'] },
];

let failed = false;
for (const t of targets) {
  const r = spawnSync('npx', ['-y', 'madge', ...t.args], { cwd: t.cwd, encoding: 'utf8', shell: true, timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/Found\s+(\d+)\s+circular/i);
  const count = m ? Number(m[1]) : null;
  const base = baseline[t.name];
  console.log(`[cycles] ${t.name}: ${count ?? '?'} (baseline ${base})`);
  if (count === null) { console.error(`[cycles] ${t.name}: could not parse madge output`); failed = true; continue; }
  if (count > base) {
    console.error(`[cycles] ${t.name}: NEW circular dependencies (${count} > ${base}). Break the cycle, or update _tools/cycle-baseline.json deliberately.`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);