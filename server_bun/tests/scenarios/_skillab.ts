// Scratch: skill A/B soak - does the mend/shield/cloak path earn kills?
// SKILL_TEAM = stock (statusIntent live). Other team = skillsOff.
//   bun tests/scenarios/_skillab.ts [--wall S] [--swap]
import { mkRoom, step } from './harness.ts';
import { hmParseBin, hmScaled } from '../../../shared/heightfield.ts';
import { readFileSync } from 'node:fs';

const arg = (n: string, d: number): number => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const WALL = arg('wall', 60);
const SKILL_TEAM = process.argv.includes('--swap') ? 'alpha' : 'bravo';

const buf = readFileSync('C:/TEMP/_WEB/FPSWebTest/maps/rimrock.bin');
const spec = JSON.parse(readFileSync('C:/TEMP/_WEB/FPSWebTest/maps/rimrock.json', 'utf8'));
const field = hmScaled(hmParseBin(buf, spec.heightScale ?? 1), spec.heightScale ?? 1);

const room = mkRoom({ mode: 'headhunt', bots: 16, botSkill: 'hard' }, 'headhunt', arg('seed', 4242), false, field);

// --pool=dash,slam,... gives each bot a different skill; kills tally
// PER SKILL - one room answers "which Q earns" for the whole set.
const POOL = process.argv.find((a) => a.startsWith('--pool='))?.split('=')[1]?.split(',');
const skillOf = new Map<string, string>();
let pi = 0;
for (const p of room.players.getAllPlayers().values()) {
  const brain = (room.bots as unknown as { brains: Map<string, { skillsOff: boolean }> }).brains.get(p.id);
  if (brain) {brain.skillsOff = p.team !== SKILL_TEAM;}
  if (POOL) {p.skill = POOL[pi++ % POOL.length]!; skillOf.set(p.id, p.skill);}
}

const start = Date.now();
let t = 0;
const lastK = new Map<string, number>(), bankK = new Map<string, number>();
const lastD = new Map<string, number>(), bankD = new Map<string, number>();
for (; Date.now() - start < WALL * 1000; t += 1) {
  step(room, 1);
  for (const p of room.players.getAllPlayers().values()) {
    const lk = lastK.get(p.id) ?? 0, ld = lastD.get(p.id) ?? 0;
    if (p.kills < lk) {bankK.set(p.id, (bankK.get(p.id) ?? 0) + lk);}
    if (p.deaths < ld) {bankD.set(p.id, (bankD.get(p.id) ?? 0) + ld);}
    lastK.set(p.id, p.kills); lastD.set(p.id, p.deaths);
  }
  if (t % 60 === 59) {
    const ps = [...room.players.getAllPlayers().values()];
    const a = ps.filter((p) => p.team === 'alpha'), b = ps.filter((p) => p.team === 'bravo');
    const ka = a.reduce((s, p) => s + p.kills, 0), kb = b.reduce((s, p) => s + p.kills, 0);
    const da = a.reduce((s, p) => s + p.deaths, 0), db = b.reduce((s, p) => s + p.deaths, 0);
    console.log(`  t=${((t + 1) * 0.05).toFixed(0)}s(sim) skills=${SKILL_TEAM} alpha ${ka}/${da} bravo ${kb}/${db}`);
  }
}
for (const p of room.players.getAllPlayers().values()) {
  console.log(`  ${p.id.padEnd(16)} ${p.team} k=${p.kills} d=${p.deaths} held=${Math.round(p.heldTokens ?? 0)}`);
}
console.log(`SKILL_TEAM=${SKILL_TEAM} sim=${(t * 0.05).toFixed(0)}s wall=${((Date.now() - start) / 1000).toFixed(0)}s`);
if (skillOf.size) {
  const tally = new Map<string, { k: number; d: number }>();
  for (const p of room.players.getAllPlayers().values()) {const it = skillOf.get(p.id)!; const e = tally.get(it) ?? { k: 0, d: 0 }; e.k += (bankK.get(p.id) ?? 0) + p.kills; e.d += (bankD.get(p.id) ?? 0) + p.deaths; tally.set(it, e);}
  console.log('SKILL TALLY:', [...tally.entries()].sort((a, b) => b[1].k - a[1].k).map(([it, e]) => `${it}=${e.k}k/${e.d}d`).join(' '));
}
