import { Room } from '../../src/Room.ts';
import { botRng } from '../../../shared/botRand.ts';
import { losMemoReset } from '../../../shared/botLos.ts';
import { resetTauntCooldowns } from '../../../shared/botTaunts.ts';
import { simNowAdvance, simNowReset } from '../../src/simClock.ts';
import { resolveMapSpec, type MapSpec } from '../../../shared/mapSpec.ts';
import type { Heightfield } from '../../../shared/heightfield.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';
import type { PlayerState, Vec3 } from '../../src/types.ts';

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

/** Per-room seeded streams — one injectable botRand stream lives
 *  process-wide, so a seeded room's dice get eaten by ANY concurrent
 *  consumer: a zombie killFeed taunt or respawn timer from an earlier
 *  suite firing mid-run shifts every roll downstream and flakes the
 *  capper scenario only in full-suite order. The stream is bound only
 *  while this room's step() runs (and during construction), so zombie
 *  timers draw ambient Math.random instead of this room's sequence. */
const roomStreams = new WeakMap<Room, () => number>();

export function mkRoom(spec: Partial<MapSpec>, mode = '', seed = 1337, moveAuthority = false, field: Heightfield = flat): Room {
  // Squad heuristics (brains/hunts/goals/taunts) share one injectable
  // stream — ambient in production, seeded here so staged shots replay.
  // Seeded BEFORE construction: brain constructor fields (temper, orbit,
  // builder rolls) draw from this stream at `new Room` time, so injecting
  // after would leave them on the previous room's leftovers.
  const stream = lcg(seed + 3);
  botRng(stream);
  // Sight answers memoize on coordinate cells with a 1s TTL — a prior
  // room's (or map's) LOS results would otherwise read as fresh here.
  losMemoReset();
  // Taunt cooldowns and the recent-lines ring are process-global — a
  // prior room's chatter changes draw counts on the shared botRand
  // stream (a recent-hit re-rolls), which silently re-sequences every
  // behavior roll downstream.
  resetTauntCooldowns();
  // Sim clock starts at wall now; step() advances it with sim ticks so
  // respawns/cooldowns/notice TTLs track sim time, not wall speed — two
  // runs of the same genome must differ only by seed, never by how fast
  // the host happened to execute the loop.
  simNowReset();
  // Staged arenas stay sterile unless the test asks for wildlife: a
  // stepping BallSim fills the field near every player, and lunging
  // balls pop on pinned bots — leaking damage into unrelated scenarios.
  const room = new Room('t', field, mode,
    resolveMapSpec({ balls: { base: 0, perPlayer: 0, max: 0 }, ...spec }), moveAuthority);
  // Wildlife sims register in room.sims — the step helper below owns
  // their cadence deterministically.
  room.ballSim.stop();
  room.ballSim.rng = lcg(seed);
  room.creatureSim.rng = lcg(seed + 1);
  room.rng = lcg(seed + 2);
  roomStreams.set(room, stream);
  // Construction draws done — close the window so a stray timer between
  // here and the first step() can't spend this room's dice.
  botRng(Math.random);
  return room;
}

/** Roster accessors that assert instead of returning `| undefined` —
 *  index access under noUncheckedIndexedAccess would force `!` noise. */
export function firstPlayer(room: Room): PlayerState {
  const p = [...room.players.getAllPlayers().values()][0];
  if (!p) throw new Error('firstPlayer: empty roster');
  return p;
}
export function twoPlayers(room: Room): [PlayerState, PlayerState] {
  const ps = [...room.players.getAllPlayers().values()];
  if (ps.length < 2) throw new Error(`twoPlayers: expected 2, got ${ps.length}`);
  return [ps[0]!, ps[1]!];
}

/** Step the whole room N sim-ticks — ball/creature sims ride room.sims
 *  like in production, so this drives the exact same ordering. */
export function step(room: Room, ticks: number, dt = 0.05, profile?: Map<string, number>): void {
  const stream = roomStreams.get(room);
  if (stream) botRng(stream);
  try {
  for (let i = 0; i < ticks; i++) {
    for (const s of room.sims) {
      if (profile) {
        const t0 = performance.now();
        s.tick(dt);
        profile.set(s.name ?? '?', (profile.get(s.name ?? '?') ?? 0) + (performance.now() - t0));
      } else {
        s.tick(dt);
      }
    }
    simNowAdvance(dt * 1000);
  }
  } finally {
    if (stream) botRng(Math.random);
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

/** pin + silence the brain — pinned bots that keep thinking wander out of
 *  staged shots and cloak mid-test (the spawnShield flake). A frozen body
 *  stays in the sim but never thinks/moves. */
export function freeze(room: Room, playerId: string, pos: Vec3): void {
  room.bots.quiet.add(playerId);
  pin(room, playerId, pos);
}

/** Record every broadcast by type. Call `.count(type)` after stepping.
 *  Pass `now()` to stamp each message with `_s` (sim seconds) so
 *  post-run analysis can time transitions (grab→cap deltas). */
export function watch(room: Room, now?: () => number): { count: (type: string, kind?: string) => number; msgs: ServerMessage[] } {
  const msgs: ServerMessage[] = [];
  room.connections.broadcast = now
    ? (m: ServerMessage) => { msgs.push({ ...m, _s: now() } as unknown as ServerMessage); }
    : (m: ServerMessage) => { msgs.push(m); };
  return {
    msgs,
    count: (type, kind) =>
      msgs.filter((m) => m.type === type && (kind === undefined || (m as { kind?: string }).kind === kind)).length,
  };
}
