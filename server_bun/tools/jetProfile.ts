// Jet profile — light class stands on flat terrain and holds the jet
// button; prints height-above-stand vs time as an ASCII plot plus a raw
// sample table. Run: bun tools/jetProfile.ts [class]
import { mkRoom, flat, step } from '../tests/scenarios/harness.ts';
import { hmHeight } from '../../shared/heightfield.ts';
import { CLASS_STATS, type ArmorClass } from '../../shared/botClasses.ts';
import { ENERGY } from '../../shared/movement.ts';

const CLS = (process.argv[2] ?? 'light') as ArmorClass;
const FLOOR = hmHeight(flat, 0, 0);
// One sample per 60Hz sim step — enough to see whether the launch is
// truly immediate or still creeps under the snap band for a few ticks.
const DT = 1 / 60;
const SECS = 12;

const room = mkRoom({ bots: 0 }, 'dm');
const st = CLASS_STATS[CLS];
const p = room.players.addPlayer(`p-${CLS}`, undefined, 'none', CLS);
p.position = { x: 0, y: FLOOR + st.eyeHeight, z: 0 };
room.moveSim.track(p.id, p.position, 0, p.perk);
room.moveSim.setSpeedScale(p.id, st.speedScale);
room.moveSim.setBody(p.id, st.mass, st.eyeHeight, st.radius);
room.moveSim.setInput(p.id, { jetHeld: true });

// Sampled each tick: height above stand + tank so the dry-out reads.
const ys: number[] = [];
const es: number[] = [];
for (let i = 0; i < SECS / DT; i++) {
  ys.push(room.moveSim.simState(p.id)!.pos.y - (FLOOR + st.eyeHeight));
  es.push(room.moveSim.energyOf(p.id) ?? 0);
  step(room, 1, DT);
}

// Plot: rows = height (top to bottom), cols = time. '#' = jet firing,
// '~' = coasting on fumes after tank empty.
const W = 96, ROWS = 28;
const peak = Math.max(...ys, 1);
const colW = ys.length / W;
console.log(`${CLS} jet-from-standstill (mass ${st.mass}, drain ${ENERGY.jetDrain}/s, tank ${ENERGY.max}) — peak ${peak.toFixed(1)}m`);
// One mark per column at the body's height band.
for (let r = ROWS; r >= 0; r--) {
  const yAt = (r / ROWS) * peak, stepY = peak / ROWS;
  let line = '';
  for (let c = 0; c < W; c++) {
    const i = Math.min(ys.length - 1, Math.floor(c * colW));
    line += ys[i]! >= yAt && ys[i]! < yAt + stepY ? (es[i]! > 0 ? '#' : '~') : ' ';
  }
  console.log(`${yAt.toFixed(0).padStart(3)} |${line}`);
}
console.log(`    +${'-'.repeat(W)}`);
const marks = new Map<number, string>();
for (let c = 0; c < W; c++) { if (c % 8 === 0) marks.set(c, String(Math.round(c * colW * DT))); }
console.log(`t(s) ${[...Array(W)].map((_, c) => marks.get(c)?.[0] ?? ' ').join('')}`);

// Raw table: every tick for the launch second, then 0.25s cadence.
for (let i = 0; i < ys.length; i += (i < 90 ? 3 : 15)) {
  console.log(`${(i * DT).toFixed(2).padStart(5)}s  h=${ys[i]!.toFixed(4).padStart(7)}m  e=${es[i]!.toFixed(1)}`);
}
