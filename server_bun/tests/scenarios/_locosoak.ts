// Scratch: LOCOMOTION soak — measure bot net-displacement rates, not
// gait. Mirrors the client LOCO column: per-bot |pos-pos@w|/w m/s at
// 1s/2s/5s/10s/15s windows (sim time). A bowl-circler reads ~0-5
// everywhere; a transiter reads high at the long windows.
//   bun tests/scenarios/_locosoak.ts [--legmin N] [--legspan N] [--mins M] [--per N]
// Sweep: --legmin/--legspan override BOT_TUNING.brain.wanderLeg* so one
// run answers "what leg length moves bots."
import { mkRoom, step } from './harness.ts';
import { hmParseBin, hmScaled } from '../../../shared/heightfield.ts';
import { BOT_TUNING } from '../../../shared/botTuning.ts';
import { readFileSync } from 'node:fs';

const arg = (n: string, d: number): number => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const LEGMIN = arg('legmin', BOT_TUNING.brain.wanderLegMin);
const LEGSPAN = arg('legspan', BOT_TUNING.brain.wanderLegSpan);
const MINS = arg('mins', 2);
const PER = arg('per', 14);
BOT_TUNING.brain.wanderLegMin = LEGMIN;
BOT_TUNING.brain.wanderLegSpan = LEGSPAN;

const buf = readFileSync('C:/TEMP/_WEB/FPSWebTest/maps/rimrock.bin');
const spec = JSON.parse(readFileSync('C:/TEMP/_WEB/FPSWebTest/maps/rimrock.json', 'utf8'));
const field = hmScaled(hmParseBin(buf, spec.heightScale ?? 1), spec.heightScale ?? 1);

const room = mkRoom({ mode: 'headhunt', bots: PER, botSkill: 'medium' }, 'headhunt', 4242, false, field);

const ring = new Map<string, { x: number; z: number; t: number }[]>();
const WINS = [1, 2, 5, 10, 15];
const TOTAL = MINS * 60;
const pathLen = new Map<string, number>();
let clock = 0;
for (let t = 0; t < TOTAL; t += 1) {
  clock += 1;
  step(room, 1);
  for (const p of room.players.getAllPlayers().values()) {
    const r = ring.get(p.id) ?? [];
    const prev = r[r.length - 1]!;
    if (prev) {pathLen.set(p.id, (pathLen.get(p.id) ?? 0) + Math.hypot(p.position.x - prev.x, p.position.z - prev.z));}
    r.push({ x: p.position.x, z: p.position.z, t: clock });
    while (r.length > 1 && clock - r[0]!.t > 16) {r.shift();}
    ring.set(p.id, r);
  }
}

const rates = (id: string): number[] => {
  const r = ring.get(id) ?? [];
  const cur = r[r.length - 1]!;
  if (!cur) {return WINS.map(() => 0);}
  return WINS.map((w): number => {
    let a: { x: number; z: number; t: number } | undefined;
    for (let i = r.length - 1; i >= 0; i -= 1) {if (r[i]!.t <= cur.t - w) {a = r[i]!; break;}}
    return a ? Math.hypot(cur.x - a.x, cur.z - a.z) / (cur.t - a.t) : 0;
  });
};

console.log(`loco soak rimrock headhunt ${PER}b ${MINS}min legs=${LEGMIN}-${LEGMIN + LEGSPAN}m`);
let lobbySum = 0, lobbyN = 0;
for (const p of room.players.getAllPlayers().values()) {
  const v = rates(p.id);
  const pl = pathLen.get(p.id) ?? 0;
  console.log(`  ${p.id.padEnd(16)} ${p.team} ${v.map((x) => x.toFixed(1).padStart(5)).join('/')}  path=${pl.toFixed(0).padStart(5)}m  net=${v[4]!.toFixed(1)}  held=${Math.round(p.heldTokens ?? 0)}`);
  if (v[4]! > 0) {lobbySum += v[4]!; lobbyN += 1;}
}
console.log(`  LOBBY 15s-net: avg=${lobbyN ? (lobbySum / lobbyN).toFixed(1) : 0} m/s  (transiter>10, bowl<5)`);
