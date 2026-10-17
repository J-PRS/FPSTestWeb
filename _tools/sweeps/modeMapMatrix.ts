/**
 * modeMapMatrix — every game mode on every custom (non-_t2) map, one
 * short bot warp each. The point isn't balance, it's "does this combo
 * live": does the match run, do bots move, fight, and play the mode's
 * objective, or does the field read dead (no kills, hunt ~0, crash).
 *
 *   bun _tools/sweeps/modeMapMatrix.ts [--mins N] [--only map,mode ...]
 *
 * Prints one line per combo; anomalies get a tag instead of a pass.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { $ } from 'bun';

const MAPS_DIR = resolve(import.meta.dir, '../../maps');
const SOAK = resolve(import.meta.dir, './teamSoak.ts');

const mins = ((): number => {
  const i = process.argv.indexOf('--mins');
  return i >= 0 ? Number(process.argv[i + 1]) : 2;
})();
const only = ((): Set<string> | null => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? new Set(process.argv.slice(i + 1).filter((s) => !s.startsWith('--'))) : null;
})();

// Custom = no _t2 provenance marker AND not delisted — `hidden` specs
// are dev/experimental arenas the picker excludes; soaking them would
// be measuring maps players can't reach.
const custom: string[] = [];
for (const f of readdirSync(MAPS_DIR).filter((f) => f.endsWith('.json') && f !== 'rotation.json').sort()) {
  const j = JSON.parse(readFileSync(resolve(MAPS_DIR, f), 'utf8')) as { _t2?: string; hidden?: boolean };
  if (!j._t2 && j.hidden !== true) {custom.push(f.replace('.json', ''));}
}

const MODES = ['ctf', 'tdm', 'nuggets', 'dm', 'rabbit', 'duel', 'flagrun', 'conquest'];

interface Row { map: string; mode: string; ok: boolean; line: string }
const rows: Row[] = [];
const combos = MODES.flatMap((mode) => custom.map((map) => ({ map, mode })))
  .filter((c) => !only || [`${c.map},${c.mode}`, c.map, c.mode].some((k) => only.has(k)));

// 4-deep pool — each soak is its own process; parallel lanes cut the
// matrix wall time ~4x without the rooms sharing the weaponStats ledger.
const POOL = 4;
for (let at = 0; at < combos.length; at += POOL) {
  await Promise.all(combos.slice(at, at + POOL).map(async ({ map, mode }) => {
    const r = await $`bun ${SOAK} --mode ${mode} --map ${map} --wild --seat map --mins ${mins} --wall 45 --seed 1`.quiet().nothrow();
    const out = r.stdout.toString();
    const err = (r.stderr.toString() + out).match(/Error|error TS|throw |failed|Cannot read/);
    const contact = out.match(/meanSpeed=([\d.]+)m\/s nearestFoe=(\d+)m hunt=(\d+)%/);
    const score = out.match(/score ([\d-]+)/);
    const flags = out.match(/flags  caps=(\d+)/);
    const gems = out.match(/gem: spawned=(\d+) banked=(\d+)/);
    const conq = out.match(/conq nodes a=(\d+) b=(\d+) neutral=(\d+) flips=(\d+)/);
    const kills = [...out.matchAll(/^(alpha|bravo|side)\s+\d+\s+(\d+)\s+\d+/gm)]
      .reduce((a, m) => a + Number(m[2]), 0);
    const spd = Number(contact?.[1] ?? 0), hunt = Number(contact?.[3] ?? 0);
    const tags: string[] = [];
    if (r.exitCode !== 0 || err) {tags.push(`ERR:${(err?.[0] ?? `exit${r.exitCode}`).slice(0, 40)}`);}
    // Conquest spreads a front across the lattice — hunt%/kills read low
    // by design; the liveness signals are flips (territory churn) and
    // bots reaching nodes at all (spd). Other modes keep their gauges.
    if (mode !== 'conquest' && hunt < 10) {tags.push(`hunt=${hunt}%`);}
    if (spd < 5) {tags.push(`spd=${spd}`);}
    if (mode !== 'conquest' && kills === 0) {tags.push('no-kills');}
    if (mode === 'ctf' && flags && Number(flags[1]) === 0) {tags.push('no-caps');}
    if (mode === 'nuggets' && (!gems || Number(gems[2]) === 0)) {tags.push('no-banks');}
    if (mode === 'conquest' && (!conq || Number(conq[4]) === 0)) {tags.push('no-flips');}
    const obj = mode === 'ctf' ? ` caps=${flags?.[1] ?? '-'}` : mode === 'nuggets' ? ` gems=${gems?.[2] ?? 0}/${gems?.[1] ?? 0}` : mode === 'conquest' ? ` nodes=${conq?.[1] ?? '?'}-${conq?.[2] ?? '?'} flips=${conq?.[4] ?? '?'}` : '';
    const line = `${map.padEnd(16)} ${mode.padEnd(8)} ${(score?.[1] ?? 'no-score').padEnd(8)} K=${String(kills).padEnd(3)} spd=${spd.toFixed(0).padEnd(2)} hunt=${String(hunt).padEnd(3)}%${obj}`;
    rows.push({ map, mode, ok: tags.length === 0, line });
    console.log(`${tags.length ? 'FAIL' : ' ok '} ${line}${tags.length ? '  ' + tags.join(' ') : ''}`);
  }));
}

const fails = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - fails.length}/${rows.length} combos clean; ${fails.length} flagged`);
