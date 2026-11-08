import { describe, it, expect } from 'bun:test';
import { WeaponType } from '../../../shared/weapons.ts';
import { mkRoom, step, freeze } from './harness.ts';

// Watersphere dome drag on projectiles — EVERY shell wades the pocket
// (environmental obstacle, no team check). shared/deployItems.ts
// waterDomeDrag is the one rule; RoomProjectiles.tick and the client's
// Projectile.stepFrame run the identical pass. This pins the authority
// half: a disc threading the dome exits slower than a twin that missed it.
describe('scenario: watersphere projectile drag', () => {
  it('a disc crossing the dome loses horizontal speed; a twin outside does not', () => {
    const room = mkRoom({ bots: 1 });
    const bot = [...room.players.getAllPlayers().values()][0]!;
    freeze(room, bot.id, { x: 0, y: 30, z: 0 });
    bot.beltCharges = 99;
    expect(room.deployables.handleDeploy(bot.id, 'watersphere', { x: 0, y: 29.5, z: 0 })).toBe(true);

    const projs = room.projectiles as unknown as { projs: Map<string, { p: { vel: { x: number; y: number; z: number } } }> };
    const through = room.projectiles.spawn(bot.id, WeaponType.Disc,
      { x: -20, y: 32, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })!;
    const beside = room.projectiles.spawn(bot.id, WeaponType.Disc,
      { x: -20, y: 32, z: 20 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })!;

    step(room, 10); // 0.5s - both discs are well past the dome's far rim

    const a = projs.projs.get(through)!.p.vel.x;
    const b = projs.projs.get(beside)!.p.vel.x;
    expect(b).toBeGreaterThan(70);          // control: drag-free ~80 m/s
    expect(a).toBeLessThan(b * 0.6);        // drowned: exponential damp bit
  });
});
