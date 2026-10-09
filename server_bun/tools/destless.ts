// Dest-less bot probe: what share of sim-time does each living bot run
// with NO routing goal (brain's dest null)? The sheep meter's idle
// channel charges these ticks hardest — this measures whether that's
// a rare think-gap or a real no-goal population.
//
//   bun tools/destless.ts [--mode ctf] [--map raindance] [--bots 16] [--hours 1] [--seed 4242]

import { readFileSync } from 'node:fs';
import { mkRoom, step } from '../tests/scenarios/harness.ts';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { simNow } from '../src/simClock.ts';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};

const MODE = arg('mode', 'ctf');
const MAP = arg('map', 'raindance');
const BOTS = Number(arg('bots', '16'));
const HOURS = Number(arg('hours', '1'));
const SEED = Number(arg('seed', '4242'));
const DT = 0.05;

const mapJson = JSON.parse(readFileSync(`${import.meta.dir}/../../maps/${MAP}.json`, 'utf8')) as {
  bases?: { alpha: { x: number; z: number }; bravo?: { x: number; z: number } };
  terrain?: string;
};
const field = hmParseBin(new Uint8Array(readFileSync(
  `${import.meta.dir}/../../maps/${mapJson.terrain ?? MAP + '.bin'}`)));

const base = (b?: { x: number; z: number }) => b ? { x: b.x, y: hmHeight(field, b.x, b.z), z: b.z } : undefined;
const room = mkRoom({
  mode: MODE,
  bots: BOTS, botFill: BOTS,
  bases: { alpha: base(mapJson.bases?.alpha) ?? { x: 0, y: hmHeight(field, 0, 0), z: 0 },
           bravo: base(mapJson.bases?.bravo) ?? { x: 80, y: hmHeight(field, 80, 80), z: 80 } },
}, MODE, SEED, false, field);
// mkRoom leaves mapSrc '' — attach() then skips the baked interior boxes.
room.mapSrc = MAP;
if (mapJson.interiors?.length) room.spec.interiors = mapJson.interiors;
room.structs.attach();

const ticks = Math.round((HOURS * 3600) / DT);
const noGoal: Record<string, number> = {};
const aliveT: Record<string, number> = {};
const streak: Record<string, number> = {};
const maxStreak: Record<string, number> = {};
const lastPos: Record<string, { x: number; z: number }> = {};
const travel: Record<string, number> = {};
// 40m-cell dwell histogram per bot — where grinders actually spend time.
const dwell: Record<string, Map<string, number>> = {};
const w0 = Date.now();
for (let t = 0; t < ticks; t++) {
  step(room, 1, DT);
  room.messages.respawnTick(simNow());
  for (const p of room.players.getAllPlayers().values()) {
    if (p.isDead) { streak[p.id] = 0; lastPos[p.id] = { x: p.position.x, z: p.position.z }; continue; }
    aliveT[p.id] = (aliveT[p.id] ?? 0) + DT;
    const lp = lastPos[p.id];
    if (lp) travel[p.id] = (travel[p.id] ?? 0) + Math.hypot(p.position.x - lp.x, p.position.z - lp.z);
    lastPos[p.id] = { x: p.position.x, z: p.position.z };
    const cell = `${Math.round(p.position.x / 40) * 40},${Math.round(p.position.z / 40) * 40}`;
    (dwell[p.id] ??= new Map()).set(cell, (dwell[p.id]!.get(cell) ?? 0) + DT);
    if (room.bots.debugDest(p.id) === null) {
      noGoal[p.id] = (noGoal[p.id] ?? 0) + DT;
      streak[p.id] = (streak[p.id] ?? 0) + DT;
      if (streak[p.id] > (maxStreak[p.id] ?? 0)) maxStreak[p.id] = streak[p.id];
    } else streak[p.id] = 0;
  }
}

const rows = Object.keys(aliveT).map(id => ({
  id,
  alive: aliveT[id],
  goalless: noGoal[id] ?? 0,
  pct: (noGoal[id] ?? 0) / aliveT[id] * 100,
  maxStreak: maxStreak[id] ?? 0,
  mps: (travel[id] ?? 0) / aliveT[id],
})).sort((a, b) => b.pct - a.pct);
console.log(`dest-less probe — mode=${MODE} map=${MAP} bots=${BOTS} sim=${HOURS}h wall=${((Date.now() - w0) / 1000).toFixed(0)}s`);
for (const r of rows) {
  console.log(`  ${r.id}: ${r.pct.toFixed(1)}% goal-less · ${r.mps.toFixed(1)} m/s avg travel · worst streak ${r.maxStreak.toFixed(1)}s`);
}
const avg = rows.reduce((n, r) => n + r.pct, 0) / (rows.length || 1);
console.log(`  roster mean ${avg.toFixed(1)}%`);
for (const r of rows) {
  const d = dwell[r.id]; if (!d) continue;
  const top = [...d.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] > r.alive * 0.3) console.log(`  ${r.id} spent ${(top[1] / r.alive * 100).toFixed(0)}% of life in cell ${top[0]}`);
}
