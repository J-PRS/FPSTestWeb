import { describe, it, expect } from 'bun:test';
import { WeaponType } from '../../../shared/weapons.ts';
import { mkRoom, step, pin, freeze, watch } from './harness.ts';

// Direct-body hits bloom the blast radius 1.5× (Bolt/Disc contract —
// shared/weapons.ts, replicas predict it). Pre-fix the server applied
// the flat radius: every entity in the 1.0–1.5× annulus (nuggets,
// splash victims) took a client-predicted shove the server never paid —
// the nugrest/kb-echo snap class.
describe('scenario: direct-hit blast bloom', () => {
  it('a disc body hit pays the 1.5x envelope to annulus victims + pickups', () => {
    const room = mkRoom({ bots: 3 });
    const w = watch(room);
    const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
    const [shooter, target, annulus] = bots;
    freeze(room, target!.id, { x: 95, y: 43.9, z: 80 });
    freeze(room, shooter!.id, { x: 80, y: 44.1, z: 80 });
    // 12m past the direct-hit victim — inside the bloomed 15m envelope,
    // outside the flat 10m one. The pickup witness sits in the same band.
    freeze(room, annulus!.id, { x: 95, y: 43.9, z: 92 });
    room.pickups!.spawn({ x: 95, y: 43.9, z: 92 }, 'gem');
    const gem = [...(room.pickups! as unknown as { pickups: Map<number, { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number } }> }).pickups.values()][0]!;
    const annulusHp = annulus!.health;
    const gemVel0 = Math.hypot(gem.vel.x, gem.vel.z);

    // Same dead-center aim as discRepro: muzzle = eye → chest eye-0.9.
    const d = { x: 15, y: (43.9 - 0.9) - 44.1, z: 0 };
    const n = Math.hypot(d.x, d.y, d.z);
    const id = room.projectiles.spawn(shooter!.id, WeaponType.Disc,
      { x: 80, y: 44.1, z: 80 }, { x: d.x / n, y: d.y / n, z: d.z / n }, { x: 0, y: 0, z: 0 });
    expect(id).not.toBeNull();
    for (let i = 0; i < 200 && w.count('playerHit') === 0; i++) {
      pin(room, target!.id, { x: 95, y: 43.9, z: 80 });
      pin(room, annulus!.id, { x: 95, y: 43.9, z: 92 });
      step(room, 1);
    }
    // Direct hit confirmed — the bloom only owes the annulus entities.
    expect(target!.health).toBeLessThan(target!.maxHealth);
    expect(annulus!.health).toBeLessThan(annulusHp); // bloomed splash reached
    expect(Math.hypot(gem.vel.x, gem.vel.z)).toBeGreaterThan(gemVel0); // bloomed knock shoved it
  });
});
