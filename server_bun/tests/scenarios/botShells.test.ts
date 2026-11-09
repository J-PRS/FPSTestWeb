import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, freeze, watch } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import { BOT_LOADOUTS, botClassForLoadout } from '../../../shared/botLoadouts.ts';
import type { Vec3 } from '../../src/types.ts';

// Bots fire REAL shells through RoomProjectiles — this suite pins the
// projectile→creature sweep and splash, and the honest miss.
type Sim = { spawnBall(v: number, near?: Vec3, pos?: Vec3): { id: number };
  balls: Map<number, { health: number; tgtValid?: boolean; tx?: number; ty?: number; tz?: number; targetId?: string | null }> };
function spawnAt(room: ReturnType<typeof mkRoom>, pos: Vec3, parkFar = false): number {
  const sim = room.ballSim as unknown as Sim;
  const {id} = sim.spawnBall(0, undefined, pos);
  // BallSim now steps in scenarios — a free ball retargets the pinned
  // bot and suicides on contact, and a ball committed to its own spot
  // pops on arrival. Commit it somewhere out of the way so the test
  // measures shell geometry, not lunge/arrival behavior. parkFar sends
  // it off-arena entirely (whiff test needs it alive at the end).
  const b = sim.balls.get(id);
  if (b) {
    b.tgtValid = true;
    b.tx = parkFar ? pos.x + 400 : pos.x;
    b.ty = pos.y;
    b.tz = parkFar ? pos.z + 400 : pos.z;
    b.targetId = null;
  }
  return id;
}
function ballHp(room: ReturnType<typeof mkRoom>, id: number): number {
  return (room.ballSim as unknown as Sim).balls.get(id)?.health ?? -1;
}
function bot(room: ReturnType<typeof mkRoom>) {
  return [...room.players.getAllPlayers().values()].find((p) => p.isBot)!;
}

