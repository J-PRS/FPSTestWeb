import { describe, expect, it } from 'bun:test';
import { mkRoom, firstPlayer, pin } from './harness.ts';
import { POWERUP } from '../../../shared/pickups.ts';

// Armor pool: absorbs armorAbsorb of each hit while it lasts, overflow
// leaks to health — the powerup never makes you invulnerable, just padded.

describe('armor soak', () => {
  it('absorbs the soak fraction, overflow reaches health', () => {
    const room = mkRoom('flat', 'dm');
    room.players.addPlayer('p1', 'alpha', 'none', 'medium');
    const p = firstPlayer(room);
    pin(room, 'p1');
    p.health = 100; p.armor = 100;
    const r = room.players.applyDamage('p1', 100);
    expect(r.newArmor).toBe(100 - 100 * POWERUP.armorAbsorb); // 20 left
    expect(r.newHealth).toBe(100 - (100 - 100 * POWERUP.armorAbsorb)); // 80
    expect(r.killed).toBe(false);
  });

  it('a depleted pool soaks nothing — the whole hit lands on health', () => {
    const room = mkRoom('flat', 'dm');
    room.players.addPlayer('p1', 'alpha', 'none', 'medium');
    const p = firstPlayer(room);
    pin(room, 'p1');
    p.health = 100; p.armor = 5;
    const r = room.players.applyDamage('p1', 100);
    expect(r.newArmor).toBe(0); // 5*0.8=4 soaked, pool gone…
    expect(r.newHealth).toBeLessThan(100); // …rest on health
  });

  it('dead players keep dead armor — no zombie padding on respawn edge', () => {
    const room = mkRoom('flat', 'dm');
    room.players.addPlayer('p1', 'alpha', 'none', 'medium');
    const p = firstPlayer(room);
    pin(room, 'p1');
    p.isDead = true; p.armor = 50;
    room.players.applyDamage('p1', 10);
    expect(p.armor).toBe(50); // applyDamage early-returns on isDead
  });
});
