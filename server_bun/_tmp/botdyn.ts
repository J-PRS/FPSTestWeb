import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { BallSim } from '../src/BallSim.ts';
import { readFileSync } from 'node:fs';
const field = BallSim.parseHeightmap(new Uint8Array(readFileSync('heightmap.bin')));
const room = new Room('t', field, 'dm', resolveMapSpec({ mode: 'dm', bots: 6 }));
room.connections.broadcast = () => 0;
const pmap = (room.players as any).players as Map<string, any>;
const shadows = (room.moveSim as any).shadows as Map<string, any>;
let skiTicks = 0, jetTicks = 0, n = 0;
const speeds: number[] = [];
for (let i = 0; i < 300; i++) { // 10s
  for (const s of room.sims) s.tick(1/30);
  for (const [id, sh] of shadows) {
    const inp = sh.sim.input;
    if (inp.skiHeld) skiTicks++;
    if (inp.jetHeld) jetTicks++;
    n++;
    speeds.push(Math.hypot(sh.sim.state.vel.x, sh.sim.state.vel.z));
  }
}
speeds.sort((a, b) => a - b);
console.log('ski%', (100 * skiTicks / n).toFixed(0), 'jet%', (100 * jetTicks / n).toFixed(0),
  'speed p50', speeds[Math.floor(n / 2)].toFixed(1), 'p90', speeds[Math.floor(n * 0.9)].toFixed(1));
