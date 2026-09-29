import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { BallSim } from '../src/BallSim.ts';
import { readFileSync } from 'node:fs';
const field = BallSim.parseHeightmap(new Uint8Array(readFileSync('heightmap.bin')));
const room = new Room('t', field, 'dm', resolveMapSpec({ mode: 'dm', bots: 6 }));
room.connections.broadcast = () => 0;
const pmap = (room.players as unknown as { players: Map<string, any> }).players;
const bots = (room as any).bots;
// tick 1s then dump brain internals
for (let i = 0; i < 30; i++) for (const s of room.sims) s.tick(1/30);
for (const [id, brain] of bots.brains) {
  const p = pmap.get(id)!;
  const g = (brain as any).goal;
  const wp = (brain as any).wanderWp;
  console.log(id, 'pos', p.position.x.toFixed(1), p.position.z.toFixed(1),
    'dead', p.isDead, 'goal', g.x.toFixed(1), g.z.toFixed(1),
    'wp', wp.x.toFixed(1), wp.z.toFixed(1),
    'thinkT', (brain as any).thinkT.toFixed(2), 'wanderT', (brain as any).wanderT.toFixed(2),
    'hunt', (brain as any).hunt?.id ?? 'none');
}
