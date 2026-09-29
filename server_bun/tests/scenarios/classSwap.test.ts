import { describe, it, expect } from 'bun:test';
import { mkRoom, firstPlayer } from './harness.ts';

describe('scenario: class/perk swaps bank on respawn', () => {
  it('classUpdate is invisible mid-life, applied at the new life', () => {
    const room = mkRoom({ bots: 1 }, 'tdm');
    const p = firstPlayer(room);
    expect(p.armorClass).toBe('medium');
    const mediumMax = p.maxHealth;

    room.messages.handleMessage(p.id, { type: 'classUpdate', armorClass: 'heavy' });
    expect(p.armorClass).toBe('medium'); // nothing changes yet
    expect(p.pendingClass).toBe('heavy');
    expect(p.maxHealth).toBe(mediumMax); // no free heal mid-life

    const res = room.players.respawnPlayer(p.id);
    expect(res).not.toBeNull();
    expect(p.armorClass).toBe('heavy');
    expect(p.maxHealth).toBeGreaterThan(mediumMax);
    expect(p.pendingClass).toBeUndefined();
  });

  it('perkUpdate banks the same way — swapped at respawn, not mid-life', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    const basePerk = p.perk;
    room.messages.handleMessage(p.id, { type: 'perkUpdate', perk: 'vitality' });
    expect(p.perk).toBe(basePerk);
    room.players.respawnPlayer(p.id);
    expect(p.perk).toBe('vitality');
    expect(p.pendingPerk).toBeUndefined();
  });
});