describe('scenario: bot shells hit creatures like player shots', () => {
  it('a rocket into the swarm takes direct + splash damage', () => {
    const room = mkRoom({ bots: 1 }, 'tdm');
    const b = bot(room);
    pin(room, b.id, { x: 0, y: 31, z: 0 });
    const aim = spawnAt(room, { x: 20, y: 31, z: 0 });
    const splash = spawnAt(room, { x: 22.5, y: 31, z: 0 });
    const hpAim = ballHp(room, aim), hpSplash = ballHp(room, splash);
    const id = room.projectiles.spawn(b.id, WeaponType.BoltLauncher,
      { x: 0, y: 31.4, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    expect(id).toBeTruthy();
    for (let i = 0; i < 60; i++) {step(room, 1);}
    // Direct-hit beast takes the directDamage line; its neighbor only the blast.
    expect(ballHp(room, aim)).toBeLessThan(hpAim);
    expect(ballHp(room, splash)).toBeLessThan(hpSplash);
  });

  it('a whiffed shell damages nothing — geometry, not dice', () => {
    const room = mkRoom({ bots: 1 }, 'tdm');
    const b = bot(room);
    // freeze, not pin: a live brain hunts the ball with its own arsenal
    // and "whiffed shell" stops measuring the shell. The frozen body
    // still owns the spawned shell; the think/fire pipeline stays off.
    freeze(room, b.id, { x: 0, y: 31, z: 0 });
    const aim = spawnAt(room, { x: 20, y: 31, z: 30 }, true); // 30m off-axis, parked far
    // Inert — tgtValid false means no chase/launch path feeds it. A
    // 400m parkFar journey is a real drive (elastic balls complete it
    // and despawn off-map); the whiff test needs a ball that stays put.
    const sim0 = room.ballSim as unknown as Sim;
    const wb = sim0.balls.get(aim);
    if (wb) {wb.tgtValid = false;}
    const hp0 = ballHp(room, aim);
    room.projectiles.spawn(b.id, WeaponType.BoltLauncher,
      { x: 0, y: 31.4, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 60; i++) {step(room, 1);}
    expect(ballHp(room, aim)).toBe(hp0);
  });

  it('a beam-rider bot welds a player for real — same funnel as botAttack', () => {
    const room = mkRoom({ bots: 1 }, 'dm');
    const b = bot(room);
    const victim = room.players.addPlayer('victim');
    pin(room, b.id, { x: 0, y: 31, z: 0 });
    pin(room, 'victim', { x: 30, y: 31, z: 0 }); // mid band - near draws Chaingun since 8b82850e
    // Force the beam-rider kit (index 8) — the mid band draws Lightning,
    // which has no projectile body and routes through fireSpeedless.
    // (Projectile guns need step()ed flight time; the beam pays on
    // discharge, which is why this test never ticks the room.)
    const bots = room.bots as unknown as {
      arsenal: { fireAt(p: { id: string; position: Vec3; velocity: Vec3 }, t: string, aim: Vec3): void; testAdvance(ms: number): void };
      loadouts: Map<string, (typeof BOT_LOADOUTS)[number]>;
    };
    bots.loadouts.set(b.id, BOT_LOADOUTS[8]!);
    // The kit is light-tier (Lightning) - arsenal.fireAt class-gates on
    // armorClass, so the forced kit needs its honest class too.
    b.armorClass = botClassForLoadout(BOT_LOADOUTS[8]!);
    // Face the aim: shots launch along the body's facing now, and this
    // test drives fireAt without ticking the room — nothing else turns
    // the body (same convention as faceLaunch: pitch aims from muzzle).
    b.rotation.yaw = Math.atan2(30 - b.position.x, 0 - b.position.z);
    b.rotation.pitch = -Math.atan2(30.1 - (b.position.y + 1.4), 30);
    const hp0 = victim.health;
    const armor0 = victim.armor;
    for (let i = 0; i < 6; i++) {
      bots.arsenal.testAdvance(60); // LG tick 50ms — stay legal
      // Aim at the capsule's axis midpoint — pos.y is the eye, so the
      // body center sits ~0.9m under it for a medium.
      bots.arsenal.fireAt(b, 'victim', { x: 30, y: 30.1, z: 0 });
    }
    expect(victim.health < hp0 || victim.armor < armor0).toBe(true);
  });

  it('a beam into empty dirt pays nothing — the tracer lies less than the RNG did', () => {
    const room = mkRoom({ bots: 1 }, 'dm');
    const b = bot(room);
    const victim = room.players.addPlayer('victim');
    pin(room, b.id, { x: 0, y: 31, z: 0 });
    pin(room, 'victim', { x: 30, y: 31, z: 0 });
    const bots = room.bots as unknown as {
      arsenal: { fireAt(p: { id: string; position: Vec3; velocity: Vec3 }, t: string, aim: Vec3): void };
      loadouts: Map<string, (typeof BOT_LOADOUTS)[number]>;
    };
    bots.loadouts.set(b.id, BOT_LOADOUTS[8]!);
    // Aim 4m over the victim's head — the ray must not "hit" anyway.
    bots.arsenal.fireAt(b, 'victim', { x: 30, y: 36, z: 0 });
    expect(victim.health).toBe(victim.maxHealth);
  });

  it('the arsenal enforces the drawn weapon\'s rate — no fast-cadence mortars', () => {
    const room = mkRoom({ bots: 1 }, 'dm');
    const w = watch(room);
    const b = bot(room);
    room.players.addPlayer('victim');
    pin(room, b.id, { x: 0, y: 31, z: 0 });
    pin(room, 'victim', { x: 50, y: 31, z: 0 }); // far band → Mortar (2.0s rate)
    const bots = room.bots as unknown as {
      arsenal: { fireAt(p: { id: string; position: Vec3; velocity: Vec3 }, t: string, aim: Vec3): void; testAdvance(ms: number): void };
      loadouts: Map<string, (typeof BOT_LOADOUTS)[number]>;
    };
    bots.loadouts.set(b.id, BOT_LOADOUTS[7]!); // artillery
    // Face the aim — see the weld test: fireAlong-facing needs the body
    // turned, and this test never ticks the room.
    b.rotation.yaw = Math.atan2(50 - b.position.x, 0 - b.position.z);
    b.rotation.pitch = -Math.atan2(32 - (b.position.y + 1.4), 50);
    for (let i = 0; i < 3; i++) {bots.arsenal.fireAt(b, 'victim', { x: 50, y: 32, z: 0 });}
    expect(w.count('projectileCreated')).toBe(1); // one shell per 2.0s, not three per tick
    bots.arsenal.testAdvance(2100);
    bots.arsenal.fireAt(b, 'victim', { x: 50, y: 32, z: 0 });
    expect(w.count('projectileCreated')).toBe(2); // rate elapsed — legal again
  });

  it('a belt toss never advertises the thrown type as the held gun', () => {
    const room = mkRoom({ bots: 1 }, 'tdm');
    const b = bot(room);
    freeze(room, b.id, { x: 0, y: 31, z: 0 });
    b.weapon = WeaponType.Disc;
    // Grenade has a projectile body (belt pulls spawn real shells) but
    // no hand model: stamping it would leave the remote wearing the
    // generic prop until the next gun shot.
    room.projectiles.spawn(b.id, WeaponType.Grenade,
      { x: 0, y: 31.4, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    expect(b.weapon).toBe(WeaponType.Disc);
    room.projectiles.spawn(b.id, WeaponType.BoltLauncher,
      { x: 0, y: 31.4, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    expect(b.weapon).toBe(WeaponType.BoltLauncher);
  });

  it('the roster reveal reads the post-adapt kit, never a stale slot', () => {
    for (let i = 0; i < 12; i++) {
      const room = mkRoom({ bots: 6 }, 'tdm');
      const bots = room.bots as unknown as { loadouts: Map<string, (typeof BOT_LOADOUTS)[number]> };
      for (const p of room.players.getAllPlayers().values()) {
        if (!p.isBot) {continue;}
        const lo = bots.loadouts.get(p.id)!;
        const held = new Set<number>([lo.near, lo.mid, lo.far, lo.side]);
        expect(p.weapon !== undefined && held.has(p.weapon)).toBe(true);
      }
    }
  });
});
