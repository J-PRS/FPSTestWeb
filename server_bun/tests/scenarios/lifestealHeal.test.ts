import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, twoPlayers } from './harness.ts';

// Butcher — the event-shaped survivability perk: every hit still deals
// its listed damage (hits-to-kill stays countable), and the payoff is a
// full heal only when the killing edge is a MELEE frag.
describe('scenario: lifesteal melee heal', () => {
  it('a melee frag refills the lifesteal to max health', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    a.perk = 'lifesteal';
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 3, y: 31, z: 0 });
    a.health = 30;
    b.health = 10; // inside one swing even after aoe falloff
    room.messages.handleMessage(a.id, {
      type: 'shotFired', weaponType: 10 /* Melee */, dir: { x: 1, y: 0, z: 0 },
    } as never);
    expect(b.isDead).toBe(true);
    expect(a.health).toBe(a.maxHealth);
  });

  it('the same frag heals nothing without the perk', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    a.perk = 'none';
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 3, y: 31, z: 0 });
    a.health = 30;
    b.health = 10;
    room.messages.handleMessage(a.id, {
      type: 'shotFired', weaponType: 10 /* Melee */, dir: { x: 1, y: 0, z: 0 },
    } as never);
    expect(b.isDead).toBe(true);
    expect(a.health).toBe(30);
  });

  it('a non-melee kill heals nothing even for the lifesteal', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    a.perk = 'lifesteal';
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 3, y: 31, z: 0 });
    a.health = 30;
    b.health = 10;
    room.messages.combat.serverHit(a.id, b.id, 50, 'Bolt', { weapon: 0 });
    expect(b.isDead).toBe(true);
    expect(a.health).toBe(30);
  });
});
