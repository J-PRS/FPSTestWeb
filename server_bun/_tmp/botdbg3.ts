import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { BallSim } from '../src/BallSim.ts';
import { readFileSync } from 'node:fs';
const field = BallSim.parseHeightmap(new Uint8Array(readFileSync('heightmap.bin')));
const room = new Room('t', field, 'dm', resolveMapSpec({ mode: 'dm', bots: 6 }));
room.connections.broadcast = () => 0;
const pmap = (room.players as any).players as Map<string, any>;
const bots = (room as any).bots;
const deadTicks = new Map<string, number>();
const noShadow = new Set<string>();
for (let i = 0; i < 180; i++) {
  for (const sim of room.sims) sim.tick(1/30);
  for (const id of pmap.keys()) {
    const p = pmap.get(id)!;
    if (p.isDead) deadTicks.set(id, (deadTicks.get(id) ?? 0) + 1);
    if (!room.moveSim.simState(id)) noShadow.add(id);
  }
}
for (const id of pmap.keys()) console.log(id, 'deadTicks', deadTicks.get(id) ?? 0, 'shadowless', noShadow.has(id));
