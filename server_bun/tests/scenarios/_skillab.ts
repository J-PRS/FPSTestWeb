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

const room = mkRoom({ mode: 'headhunt', bots: 16, botSkill: 'hard' }, 'headhunt', 4242, false, field);

for (const p of room.players.getAllPlayers().values()) {
  const brain = (room.bots as unknown as { brains: Map<string, { skillsOff: boolean }> }).brains.get(p.id);
  if (brain) {brain.skillsOff = p.team !== SKILL_TEAM;}
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
    console.log(`  t=${t + 1}s skills=${SKILL_TEAM} alpha ${ka}/${da} bravo ${kb}/${db}`);
  }
}
for (const p of room.players.getAllPlayers().values()) {
  console.log(`  ${p.id.padEnd(16)} ${p.team} k=${p.kills} d=${p.deaths} held=${Math.round(p.heldTokens ?? 0)}`);
}
console.log(`SKILL_TEAM=${SKILL_TEAM} sim=${t}s wall=${((Date.now() - start) / 1000).toFixed(0)}s`);
