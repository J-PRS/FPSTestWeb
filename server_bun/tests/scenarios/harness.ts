import { Room } from '../../src/Room.ts';
import { botRng, botRngRelease, tauntRng } from '../../../shared/botRand.ts';
// Fail loud on ambient dice INSIDE seeded windows — botRng() arms the
// strictRng gate on injection and botRngRelease() disarms it, so ambient
// draws outside a seeded stream are legal here and in unrelated suites
// sharing this process (netbot's real-socket bots draw ambient on
// purpose; an import-time arm would trip them instead).
import { losMemoReset } from '../../../shared/botLos.ts';
import { resetTauntCooldowns } from '../../../shared/botTaunts.ts';
import { simNowAdvance, simNowReset , simMs} from '../../src/simClock.ts';
import { resolveMapSpec, type MapSpec } from '../../../shared/mapSpec.ts';
import { computeStateHash } from '../../../shared/stateHash.ts';
import { decodeTickFrame, type WireTickPlayer } from '../../../shared/wire.ts';
import { TickFanout, type FanoutMetrics } from '../../src/tickRecords.ts';
import { wallNow } from '../../src/wallClock.ts';
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
  return () => { s = (s * 1_664_525 + 1_013_904_223) >>> 0; return s / 0x1_00_00_00_00; };
}

/** Per-room seeded streams — one injectable botRand stream lives
 *  process-wide, so a seeded room's dice get eaten by ANY concurrent
 *  consumer: a zombie killFeed taunt or respawn timer from an earlier
 *  suite firing mid-run shifts every roll downstream and flakes the
 *  capper scenario only in full-suite order. The stream is bound only
 *  while this room's step() runs (and during construction), so zombie
 *  timers draw ambient Math.random instead of this room's sequence. */
const roomStreams = new WeakMap<Room, () => number>();
const tauntStreams = new WeakMap<Room, () => number>();

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
  // Harnesses step() in a tight synchronous loop — worker replies never
  // dispatch while it runs. Pin MPC to its sync path or every capper
  // silently degrades to the reactive stack for the whole test.
  process.env.FPS_MPC_SYNC ??= '1';
  // Sim clock starts at wall now; step() advances it with sim ticks so
  // respawns/cooldowns/notice TTLs track sim time, not wall speed — two
  // runs of the same genome must differ only by seed, never by how fast
  // the host happened to execute the loop. Fixed epoch, not Date.now():
  // lockstep canaries build two rooms wall-milliseconds apart and the
  // shared frozen clock must agree bit-for-bit (protectedUntil windows
  // gate damage — a wall-offset base desyncs them).
  simNowReset(1_700_000_000_000);
  // Staged arenas stay sterile unless the test asks for wildlife: a
  // stepping BallSim fills the field near every player, and lunging
  // balls pop on pinned bots — leaking damage into unrelated scenarios.
  const room = new Room('t', field, mode,
    resolveMapSpec({ balls: { base: 0, perPlayer: 0, max: 0 }, ...spec }), moveAuthority);
  // Taunt draws ride a parallel stream — flavor must never consume the
  // behavior sequence (a shared cooldown ring would otherwise let one
  // room's chatter re-order another room's decision rolls).
  tauntStreams.set(room, lcg(seed + 7));
  // Wildlife sims register in room.sims — the step helper below owns
  // their cadence deterministically.
  room.ballSim.stop();
  room.ballSim.rng = lcg(seed);
  room.creatureSim.rng = lcg(seed + 1);
  room.rng = lcg(seed + 2);
  roomStreams.set(room, stream);
  // Construction draws done — close the window so a stray timer between
  // here and the first step() can't spend this room's dice.
  // Release via the tagged ambient — strictRng allows marked-ambient
  // draws (zombie timers) but throws on unmarked Math.random, i.e. a
  // consumer that was never seeded.
  botRngRelease();
  tauntRng(Math.random);
  return room;
}

/** Roster accessors that assert instead of returning `| undefined` —
 *  index access under noUncheckedIndexedAccess would force `!` noise. */
