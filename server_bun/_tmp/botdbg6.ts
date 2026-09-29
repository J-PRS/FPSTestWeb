import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { BallSim } from '../src/BallSim.ts';
import { readFileSync } from 'node:fs';
const field = BallSim.parseHeightmap(new Uint8Array(readFileSync('heightmap.bin')));
const room = new Room('t', field, 'dm', resolveMapSpec({ mode: 'dm', bots: 6 }));
room.connections.broadcast = () => 0;
const pmap = (room.players as any).players as Map<string, any>;
const bots = (room as any).bots;
// capture think outputs by wrapping each brain.think
const lastOut = new Map<string, any>();
for (const [id, b] of bots.brains) {
  const orig = b.think.bind(b);
  (b as any).think = (dt: number, c: any) => { const o = orig(dt, c); lastOut.set(id, o); return o; };
}
for (let s = 0; s < 6; s++) {
  for (let i = 0; i < 15; i++) for (const sim of room.sims) sim.tick(1/30);
  const line = [...pmap.keys()].map(id => {
    const p = pmap.get(id)!;
    const o = lastOut.get(id);
    const b = bots.brains.get(id);
    const g = (b as any).goal;
    const d = o ? Math.hypot(o.dest.x - p.position.x, o.dest.z - p.position.z) : -1;
    return `${id.replace('BOT-','')} goalDist=${d.toFixed(1)} goal=${g.x.toFixed(0)},${g.z.toFixed(0)} pos=${p.position.x.toFixed(0)},${p.position.z.toFixed(0)}`;
  }).join('\n  ');
  console.log(`t=${(s+1)/2}s\n  ${line}`);
}
