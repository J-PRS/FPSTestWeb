/** One-off probe: stageProf breakdown of sim:bots at N bots, plus the
 *  shared thinkProf sub-stage dump (hunt/dest/lines/steer/sense:*). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { setSharedEnv } from '../../shared/env.ts';
import { mkRoom, step } from '../../server_bun/tests/scenarios/harness.ts';
import { simNow } from '../../server_bun/src/simClock.ts';

const f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, '../../server_bun/heightmap.bin'))), 1);
const at = (x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });
const NAMES = ['parties+flag', 'ctxBuild', 'think', 'fire', 'drive'];
const N = Number(process.argv[2] ?? 200);

const room = mkRoom({ mode: 'ctf', bots: 0, bases: { alpha: at(566, -566), bravo: at(-566, 566) } }, 'ctf', 1337, false, f);
room.bots.populate(N);
const thinkProf = new Map<string, number>();
setSharedEnv({ wallPerf: () => performance.now(), thinkProf });
step(room, 40, 0.05);
room.bots.stageProf.fill(0);
thinkProf.clear();
const t0 = performance.now();
step(room, 200, 0.05);
const wall = performance.now() - t0;
setSharedEnv({ thinkProf: undefined });
console.log(`n=${N} roomStep=${(wall / 200).toFixed(2)}ms/tick`);
console.log('  stages:', room.bots.stageProf.map((v, i) => `${NAMES[i]}=${(v / 200).toFixed(3)}`).join(' '));
console.log('  think :', [...thinkProf.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${(v / 200).toFixed(3)}`).join(' '));
