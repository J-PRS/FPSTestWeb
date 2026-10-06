import { describe, it, expect } from 'bun:test';
import { mkRoom, watch } from './harness.ts';
import { PlayerManager } from '../../src/PlayerManager.ts';
import { CombatHandler } from '../../src/CombatHandler.ts';
import { SessionRegistry } from '../../src/sessionRegistry.ts';

// Arm a real grace session — mirrors GameServer.onClose end to end:
// seat the player, drop the socket, arm the expiry the registry owns.
function graceArm(room: ReturnType<typeof mkRoom>, playerId: string, ms: number): SessionRegistry {
  const reg = new SessionRegistry();
  room.sessions = reg;
  reg.begin(playerId, room.name);
  reg.seat(playerId, false, 't');
  reg.disconnect(playerId, 'socket closed', ms, () => room.removePlayerCompletely(playerId, 'grace period', () => {}));
  return reg;
}

// A kicked/switched player mid-grace used to leave the grace timer
// armed: when it fired, removePlayerCompletely ran a SECOND time —
// duplicate playerLeft, double leaves count, and if the id had been
// re-seated it would tear down the live player.
describe('scenario: grace timer teardown', () => {
  it('removal during grace disarms the zombie timer — teardown runs once', async () => {
    const room = mkRoom({}, 'tdm');
    const a = room.players.addPlayer('p1');
    const w = watch(room);
    const reg = graceArm(room, a.id, 10);
    // Kicked before the timer fires.
    room.removePlayerCompletely(a.id, 'adminKick', () => {});
    expect(reg.state(a.id)).toBeUndefined(); // reaped — session deleted
    await new Promise((r) => setTimeout(r, 30));
    expect(w.count('playerLeft')).toBe(1);
  });

  it('grace expiry itself still tears down normally', async () => {
    const room = mkRoom({}, 'tdm');
    const a = room.players.addPlayer('p1');
    const w = watch(room);
    graceArm(room, a.id, 10);
    await new Promise((r) => setTimeout(r, 30));
    expect(room.players.getPlayer(a.id)).toBeUndefined();
    expect(w.count('playerLeft')).toBe(1);
  });

  it('full removal also disarms a pending respawn — same zombie class', () => {
    const pm = new PlayerManager();
    const combat = new CombatHandler(pm, () => {}, () => {});
    pm.addPlayer('p1'); pm.breakShield('p1');
    // Kill through the env-damage funnel so scheduleRespawn arms.
    // Claims clamp at 40/hit and medium is 125hp now — needs four.
    for (let i = 0; i < 4; i++) {
      combat.handleEnvironmentDamage('p1', { type: 'environmentDamage', amount: 50 });
    }
    expect(pm.getPlayer('p1')!.isDead).toBe(true);
    const timers = (combat as unknown as {
      respawner: { timers: Map<string, ReturnType<typeof setTimeout>> };
    }).respawner.timers;
    expect(timers.has('p1')).toBe(true);
    combat.onPlayerRemoved('p1');
    expect(timers.has('p1')).toBe(false);
  });

  it('removal clears a held-corpse flag too — a rejoin re-arms fresh', () => {
    const pm = new PlayerManager();
    const combat = new CombatHandler(pm, () => {}, () => {});
    pm.addPlayer('p1');
    const respawner = (combat as unknown as {
      respawner: { hold(id: string): void; isHeld(id: string): boolean };
    }).respawner;
    respawner.hold('p1');
    expect(respawner.isHeld('p1')).toBe(true);
    combat.onPlayerRemoved('p1');
    expect(respawner.isHeld('p1')).toBe(false);
  });
});
