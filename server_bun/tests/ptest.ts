/**
 * Parallel suite runner — `bun test` is single-process by design, so a
 * 24-core box runs 184 files one at a time (~4min). This shards the
 * file list across N bun processes (N = cores/2, capped) and merges
 * results: same coverage, near-linear wall speedup.
 *
 *   bun tests/ptest.ts            # run everything, auto shards
 *   bun tests/ptest.ts 8          # force 8 shards
 *   bun tests/ptest.ts -- net/    # filter args passed through as globs
 *
 * Files that bind sockets use port:0 (ephemeral) so shards can't
 * collide. WEIGHTS is expected seconds per known-heavy file (greedy
 * LPT packing); unknown files cost 0.5s. Update it when a file's real
 * duration drifts — stale weights only cost balance, not correctness.
 */

import { readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');
const TESTS = join(ROOT, 'tests');

const WEIGHTS: Record<string, number> = {
  // netbot/ is real-socket + wall-paced — the heaviest shard material.
  'netbot/ctfFlag.test.ts': 30,
  'netbot/rtcLanes.test.ts': 15,
  'netbot/roomHop.test.ts': 12,
  'netbot/harshWan.test.ts': 12,
  'netbot/wsFight.test.ts': 10,
  'netbot/rejoin.test.ts': 10,
  'netbot/deploy.test.ts': 8,
  'net/predictionChaos.test.ts': 50,
  'net/multiBridge.test.ts': 17,
  'net/bridge.test.ts': 10,
  'net/wireChaos.test.ts': 8,
  'net/claimChaos.test.ts': 6,
};

function collect(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (f.endsWith('.test.ts')) out.push(p.slice(TESTS.length + 1));
  }
  return out;
}

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const numFlag = Number(argv[0]);
const workers = Math.max(2, Math.min(
  Number.isFinite(numFlag) && numFlag > 0 ? numFlag : Math.ceil((navigator.hardwareConcurrency ?? 8) / 2),
  16,
));
const filter = dash >= 0 ? argv.slice(dash + 1) : [];

let files = collect(TESTS).sort();
if (filter.length) files = files.filter((f) => filter.some((g) => f.includes(g)));

// Greedy LPT: heaviest file → currently lightest shard.
const shards: { files: string[]; w: number }[] = Array.from({ length: workers }, () => ({ files: [], w: 0 }));
const weight = (f: string) => WEIGHTS[f] ?? WEIGHTS[f.split('/').pop()!] ?? 0.5;
for (const f of files.sort((a, b) => weight(b) - weight(a))) {
  const s = shards.reduce((m, s) => (s.w < m.w ? s : m));
  s.files.push(f);
  s.w += weight(f);
}

console.log(`ptest: ${files.length} files across ${shards.filter((s) => s.files.length).length} workers`);
const t0 = Date.now();

const procs = shards.filter((s) => s.files.length).map((s, i) =>
  Bun.spawn(['bun', 'test', ...s.files.map((f) => join(TESTS, f))], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  }),
);

let fails = 0;
const tails: string[] = [];
await Promise.all(procs.map(async (p, i) => {
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  // Keep only each shard's rollup so the merged log stays readable.
  const m = out.match(/(\d+) pass[\s\S]*?Ran \d+ tests[^\n]*/);
  const fm = out.match(/\(fail\) [^\n]+/g) ?? [];
  if (m) tails.push(`shard ${i}: ${m[0]}${fm.length ? `\n  fails: ${fm.join('\n  ')}` : ''}`);
  else tails.push(`shard ${i}: (no summary) ${out.slice(-300)} ${err.slice(-300)}`);
  if (code !== 0) fails++;
}));

console.log(tails.join('\n'));
console.log(`ptest done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${fails ? 'FAILED' : 'all green'}`);
process.exit(fails ? 1 : 0);
