import { describe, it, expect } from 'bun:test';
import { WeaponType } from '../../../shared/weapons.ts';
import { mkRoom, step, pin, freeze, watch } from './harness.ts';

// damagereplay's exact staging: shooter feet (80,44.1,80), victim feet
// (95,43.9,80) — disc spawned at eye height aimed at victim's eye.
// The e2e fired this real volley and hit NOTHING — scenario repro.
describe('scenario: disc at e2e staging', () => {
  it('a disc fired at a parked player 15m away lands', () => {
    const room = mkRoom({ bots: 2 });
    const w = watch(room);
    const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
    const [shooter, target] = bots;
    freeze(room, target!.id, { x: 95, y: 43.9, z: 80 });
    freeze(room, shooter!.id, { x: 80, y: 44.1, z: 80 });
    const hp = target!.health;
    // Muzzle is the eye (Quake rule); dir aims at the capsule chest (eye − 0.9).
    const d = { x: 95 - 80, y: (43.9 - 0.9) - 44.1, z: 80 - 80 };
    const n = Math.hypot(d.x, d.y, d.z);
    const id = room.projectiles.spawn(shooter!.id, WeaponType.Disc,
      { x: 80, y: 44.1, z: 80 }, { x: d.x / n, y: d.y / n, z: d.z / n }, { x: 0, y: 0, z: 0 });
    expect(id).not.toBeNull();
    for (let i = 0; i < 200; i++) {
      pin(room, target!.id, { x: 95, y: 43.9, z: 80 });
      step(room, 1);
      if (w.count('playerHit') + w.count('playerKill') > 0) {break;}
    }
    expect(w.count('playerHit') + w.count('playerKill')).toBeGreaterThan(0);
    expect(target!.health).toBeLessThan(hp);
  });
});
