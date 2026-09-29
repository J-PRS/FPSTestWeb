import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { BallSim } from '../src/BallSim.ts';
import { readFileSync } from 'node:fs';
const field = BallSim.parseHeightmap(new Uint8Array(readFileSync('heightmap.bin')));
const room = new Room('t', field, 'dm', resolveMapSpec({ mode: 'dm', bots: 6 }));
room.connections.broadcast = () => 0;
const pmap = (room.players as any).players as Map<string, any>;
const shadows = (room.moveSim as any).shadows as Map<string, any>;
const { hmHeight } = await import('../../shared/heightfield.ts');
// find the frozen one after 2s
for (let i = 0; i < 60; i++) for (const s of room.sims) s.tick(1/30);
for (const [id, sh] of shadows) {
  const p = pmap.get(id)!;
  const sim = sh.sim;
  const g = hmHeight(field, sim.state.pos.x, sim.state.pos.z);
  console.log(id, 'spos', sim.state.pos.x.toFixed(1), sim.state.pos.y.toFixed(1), sim.state.pos.z.toFixed(1),
    'g', g.toFixed(1), 'onG', sim.state.onGround, 'input', JSON.stringify(sim.input),
    'energy', sh.energy.toFixed(0), 'acc', (sim as any).acc?.toFixed?.(3), 'vel', JSON.stringify(sim.state.vel));
}
