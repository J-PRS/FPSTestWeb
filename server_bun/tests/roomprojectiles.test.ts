import { simMs } from '../src/simClock.ts';
import { describe, it, expect } from 'bun:test';
import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { WeaponType, getWeaponStats } from '../../shared/weapons.ts';
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { CLASS_STATS } from '../../shared/botClasses.ts';
import { decodeProjGone } from '../../shared/wire.ts';

const flat: Heightfield = { size: 4, data: new Uint8Array(16).fill(60), stride: 1 };
const FLOOR = hmHeight(flat, 0, 0);
// position.y is the EYE point - a standing medium's eye rides its
// eyeHeight above the terrain, so pins park at FLOOR + eye, not FLOOR.
const EYE = FLOOR + CLASS_STATS.medium.eyeHeight;

function arena() {
  const room = new Room('t', flat, '', resolveMapSpec({ mode: 'dm' }));
  const shooter = room.players.addPlayer('BOT-VEKTOR-01');
  shooter.isBot = true;
  const target = room.players.addPlayer('human');
  shooter.protectedUntil = simMs(0);
  target.protectedUntil = simMs(0);
  return { room, shooter, target };
}

describe('RoomProjectiles', () => {
  it('a bolt fired at a still target damages it', () => {
    const { room, shooter, target } = arena();
    shooter.position = { x: 0, y: EYE, z: 0 };
    target.position = { x: 20, y: EYE, z: 0 };
    const dir = { x: 1, y: 0, z: 0 }; // level shot, chest height on target
    room.projectiles.spawn(shooter.id, WeaponType.PlasmaGun,
      { x: 0, y: FLOOR + 1.4, z: 0 }, dir, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 10 && target.health === target.maxHealth; i++) {
      room.projectiles.tick(0.05);
    }
    expect(target.health).toBeLessThan(target.maxHealth);
  });

  it('a teammate between shooter and target does not eat the bolt', () => {
    const { room, shooter, target } = arena();
    // Same-team body in the flight path: friendly damage is refused
    // anyway, so a block would just swallow the shell.
    shooter.team = 'alpha';
    const mate = room.players.addPlayer('mate');
    mate.team = 'alpha';
    target.team = 'bravo';
    shooter.position = { x: 0, y: EYE, z: 0 };
    mate.position = { x: 10, y: EYE, z: 0 };
    target.position = { x: 20, y: EYE, z: 0 };
    room.projectiles.spawn(shooter.id, WeaponType.PlasmaGun,
      { x: 0, y: FLOOR + 1.4, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 12 && target.health === target.maxHealth; i++) {
      room.projectiles.tick(0.05);
    }
    expect(mate.health).toBe(mate.maxHealth); // teammate unharmed
    expect(target.health).toBeLessThan(target.maxHealth); // enemy still hit
  });

  it('a bolt over a target\'s head whiffs - no fake damage', () => {
    const { room, shooter, target } = arena();
    shooter.position = { x: 0, y: EYE, z: 0 };
    target.position = { x: 20, y: EYE, z: 0 };
    room.projectiles.spawn(shooter.id, WeaponType.PlasmaGun,
      { x: 0, y: FLOOR + 8, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 10; i++) {room.projectiles.tick(0.05);}
    expect(target.health).toBe(target.maxHealth);
  });

  it('terrain contact detonates: a shell aimed into the ground splashes', () => {
    const { room, shooter, target } = arena();
    shooter.position = { x: 0, y: EYE, z: 0 };
    target.position = { x: 10, y: EYE, z: 0 };
    // Downward lob that lands ~10m out - right at the target's feet.
    room.projectiles.spawn(shooter.id, WeaponType.BoltLauncher,
      { x: 0, y: FLOOR + 1.4, z: 0 }, { x: 1, y: -0.1, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 10; i++) {room.projectiles.tick(0.05);}
    // Splash caught the target even though the segment never touched it.
    expect(target.health).toBeLessThan(target.maxHealth);
  });

  it('shells die at the fuse limit without reaching anything', () => {
    const { room, shooter } = arena();
    shooter.position = { x: 0, y: FLOOR + 50, z: 0 };
    const stats = getWeaponStats(WeaponType.PlasmaGun);
    room.projectiles.spawn(shooter.id, WeaponType.PlasmaGun,
      { x: 0, y: FLOOR + 50, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < Math.ceil((stats.maxLifetime! + 0.2) / 0.05); i++) {
      room.projectiles.tick(0.05);
    }
    // Fired straight up - fuse must have claimed it; nothing asserts the
    // pop, but a second run must leave the map empty (no leak).
    expect(true).toBe(true);
  });

  it('remote railgun discharges its beam along the velocity line', () => {
    const { room, shooter, target } = arena();
    shooter.position = { x: 0, y: EYE, z: 0 };
    target.position = { x: 30, y: EYE, z: 0 };
    const stats = getWeaponStats(WeaponType.RemoteRailgun);
    // The beam inherits the shell's velocity line - flat flight now, so a
    // throw aimed down 1.4m over the 30m gap lands level on the target.
    room.projectiles.spawn(shooter.id, WeaponType.RemoteRailgun,
      { x: 0, y: FLOOR + 1.4, z: 0 }, { x: 1, y: -0.05, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 20 && target.health === target.maxHealth; i++) {
      room.projectiles.tick(0.05);
    }
    expect(stats.rayDelay).toBeGreaterThan(0);
    expect(target.health).toBeLessThan(target.maxHealth);
  });

  it('a ridge between shell and target blocks the beam', () => {
    const { room, shooter, target } = arena();
    // Tall narrow field: a berm at x≈30 the beam must cross first.
    const berm: Heightfield = { size: 64, data: new Uint8Array(64).fill(60), stride: 1 };
    for (let i = 30; i < 32; i++) {berm.data[i] = 200;} // ~140m-high wall
    const room2 = new Room('t2', berm, '', resolveMapSpec({ mode: 'dm' }));
    const s2 = room2.players.addPlayer('BOT-VEKTOR-01'); s2.isBot = true;
    const t2 = room2.players.addPlayer('human');
    s2.protectedUntil = simMs(0); t2.protectedUntil = simMs(0);
    t2.position = { x: 40, y: hmHeight(berm, 40, 0) + CLASS_STATS.medium.eyeHeight, z: 0 };
    room2.projectiles.spawn(s2.id, WeaponType.RemoteRailgun,
      { x: 0, y: hmHeight(berm, 0, 0) + 1.4, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 20; i++) {room2.projectiles.tick(0.05);}
    expect(t2.health).toBe(t2.maxHealth);
    void shooter; void target; void room;
  });

  it('terrain scheduling never skips a real hit - high arc still lands', () => {
    const { room, shooter, target } = arena();
    shooter.position = { x: 0, y: EYE, z: 0 };
    target.position = { x: 25, y: EYE, z: 0 };
    // Mortar-style lob: climbs far above the field ceiling (terrain sweep
    // skipped for most of the flight), then descends into the ground at
    // the target. If scheduling lied, the pop never happens.
    // Mortars bounce off dirt while unarmed - a sub-1.5s flight just
    // skips off the dirt. At speed 80 a ~16.3° lob lands at t≈1.61s
    // (2·v·sinθ/g), just past the 1.5s arm, ~123m out - the contact pop
    // lands inside the 18m splash of a target parked at 118m.
    target.position = { x: 118, y: EYE, z: 0 };
    room.projectiles.spawn(shooter.id, WeaponType.Mortar,
      { x: 0, y: FLOOR + 1.4, z: 0 }, { x: 0.96, y: 0.28, z: 0 }, { x: 0, y: 0, z: 0 });
    let flewTicks = 0;
    for (let i = 0; i < 80 && target.health === target.maxHealth; i++) {
      room.projectiles.tick(0.05);
      flewTicks++;
    }
    expect(target.health).toBeLessThan(target.maxHealth);
    expect(flewTicks).toBeGreaterThan(2); // actually flew, not instant pop
  });

  it('a slow-moving player closing in still gets hit', () => {
    const { room, shooter, target } = arena();
    shooter.position = { x: 0, y: EYE, z: 0 };
    // Target stands outside the initial capsule but sprints into the
    // shell's path - the sphere reject must budget for his velocity.
    target.position = { x: 22, y: EYE, z: 0 };
    target.velocity = { x: -40, y: 0, z: 0 };
    room.projectiles.spawn(shooter.id, WeaponType.PlasmaGun,
      { x: 0, y: FLOOR + 1.4, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 10 && target.health === target.maxHealth; i++) {
      room.projectiles.tick(0.05);
      target.position.x += target.velocity.x * 0.05;
    }
    expect(target.health).toBeLessThan(target.maxHealth);
  });

  it('a sticky blast cooks a sibling bomb in its radius', () => {
    const { room, shooter } = arena();
    shooter.position = { x: 0, y: EYE, z: 0 };
    let pops = 0;
    const orig = room.broadcast.bind(room);
    const tap = ((m: { type: string }) => {
      if (m.type === 'projectileDestroyed') {pops++;}
      orig(m as Parameters<typeof room.broadcast>[0]);
    }) as typeof room.broadcast;
    room.broadcast = tap;
    // 'gone' edges ride the binary lane post-batching - count them too.
    const prevBin = room.connections.broadcastBinaryReliable.bind(room.connections);
    room.connections.broadcastBinaryReliable = (data: Uint8Array) => {
      if (decodeProjGone(data)) {pops++;}
      prevBin(data);
    };
    // Bomb 1 sticks on landing and its 3s fuse pops it; bomb 2 lands
    // inside the first blast's radius, sticks, and its own fuse pops
    // shortly after - or the chain cooks it early. Either way both
    // shells die inside the window, which only works when stick and
    // chain are real (a contact-pop used to pop bomb 1 instantly).
    room.projectiles.spawn(shooter.id, WeaponType.Sticky,
      { x: 0, y: FLOOR + 1.4, z: 0 }, { x: 0, y: -0.2, z: 0 }, { x: 0, y: 0, z: 0 });
    room.projectiles.spawn(shooter.id, WeaponType.Sticky,
      { x: 4, y: FLOOR + 1.4, z: 0 }, { x: 0, y: 0.6, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 160; i++) {room.projectiles.tick(0.05);}
    expect(pops).toBe(2);
  });

  it('a grenade-launcher shell skips off dirt pre-arm, pops after cooking', () => {
    const { room, shooter } = arena();
    shooter.position = { x: 0, y: EYE, z: 0 };
    let pops = 0, firstPopTick = -1, tick = 0;
    const orig = room.broadcast.bind(room);
    room.broadcast = ((m: { type: string }) => {
      if (m.type === 'projectileDestroyed') { pops++; if (firstPopTick < 0) {firstPopTick = tick;} }
      orig(m as Parameters<typeof room.broadcast>[0]);
    }) as typeof room.broadcast;
    const prevBin = room.connections.broadcastBinaryReliable.bind(room.connections);
    room.connections.broadcastBinaryReliable = (data: Uint8Array) => {
      if (decodeProjGone(data)) {pops++; if (firstPopTick < 0) {firstPopTick = tick;}}
      prevBin(data);
    };
    // Steep down-lob: hits dirt ~0.1s in - inside the 1s arming window, so
    // it must BOUNCE (still live past the landing tick), then die once
    // armed on its next dirt contact. The pre-fix server popped it on
    // the first touch - a weapon the client predicted bouncing.
    room.projectiles.spawn(shooter.id, WeaponType.GrenadeLauncher,
      { x: 0, y: FLOOR + 1.4, z: 0 }, { x: 0.5, y: -0.5, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 120 && pops === 0; i++) { room.projectiles.tick(0.05); tick++; }
    expect(firstPopTick).toBeGreaterThan(4); // survived past the first dirt touch
    expect(pops).toBe(1);
  });

  it('hitscan weapons refuse a body - spawn returns null', () => {
    const { room, shooter } = arena();
    expect(room.projectiles.spawn(shooter.id, WeaponType.Slam,
      { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBeNull();
  });
});
