import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, twoPlayers } from './harness.ts';
import { STATUS } from '../../../shared/status.ts';
import { simNow } from '../../src/simClock.ts';

describe('scenario: respawn is a clean life', () => {
  it('death strips channels; respawn restores health, protection, and a legal spot', () => {
    const room = mkRoom({
      mode: 'tdm', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'tdm');
    const [a, b] = twoPlayers(room);
    a.team = 'alpha'; b.team = 'bravo';
    pin(room, b.id, { x: 20, y: 31, z: 0 });
    b.status = STATUS.CLOAK | STATUS.MEND;
    b.protectedUntil = 0;
    room.players.applyDamage(b.id, 9999);
    expect(b.isDead).toBe(true);
    expect(b.status).toBe(0); // death strips cloak/mend — no ghost buffs
    const back = room.players.respawnPlayer(b.id);
    expect(back).toBeTruthy();
    expect(b.isDead).toBe(false);
    expect(b.health).toBeGreaterThan(0);
    // No armor handout on respawn — plating is earned via pickups/perks.
    expect(b.armor).toBe(0);
    expect(b.protectedUntil).toBeGreaterThan(simNow()); // sim domain, not wall
    expect(b.pendingRespawn).toBe(false);
  });
});
