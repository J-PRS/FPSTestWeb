/** One-off probe: stageProf breakdown of sim:bots at N bots, plus the
 *  shared thinkProf sub-stage dump (hunt/dest/lines/steer/sense:*). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { setSharedEnv } from '../../shared/env.ts';
import { mkRoom, step } from '../../server_bun/tests/scenarios/harness.ts';
import { simNow } from '../../server_bun/src/simClock.ts';
import { TickFanout } from '../../server_bun/src/tickRecords.ts';

const f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, '../../server_bun/heightmap.bin'))), 1);
const at = (x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });
const NAMES = ['parties+flag', 'ctxBuild', 'think', 'fire', 'drive', 'tail'];
const N = Number(process.argv[2] ?? 200);

const room = mkRoom({ mode: 'ctf', bots: 0, bases: { alpha: at(566, -566), bravo: at(-566, 566) } }, 'ctf', 1337, false, f);
room.bots.populate(N);
const thinkProf = new Map<string, number>();
setSharedEnv({ wallPerf: () => performance.now(), thinkProf });
step(room, 40, 0.05);
room.bots.stageProf.fill(0);
thinkProf.clear();
// Per-sim split: bots' stages self-report; the rest of roomStep names
// itself here so "other sims" isn't a black box.
const simMs = new Map<string, number>();
for (const s of room.sims) {
  const orig = s.tick;
  const name = s.name ?? 'anon';
  s.tick = (dt: number) => {
    const t = performance.now();
    orig(dt);
    simMs.set(name, (simMs.get(name) ?? 0) + performance.now() - t);
  };
}
const t0 = performance.now();
step(room, 200, 0.05);
const wall = performance.now() - t0;
setSharedEnv({ thinkProf: undefined });
console.log(`n=${N} roomStep=${(wall / 200).toFixed(2)}ms/tick`);
console.log('  sims  :', [...simMs.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${(v / 200).toFixed(3)}`).join(' '));

// Records+fanout — the OTHER n²: every recipient distance-checks every
// record every tick. capSoak only times room.sims, so this phase's real
// share at scale was invisible until now. Send targets are socketless
// bots in a harness room — the CPU cost (checks+encode) is what counts.
const fan = new TickFanout({ recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0, recordsSent: 0, recordsTierSkipped: 0, bytesSent: 0, tickFramesDropped: 0 }, () => {});
const players = room.players.getAllPlayers();
let recMs = 0, fanMs = 0;
for (let i = 0; i < 200; i++) {
  let t = performance.now();
  const recs = fan.buildRecords(room, players, simNow());
  recMs += performance.now() - t; t = performance.now();
  fan.fanoutRecords(room, players, recs);
  fanMs += performance.now() - t;
  room.tickSeq++;
}
console.log(`  wire  : records=${(recMs / 200).toFixed(3)} fanout=${(fanMs / 200).toFixed(3)} ms/tick`);
console.log('  stages:', room.bots.stageProf.map((v, i) => `${NAMES[i]}=${(v / 200).toFixed(3)}`).join(' '));
console.log('  think :', [...thinkProf.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${(v / 200).toFixed(3)}`).join(' '));
