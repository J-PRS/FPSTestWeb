// Scratch: belt A/B soak - is the deployables actually worth it?
// ALPHA = deploy-blind (pickDeploy patched off). BRAVO = stock (deploy on).
// Same map, same seed, same roster: the K/D delta is the deployable's value.
//   bun tests/scenarios/_deployab.ts [--mins M] [--swap]  (--swap flips which side has belts)
import { mkRoom, step } from './harness.ts';
import { hmParseBin, hmScaled } from '../../../shared/heightfield.ts';
import { readFileSync } from 'node:fs';

const arg = (n: string, d: number): number => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const WALL = arg('wall', 60); // wall-clock seconds - sim runs as fast as it can
const SWAP = process.argv.includes('--swap');
const DEPLOY_TEAM = SWAP ? 'alpha' : 'bravo';

const buf = readFileSync('C:/TEMP/_WEB/FPSWebTest/maps/rimrock.bin');
const spec = JSON.parse(readFileSync('C:/TEMP/_WEB/FPSWebTest/maps/rimrock.json', 'utf8'));
const field = hmScaled(hmParseBin(buf, spec.heightScale ?? 1), spec.heightScale ?? 1);

const room = mkRoom({ mode: 'headhunt', bots: 16, botSkill: "hard" }, 'headhunt', arg('seed', 4242), false, field);

// Two modes: --off = control (deploy vs deploy-blind), default = trigger
// A/B (both deploy, one team LOOSE: 8-18s cd + 60m objective radius vs
// stock 28-48s + 15m). --loose=alpha|bravo picks the loose side.
// All brains forced builder so every bot carries the kit for the A/B.
const OFF = process.argv.includes('--off');
const LOOSE = process.argv.find((a) => a.startsWith('--loose='))?.split('=')[1] ?? 'bravo';
// Item A/B: --kindA=turret --kindB=mine forces each team's deploy kind.
// --pool=A,B,C pins each bot to a different kind; kills tally PER KIND.
const POOL = process.argv.find((a) => a.startsWith('--pool='))?.split('=')[1]?.split(',');
const kindOf = new Map<string, string>();
const KA = process.argv.find((a) => a.startsWith('--kindA='))?.split('=')[1];
const KB = process.argv.find((a) => a.startsWith('--kindB='))?.split('=')[1];
let pi = 0;
for (const p of room.players.getAllPlayers().values()) {
  const brain = (room.bots as unknown as { brains: Map<string, { pickDeploy: () => boolean; builder: boolean; deployCdLo: number; deployCdSpan: number; deployObjR: number; deployForce: string | undefined }> }).brains.get(p.id);
  if (!brain) {continue;}
  brain.builder = true;
  if (POOL) {brain.deployForce = POOL[pi++ % POOL.length]!; kindOf.set(p.id, brain.deployForce);}
  else if (KA && KB) {brain.deployForce = p.team === 'alpha' ? KA : KB;}
  if (OFF && p.team !== DEPLOY_TEAM) {brain.pickDeploy = (): never => undefined as never;}
  if (!OFF && p.team === LOOSE) {brain.deployCdLo = 8; brain.deployCdSpan = 10; brain.deployObjR = 60;}
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
    console.log(`  t=${((t + 1) * 0.05).toFixed(0)}s(sim) ${OFF ? 'deploy=' + DEPLOY_TEAM : 'loose=' + LOOSE} alpha ${ka}/${da} bravo ${kb}/${db}`);
  }
}
const ps = [...room.players.getAllPlayers().values()];
for (const p of ps) {
  console.log(`  ${p.id.padEnd(16)} ${p.team} k=${p.kills} d=${p.deaths} held=${Math.round(p.heldTokens ?? 0)}`);
}
console.log(`DEPLOY_TEAM=${DEPLOY_TEAM} sim=${(t * 0.05).toFixed(0)}s wall=${((Date.now() - start) / 1000).toFixed(0)}s (belt side's kill advantage = the lever's real value)`);
if (kindOf.size) {
  const tally = new Map<string, { k: number; d: number }>();
  for (const p of ps) {const it = kindOf.get(p.id)!; const e = tally.get(it) ?? { k: 0, d: 0 }; e.k += (bankK.get(p.id) ?? 0) + p.kills; e.d += (bankD.get(p.id) ?? 0) + p.deaths; tally.set(it, e);}
  console.log('KIND TALLY:', [...tally.entries()].sort((a, b) => b[1].k - a[1].k).map(([it, e]) => `${it}=${e.k}k/${e.d}d`).join(' '));
}
