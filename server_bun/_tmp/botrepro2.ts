import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { BallSim } from '../src/BallSim.ts';
import { readFileSync } from 'node:fs';
const field = BallSim.parseHeightmap(new Uint8Array(readFileSync('heightmap.bin')));
const room = new Room('t', field, 'dm', resolveMapSpec({ mode: 'dm', bots: 6 }));
room.connections.broadcast = () => 0;
const pmap = (room.players as unknown as { players: Map<string, { position: {x:number;y:number;z:number}; isDead: boolean }> }).players;
const bots = (room as unknown as { bots: { brains: Map<string, { think(d:number,c:unknown): {dest:{x:number;z:number}; move?:object} }> } }).bots;
const p0 = new Map([...pmap.keys()].map(id => [id, { ...pmap.get(id)!.position }]));
// tick 5s
for (let i = 0; i < 150; i++) for (const s of room.sims) s.tick(1/30);
for (const [id] of pmap) {
  const p = pmap.get(id)!;
  const d = Math.hypot(p.position.x - p0.get(id)!.x, p.position.z - p0.get(id)!.z);
  const brain = [...bots.brains.keys()].includes(id);
  const b = bots.brains.get(id);
  const out = b ? b.think(0.033, { pos: p.position, vel: {x:0,y:0,z:0}, enemies: [], groundY: () => p.position.y, now: Date.now() }) : null;
  const goal = b ? (b as unknown as { goal: {x:number;z:number} }).goal : null;
  console.log(id, 'moved', d.toFixed(1), 'dead', p.isDead, 'dest', out ? `${out.dest.x.toFixed(0)},${out.dest.z.toFixed(0)}` : '-', 'goal', goal ? `${goal.x.toFixed(0)},${goal.z.toFixed(0)}` : '-', 'pos', `${p.position.x.toFixed(0)},${p.position.z.toFixed(0)}`);
}
