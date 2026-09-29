import { Room } from '../../src/Room.ts';
import { resolveMapSpec, type MapSpec } from '../../../shared/mapSpec.ts';
import type { Heightfield } from '../../../shared/heightfield.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';
import type { Vec3 } from '../../../shared/types.ts';

// Scenario-test harness — tiny staged arenas: spawn agents, pin them,
// step fixed ticks, assert the outcome. Finer than a soak: a soak says
// "things are smooth", these say "this interaction produced this result".

export const flat: Heightfield = { size: 4, data: new Uint8Array(16).fill(60), stride: 1 };

/** Seeded host-side RNG (LCG) — scenario rooms get reproducible spawn
 *  scatter/variant rolls instead of Math.random flake jitter. */
export function lcg(seed = 42): () => number {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

export function mkRoom(spec: Partial<MapSpec>, mode = '', seed = 1337): Room {
  const room = new Room('t', flat, mode, resolveMapSpec(spec));
  room.ballSim.rng = lcg(seed);
  room.creatureSim.rng = lcg(seed + 1);
  return room;
}

/** Step the whole room N sim-ticks. CreatureSim self-drives on a wall-clock
 *  setInterval in production — tests step it deterministically instead. */
export function step(room: Room, ticks: number, dt = 0.05): void {
  for (let i = 0; i < ticks; i++) {
    for (const s of room.sims) s.tick(dt);
    room.creatureSim.step(dt);
  }
}

/** Freeze a player at a spot. The move shadow is the truth — writing
 *  position alone is stomped by moveSim integration — and wall-clock spawn
 *  protection never lapses when a test runs hundreds of sim-ticks in
 *  milliseconds, so it's cleared here too. */
export function pin(room: Room, playerId: string, pos: Vec3): void {
  const p = room.players.getPlayer(playerId);
  if (!p) throw new Error(`pin: no player ${playerId}`);
  room.moveSim.resync(playerId, pos, 0);
  p.position = { ...pos };
  p.protectedUntil = 0;
}

/** Record every broadcast by type. Call `.count(type)` after stepping. */
export function watch(room: Room): { count: (type: string, kind?: string) => number; msgs: ServerMessage[] } {
  const msgs: ServerMessage[] = [];
  room.connections.broadcast = (m: ServerMessage) => { msgs.push(m); };
  return {
    msgs,
    count: (type, kind) =>
      msgs.filter((m) => m.type === type && (kind === undefined || (m as { kind?: string }).kind === kind)).length,
  };
}
