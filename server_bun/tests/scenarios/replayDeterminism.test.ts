// Lockstep desync canary — the netcode gold standard: two identical rooms
// built from the same seed, stepped tick-for-tick, must produce identical
// state hashes every tick. ANY hidden nondeterminism (a Math.random leak,
// a wall-clock read, iteration-order dependence, float drift via wall-time
// dt) diverges a hash and names the tick it first appeared.
// Unlike the wire stateHash (which catches client/server drift), this
// catches sim-code nondeterminism before it ever reaches the wire.
import { test, expect } from 'bun:test';
import { mkRoom, flat } from './harness.ts';
import { botRng, botRngRelease, tauntRng } from '../../../shared/botRand.ts';
import { simNowAdvance, simNowReset } from '../../src/simClock.ts';
import { computeStateHash } from '../../../shared/stateHash.ts';
import type { Room } from '../../src/Room.ts';
import type { MapSpec } from '../../../shared/mapSpec.ts';
import type { Heightfield } from '../../../shared/heightfield.ts';

function hashOf(room: Room): string {
  // Players ride computeStateHash's quantizer; everything else is plain
  // scalar sim objects — a sorted JSON dump folds balls/crawlers/flags
  // (incl. per-entity rng state) into the same per-tick fingerprint.
  const players = computeStateHash([...room.players.getAllPlayers()].map(([id, p]) => [id, {
    x: p.position.x, y: p.position.y, z: p.position.z,
    health: p.health, isDead: p.isDead,
  }] as [string, { x: number; y: number; z: number; health: number; isDead: boolean }]));
  const rest = JSON.stringify([
    [...(room.ballSim?.balls.values() ?? [])].sort((a, b) => a.id - b.id),
    [...(room.creatureSim?.crawlers.values() ?? [])].sort((a, b) => a.id - b.id),
    [...(room.flags?.flags.values() ?? [])].sort((a, b) => (a.team < b.team ? -1 : 1)),
  ]);
  let h = 0x81_1C_9D_C5;
  for (const s of players + rest) {
    h ^= s.charCodeAt(0); h = Math.imul(h, 0x01_00_01_93) >>> 0;
  }
  return `${h.toString(16)  }|${  players}`;
}

const mkStream = (seed: number): (() => number) => {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1_664_525 + 1_013_904_223) >>> 0; return s / 0x1_00_00_00_00; };
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
      try { for (const s of room.sims) {s.tick(dt);} } finally { botRngRelease(); tauntRng(Math.random); }
    }
    simNowAdvance(dt * 1000);
    hashA = hashOf(a); hashB = hashOf(b);
    if (divergedAt < 0 && hashA !== hashB) {divergedAt = i;}
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

test('replay determinism > a different stream diverges (sanity: the check actually fires)', () => {
  // Brain/room-construction draws are all spawn-hash seeded now, so two
  // differently-seeded rooms on the same layout stay identical by design —
  // divergence must come from the tick stream itself. Feed room B a
  // different stream; any behavioral draw at all must split the hashes.
  simNowReset();
  const a = mkRoom({ bots: 8 }, 'tdm', 1337, false, flat);
  const b = mkRoom({ bots: 8 }, 'tdm', 1337, false, flat);
  const streams = new Map<Room, () => number>();
  const tstreams = new Map<Room, () => number>();
  streams.set(a, mkStream(1340)); streams.set(b, mkStream(4242));
  tstreams.set(a, mkStream(1344)); tstreams.set(b, mkStream(4248));
  simNowReset();
  let divergedAt = -1;
  for (let i = 0; i < 600; i++) {
    for (const room of [a, b]) {
      botRng(streams.get(room)!);
      tauntRng(tstreams.get(room)!);
      try { for (const s of room.sims) {s.tick(0.05);} } finally { botRngRelease(); tauntRng(Math.random); }
    }
    simNowAdvance(50);
    if (divergedAt < 0 && hashOf(a) !== hashOf(b)) {divergedAt = i;}
  }
  expect(divergedAt).toBeGreaterThanOrEqual(0);
});
