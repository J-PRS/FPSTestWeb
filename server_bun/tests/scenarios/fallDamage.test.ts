import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, firstPlayer } from './harness.ts';
import { MOVEMENT_CONFIG } from '../../../shared/movement.ts';

// T1 collision damage end-to-end: a real Room, a dropped body, the same
// funnel every damage path rides — plus the Featherfall soak turning the
// landing into an energy burn instead of a hit. (The harness `flat`
// field rests at ~29m — a pin at 60 is a ~30m drop, still >25 m/s.)
describe('scenario: fall damage', () => {
  it('hard landing pays hp; featherfall spends the tank instead', () => {
    // No perk — the drop lands over the T1 floor and costs real blood.
    const room = mkRoom({ bots: 1, botFill: 1 }, '');
    const p = firstPlayer(room);
    room.bots.quiet.add(p.id);
    p.perk = 'none';
    const hp0 = p.health;
    pin(room, p.id, { x: 0, y: 90, z: 0 });
    for (let i = 0; i < 300 && !p.isDead; i++) { step(room, 1); }
    expect(p.health).toBeLessThan(hp0);
    expect(p.isDead).toBe(false); // ~30 m/s fall — a sting, not a splat

    // Featherfall — the identical drop burns the jet tank at 20:1 and
    // never fires a hit: a covered landing leaves no mark on the bar.
    const room2 = mkRoom({ bots: 1, botFill: 1 }, '');
    const p2 = firstPlayer(room2);
    room2.bots.quiet.add(p2.id);
    p2.perk = 'featherfall';
    const hp2 = p2.health;
    pin(room2, p2.id, { x: 0, y: 90, z: 0 });
    const seen: number[] = [];
    let enBefore = -1; let enAfter = -1;
    const prev = room2.moveSim.onLanding;
    room2.moveSim.onLanding = (pid, imp): void => {
      seen.push(imp);
      // Tank read inside the callback brackets the drain — regen between
      // ticks can't smear the measurement.
      enBefore = room2.moveSim.energyOf(pid) ?? -1;
      prev?.(pid, imp);
      enAfter = room2.moveSim.energyOf(pid) ?? -1;
    };
    for (let i = 0; i < 300 && !p2.isDead; i++) { step(room2, 1); }
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.min(...seen)).toBeGreaterThan(MOVEMENT_CONFIG.fallDamageMinSpeed);
    expect(p2.health).toBe(hp2);
    expect(enAfter).toBeGreaterThanOrEqual(0);
    expect(enAfter).toBeLessThan(enBefore);
    expect(enBefore - enAfter).toBeLessThan(2); // ~1 energy — the 20:1 favour is real

    // An empty tank falls back to blood — the perk is a spend, not immunity.
    const room3 = mkRoom({ bots: 1, botFill: 1 }, '');
    const p3 = firstPlayer(room3);
    room3.bots.quiet.add(p3.id);
    p3.perk = 'featherfall';
    pin(room3, p3.id, { x: 0, y: 90, z: 0 });
    room3.moveSim.drainEnergy(p3.id, 999);
    // Regen would rebuild ~17 energy during the fall and re-cover the
    // hit — the empty-tank case wants the pool to STAY empty.
    const sh3 = (room3.moveSim as unknown as { shadows: Map<string, { skillSuppressRegen: boolean }> }).shadows.get(p3.id);
    if (sh3) {sh3.skillSuppressRegen = true;}
    const hp3 = p3.health;
    for (let i = 0; i < 300 && !p3.isDead; i++) { step(room3, 1); }
    expect(p3.health).toBeLessThan(hp3);
  });

  it('a stubbed toe under 10% of the bar is absorbed whole', () => {
    // ~20m drop — over the 25 m/s floor but the (impact-25)*0.005 hit
    // lands under a tenth of max hp, so the funnel never fires it.
    const room = mkRoom({ bots: 1, botFill: 1 }, '');
    const p = firstPlayer(room);
    room.bots.quiet.add(p.id);
    p.perk = 'none';
    const seen: number[] = [];
    const prev = room.moveSim.onLanding;
    room.moveSim.onLanding = (pid, imp): void => { seen.push(imp); prev?.(pid, imp); };
    const hp0 = p.health;
    pin(room, p.id, { x: 0, y: 65, z: 0 }); // ~43 m/s — past the floor, under a tenth
    for (let i = 0; i < 300 && !p.isDead; i++) { step(room, 1); }
    // The landing DID register past minSpeed — the absorb, not the floor,
    // is what spared the bar.
    expect(seen.length).toBeGreaterThan(0);
    const hit = (Math.min(...seen) - MOVEMENT_CONFIG.fallDamageMinSpeed) * MOVEMENT_CONFIG.fallDamageScale * p.maxHealth;
    expect(hit).toBeLessThan(p.maxHealth * MOVEMENT_CONFIG.fallDamageAbsorbFrac);
    expect(p.health).toBe(hp0);
  });
});
