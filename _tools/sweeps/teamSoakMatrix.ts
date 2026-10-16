/**
 * teamSoakMatrix.ts — every primary-vs-primary teamSoak, pooled across
 * cores, reports appended to _tools/sweeps/out/teamsoak_matrix.txt.
 *
 *   bun _tools/sweeps/teamSoakMatrix.ts [--wall 60] [--mins 10] [--jobs 8]
 *                                       [--map dunes --seat map --mix ...]
 *
 * Pool is the union of WILDCARD_SLOTS near/mid/far — the guns a bot can
 * actually carry as a primary (belt throws, heals and spawned
 * submunitions are out). Unordered pairs; mirrors skipped under --mix
 * (an X-vs-X mix is symmetric by construction). Pairs already logged in
 * the output file are skipped — reruns resume where they left off.
 *
 * Parallel note: each run is its own Bun process and one core, so --jobs
 * up to the logical core count is near-linear. Saturation stretches
 * wall time per run, NOT sim time — --wall is still the truncation guard,
 * and each block's `simS` header proves the sample completed.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const has = (name: string): boolean => process.argv.includes('--' + name);

const WEAPONS = [
  'Chaingun', 'Shotgun', 'Flak', 'Lightning',
  'Disc', 'Cannon', 'GrenadeLauncher', 'Sprinkler', 'Sticky', 'PlasmaGun', 'Bombard',
  'BoltLauncher', 'Mortar', 'Railgun', 'RocketLauncher', 'MRVLauncher',
];

const OUT_DIR = resolve(import.meta.dir, 'out');
mkdirSync(OUT_DIR, { recursive: true });
const OUT = resolve(OUT_DIR, arg('out', 'teamsoak_matrix.txt'));
const WALL = arg('wall', '60');
const MINS = arg('mins', '10');
const JOBS = Math.min(Number(arg('jobs', String(Math.max(1, cpus().length - 2)))), WEAPONS.length);
const SOAK = resolve(import.meta.dir, 'teamSoak.ts');
const MIX = has('mix');

// Forward our own argv (minus knobs we encode or consume locally) —
// teamSoak picks out what it knows (--map/--seat/--ring/--berserk/...).
const extra: string[] = [];
for (let i = 2; i < process.argv.length; i += 1) {
  const v = process.argv[i]!;
  if (v === '--wall' || v === '--mins' || v === '--jobs' || v === '--out') {i += 1; continue;}
  extra.push(v);
}

// Resume: a pair counts as done only if its block reached the report
// (a killed run can leave a header with no body).
const donePairs = new Set<string>();
if (existsSync(OUT)) {
  for (const m of readFileSync(OUT, 'utf8').matchAll(/===== (\w+) vs (\w+) =====\n[\s\S]*?contact /g)) {
    donePairs.add(`${m[1]} vs ${m[2]}`);
  }
}

const queue: [string, string][] = [];
for (let i = 0; i < WEAPONS.length; i += 1) {
  for (let j = i; j < WEAPONS.length; j += 1) {
    const a = WEAPONS[i]!, b = WEAPONS[j]!;
    if (MIX && a === b) {continue;}
    if (!donePairs.has(`${a} vs ${b}`)) {queue.push([a, b]);}
  }
}

let done = 0, failed = 0;
const total = queue.length;
const t0 = Date.now();
console.log(`teamSoakMatrix: ${total} pairs to run (${donePairs.size} resumed-skipped), ${JOBS} jobs${MIX ? ' — mix, mirrors skipped' : ''}`);

const worker = async (): Promise<void> => {
  for (;;) {
    const pair = queue.shift();
    if (!pair) {return;}
    const [a, b] = pair;
    const r = await new Promise<{ code: number | null; body: string }>((res) => {
      const p = spawn('bun', [SOAK, '--alpha', a, '--bravo', b, '--wall', WALL, '--mins', MINS, ...extra]);
      let body = '';
      p.stdout.on('data', (d) => {body += d;});
      p.stderr.on('data', (d) => {body += d;});
      const kill = setTimeout(() => p.kill(), (Number(WALL) + 120) * 1000);
      p.on('close', (code) => {clearTimeout(kill); res({ code, body });});
    });
    appendFileSync(OUT, `\n===== ${a} vs ${b} =====\n${r.body}`);
    done += 1;
    if (r.code !== 0) {failed += 1;}
    const score = r.body.match(/^score (\S+)/m)?.[1] ?? 'ERR';
    const simS = r.body.match(/(\d+)s sim in ([\d.]+)s wall/)?.slice(1).join('s/') ?? '?';
    console.log(`[${done}/${total}] ${a} vs ${b}  score=${score}  sim=${simS}s${r.code !== 0 ? '  FAILED' : ''}`);
  }
};
await Promise.all(Array.from({ length: JOBS }, worker));
console.log(`done: ${done - failed}/${total} ok, ${failed} failed, ${((Date.now() - t0) / 60000).toFixed(1)}min -> ${OUT}`);
