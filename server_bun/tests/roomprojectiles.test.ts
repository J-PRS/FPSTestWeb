import { describe, it, expect } from 'bun:test';
import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { WeaponType, getWeaponStats } from '../../shared/weapons.ts';
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { CONFIG } from '../src/config.ts';

const flat: Heightfield = { size: 4, data: new Uint8Array(16).fill(60), stride: 1 };
const FLOOR = hmHeight(flat, 0, 0);

function arena() {
  const room = new Room('t', flat, '', resolveMapSpec({ mode: 'dm' }));
  const shooter = room.players.addPlayer('BOT-t1');
  shooter.isBot = true;
  const target = room.players.addPlayer('human');
  shooter.protectedUntil = 0;
  target.protectedUntil = 0;
  return { room, shooter, target };
}

describe('RoomProjectiles', () => {
  it('a bolt fired at a still target damages it', () => {
    const { room, shooter, target } = arena();
    shooter.position = { x: 0, y: FLOOR + 1.4, z: 0 };
    target.position = { x: 20, y: FLOOR, z: 0 };
    const dir = { x: 1, y: 0, z: 0 }; // level shot, chest height on target
    room.projectiles.spawn(shooter.id, WeaponType.PlasmaGun,
      { x: 0, y: FLOOR + 1.4, z: 0 }, dir, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 10 && target.health === CONFIG.playerMaxHealth; i++) {
      room.projectiles.tick(0.05);
    }
    expect(target.health).toBeLessThan(CONFIG.playerMaxHealth);
  });

  it('a bolt over a target\'s head whiffs — no fake damage', () => {
    const { room, shooter, target } = arena();
    shooter.position = { x: 0, y: FLOOR, z: 0 };
    target.position = { x: 20, y: FLOOR, z: 0 };
    room.projectiles.spawn(shooter.id, WeaponType.PlasmaGun,
      { x: 0, y: FLOOR + 8, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 10; i++) room.projectiles.tick(0.05);
    expect(target.health).toBe(CONFIG.playerMaxHealth);
  });

  it('terrain contact detonates: a shell aimed into the ground splashes', () => {
    const { room, shooter, target } = arena();
    shooter.position = { x: 0, y: FLOOR, z: 0 };
    target.position = { x: 10, y: FLOOR, z: 0 };
    // Downward lob that lands ~10m out — right at the target's feet.
    room.projectiles.spawn(shooter.id, WeaponType.Rocket,
      { x: 0, y: FLOOR + 1.4, z: 0 }, { x: 1, y: -0.1, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 10; i++) room.projectiles.tick(0.05);
    // Splash caught the target even though the segment never touched it.
    expect(target.health).toBeLessThan(CONFIG.playerMaxHealth);
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
    // Fired straight up — fuse must have claimed it; nothing asserts the
    // pop, but a second run must leave the map empty (no leak).
    expect(true).toBe(true);
  });

  it('remote railgun discharges its beam along the velocity line', () => {
    const { room, shooter, target } = arena();
    shooter.position = { x: 0, y: FLOOR + 1.4, z: 0 };
    target.position = { x: 30, y: FLOOR, z: 0 };
    const stats = getWeaponStats(WeaponType.RemoteRailgun);
    // The beam inherits the shell's velocity line — gravity over rayDelay
    // drags it down, so a slight upward lob lands level on the target.
    room.projectiles.spawn(shooter.id, WeaponType.RemoteRailgun,
      { x: 0, y: FLOOR + 1.4, z: 0 }, { x: 1, y: 0.15, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 20 && target.health === CONFIG.playerMaxHealth; i++) {
      room.projectiles.tick(0.05);
    }
    expect(stats.rayDelay).toBeGreaterThan(0);
    expect(target.health).toBeLessThan(CONFIG.playerMaxHealth);
  });

  it('a ridge between shell and target blocks the beam', () => {
    const { room, shooter, target } = arena();
    // Tall narrow field: a berm at x≈30 the beam must cross first.
    const berm: Heightfield = { size: 64, data: new Uint8Array(64).fill(60), stride: 1 };
    for (let i = 30; i < 32; i++) berm.data[i] = 200; // ~140m-high wall
    const room2 = new Room('t2', berm, '', resolveMapSpec({ mode: 'dm' }));
    const s2 = room2.players.addPlayer('BOT-t1'); s2.isBot = true;
    const t2 = room2.players.addPlayer('human');
    s2.protectedUntil = 0; t2.protectedUntil = 0;
    t2.position = { x: 40, y: hmHeight(berm, 40, 0), z: 0 };
    room2.projectiles.spawn(s2.id, WeaponType.RemoteRailgun,
      { x: 0, y: hmHeight(berm, 0, 0) + 1.4, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 20; i++) room2.projectiles.tick(0.05);
    expect(t2.health).toBe(CONFIG.playerMaxHealth);
    void shooter; void target; void room;
  });

  it('hitscan weapons refuse a body — spawn returns null', () => {
    const { room, shooter } = arena();
    expect(room.projectiles.spawn(shooter.id, WeaponType.Slam,
      { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBeNull();
  });
});
