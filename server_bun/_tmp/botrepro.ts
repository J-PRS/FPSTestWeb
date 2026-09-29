import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { BallSim } from '../src/BallSim.ts';
import { readFileSync } from 'node:fs';
const field = BallSim.parseHeightmap(new Uint8Array(readFileSync('heightmap.bin')));
const room = new Room('t', field, 'dm', resolveMapSpec({ mode: 'dm', bots: 3 }));
room.connections.broadcast = () => 0;
const pmap = (room.players as unknown as { players: Map<string, { position: {x:number;y:number;z:number}; velocity: {x:number;y:number;z:number} }> }).players;
const ids = [...pmap.keys()];
console.log('bots:', ids, 'shadows:', ids.map(id => !!room.moveSim.simState(id)));
const p0 = ids.map(id => ({ ...pmap.get(id)!.position }));
for (let i = 0; i < 150; i++) for (const s of room.sims) s.tick(1/30);
for (const id of ids) {
  const p = pmap.get(id)!;
  const d = Math.hypot(p.position.x - p0[ids.indexOf(id)].x, p.position.z - p0[ids.indexOf(id)].z);
  console.log(id, 'moved', d.toFixed(1), 'm', 'vel', p.velocity.x.toFixed(1), p.velocity.y.toFixed(1), p.velocity.z.toFixed(1));
}
