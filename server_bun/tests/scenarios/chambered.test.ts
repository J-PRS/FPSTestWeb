import { describe, it, expect } from 'bun:test';
import { mkRoom, flat, firstPlayer, watch } from './harness.ts';
import { simMs } from '../../src/simClock.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import { flyRampMult, perkMods } from '../../../shared/perks.ts';
import { hmHeight } from '../../../shared/heightfield.ts';
import { CLASS_STATS, classCapsule } from '../../../shared/botClasses.ts';
import type { Room } from '../../src/Room.ts';
import type { PlayerState } from '../../src/types.ts';

const EYE = hmHeight(flat, 0, 0) + CLASS_STATS.medium.eyeHeight;

function projsLive(room: Room): number {
  return (room.projectiles as unknown as { projs: Map<string, unknown> }).projs.size;
}

function stand(room: Room, id: string, x: number, perk = 'none'): PlayerState {
  const p = room.players.addPlayer(id, undefined, perk as never, 'medium');
  p.isBot = true;
  p.protectedUntil = simMs(0);
  p.position = { x, y: EYE, z: 0 };
  return p;
}

// Disc: fireInterval 1s, speed 80 m/s, flat flight.
function discAt(room: Room, shooterId: string, x = 0, lagS = 0): void {
  // Aim at capsule CENTER - a wake-only contact still detonates but pays
  // no airtime ramp (bodyDirect gate), which would read as ratio 1.
  room.projectiles.spawn(shooterId, WeaponType.Disc,
    { x, y: EYE + classCapsule('medium').centerOff, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, undefined, lagS);
}

describe('perk: chambered - one shell in the air, direct hits ramp to 2x', () => {
  it('flyRampMult: 0.1s bands to 100% at the interval, capped past it', () => {
    const m = perkMods('chambered');
    // interval 1s: banded airtime IS the bonus fraction
    expect(flyRampMult(m, 0.05, 1)).toBe(1);      // 0.0s band
    expect(flyRampMult(m, 0.25, 1)).toBeCloseTo(1.2); // 0.2s band
    expect(flyRampMult(m, 0.5, 1)).toBeCloseTo(1.5);
    expect(flyRampMult(m, 0.75, 1)).toBeCloseTo(1.7); // 0.7s band
    expect(flyRampMult(m, 1, 1)).toBeCloseTo(2);
    expect(flyRampMult(m, 4, 1)).toBeCloseTo(2); // capped
    // interval 0.8s: same bands, steeper ramp
    expect(flyRampMult(m, 0.4, 0.8)).toBeCloseTo(1.5);
    expect(flyRampMult(m, 0.6, 0.8)).toBeCloseTo(1.75);
    expect(flyRampMult(m, 0.8, 0.8)).toBeCloseTo(2);
    // other perks / missing airtime pay nothing
    expect(flyRampMult(perkMods('none'), 5, 1)).toBe(1);
    expect(flyRampMult(m, undefined, 1)).toBe(1);
    // sub-0.35s guns are exempt - no ramp however long the shell flew
    expect(flyRampMult(m, 5, 0.3)).toBe(1);
    expect(flyRampMult(m, 0.35, 0.34)).toBe(1);
  });

  it('a second pull fades the first shell - fizzle edge, no blast', () => {
    const room = mkRoom({ bots: 1 });
    const w = watch(room);
    const shooter = firstPlayer(room);
    shooter.perk = 'chambered';
    shooter.protectedUntil = simMs(0);
    shooter.position = { x: 0, y: EYE, z: 0 };
    discAt(room, shooter.id);
    expect(projsLive(room)).toBe(1);
    const goneBefore = w.msgs.filter((m) => m.type === 'projectileDestroyed').length;
    discAt(room, shooter.id); // pull two fades shell A
    expect(projsLive(room)).toBe(1); // only the new shell lives
    const gone = w.msgs.filter((m) => m.type === 'projectileDestroyed');
    expect(gone.length).toBe(goneBefore + 1);
    expect((gone[gone.length - 1] as { fizzle?: boolean }).fizzle).toBe(true);
  });

  it('a non-chambered owner keeps both shells flying', () => {
    const room = mkRoom({ bots: 1 });
    const shooter = firstPlayer(room);
    shooter.position = { x: 0, y: EYE, z: 0 };
    discAt(room, shooter.id);
    discAt(room, shooter.id);
    expect(projsLive(room)).toBe(2);
  });

  it('a shell landing at ~1s age pays ~2x direct damage vs the same hit without the perk', () => {
    // Spawned 4m short with lagS=0.95: the first swept tick crosses the
    // capsule dead-center (bodyDirect) at ~1s age = the full ramp. A
    // long spawn wakes up early and detonates on the wake sphere.
    const hits = (perk: string): number => {
      const room = mkRoom({ bots: 0 });
      const shooter = stand(room, 'shooter', 0, perk);
      const victim = stand(room, 'victim', 80);
      victim.health = 10_000; // uncapped reading - a 2x ramp would gib a stock bar
      const hp = victim.health;
      discAt(room, shooter.id, 76, 0.95);
      for (let i = 0; i < 10 && projsLive(room) > 0; i++) {room.projectiles.tick(0.05);}
      return hp - victim.health;
    };
    const normal = hits('none');
    const chambered = hits('chambered');
    expect(normal).toBeGreaterThan(0);
    expect(chambered / normal).toBeGreaterThan(1.9);
    expect(chambered / normal).toBeLessThan(2.1);
  });
});
