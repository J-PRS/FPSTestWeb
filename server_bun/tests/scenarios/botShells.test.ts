import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { Vec3 } from '../../src/types.ts';

// Bots fire REAL shells through RoomProjectiles — this suite pins the
// projectile→creature sweep and splash, and the honest miss.
type Sim = { spawnBall(v: number, near?: Vec3, pos?: Vec3): { id: number };
  balls: Map<number, { health: number }> };
function spawnAt(room: ReturnType<typeof mkRoom>, pos: Vec3): number {
  return (room.ballSim as unknown as Sim).spawnBall(0, undefined, pos).id;
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
    const id = room.projectiles.spawn(b.id, WeaponType.Rocket,
      { x: 0, y: 31.4, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    expect(id).toBeTruthy();
    for (let i = 0; i < 60; i++) step(room, 1);
    // Direct-hit beast takes the directDamage line; its neighbor only the blast.
    expect(ballHp(room, aim)).toBeLessThan(hpAim);
    expect(ballHp(room, splash)).toBeLessThan(hpSplash);
  });

  it('a whiffed shell damages nothing — geometry, not dice', () => {
    const room = mkRoom({ bots: 1 }, 'tdm');
    const b = bot(room);
    pin(room, b.id, { x: 0, y: 31, z: 0 });
    const aim = spawnAt(room, { x: 20, y: 31, z: 30 }); // 30m off-axis
    const hp0 = ballHp(room, aim);
    room.projectiles.spawn(b.id, WeaponType.Rocket,
      { x: 0, y: 31.4, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 60; i++) step(room, 1);
    expect(ballHp(room, aim)).toBe(hp0);
  });
});
