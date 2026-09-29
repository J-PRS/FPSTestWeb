import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { BallSim } from '../src/BallSim.ts';
import { readFileSync } from 'node:fs';
const field = BallSim.parseHeightmap(new Uint8Array(readFileSync('heightmap.bin')));
const room = new Room('t', field, 'dm', resolveMapSpec({ mode: 'dm', bots: 6 }));
room.connections.broadcast = () => 0;
const pmap = (room.players as any).players as Map<string, any>;
const bots = (room as any).bots;
const { hmHeight } = await import('../../shared/heightfield.ts');
for (let s = 0; s < 10; s++) {
  for (let i = 0; i < 15; i++) for (const sim of room.sims) sim.tick(1/30);
  const line = [...pmap.keys()].map(id => {
    const p = pmap.get(id)!;
    const g = hmHeight(field, p.position.x, p.position.z);
    const air = p.position.y - g;
    const sh = room.moveSim.simState(id)!;
    return `${id.replace('BOT-','')} ${p.isDead?'D':''} air=${air.toFixed(1)} vel=${Math.hypot(p.velocity.x,p.velocity.z).toFixed(1)}`;
  }).join(' | ');
  console.log(`t=${(s+1)/2}s`, line);
}
