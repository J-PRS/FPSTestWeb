// Scratch: belt A/B soak - is the belt lob actually worth using?
// ALPHA = belt-blind (pickBelt patched off). BRAVO = stock (belt on).
// Same map, same seed, same roster: the K/D delta is the belt's value.
//   bun tests/scenarios/_beltab.ts [--mins M] [--swap]  (--swap flips which side has belts)
import { mkRoom, step } from './harness.ts';
import { hmParseBin, hmScaled } from '../../../shared/heightfield.ts';
import { readFileSync } from 'node:fs';

const arg = (n: string, d: number): number => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const WALL = arg('wall', 60); // wall-clock seconds - sim runs as fast as it can
const SWAP = process.argv.includes('--swap');
const BELT_TEAM = SWAP ? 'alpha' : 'bravo';
// Trigger A/B: WIDE team gets a 5-45m window + 6s cooldown, stock team
// keeps 10-35m + 9s. --wide=alpha|bravo picks who runs wide; the delta
// answers "what range actually earns lobs" - the winner becomes default.

const buf = readFileSync('C:/TEMP/_WEB/FPSWebTest/maps/rimrock.bin');
const spec = JSON.parse(readFileSync('C:/TEMP/_WEB/FPSWebTest/maps/rimrock.json', 'utf8'));
const field = hmScaled(hmParseBin(buf, spec.heightScale ?? 1), spec.heightScale ?? 1);

const room = mkRoom({ mode: 'headhunt', bots: 16, botSkill: "hard" }, 'headhunt', 4242, false, field);

// Two modes: --off = control (belt-on vs belt-blind), default = trigger
// A/B (both belt, one team runs a WIDE 5-45m/6s window vs stock 10-35m/9s).
// --wide=alpha|bravo picks the wide side; winner's window becomes default.
// Item A/B: --itemA=Grenade --itemB=ImpactGrenade forces each team's belt
// slot. --pool=A,B,C gives each bot a different item round-robin and
// tallies kills PER ITEM - one room answers "which earns" for the list.
const POOL = process.argv.find((a) => a.startsWith('--pool='))?.split('=')[1]?.split(',');
const itemOf = new Map<string, string>();
const IA = process.argv.find((a) => a.startsWith('--itemA='))?.split('=')[1];
const IB = process.argv.find((a) => a.startsWith('--itemB='))?.split('=')[1];
if (POOL || (IA && IB)) {
  let i = 0;
  for (const p of room.players.getAllPlayers().values()) {
    const lo = (room.bots as unknown as { loadouts: Map<string, { belt: string }> }).loadouts.get(p.id);
    if (!lo) {continue;}
    const item = POOL ? POOL[i++ % POOL.length]! : (p.team === 'alpha' ? IA! : IB!);
    lo.belt = item as never;
    if (POOL) {itemOf.set(p.id, item);}
  }
}
const OFF = process.argv.includes('--off');
const WIDE = process.argv.find((a) => a.startsWith('--wide='))?.split('=')[1] ?? 'bravo';
for (const p of room.players.getAllPlayers().values()) {
  const brain = (room.bots as unknown as { brains: Map<string, { pickBelt: () => boolean; beltMin: number; beltMax: number; beltCd: number }> }).brains.get(p.id);
  if (!brain) {continue;}
  if (OFF && p.team !== BELT_TEAM) {brain.pickBelt = (): boolean => false;}
  if (!OFF && p.team === WIDE) {brain.beltMin = 5; brain.beltMax = 45; brain.beltCd = 6;}
}

const start = Date.now();
let t = 0;
for (; Date.now() - start < WALL * 1000; t += 1) {
  step(room, 1);
  if (t % 60 === 59) {
    const ps = [...room.players.getAllPlayers().values()];
    const a = ps.filter((p) => p.team === 'alpha'), b = ps.filter((p) => p.team === 'bravo');
    const ka = a.reduce((s, p) => s + p.kills, 0), kb = b.reduce((s, p) => s + p.kills, 0);
    const da = a.reduce((s, p) => s + p.deaths, 0), db = b.reduce((s, p) => s + p.deaths, 0);
    console.log(`  t=${t + 1}s ${OFF ? 'belt=' + BELT_TEAM : 'wide=' + WIDE} alpha ${ka}/${da} bravo ${kb}/${db}`);
  }
}
const ps = [...room.players.getAllPlayers().values()];
for (const p of ps) {
  console.log(`  ${p.id.padEnd(16)} ${p.team} k=${p.kills} d=${p.deaths} held=${Math.round(p.heldTokens ?? 0)}`);
}
console.log(`BELT_TEAM=${BELT_TEAM} sim=${t}s wall=${((Date.now() - start) / 1000).toFixed(0)}s (belt side's kill advantage = the lever's real value)`);
if (itemOf.size) {
  const tally = new Map<string, { k: number; d: number }>();
  for (const p of ps) {const it = itemOf.get(p.id)!; const e = tally.get(it) ?? { k: 0, d: 0 }; e.k += p.kills; e.d += p.deaths; tally.set(it, e);}
  console.log('ITEM TALLY:', [...tally.entries()].sort((a, b) => b[1].k - a[1].k).map(([it, e]) => `${it}=${e.k}k/${e.d}d`).join(' '));
}
