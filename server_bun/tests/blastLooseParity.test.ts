import { simMs } from '../src/simClock.ts';
import { describe, it, expect } from 'bun:test';
import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { WeaponType } from '../../shared/weapons.ts';
import { makeSimCrawler } from '../../shared/creatureCore.ts';
import type { SimBall } from '../../shared/ballSim.ts';

// Parity contract: whatever the client predicts on a blast (the gem
// tumbles, the creature staggers) the authority must apply — or the next
// truth update snaps it back ("I knock it and it returns to og position").
// These assert the shove reaches the SERVER-SIDE object, not just visuals.

const FFA_SPEC = resolveMapSpec({ mode: 'dm' });
const NUGGETS_SPEC = resolveMapSpec({ mode: 'nuggets' });

function roomWithShooter(spec = FFA_SPEC) {
  const room = new Room('f', null, '', spec);
  const p = room.players.addPlayer('p1', undefined, 'none', 'heavy'); // Slam is heavy-locked
  p.position = { x: 0, y: 10, z: 0 };
  p.protectedUntil = simMs(0);
  return { room, p };
}

// Server-authority rooms reject aoeShot claims ('outcomes are
// server-simmed') — a mine blast is the real blast entry point here and
// exercises the same emit→Room→knock funnel every server detonation uses.
const blastAt = { x: 0, y: 10, z: 0 };
const blast = (room: Room, knockback = 40) =>
  room.messages.mineBlast('p1', { ...blastAt }, 60, 12, knockback);

function fakeBall(id: number, x: number, y: number, z: number): SimBall {
  return {
    id, variant: 0, colorIdx: 0,
    x, y, z, vx: 0, vy: 0, vz: 0,
    scale: 1, radius: 1.5,
    health: 60, maxHealth: 60,
    enraged: false, enrageTimer: 0, slowTimer: 0, dampNextBounce: false,
    dead: false, targetId: null,
    tx: 0, ty: 0, tz: 0, tgtValid: false,
    gProbe: 0, gProbeY: 0,
  } as unknown as SimBall;
}

describe('blast → loose-object parity', () => {
  it('a blast punts the server-side gem the client already threw', () => {
    const { room } = roomWithShooter(NUGGETS_SPEC);
    room.pickups!.spawn({ x: 3, y: 10, z: 0 }, 'gem');
    const before = room.pickups!.snapshot()[0]!.pos;
    blast(room);
    for (let i = 0; i < 5; i++) {room.pickups!.tick(0.05);}
    const after = room.pickups!.snapshot()[0]!.pos;
    expect(Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z)).toBeGreaterThan(0.05);
  });

  it('a blast shoves a server-side ball (swarm parity)', () => {
    const { room } = roomWithShooter();
    room.ballSim.balls.set(42, fakeBall(42, 3, 10, 0));
    blast(room);
    const b = room.ballSim.balls.get(42)!;
    expect(Math.hypot(b.vx, b.vy, b.vz)).toBeGreaterThan(0.1);
  });

  it('a blast staggers a server-side crawler (pack parity)', () => {
    const { room } = roomWithShooter();
    room.creatureSim.crawlers.set(7, makeSimCrawler(7, { x: 3, y: 10, z: 0 }, false, 1));
    blast(room);
    const c = room.creatureSim.crawlers.get(7)!;
    expect(Math.hypot(c.vx, c.vy, c.vz)).toBeGreaterThan(0.1);
  });

  it('a pull blast sucks a server-side ball toward center, not away', () => {
    const { room } = roomWithShooter();
    room.ballSim.balls.set(43, fakeBall(43, 5, 10, 0));
    room.messages.serverBlast('p1', { ...blastAt }, WeaponType.Implodisc, null);
    const b = room.ballSim.balls.get(43)!;
    // Ball sits +x from center — a pull must drive it BACK toward 0, never
    // fling it further out (the old sign-less knock pushed instead).
    expect(b.vx).toBeLessThan(-0.1);
  });

  it('the same blast leaves a far gem untouched (radius, not blanket)', () => {
    const { room } = roomWithShooter(NUGGETS_SPEC);
    room.pickups!.spawn({ x: 200, y: 10, z: 0 }, 'gem');
    const before = room.pickups!.snapshot()[0]!.pos;
    blast(room);
    for (let i = 0; i < 5; i++) {room.pickups!.tick(0.05);}
    expect(room.pickups!.snapshot()[0]!.pos).toEqual(before);
  });
});
