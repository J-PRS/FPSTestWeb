import { simMs } from '../../src/simClock.ts';
import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, firstPlayer } from './harness.ts';
import { healPerTick } from '../../src/TickLoop.ts';
import { STATUS } from '../../../shared/status.ts';
import { POWERUP } from '../../../shared/pickups.ts';
import { perkMods } from '../../../shared/perks.ts';
import { CONFIG } from '../../src/config.ts';

// The tick-loop heal stack: mend flag + regen powerup + regenerator perk,
// all server-owned, all capped at maxHealth.
describe('scenario: server-owned heal channels', () => {
  it('mend flag heals per tick, dead and full health get nothing', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    pin(room, p.id, { x: 0, y: 31, z: 0 });
    p.health = Math.max(1, p.maxHealth - 20); // classes vary the pool — just leave heal room
    p.status = STATUS.MEND;
    const heal = healPerTick(p, Date.now());
    expect(heal).toBeCloseTo(12 / CONFIG.tickRate, 8);

    p.isDead = true;
    expect(healPerTick(p, Date.now())).toBe(0);
    p.isDead = false;
    p.health = p.maxHealth;
    expect(healPerTick(p, Date.now())).toBe(0);
  });

  it('regen powerup heals only inside its window; perk regen stacks', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    p.health = 10;
    p.status = 0;
    const now = Date.now();
    p.regenUntil = simMs(now + 30_000);
    expect(healPerTick(p, now)).toBeCloseTo(POWERUP.regenHpPerSec / CONFIG.tickRate, 8);

    // Expired window — nothing (default perk has no regen either).
    p.regenUntil = simMs(now - 1);
    expect(healPerTick(p, now)).toBeCloseTo(perkMods(p.perk).regen / CONFIG.tickRate, 8);

    // Regenerator is a ramp, not a flat rate: 10 unhurt seconds deep it
    // pays 0.2×10 = 2 hp/s on top of the powerup; a fresh hit zeroes it.
    p.perk = 'regenerator';
    p.lastDamageAt = simMs(now - 10_000);
    p.regenUntil = simMs(now + 30_000);
    expect(healPerTick(p, now)).toBeCloseTo(
      (POWERUP.regenHpPerSec + perkMods('regenerator').regenRamp * 10) / CONFIG.tickRate, 8,
    );
    p.lastDamageAt = simMs(now); // the chip-damage case: just hit → ~0
    expect(healPerTick(p, now)).toBeCloseTo(POWERUP.regenHpPerSec / CONFIG.tickRate, 8);
  });
});
