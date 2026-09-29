import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, freeze, watch, twoPlayers } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';

describe('scenario: ffa kill feeds the dm scoreboard', () => {
  it('a dm kill bumps the shooter\'s ffaScore — teamScore never fires', () => {
    const room = mkRoom({ mode: 'dm', bots: 2 }, 'dm');
    const w = watch(room);
    const [killer, target] = twoPlayers(room);
    pin(room, killer.id, { x: 0, y: 31, z: 0 });
    target.health = 1; target.armor = 0;
    freeze(room, target.id, { x: 20, y: 31, z: 0 });
    room.projectiles.spawn(killer.id, WeaponType.PlasmaGun,
      { x: 0, y: 31, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 100 && !target.isDead; i++) {
      freeze(room, target.id, { x: 20, y: 31, z: 0 });
      step(room, 1);
    }
    expect(target.isDead).toBe(true);
    const fs = w.msgs.find((m) => m.type === 'ffaScore') as { scores?: Record<string, number> } | undefined;
    expect(fs).toBeTruthy();
    expect(fs!.scores![killer.id]).toBeGreaterThan(0);
    expect(w.count('teamScore')).toBe(0);
  });
});