export function firstPlayer(room: Room): PlayerState {
  const p = [...room.players.getAllPlayers().values()][0];
  if (!p) {throw new Error('firstPlayer: empty roster');}
  return p;
}
export function twoPlayers(room: Room): [PlayerState, PlayerState] {
  const ps = [...room.players.getAllPlayers().values()];
  if (ps.length < 2) {throw new Error(`twoPlayers: expected 2, got ${ps.length}`);}
  return [ps[0]!, ps[1]!];
}

/** Step the whole room N sim-ticks — ball/creature sims ride room.sims
 *  like in production, so this drives the exact same ordering. */
export function step(room: Room, ticks: number, dt = 0.05, profile?: Map<string, number>): void {
  const stream = roomStreams.get(room);
  if (stream) {botRng(stream);}
  const tstream = tauntStreams.get(room);
  if (tstream) {tauntRng(tstream);}
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
    if (stream) {botRngRelease();}
    if (tstream) {tauntRng(Math.random);}
  }
}

/** The seeded streams a mkRoom'd room draws from — same objects step()
 *  injects per call, so a driver that needs code between ticks (demo
 *  recording, fuse stepping) can keep them injected continuously and get
 *  the identical draw sequence batch-stepping would produce. */
export function roomRng(room: Room): { bot?: () => number; taunt?: () => number } {
  return { bot: roomStreams.get(room), taunt: tauntStreams.get(room) };
}

/** Freeze a player at a spot. The move shadow is the truth — writing
 *  position alone is stomped by moveSim integration — and wall-clock spawn
 *  protection never lapses when a test runs hundreds of sim-ticks in
 *  milliseconds, so it's cleared here too. */
