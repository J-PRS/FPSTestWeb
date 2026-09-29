import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { BallSim } from '../src/BallSim.ts';
import { readFileSync } from 'node:fs';
const field = BallSim.parseHeightmap(new Uint8Array(readFileSync('heightmap.bin')));
const room = new Room('t', field, 'dm', resolveMapSpec({ mode: 'dm', bots: 6 }));
room.connections.broadcast = () => 0;
const pmap = (room.players as any).players as Map<string, any>;
const shadows = (room.moveSim as any).shadows as Map<string, any>;
for (let s = 0; s < 8; s++) {
  for (let i = 0; i < 15; i++) for (const sim of room.sims) sim.tick(1/30);
  console.log(`t=${(s+1)/2}s`, [...pmap.keys()].map(id => {
    const p = pmap.get(id)!;
    const sh = shadows.get(id);
    const inp = sh ? sh.sim.input : null;
    const sv = sh ? sh.sim.state.vel : null;
    const sp = sh ? sh.sim.state.pos : null;
    return `${id.replace('BOT-','')} fwd=${inp?.forward} yaw=${sh?.sim.state.yaw.toFixed(1)} svel=${sv?Math.hypot(sv.x,sv.z).toFixed(1):'?'} spos=${sp?sp.x.toFixed(0)+','+sp.z.toFixed(0):'?'} ppos=${p.position.x.toFixed(0)},${p.position.z.toFixed(0)}`;
  }).join('\n  '));
}
