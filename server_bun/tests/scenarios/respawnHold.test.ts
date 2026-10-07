import { describe, expect, it } from 'bun:test';
import { mkRoom, pin, step } from './harness.ts';
import { simNow } from '../../src/simClock.ts';
import { CONFIG } from '../../src/config.ts';

// Die-and-spectate (the L bind): respawn{hold:true} kills through the
// normal funnel but the corpse parks — the auto-respawn deadline lapses
// without reviving, and a plain dead-state respawn releases it instantly.
describe('respawn hold', () => {
  const runTicks = (room: ReturnType<typeof mkRoom>, seconds: number) => {
    for (let i = 0; i < Math.ceil(seconds / 0.05); i++) {
      step(room, 1);
      room.messages.respawnTick(simNow());
    }
  };

  it('a held suicide stays dead past the deadline; a dead press revives', () => {
    const room = mkRoom({});
    room.players.addPlayer('p1');
    const p = room.players.getPlayer('p1');
    if (!p) throw new Error('no p1');
    pin(room, 'p1', { x: 0, y: 60, z: 0 });

    room.messages.combat.respawnRequest('p1', true);
    expect(p.isDead).toBe(true);

    runTicks(room, CONFIG.respawnDelayMs / 1000 + 1);
    expect(p.isDead).toBe(true); // held corpse — no auto revive

    // Dead-state press = respawn now, releasing the hold.
    room.messages.combat.respawnRequest('p1');
    expect(p.isDead).toBe(false);
  });

  it('a dead press during the countdown does not skip the timer', () => {
    const room = mkRoom({});
    room.players.addPlayer('p3');
    const p = room.players.getPlayer('p3');
    if (!p) throw new Error('no p3');
    pin(room, 'p3', { x: 0, y: 60, z: 0 });

    room.messages.combat.respawnRequest('p3');
    expect(p.isDead).toBe(true);

    // Click-spam mid-countdown — must not revive early.
    for (let i = 0; i < 3; i++) room.messages.combat.respawnRequest('p3');
    expect(p.isDead).toBe(true);

    runTicks(room, CONFIG.respawnDelayMs / 1000 + 1);
    expect(p.isDead).toBe(false);
  });

  it('a plain suicide still auto-respawns on schedule', () => {
    const room = mkRoom({});
    room.players.addPlayer('p2');
    const p = room.players.getPlayer('p2');
    if (!p) throw new Error('no p2');
    pin(room, 'p2', { x: 0, y: 60, z: 0 });

    room.messages.combat.respawnRequest('p2');
    expect(p.isDead).toBe(true);

    runTicks(room, CONFIG.respawnDelayMs / 1000 + 1);
    expect(p.isDead).toBe(false);
  });
});
