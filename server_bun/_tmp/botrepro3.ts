import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { BallSim } from '../src/BallSim.ts';
import { readFileSync } from 'node:fs';
const field = BallSim.parseHeightmap(new Uint8Array(readFileSync('heightmap.bin')));
const room = new Room('t', field, 'dm', resolveMapSpec({ mode: 'dm', bots: 6 }));
room.connections.broadcast = () => 0;
const pmap = (room.players as unknown as { players: Map<string, { position: {x:number;y:number;z:number}; isDead: boolean }> }).players;
const last = new Map([...pmap.keys()].map(id => [id, { ...pmap.get(id)!.position }]));
for (let s = 0; s < 5; s++) {
  for (let i = 0; i < 30; i++) for (const sim of room.sims) sim.tick(1/30);
  const line = [...pmap.keys()].map(id => {
    const p = pmap.get(id)!;
    const d = Math.hypot(p.position.x - last.get(id)!.x, p.position.z - last.get(id)!.z);
    last.set(id, { ...p.position });
    return `${id.replace('BOT-','')}=${d.toFixed(1)}${p.isDead?'(dead)':''}`;
  }).join(' ');
  console.log(`t=${s+1}s`, line);
}
