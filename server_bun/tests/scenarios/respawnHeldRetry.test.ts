import { describe, it, expect } from 'bun:test';
import { mkRoom, step } from './harness.ts';
import { simNow } from '../../src/simClock.ts';

describe('scenario: respawn deadline lapsing inside a hold retries', () => {
  it('a deadline that fires while held is not lost - the player still revives', () => {
    const room = mkRoom({ bots: 0 });
    const p = room.players.addPlayer('stuckdead', undefined, 'none', 'medium');
    p.isDead = true;
    p.health = 0;
    room.messages.combat.ensureRespawn(p.id); // arm the deadline while dead
    // Reclaim-style hold lands AFTER the deadline was armed (resync
    // churn re-holds a dead seat) — the fired attempt must retry, not
    // lapse, or the seat stays dead forever.
    room.players.holdSpawn(p.id);
    for (let i = 0; i < 40; i++) {step(room, 1); room.messages.respawnTick(simNow());}
    expect(p.isDead).toBe(true); // held — still dead, attempt refused
    expect(p.awaitingReady).toBeDefined();
    // Release the hold: the re-armed deadline revives without any
    // extra arm — the retry carried the intent across the hold.
    room.players.releaseSpawn(p.id);
    for (let i = 0; i < 40 && p.isDead; i++) {step(room, 1); room.messages.respawnTick(simNow());}
    expect(p.isDead).toBe(false);
    expect(p.health).toBe(p.maxHealth);
  });
});
