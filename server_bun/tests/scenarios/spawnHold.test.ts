import { describe, it, expect } from 'bun:test';
import { mkRoom, step } from './harness.ts';
import { simNow } from '../../src/simClock.ts';

describe('scenario: spawn hold — the body waits for client-ready', () => {
  it('a held seat is invisible + untouchable until ready releases it', () => {
    const room = mkRoom({ bots: 0 });
    const p = room.players.addPlayer('held', undefined, 'none', 'medium');
    p.spawnHold = true;
    room.players.holdSpawn(p.id);
    // Dormancy = dead-for-physics + suppressed-for-display: every
    // damage/collision funnel already rejects isDead, and the visible
    // channels (records, announce, roster) gate on the flag itself.
    expect(p.isDead).toBe(true);
    expect(p.awaitingReady?.hp).toBe(p.maxHealth);
    // The join announce defers: first-report announce fires off
    // announceIfInWorld — while held it must not mint the remote mesh.
    p.hasReceivedPosition = true;
    room.messages.announceIfInWorld(p);
    expect(p.joinAnnounced).toBe(false);
    // A blast landing on the dormant spot must not touch the body —
    // the saved hp is what releases, not whatever the zone dealt.
    const dealt = room.players.applyDamage(p.id, 999);
    expect(dealt.killed).toBe(false);
    expect(p.health).toBe(p.maxHealth);
    // Release via the wire verb — the body's TRUE state restores and
    // the spawn shield re-arms off the release (vulnerable only from
    // the moment the client can actually see and act).
    room.messages.handleMessage(p.id, { type: 'ready' });
    expect(p.awaitingReady).toBeUndefined();
    expect(p.isDead).toBe(false);
    expect(p.health).toBe(p.maxHealth);
    expect(p.protectedUntil).toBeGreaterThan(simNow());
    // Post-release the announce resumes its normal first-report path.
    room.messages.announceIfInWorld(p);
    expect(p.joinAnnounced).toBe(true);
  });

  it('a dead-held seat releases dead and re-arms respawn', () => {
    const room = mkRoom({ bots: 0 });
    const p = room.players.addPlayer('deadheld', undefined, 'none', 'medium');
    p.isDead = true;
    p.health = 0;
    p.spawnHold = true;
    room.players.holdSpawn(p.id);
    room.messages.handleMessage(p.id, { type: 'ready' });
    expect(p.isDead).toBe(true);
    // The re-armed respawn timer fires on the room clock — the corpse
    // revives like any death. (step() only ticks room.sims; respawn
    // deadlines ride respawnTick — drive it the same way TickLoop does.)
    for (let i = 0; i < 120 && p.isDead; i++) {step(room, 1); room.messages.respawnTick(simNow());}
    expect(p.isDead).toBe(false);
    expect(p.health).toBe(p.maxHealth);
  });

  it('ready on an unheld seat is a no-op', () => {
    const room = mkRoom({ bots: 0 });
    const p = room.players.addPlayer('plain', undefined, 'none', 'medium');
    p.health = 60;
    room.messages.handleMessage(p.id, { type: 'ready' });
    expect(p.isDead).toBe(false);
    expect(p.health).toBe(60);
  });
});
