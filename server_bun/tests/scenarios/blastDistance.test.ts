import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze, twoPlayers } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';

// Knockback sanity ledger: detonate each core blast type at a fixed 3m
// standoff and measure the PEAK horizontal distance the victim's shadow
// travels from its spot before settling. Guards the impulse table
// against "launched across the map" regressions — a blast should
// displace, not catapult.
//
// Caps are ~2.5× the measured peak (comment column) so the test fails
// on order-of-magnitude changes, not ordinary tuning.
const STANDOFF = 3;
const SETTLE_TICKS = 200; // 10s of sim — friction has long stopped the slide

function peakDrift(room: ReturnType<typeof mkRoom>, shooterId: string, victimId: string, weapon: number): number {
  const before = { ...room.moveSim.simPos(victimId)! };
  room.messages.serverBlast(shooterId, { x: STANDOFF, y: 31, z: 0 }, weapon, null);
  let peak = 0;
  for (let i = 0; i < SETTLE_TICKS; i += 10) {
    step(room, 10);
    const p = room.moveSim.simPos(victimId)!;
    peak = Math.max(peak, Math.hypot(p.x - before.x, p.z - before.z));
  }
  return peak;
}

describe('scenario: blast knockback distance', () => {
  // [weapon, name, peak measured at write-time, max tolerated peak]
  const CASES: [number, string, number, number][] = [
    [WeaponType.Rocket, 'rocket', 1.2, 4],
    [WeaponType.Disc, 'disc', 1.2, 4],
    [WeaponType.Grenade, 'grenade', 1.2, 4],
    [WeaponType.Mortar, 'mortar', 1.2, 4],
    [WeaponType.ImpactGrenade, 'impact grenade', 1.2, 4],
    [WeaponType.ArmorGrenade, 'armor grenade', 1.2, 4],
    [WeaponType.DiscPull, 'disc pull', 1.1, 4],
  ];

  for (const [wt, name, , cap] of CASES) {
    it(`${name} blast displaces the victim but does not catapult them`, () => {
      const room = mkRoom({ bots: 2 }, 'dm');
      const [shooter, victim] = twoPlayers(room);
      freeze(room, shooter.id, { x: -40, y: 31, z: 0 });
      freeze(room, victim.id, { x: 0, y: 31, z: 0 });

      const drift = peakDrift(room, shooter.id, victim.id, wt);
      if (process.env.BLAST_LOG) console.log(`${name}: ${drift.toFixed(1)}m`);
      expect(drift).toBeGreaterThan(0.5);   // the blast did displace them
      expect(drift).toBeLessThan(cap);       // …but didn't launch them
    });
  }
});
