import { describe, it, expect } from 'bun:test';
import { mkRoom, pin } from './harness.ts';
import { simNow } from '../../src/simClock.ts';

describe('scenario: death and respawn', () => {
  it('a dead player respawns at a base with full health and protection', () => {
    const room = mkRoom({
      mode: 'tdm', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'tdm');
    const players = [...room.players.getAllPlayers().values()];
    const bravo = players.find((p) => p.team === 'bravo')!;
    pin(room, bravo.id, { x: 0, y: 31, z: 0 });
    bravo.health = 1;
    // Lethal damage through the same funnel every weapon funnels into.
    const kill = room.players.applyDamage(bravo.id, 500);
    expect(kill.killed).toBe(true);
    expect(bravo.isDead).toBe(true);
    // The 3s respawn timer is wall-clock — call the respawn directly, the
    // timer just schedules this same call in production.
    const res = room.players.respawnPlayer(bravo.id);
    expect(res).not.toBeNull();
    expect(bravo.isDead).toBe(false);
    expect(bravo.health).toBe(bravo.maxHealth);
    expect(bravo.protectedUntil).toBeGreaterThan(simNow()); // sim domain, not wall
    // Bravo base sits at x=+70 — the respawn must land near it, not at the
    // corpse site (rewind buffer cleared too).
    expect(Math.abs(res!.position.x - 70)).toBeLessThan(30);
  });
});