export function pin(room: Room, playerId: string, pos: Vec3): void {
  const p = room.players.getPlayer(playerId);
  if (!p) {throw new Error(`pin: no player ${playerId}`);}
  room.moveSim.resync(playerId, pos, 0);
  p.position = { ...pos };
  p.protectedUntil = simMs(0);
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

/** Headless client replica — the parity check the live client's StateHash
 *  warns run, without a browser. A replica "spectates" the room: it eats
 *  the same wireIds rosters and binary tick frames the fanout emits (the
 *  spectator tier gets the full record set, no interest-rate loss), keeps
 *  the roster the client would hold, and re-hashes it at will so a test
 *  can assert replica === server authority — the drift classes the wire
 *  is supposed to converge (health echoes, liveness edges, positions)
 *  instead of only ever being observed in production consoles. */
export interface Replica {
  /** Replica-held players — what a real client's replica would carry
   *  (specimens the wire delivered, not the room's truth). */
  readonly players: ReadonlyMap<string, { x: number; y: number; z: number; health: number; isDead: boolean }>;
  /** computeStateHash over the replica — compare against roomHash(). */
  hash(): string;
  /** computeStateHash over the room's authoritative players — the value
   *  the server's TickLoop hash broadcast ships. */
  roomHash(): string;
  /** Field-level diff vs room truth — names every diverging player so a
   *  failed parity assert reports WHO drifted, not just a hash. */
  diff(): string[];
  /** Restore the room's broadcast/frame paths and drop the spectator seat
   *  — an attached replica keeps an otherwise-idle room's spectator count
   *  non-zero, which delays room disposal. */
  detach(): void;
}

export function replica(room: Room): Replica {
  const REPLICA_ID = '__replica__';
  const held = new Map<string, { x: number; y: number; z: number; health: number; isDead: boolean }>();
  const roster = new Map<number, string>(); // wireId → playerId
  // byId lets v4 masked records inherit unchanged fields — a pool without
  // it decodes every masked group as a fresh zero slot (health reads 0).
  const pool = { slots: [] as WireTickPlayer[], byId: new Map<number, WireTickPlayer>(), resolveId: (wid: number) => roster.get(wid) };
  const prevBroadcast = room.connections.broadcast;
  const prevSendBin = room.connections.sendBinaryToPlayer;
  room.spectators.add(REPLICA_ID);
  // The record fanout lives in TickLoop, outside room.sims — a scenario
  // step() would starve the replica of frames entirely. Mount it as a
  // sim so step() drives the production ordering (input → sim → fanout).
  const fanoutMetrics: FanoutMetrics = {
    recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0,
    recordsSent: 0, recordsTierSkipped: 0, bytesSent: 0, tickFramesDropped: 0, tickFramesHeld: 0,
  };
  const fanout = new TickFanout(fanoutMetrics,
    (r, pid, reason) => r.removePlayerCompletely(pid, reason, () => {}));
  const fanoutSim = { name: 'fanout', tick: () => {
    room.tickSeq++;
    const players = room.players.getAllPlayers();
    fanout.fanoutRecords(room, players, fanout.buildRecords(room, players, wallNow()));
  } };
  room.sims.push(fanoutSim);
  room.connections.broadcast = (m: ServerMessage, exclude?: string) => {
    if (m.type === 'wireIds') {
      const w = m as { add?: Record<number, string>; remove?: number[] };
      for (const [wid, id] of Object.entries(w.add ?? {})) {roster.set(Number(wid), id);}
      for (const wid of w.remove ?? []) {roster.delete(wid);}
    } else if (m.type === 'playerLeft') {
      held.delete((m as { playerId: string }).playerId);
    }
    return prevBroadcast.call(room.connections, m, exclude);
  };
  room.connections.sendBinaryToPlayer = (playerId: string, data: Uint8Array) => {
    if (playerId !== REPLICA_ID) {return prevSendBin.call(room.connections, playerId, data);}
    const f = decodeTickFrame(data, pool);
    if (!f) {return 'gone';}
    for (let i = 0; i < f.count; i++) {
      const u = f.updates[i]!;
      if (!u.playerId) {continue;} // unresolved wireId — roster arrives on its own event
      held.set(u.playerId, { x: u.position.x, y: u.position.y, z: u.position.z, health: u.health, isDead: u.isDead });
    }
    return 'sent';
  };
  const flat = (map: Map<string, { x: number; y: number; z: number; health: number; isDead: boolean }>) => map;
  return {
    players: held,
    hash: () => computeStateHash(flat(new Map(held))),
    roomHash: () => {
      const truth = new Map<string, { x: number; y: number; z: number; health: number; isDead: boolean }>();
      for (const [id, p] of room.players.getAllPlayers()) {
        truth.set(id, { x: p.position.x, y: p.position.y, z: p.position.z, health: p.health, isDead: p.isDead });
      }
      return computeStateHash(truth);
    },
    diff: () => {
      const out: string[] = [];
      const truth = new Map([...room.players.getAllPlayers()].map(([id, p]) => [id, p]));
      for (const id of new Set([...held.keys(), ...truth.keys()])) {
        const hp = held.get(id);
        const tp = truth.get(id);
        if (!hp || !tp) {
          if (hp !== undefined || tp !== undefined) {out.push(`${id}: replica=${hp ? 'held' : 'missing'} room=${tp ? 'live' : 'gone'}`);}
          continue;
        }
        if (Math.round(hp.x) !== Math.round(tp.position.x) || Math.round(hp.y) !== Math.round(tp.position.y) || Math.round(hp.z) !== Math.round(tp.position.z)) {
          out.push(`${id}: pos replica(${hp.x.toFixed(1)},${hp.y.toFixed(1)},${hp.z.toFixed(1)}) room(${tp.position.x.toFixed(1)},${tp.position.y.toFixed(1)},${tp.position.z.toFixed(1)})`);
        }
        // Compare through the wire transform — health lands as a u16
        // (Math.round), so a float truth straddling a bucket edge is
        // parity, not drift. Mirrors computeStateHash's quantization.
        if (Math.floor(Math.round(hp.health) / 4) !== Math.floor(Math.round(tp.health) / 4)) {
          out.push(`${id}: health replica=${hp.health} room=${tp.health}`);
        }
        if (hp.isDead !== tp.isDead) {out.push(`${id}: isDead replica=${hp.isDead} room=${tp.isDead}`);}
      }
      return out;
    },
    detach: () => {
      room.spectators.delete(REPLICA_ID);
      const i = room.sims.indexOf(fanoutSim);
      if (i !== -1) {room.sims.splice(i, 1);}
      room.connections.broadcast = prevBroadcast;
      room.connections.sendBinaryToPlayer = prevSendBin;
    },
  };
}
