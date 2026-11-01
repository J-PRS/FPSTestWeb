import { describe, it, expect } from 'bun:test';
import { CLASS_STATS } from '../../../shared/botClasses.ts';
import { mkRoom, firstPlayer } from './harness.ts';

describe('scenario: class/perk swaps bank on respawn', () => {
  it('classUpdate is invisible mid-life, applied at the new life', () => {
    const room = mkRoom({ bots: 1 }, 'tdm');
    const p = firstPlayer(room);
    // Spawn class follows the bot's kit now — the swap is what matters,
    // not which body the roster dealt it.
    const startClass = p.armorClass;
    const startMax = p.maxHealth;

    room.messages.handleMessage(p.id, { type: 'classUpdate', armorClass: 'heavy' });
    expect(p.armorClass).toBe(startClass); // nothing changes yet
    expect(p.pendingClass).toBe('heavy');
    expect(p.maxHealth).toBe(startMax); // no free heal mid-life

    const res = room.players.respawnPlayer(p.id);
    expect(res).not.toBeNull();
    expect(p.armorClass).toBe('heavy');
    expect(p.maxHealth).toBeGreaterThan(startMax);
    expect(p.pendingClass).toBeUndefined();
  });

  it('perkUpdate banks the same way — swapped at respawn, not mid-life', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    const basePerk = p.perk;
    room.messages.handleMessage(p.id, { type: 'perkUpdate', perk: 'regenerator' });
    expect(p.perk).toBe(basePerk);
    expect(p.pendingPerk).toBe('regenerator');
    room.players.respawnPlayer(p.id);
    expect(p.perk).toBe('regenerator');
    expect(p.pendingPerk).toBeUndefined();
  });
});

describe('scenario: reclaim applies the rejoiner class', () => {
  it('applyClaimedClass swaps the seat now, clamping health', () => {
    const room = mkRoom({ bots: 1 }, 'tdm');
    const p = firstPlayer(room);
    p.armorClass = 'medium';
    p.maxHealth = 100 + CLASS_STATS.medium.maxHealth;
    p.health = p.maxHealth;
    room.applyClaimedClass(p.id, 'heavy');
    expect(p.armorClass).toBe('heavy');
    expect(p.maxHealth).toBeGreaterThan(100 + CLASS_STATS.medium.maxHealth);
    expect(p.pendingClass).toBeUndefined();
    // Downgrade clamps current health to the smaller pool
    room.applyClaimedClass(p.id, 'light');
    expect(p.armorClass).toBe('light');
    expect(p.health).toBeLessThanOrEqual(p.maxHealth);
    // Bogus/unchanged claims are no-ops
    room.applyClaimedClass(p.id, 'bogus');
    expect(p.armorClass).toBe('light');
  });
});
