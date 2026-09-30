import { describe, it, expect } from 'bun:test';
import { mkRoom, watch } from './harness.ts';
import { PlayerManager } from '../../src/PlayerManager.ts';
import { CombatHandler } from '../../src/CombatHandler.ts';

// A kicked/switched player mid-grace used to leave the grace timer
// armed: when it fired, removePlayerCompletely ran a SECOND time —
// duplicate playerLeft, double leaves count, and if the id had been
// re-seated it would tear down the live player.
describe('scenario: grace timer teardown', () => {
  it('removal during grace disarms the zombie timer — teardown runs once', async () => {
    const room = mkRoom({}, 'tdm');
    const a = room.players.addPlayer('p1');
    const w = watch(room);
    // Mirrors GameServer.onClose: socket dropped, grace timer armed.
    room.disconnected.set(a.id, {
      timeout: setTimeout(() => {
        room.disconnected.delete(a.id);
        room.removePlayerCompletely(a.id, 'grace period', () => {});
      }, 10),
    });
    // Kicked before the timer fires.
    room.removePlayerCompletely(a.id, 'adminKick', () => {});
    expect(room.disconnected.has(a.id)).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(w.count('playerLeft')).toBe(1);
  });

  it('grace expiry itself still tears down normally', async () => {
    const room = mkRoom({}, 'tdm');
    const a = room.players.addPlayer('p1');
    const w = watch(room);
    room.disconnected.set(a.id, {
      timeout: setTimeout(() => {
        room.disconnected.delete(a.id);
        room.removePlayerCompletely(a.id, 'grace period', () => {});
      }, 10),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(room.players.getPlayer(a.id)).toBeUndefined();
    expect(w.count('playerLeft')).toBe(1);
  });

  it('full removal also disarms a pending respawn — same zombie class', () => {
    const pm = new PlayerManager();
    const combat = new CombatHandler(pm, () => {}, () => {});
    pm.addPlayer('p1'); pm.breakShield('p1');
    // Kill through the env-damage funnel so scheduleRespawn arms.
    for (let i = 0; i < 3; i++) {
      combat.handleEnvironmentDamage('p1', { type: 'environmentDamage', amount: 40 });
    }
    expect(pm.getPlayer('p1')!.isDead).toBe(true);
    const timers = (combat as unknown as {
      respawner: { timers: Map<string, ReturnType<typeof setTimeout>> };
    }).respawner.timers;
    expect(timers.has('p1')).toBe(true);
    combat.onPlayerRemoved('p1');
    expect(timers.has('p1')).toBe(false);
  });
});
