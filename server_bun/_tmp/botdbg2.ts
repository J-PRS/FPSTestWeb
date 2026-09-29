import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { BallSim } from '../src/BallSim.ts';
import { readFileSync } from 'node:fs';
const field = BallSim.parseHeightmap(new Uint8Array(readFileSync('heightmap.bin')));
const room = new Room('t', field, 'dm', resolveMapSpec({ mode: 'dm', bots: 6 }));
room.connections.broadcast = () => 0;
const pmap = (room.players as any).players as Map<string, any>;
for (let s = 0; s < 6; s++) {
  const line = [...pmap.keys()].map(id => {
    const p = pmap.get(id)!;
    return `${id.replace('BOT-','')}=${p.isDead?'DEAD':`${p.position.x.toFixed(0)},${p.position.z.toFixed(0)}`}`;
  }).join(' ');
  console.log(`t=${s}s`, line);
  for (let i = 0; i < 30; i++) for (const sim of room.sims) sim.tick(1/30);
}
