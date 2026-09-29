import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { BallSim } from '../src/BallSim.ts';
import { readFileSync } from 'node:fs';
const field = BallSim.parseHeightmap(new Uint8Array(readFileSync('heightmap.bin')));
const room = new Room('t', field, 'dm', resolveMapSpec({ mode: 'dm', bots: 6 }));
room.connections.broadcast = () => 0;
const pmap = (room.players as any).players as Map<string, any>;
for (const id of pmap.keys()) {
  const p = pmap.get(id)!;
  console.log(id, 'spawn', p.position.x.toFixed(1), p.position.y.toFixed(1), p.position.z.toFixed(1));
}
// track y for the stuck ones over first 3s
const order = [...pmap.keys()];
for (let s = 0; s < 6; s++) {
  for (let i = 0; i < 15; i++) for (const sim of room.sims) sim.tick(1/30);
  console.log(`t=${(s+1)/2}s`, order.map(id => `${id.replace('BOT-','')} y=${pmap.get(id)!.position.y.toFixed(1)}`).join(' '));
}
