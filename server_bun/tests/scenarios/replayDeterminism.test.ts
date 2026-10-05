// Lockstep desync canary — the netcode gold standard: two identical rooms
// built from the same seed, stepped tick-for-tick, must produce identical
// state hashes every tick. ANY hidden nondeterminism (a Math.random leak,
// a wall-clock read, iteration-order dependence, float drift via wall-time
// dt) diverges a hash and names the tick it first appeared.
// Unlike the wire stateHash (which catches client/server drift), this
// catches sim-code nondeterminism before it ever reaches the wire.
import { test, expect } from 'bun:test';
import { mkRoom, flat } from './harness.ts';
import { botRng, tauntRng } from '../../../shared/botRand.ts';
import { simNowAdvance, simNowReset } from '../../src/simClock.ts';
import { computeStateHash } from '../../../shared/stateHash.ts';
import type { Room } from '../../src/Room.ts';
import type { MapSpec } from '../../../shared/mapSpec.ts';
import type { Heightfield } from '../../../shared/heightfield.ts';

function hashOf(room: Room): string {
  return computeStateHash([...room.players.getAllPlayers()].map(([id, p]) => [id, {
    x: p.position.x, y: p.position.y, z: p.position.z,
    health: p.health, isDead: p.isDead,
  }] as [string, { x: number; y: number; z: number; health: number; isDead: boolean }]));
}

const mkStream = (seed: number): (() => number) => {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
};

/** Lockstep two rooms N ticks: each room's sims run under its own seeded
 *  stream, both under the same advancing sim clock. Divergence reports the
 *  first differing tick. */
function lockstep(a: Room, b: Room, ticks: number, dt = 0.05): { divergedAt: number; hashA: string; hashB: string } {
  const streams = new Map<Room, () => number>();
  const tstreams = new Map<Room, () => number>();
  for (const room of [a, b]) {
    streams.set(room, mkStream(1337 + 3));
    tstreams.set(room, mkStream(1337 + 7));
  }
  let divergedAt = -1;
  let hashA = '', hashB = '';
  for (let i = 0; i < ticks; i++) {
    for (const room of [a, b]) {
      botRng(streams.get(room)!);
      tauntRng(tstreams.get(room)!);
      try { for (const s of room.sims) s.tick(dt); } finally { botRng(Math.random); tauntRng(Math.random); }
    }
    simNowAdvance(dt * 1000);
    hashA = hashOf(a); hashB = hashOf(b);
    if (divergedAt < 0 && hashA !== hashB) divergedAt = i;
  }
  return { divergedAt, hashA, hashB };
}

function roomPair(spec: Partial<MapSpec>, mode: string, field: Heightfield = flat): [Room, Room] {
  simNowReset();
  const a = mkRoom(spec, mode, 1337, false, field);
  const b = mkRoom(spec, mode, 1337, false, field);
  return [a, b];
}

test('replay determinism > identical seeded rooms hold identical hashes through combat', () => {
  const [a, b] = roomPair({ bots: 8 }, 'tdm');
  const r = lockstep(a, b, 600); // 30 sim-seconds
  expect(r.divergedAt).toBe(-1);
});

test('replay determinism > wildlife-heavy room stays deterministic', () => {
  const [a, b] = roomPair({ ambient: { crawler: 6, rakk: 4, gnat: 4 }, bots: 4 }, 'tdm');
  const r = lockstep(a, b, 600);
  expect(r.divergedAt).toBe(-1);
});

test('replay determinism > a different seed may diverge (sanity: the check actually fires)', () => {
  simNowReset();
  const a = mkRoom({ bots: 8 }, 'tdm', 1337, false, flat);
  const b = mkRoom({ bots: 8 }, 'tdm', 4242, false, flat);
  const r = lockstep(a, b, 600);
  expect(r.divergedAt).toBeGreaterThanOrEqual(0);
});
