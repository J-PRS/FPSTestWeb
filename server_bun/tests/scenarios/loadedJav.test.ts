import { describe, it, expect } from 'bun:test';
import { WeaponType, BELT_MAX, beltThrowCost } from '../../../shared/weapons.ts';
import { mkRoom, pin, twoPlayers } from './harness.ts';
import type { Room } from '../../src/Room.ts';
import type { PlayerState } from '../../src/types.ts';

// Chambered belt load (stats.loadable): with the host weapon drawn the
// javelin belt press rams the shell instead of throwing it - the next
// host fire claims AS the host but spawns the loaded type at dmgMult.
// The toggle is free bookkeeping: unload refunds the same charge.
const JAV = WeaponType.Javelin;
const HOST = WeaponType.BoltLauncher;
const COST = beltThrowCost(JAV);

function projs(room: Room): { weaponType: number; directBonus?: number }[] {
  return [...(room.projectiles as unknown as { projs: Map<string, { weaponType: number; directBonus?: number }> }).projs.values()];
}

function arm(): [Room, PlayerState] {
  const room = mkRoom({ bots: 2 }, 'tdm');
  const [a] = twoPlayers(room);
  pin(room, a.id, { x: 0, y: 31, z: 0 });
  a.weapon = HOST;
  return [room, a];
}

function load(room: Room, a: PlayerState): void {
  room.messages.handleMessage(a.id, { type: 'loadItem', weaponType: JAV } as never);
}

function fire(room: Room, a: PlayerState, wt = HOST): void {
  room.messages.handleMessage(a.id, {
    type: 'shotFired', weaponType: wt, dir: { x: 1, y: 0, z: 0 },
  } as never);
}

describe('scenario: javelin loaded into bolt launcher', () => {
  it('the belt press pays a charge and chambers the shell', () => {
    const [room, a] = arm();
    const belt = a.beltCharges;
    load(room, a);
    expect(a.loadedShell).toBe(JAV);
    expect(a.beltCharges).toBe(belt - COST);
  });

  it('a second press unloads and refunds the charge', () => {
    const [room, a] = arm();
    const belt = a.beltCharges;
    load(room, a); load(room, a);
    expect(a.loadedShell).toBeUndefined();
    expect(a.beltCharges).toBe(Math.min(BELT_MAX, belt));
  });

  it('the load is refused when the host weapon is not drawn', () => {
    const [room, a] = arm();
    a.weapon = WeaponType.Disc;
    const belt = a.beltCharges;
    load(room, a);
    expect(a.loadedShell).toBeUndefined();
    expect(a.beltCharges).toBe(belt);
  });

  it('the load is refused on an empty belt', () => {
    const [room, a] = arm();
    a.beltCharges = 0;
    load(room, a);
    expect(a.loadedShell).toBeUndefined();
  });

  it('the next host fire spawns the javelin at 1.5x direct, consuming the chamber', () => {
    const [room, a] = arm();
    load(room, a);
    fire(room, a);
    const spawned = projs(room);
    expect(spawned.length).toBe(1);
    expect(spawned[0]!.weaponType).toBe(JAV);
    expect(spawned[0]!.directBonus).toBeCloseTo(1.5);
    expect(a.loadedShell).toBeUndefined();
  });

  it('a different weapon fires its own shell and keeps the chamber', () => {
    const [room, a] = arm();
    load(room, a);
    fire(room, a, WeaponType.Disc);
    const spawned = projs(room);
    expect(spawned.length).toBe(1);
    expect(spawned[0]!.weaponType).toBe(WeaponType.Disc);
    expect(a.loadedShell).toBe(JAV);
  });
});
