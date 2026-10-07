import { describe, it, expect, beforeEach } from 'bun:test';
import { RespawnManager } from '../../src/respawn.ts';
import { CONFIG } from '../../src/config.ts';
import { simNow, simNowAdvance, simNowReset } from '../../src/simClock.ts';

interface FakePlayer { isDead: boolean; correctionGraceUntil: number; internalId: string }

function mkManager() {
  const players = new Map<string, FakePlayer>();
  const fired: string[] = [];
  const broadcasts: string[] = [];
  const pm = {
    getPlayer: (id: string) => players.get(id),
    respawnPlayer: (id: string) => {
      const p = players.get(id);
      if (!p) return null;
      p.isDead = false;
      fired.push(id);
      return { position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 }, armorClass: 'light' };
    },
  };
  const mgr = new RespawnManager(pm as never, (m) => broadcasts.push(m.type), undefined);
  return { players, fired, broadcasts, mgr };
}

const kill = (players: Map<string, FakePlayer>, id: string) =>
  players.set(id, { isDead: true, correctionGraceUntil: 0, internalId: id });

// One corpse = one respawn, on the deadline, never early, never twice.
// The wall timer and the sim-tick share fire(), so ticking these down
// pins the same lifecycle the production timer takes.
describe('RespawnManager lifecycle', () => {
  beforeEach(() => simNowReset(1_700_000_000_000));

  it('a pending respawn fires exactly once on the deadline', () => {
    const { players, fired, broadcasts, mgr } = mkManager();
    kill(players, 'p1');
    mgr.schedule('p1');
    // Nothing fires before the deadline.
    mgr.tick(simNow() + CONFIG.respawnDelayMs - 1);
    expect(fired.length).toBe(0);
    simNowAdvance(CONFIG.respawnDelayMs + 1);
    mgr.tick(simNow());
    expect(fired).toEqual(['p1']);
    expect(broadcasts).toEqual(['playerRespawn']);
    // A second tick long after must not re-fire.
    simNowAdvance(CONFIG.respawnDelayMs * 2);
    mgr.tick(simNow());
    expect(fired.length).toBe(1);
  });

  it('a second death while dead replaces the timer — never stacks', () => {
    const { players, fired, mgr } = mkManager();
    kill(players, 'p1');
    mgr.schedule('p1');
    simNowAdvance(1000);
    mgr.schedule('p1'); // re-arm — the first timer is dead code now
    simNowAdvance(CONFIG.respawnDelayMs + 1);
    mgr.tick(simNow());
    expect(fired).toEqual(['p1']);
    // And the replaced deadline must not also fire later.
    simNowAdvance(CONFIG.respawnDelayMs * 3);
    mgr.tick(simNow());
    expect(fired.length).toBe(1);
  });

  it('cancel() (depart/disconnect) drains the pending respawn', () => {
    const { players, fired, mgr } = mkManager();
    kill(players, 'p1');
    mgr.schedule('p1');
    mgr.cancel('p1');
    simNowAdvance(CONFIG.respawnDelayMs * 2);
    mgr.tick(simNow());
    expect(fired.length).toBe(0);
  });

  it('a held corpse stays dead past the deadline until respawnNow', () => {
    const { players, fired, broadcasts, mgr } = mkManager();
    kill(players, 'p1');
    mgr.hold('p1');
    mgr.schedule('p1');
    simNowAdvance(CONFIG.respawnDelayMs * 3);
    mgr.tick(simNow());
    expect(fired.length).toBe(0);
    expect(players.get('p1')!.isDead).toBe(true);
    mgr.respawnNow('p1');
    expect(fired).toEqual(['p1']);
    expect(broadcasts).toEqual(['playerRespawn']);
  });

  it('respawnNow does NOT skip an unheld pending countdown', () => {
    const { players, fired, mgr } = mkManager();
    kill(players, 'p1');
    mgr.schedule('p1');
    mgr.respawnNow('p1'); // press during countdown — the timer is owed
    expect(fired.length).toBe(0);
    expect(players.get('p1')!.isDead).toBe(true);
    simNowAdvance(CONFIG.respawnDelayMs + 1);
    mgr.tick(simNow());
    expect(fired).toEqual(['p1']);
  });

  it('ensure() re-arms a reconnecting dead player with no timer', () => {
    const { players, fired, mgr } = mkManager();
    kill(players, 'p1'); // restored dead, cancel() already ran on depart
    mgr.ensure('p1');
    simNowAdvance(CONFIG.respawnDelayMs + 1);
    mgr.tick(simNow());
    expect(fired).toEqual(['p1']);
    // And a living player gets nothing.
    players.set('p2', { isDead: false, correctionGraceUntil: 0, internalId: 'p2' });
    mgr.ensure('p2');
    simNowAdvance(CONFIG.respawnDelayMs + 1);
    mgr.tick(simNow());
    expect(fired.length).toBe(1);
  });

  it('dispose() drains every pending timer + hold with the room', () => {
    const { players, fired, mgr } = mkManager();
    kill(players, 'p1'); kill(players, 'p2');
    mgr.hold('p1');
    mgr.schedule('p1'); mgr.schedule('p2');
    mgr.dispose();
    simNowAdvance(CONFIG.respawnDelayMs * 3);
    mgr.tick(simNow());
    expect(fired.length).toBe(0);
    expect(players.get('p1')!.isDead).toBe(true);
    expect(players.get('p2')!.isDead).toBe(true);
  });
});
