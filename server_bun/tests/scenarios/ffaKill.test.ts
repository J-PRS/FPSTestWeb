import { describe, it, expect } from 'bun:test';
import { WeaponType } from '../../../shared/weapons.ts';
import { mkRoom, step, pin, watch } from './harness.ts';

describe('scenario: ffa kill scores', () => {
  it('killing an enemy in dm bumps the shooter\'s ffaScore', () => {
    const room = mkRoom({ mode: 'dm', bots: 2 }, 'dm');
    const w = watch(room);
    const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
    const [shooter, target] = bots;
    target!.health = 10; // one bolt should do it
    pin(room, shooter!.id, { x: 0, y: 32, z: 0 });
    pin(room, target!.id, { x: 20, y: 32, z: 0 });
    room.projectiles.spawn(shooter!.id, WeaponType.PlasmaGun,
      { x: 0, y: 32, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 300 && w.count('playerKill') === 0; i++) {
      pin(room, target!.id, { x: 20, y: 32, z: 0 });
      step(room, 1);
    }
    expect(w.count('playerKill')).toBe(1);
    const kill = w.msgs.find((m) => m.type === 'playerKill')! as { shooterId: string; targetId: string };
    expect(kill.shooterId).toBe(shooter!.id);
    expect(kill.targetId).toBe(target!.id);
    expect(w.count('ffaScore')).toBeGreaterThan(0);
  });
});
