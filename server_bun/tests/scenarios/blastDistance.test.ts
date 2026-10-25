import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze, twoPlayers } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';

// Knockback sanity ledger: detonate each core blast type at the victim's
// feet — the optimal catapult geometry — and measure the PEAK horizontal
// drift and PEAK height the shadow reaches before settling. Guards the
// impulse table against "launched across the map" regressions: a blast
// should displace, not orbit.
//
// Caps are ~2.5× the measured peaks (comment column) so the test fails
// on order-of-magnitude changes, not ordinary tuning.
const SETTLE_TICKS = 200; // 10s of sim — friction has long stopped the slide

interface Flight { drift: number; height: number }

function blastFlight(room: ReturnType<typeof mkRoom>, shooterId: string, victimId: string, weapon: number): Flight {
  const before = { ...room.moveSim.simPos(victimId)! };
  // Feet blast: point-blank under the victim, slight +x so the push has a
  // readable direction — this is the geometry rocket jumps optimize for.
  // simPos is the EYE position (feet = eye - eyeHeight), so a feet blast
  // sits ~2m below it — under T1's hitbox-center curve that's the ramp's
  // peak, while eye-0.5 is inside the torso's point-blank dead zone.
  room.messages.serverBlast(shooterId, { x: before.x + 1.5, y: before.y - 2.5, z: before.z }, weapon, null);
  let drift = 0, height = 0;
  for (let i = 0; i < SETTLE_TICKS; i += 10) {
    step(room, 10);
    const p = room.moveSim.simPos(victimId)!;
    drift = Math.max(drift, Math.hypot(p.x - before.x, p.z - before.z));
    height = Math.max(height, p.y - before.y);
  }
  return { drift, height };
}

describe('scenario: blast knockback distance', () => {
  // [weapon, name, measured drift, drift cap, measured height, height cap]
  const CASES: [number, string, number, number, number, number][] = [
    [WeaponType.BoltLauncher, 'rocket', 16.5, 22, 2.8, 4],
    [WeaponType.Disc, 'disc', 18.6, 26, 2.2, 4],
    [WeaponType.Grenade, 'grenade', 22.9, 30, 3.9, 6],
    [WeaponType.Mortar, 'mortar', 22.9, 30, 3.9, 6],
    [WeaponType.ImpactGrenade, 'impact grenade', 22.9, 30, 3.9, 6],
    [WeaponType.ArmorGrenade, 'armor grenade', 13.6, 18, 2.2, 4],
    [WeaponType.Implodisc, 'implodisc', 8.5, 12, 0.4, 1.5],
  ];

  for (const [wt, name, , dCap, , hCap] of CASES) {
    it(`${name} blast displaces the victim but does not catapult them`, () => {
      const room = mkRoom({ bots: 2 }, 'dm');
      const [shooter, victim] = twoPlayers(room);
      freeze(room, shooter.id, { x: -40, y: 31, z: 0 });
      freeze(room, victim.id, { x: 0, y: 31, z: 0 });

      const f = blastFlight(room, shooter.id, victim.id, wt);
      if (process.env.BLAST_LOG) {console.log(`${name}: drift ${f.drift.toFixed(1)}m, height ${f.height.toFixed(1)}m`);}
      expect(f.drift).toBeGreaterThan(0.3);  // the blast did displace them
      expect(f.drift).toBeLessThan(dCap);    // …but didn't launch them
      expect(f.height).toBeGreaterThan(0.2); // feet pops do loft them
      expect(f.height).toBeLessThan(hCap);
    });
  }
});
