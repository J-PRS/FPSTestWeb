import { describe, it, expect } from 'bun:test';
import { WeaponType } from '../../../shared/weapons.ts';
import { mkRoom, step, pin, freeze, watch } from './harness.ts';
import type { Room } from '../../src/Room.ts';
import type { PlayerState } from '../../src/types.ts';

// Tribes Rabbit (T2 rules): NO flag at match start — the first corpse
// of the match drops it. Whoever grabs it is the rabbit: the only legal
// damage pairing is one involving the rabbit, EXCEPT the bottom feeder —
// last place on the leaderboard can hit/be hit by anyone.

function mkRabbit(bots = 3): { room: Room; players: PlayerState[] } {
  const room = mkRoom({
    mode: 'rabbit', bots,
    arena: { x: 0, z: 0, radius: 200 },
    spawns: [{ x: 60, y: 0, z: 0, r: 10 }],
  }, 'rabbit');
  const players = [...room.players.getAllPlayers().values()];
  expect(players.length).toBeGreaterThanOrEqual(bots);
  return { room, players };
}

function bolt(room: Room, shooter: PlayerState, from: { x: number; y: number; z: number }): void {
  room.projectiles.spawn(shooter.id, WeaponType.PlasmaGun, from, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
}

/** Run the bolt at a target pinned at `at`; returns damage dealt. */
function shoot(room: Room, shooter: PlayerState, target: PlayerState, at: { x: number; y: number; z: number }): number {
  const hp = target.health;
  bolt(room, shooter, { x: at.x - 10, y: at.y, z: at.z });
  for (let i = 0; i < 200; i++) { freeze(room, target.id, at); step(room, 1); }
  return hp - target.health;
}

/** Kill `victim` — the funnel call that drops/spawns the flag. */
function kill(room: Room, victim: PlayerState): void {
  room.players.applyDamage(victim.id, 10000);
  room.flagCarrierDied(victim.id); // the funnel path CombatHandler calls
}

/** Park every roster member far from the action except `keep`. */
function scatter(room: Room, keep: PlayerState[]): void {
  const keepIds = new Set(keep.map(p => p.id));
  let i = 0;
  for (const p of room.players.getAllPlayers().values()) {
    if (keepIds.has(p.id)) continue;
    freeze(room, p.id, { x: -150 + i * 15, y: 32, z: 150 });
    i++;
  }
}

describe('scenario: rabbit mode', () => {
  it('starts with no flag; the first kill drops it at the corpse', () => {
    const { room, players } = mkRabbit();
    const flag = room.flags!.flags.get('alpha')!;
    expect(flag.state).toBe('unspawned');
    expect(room.flags!.snapshot()).toHaveLength(0); // nothing on the wire yet
    const victim = players[0]!;
    scatter(room, [victim]);
    pin(room, victim.id, { x: 30, y: 32, z: -30 });
    kill(room, victim);
    expect(flag.state).toBe('dropped');
    expect(flag.pos.x).toBeCloseTo(30, 0);
    expect(flag.pos.z).toBeCloseTo(-30, 0);
    expect(room.flags!.snapshot()).toHaveLength(1);
  });

  it('whoever touches the loose flag becomes the rabbit', () => {
    const { room, players } = mkRabbit();
    const [victim, grabber] = players as [PlayerState, PlayerState];
    scatter(room, [victim, grabber]);
    pin(room, victim.id, { x: 30, y: 32, z: -30 });
    kill(room, victim);
    const flag = room.flags!.flags.get('alpha')!;
    pin(room, grabber.id, { ...flag.pos });
    room.tickFlags(0.05);
    expect(flag.carrier).toBe(grabber.id);
    expect(flag.state).toBe('carried');
    expect(room.flags!.carrierId()).toBe(grabber.id);
  });

  it('open season while no rabbit exists — hunters can kill each other', () => {
    const { room, players } = mkRabbit();
    const [h1, h2] = players as [PlayerState, PlayerState];
    // Park everyone else — a bot left mid-lane can eat the bolt (any
    // skill-roll rng draw shifts the whole room stream; don't depend on it).
    scatter(room, [h1, h2]);
    freeze(room, h1.id, { x: 40, y: 32, z: 0 });
    expect(shoot(room, h1, h2, { x: 60, y: 32, z: 0 })).toBeGreaterThan(0);
  });

  it('once a rabbit exists: hunter-vs-hunter blocked, rabbit pairs legal', () => {
    const { room, players } = mkRabbit(4);
    const [victim, rabbit, h1, h2] = players as [PlayerState, PlayerState, PlayerState, PlayerState];
    scatter(room, [victim, rabbit, h1, h2]);
    pin(room, victim.id, { x: 30, y: 32, z: -30 });
    kill(room, victim);
    const flag = room.flags!.flags.get('alpha')!;
    pin(room, rabbit.id, { ...flag.pos });
    room.tickFlags(0.05);
    expect(flag.carrier).toBe(rabbit.id);

    // Board: rabbit + h1 + h2 mid-table, dead victim strictly last — the
    // bottom-feeder exemption must not leak into hunter-vs-hunter here.
    room.ffaScores.set(victim.id, 0);
    room.ffaScores.set(rabbit.id, 9);
    room.ffaScores.set(h1.id, 3);
    room.ffaScores.set(h2.id, 3);
    // All four participants are live bots — silence the hunters' brains
    // too or one hunts the frozen rabbit mid-test, drops the flag, and
    // flips the room back to open season (correctly — just not staged).
    freeze(room, rabbit.id, { x: 80, y: 32, z: 0 });
    room.bots.quiet.add(h1.id);
    room.bots.quiet.add(h2.id);
    expect(shoot(room, rabbit, h1, { x: 40, y: 32, z: 0 })).toBeGreaterThan(0); // rabbit hits hunter
    expect(shoot(room, h1, h2, { x: 60, y: 32, z: 0 })).toBe(0);               // hunter can't hit hunter
    expect(shoot(room, h1, rabbit, { x: 80, y: 32, z: 0 })).toBeGreaterThan(0); // hunter hits rabbit
  });

  it('the bottom feeder brawls with anyone', () => {
    const { room, players } = mkRabbit(4);
    const [victim, rabbit, bottom, other] = players as [PlayerState, PlayerState, PlayerState, PlayerState];
    scatter(room, players);
    pin(room, victim.id, { x: 30, y: 32, z: -30 });
    kill(room, victim);
    const flag = room.flags!.flags.get('alpha')!;
    pin(room, rabbit.id, { ...flag.pos });
    room.tickFlags(0.05);
    // Make `bottom` strictly last: everyone else has points — a min-tie
    // now resolves to ONE feeder (id order), not the whole tied field.
    room.ffaScores.set(victim.id, 9);
    room.ffaScores.set(rabbit.id, 5);
    room.ffaScores.set(other.id, 3);
    // Same brain-silence as above — a live hunter brain can kill the
    // staged rabbit and flip open season mid-shot.
    room.bots.quiet.add(bottom.id);
    room.bots.quiet.add(other.id);
    // bottom (0 pts, last) hits `other` (3 pts) — legal despite both hunters
    expect(shoot(room, bottom, other, { x: 60, y: 32, z: 0 })).toBeGreaterThan(0);
  });

  it('carrying the flag scores one point per second held', () => {
    const { room, players } = mkRabbit();
    const [victim, rabbit] = players as [PlayerState, PlayerState];
    scatter(room, [victim, rabbit]);
    pin(room, victim.id, { x: 30, y: 32, z: -30 });
    kill(room, victim);
    const flag = room.flags!.flags.get('alpha')!;
    pin(room, rabbit.id, { ...flag.pos });
    room.tickFlags(0.05);
    expect(flag.carrier).toBe(rabbit.id);
    pin(room, rabbit.id, { x: 100, y: 32, z: 100 });
    for (let i = 0; i < 60; i++) step(room, 1, 0.05); // 3 sim-seconds
    expect(room.ffaScores.get(rabbit.id) ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('a dropped flag stays locked — only the bottom feeder brawls', () => {
    const { room, players } = mkRabbit(5);
    const [victim, rabbit, h1, h2, h3] = players as [PlayerState, PlayerState, PlayerState, PlayerState, PlayerState];
    scatter(room, players);
    pin(room, victim.id, { x: 30, y: 32, z: -30 });
    kill(room, victim);
    const flag = room.flags!.flags.get('alpha')!;
    pin(room, rabbit.id, { ...flag.pos });
    room.tickFlags(0.05);
    pin(room, rabbit.id, { x: 30, y: 32, z: -30 });
    kill(room, rabbit); // flag loose again — but it exists, so season is closed
    expect(flag.state).toBe('dropped');

    room.ffaScores.set(victim.id, 9);
    room.ffaScores.set(rabbit.id, 9);
    room.ffaScores.set(h1.id, 9);
    room.ffaScores.set(h3.id, 9); // h2 strictly last = the bottom feeder
    room.bots.quiet.add(h1.id);
    room.bots.quiet.add(h2.id);
    room.bots.quiet.add(h3.id);
    room.bots.quiet.add(rabbit.id);
    expect(shoot(room, h1, h2, { x: 60, y: 32, z: 0 })).toBeGreaterThan(0); // feeder is fair game
    expect(shoot(room, h2, h3, { x: 60, y: 32, z: 0 })).toBeGreaterThan(0);     // feeder can hit anyone
    expect(shoot(room, h1, h3, { x: 60, y: 32, z: 0 })).toBe(0);                // hunters stay locked
  });

  it('killing the rabbit drops the flag loose', () => {
    const { room, players } = mkRabbit();
    const w = watch(room);
    const [victim, rabbit] = players as [PlayerState, PlayerState];
    scatter(room, [victim, rabbit]);
    pin(room, victim.id, { x: 30, y: 32, z: -30 });
    kill(room, victim);
    const flag = room.flags!.flags.get('alpha')!;
    pin(room, rabbit.id, { ...flag.pos });
    room.tickFlags(0.05);
    expect(flag.carrier).toBe(rabbit.id);
    pin(room, rabbit.id, { x: 30, y: 32, z: -30 });
    kill(room, rabbit);
    room.tickFlags(0.05);
    expect(flag.state).toBe('dropped');
    expect(flag.carrier).toBeNull();
    expect(w.count('flagUpdate')).toBeGreaterThan(0);
  });
});
