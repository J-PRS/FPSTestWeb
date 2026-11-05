/**
 * weaponLadder.ts — fills weapon_results.jsonl with mirrored matches so
 * weaponRank.ts can ladder the whole pool. Each pool weapon draws
 * --foes N distinct opponents (seeded, mirrored --mix so no side skew),
 * then you run weaponRank for the table. Matches append to the same
 * ledger teamSoak writes, so hand-run mirrors mix in too.
 *
 *   bun _tools/sweeps/weaponLadder.ts                # ~2 foes/weapon, short runs
 *   bun _tools/sweeps/weaponLadder.ts --foes 3 --mins 20 --wall 20
 *   bun _tools/sweeps/weaponRank.ts
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { WeaponType, WEAPONS } from '../../shared/weapons.ts';

const arg = (n: string, d: string): string => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1]! : d; };
const has = (n: string): boolean => process.argv.includes('--' + n);
const FOES = Number(arg('foes', '2'));
const MINS = arg('mins', '15');
const WALL = arg('wall', '15');
const MAP = arg('map', 'rimrock');
const MODE = arg('mode', 'tdm');
const PER = arg('per', '10');
const BASE_SEED = Number(arg('seed', '1'));
const DRY = has('dry');

// Same pool teamSoak --cycle uses: kill weapons only (utilities are
// measurable only as side-effects, not primaries).
const UTILITY_WTS = new Set<number>([
  WeaponType.ClusterBomblet, WeaponType.MRVBomblet, WeaponType.Slam,
  WeaponType.HealBeam, WeaponType.Repair, WeaponType.HealGrenade,
  WeaponType.ArmorGrenade, WeaponType.SatchelCharge, WeaponType.EMP,
  WeaponType.Concussion, WeaponType.Hook,
]);
const POOL = (Object.keys(WEAPONS).map(Number) as WeaponType[]).filter((w) => !UTILITY_WTS.has(w));

// Seeded rng so a rerun replays the same pairings (adds --seed math to
// dedupe across runs if you want a second pass).
let s = BASE_SEED || 1;
const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

const seen = new Set<string>();
const pairs: [WeaponType, WeaponType][] = [];
for (const w of POOL) {
  const chosen = new Set<number>([w]);
  for (let f = 0; f < FOES; f++) {
    let o = POOL[Math.floor(rnd() * POOL.length)]!;
    for (let g = 0; g < 40 && chosen.has(o); g++) {o = POOL[Math.floor(rnd() * POOL.length)]!;}
    if (chosen.has(o)) {continue;}
    chosen.add(o);
    const key = [Math.min(w, o), Math.max(w, o)].join('-');
    if (!seen.has(key)) {seen.add(key); pairs.push([w, o]);}
  }
}

console.log(`${POOL.length} weapons x ~${FOES} foes -> ${pairs.length} unique matches (mins=${MINS} wall=${WALL}/match)`);
const soak = resolve(import.meta.dir, 'teamSoak.ts');
let done = 0;
for (const [a, b] of pairs) {
  const mi = done++;
  const cmd = ['--alpha', WeaponType[a], '--bravo', WeaponType[b], '--mix', '--per', PER,
    '--mode', MODE, '--map', MAP, '--mins', MINS, '--wall', WALL, '--seed', String(BASE_SEED * 1000 + mi)];
  if (DRY) {console.log('bun teamSoak.ts ' + cmd.join(' ')); continue;}
  const r = spawnSync(process.execPath, [soak, ...cmd], { stdio: 'inherit', cwd: process.cwd() });
  if (r.status !== 0) {console.error(`match ${WeaponType[a]} vs ${WeaponType[b]} exited ${r.status}`);}
}
console.log(DRY ? `${pairs.length} commands` : `${done}/${pairs.length} matches appended -> run weaponRank.ts`);
