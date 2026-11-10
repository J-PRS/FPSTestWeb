import { describe, it, expect, vi, beforeEach } from 'vitest';
import {type ServerMessage, PROTOCOL_VERSION} from '../../../shared/protocol.js';

import { makeDeps, feed } from './netHarness.js';
vi.mock('../core/sfx.js', () => ({ at: (): void => { return; }, shotAt: (): void => { return; }, init: (): void => { return; }, hitMarker: (): void => { return; }, playerHurt: (): void => { return; }, shieldHit: (): void => { return; }, killConfirm: (): void => { return; }, flagCue: (): void => { return; }, matchHorn: (): void => { return; } }));
// RemotePlayer's GLTF model fetch can't run headless - visual shell only,
// the lifecycle under test lives in RemoteSet, not the mesh.
vi.mock('../entities/PlayerModel.js', (): { PlayerModel: () => { load: () => Promise<void>; }; } => ({
  PlayerModel: function (): { load: () => Promise<void>; } {
    return new Proxy({ load: (): Promise<void> => Promise.resolve() }, {
      get: (t, k): unknown => (k in t ? (t as Record<PropertyKey, unknown>)[k] : (): void => { return; }),
    });
  },
}));
// Lobby is constructed async inside wireNetworkHandlers off a fetch() -
// keep it pending forever so it never builds DOM in tests.
globalThis.fetch = ((): Promise<Response> => new Promise<Response>((): void => { return; })) as unknown as typeof fetch;


describe('netHarness - real wire messages through real handlers', (): void => {
  // oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
  let h!: ReturnType<typeof makeDeps>;
  beforeEach((): void => { h = makeDeps(); });

  it('gameState populates world meta + remote roster', (): void => {
    feed(h.nm, {
      type: 'gameState', players: [
        { id: 'BOT-1', internalId: 'b1', position: { x: 1, y: 2, z: 3 }, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 }, health: 100, isDead: false, team: 'alpha' },
      ],
      sessionToken: 'tok', protocolVersion: PROTOCOL_VERSION,
      room: 'duel-1', mode: 'dm', team: 'bravo', ffaScores: { 'BOT-1': 2 },
      respawnMs: 3000,
    } as ServerMessage);
    expect(h.world.mode).toBe('dm');
    expect(h.world.localTeam).toBe('bravo');
    expect(h.world.ffaScores.get('BOT-1')).toBe(2);
    expect(h.world.respawnMs).toBe(3000);
  });

  it('playerJoined → update → left lifecycle through RemoteSet', (): void => {
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION, room: 'r' } as ServerMessage);
    feed(h.nm, { type: 'playerJoined', playerId: 'peer-1', position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 } } as ServerMessage);
    // Join only registers the roster row - the RemotePlayer materializes
    // on the first tickUpdate carrying that id.
    feed(h.nm, { type: 'tickUpdate', updates: [{ playerId: 'peer-1', position: { x: 1, y: 2, z: 3 }, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 }, health: 100, isDead: false }] } as ServerMessage);
    expect(h.world.remotePlayers.has('peer-1')).toBe(true);
    feed(h.nm, { type: 'playerLeft', playerId: 'peer-1' } as ServerMessage);
    expect(h.world.remotePlayers.has('peer-1')).toBe(false);
  });

  it('playerKill routes into frag feed with weapon context', (): void => {
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION } as ServerMessage);
    feed(h.nm, { type: 'playerKill', shooterId: 'peer-1', targetId: 'tester-local', weaponType: 1 } as ServerMessage);
    // Local death → HUD death overlay, no frag banner for our own death.
    expect(h.calls.hud).toContain('setDeathOverlay');
  });

  it('pickup spawn/gone and gem collect grant local effects', (): void => {
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION } as ServerMessage);
    const spawnSpy = vi.spyOn(h.nm as unknown as { onPickupSpawn(): void }, 'onPickupSpawn');
    feed(h.nm, { type: 'pickupSpawn', id: 7, pos: { x: 0, y: 0, z: 0 }, kind: 'gem' } as ServerMessage);
    expect(spawnSpy).toHaveBeenCalled();
    expect(h.world.netPickups?.has(7)).toBe(true);
    feed(h.nm, { type: 'pickupGone', id: 7, by: (h.nm as unknown as { getLocalPlayerId(): string }).getLocalPlayerId() } as ServerMessage);
    // Server-verified collect - the handler grants the offline reward itself.
    expect(h.player.heal).toHaveBeenCalledWith(0.2);
    expect(h.player.grantJetBoost).toHaveBeenCalled();
  });

  it('deploySpawn/Gone reach the deployables manager', (): void => {
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION } as ServerMessage);
    feed(h.nm, { type: 'deploySpawn', id: 3, owner: 'peer-1', kind: 'turret', pos: { x: 0, y: 0, z: 0 } } as ServerMessage);
    expect(h.calls.deployables).toContain('spawn:3');
    feed(h.nm, { type: 'deployGone', id: 3 } as ServerMessage);
    expect(h.calls.deployables).toContain('gone:3');
    feed(h.nm, { type: 'turretShot', id: 3, owner: 'peer-1', targetId: 'tester-local' } as ServerMessage);
    expect(h.calls.deployables).toContain('shot:3');
    feed(h.nm, { type: 'mineBoom', id: 3, pos: { x: 0, y: 0, z: 0 } } as ServerMessage);
    expect(h.calls.deployables).toContain('boom:3');
  });

  it('flagUpdate writes flagStates', (): void => {
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION } as ServerMessage);
    feed(h.nm, { type: 'flagUpdate', flags: [{ team: 'alpha', pos: { x: 1, y: 0, z: 1 }, state: 'carried', carrier: 'peer-1' }] } as ServerMessage);
    expect(h.world.flagStates.alpha).toBe('carried');
  });

  it('correction below 0.5m is ignored; above snaps local pos', (): void => {
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION } as ServerMessage);
    feed(h.nm, { type: 'correction', seq: 1, position: { x: 0.1, y: 5, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 } } as ServerMessage);
    expect(h.player.pos.x).toBe(0);
    feed(h.nm, { type: 'correction', seq: 2, position: { x: 10, y: 5, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 } } as ServerMessage);
    expect(h.player.pos.x).toBe(10);
    // The sim snaps instantly but the camera eases - renderPos carries the
    // pre-snap offset so the view glides ~100ms instead of teleporting.
    expect(h.calls.renderSnap).toEqual([10]);
  });

  // hitSeq/tickSeq are per-room spaces. A room hop without reconnect must
  // reset both watermarks or every hit (and every tick frame) drops for
  // the rest of the session - the persistent health-desync signature.
  it('hit seq watermark resets on gameState so a new room hits apply', (): void => {
    const hit = (seq: number, health: number): void => feed(h.nm, {
      type: 'playerHit', shooterId: 'peer-1', targetId: 'tester-local', damage: 10, health, seq,
    } as ServerMessage);
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION, room: 'r1' } as ServerMessage);
    hit(5, 50);
    expect(h.player.health).toBe(50);
    // Stale re-delivery dedups.
    hit(5, 10);
    hit(4, 10);
    expect(h.player.health).toBe(50);
    // Room hop: the new room's seqs restart at 1 - must still apply.
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION, room: 'r2' } as ServerMessage);
    hit(1, 90);
    expect(h.player.health).toBe(90);
  });

  // Protocol mismatch: a stale bundle can't parse a new wire format -
  // the gameState must bail BEFORE the roster swap (a cleared roster on
  // a bad frame would silently desync), count the reload attempt, and
  // stop trying after the 2-attempt budget so a newer server can't
  // reload-loop the tab.
  it('a protocol-mismatched gameState early-returns and caps reload attempts', (): void => {
    // Plain-object location: assignment is a no-op store, but the counter
    // path runs - headless tests still exercise the reload contract.
    vi.stubGlobal('location', { href: 'http://x/' });
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION, room: 'r1', mode: 'dm' } as ServerMessage);
    expect(h.world.mode).toBe('dm');

    const bad = (): void => feed(h.nm, { type: 'gameState', players: [], protocolVersion: 999_999, room: 'evil', mode: 'ctf' } as ServerMessage);
    bad();
    expect(sessionStorage.getItem('fps-proto-reload')).toBe('1');
    expect(h.world.mode).toBe('dm'); // swap never ran - stale bundle can't rewrite state
    bad();
    expect(sessionStorage.getItem('fps-proto-reload')).toBe('2');
    bad();
    expect(sessionStorage.getItem('fps-proto-reload')).toBe('2'); // budget spent - no loop

    // A clean connect resets the counter and applies the frame normally.
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION, room: 'r2', mode: 'ctf' } as ServerMessage);
    expect(sessionStorage.getItem('fps-proto-reload')).toBeNull();
    expect(h.world.mode).toBe('ctf');
    vi.unstubAllGlobals();
  });

  it('a throwing sessionStorage bails the mismatch without crashing the handler', (): void => {
    vi.stubGlobal('sessionStorage', {
      getItem: (): never => { throw new Error('SecurityError'); },
      setItem: (): never => { throw new Error('QuotaExceededError'); },
      removeItem: (): never => { throw new Error('SecurityError'); },
    });
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION, room: 'r1', mode: 'dm' } as ServerMessage);
    expect((): void => feed(h.nm, { type: 'gameState', players: [], protocolVersion: 999_999, room: 'x' } as ServerMessage)).not.toThrow();
    expect(h.world.mode).toBe('dm'); // still bailed before the swap
    vi.unstubAllGlobals();
  });
});

// Corpse-window regression: dead rows keep streaming position echoes,
// and update()'s revive-on-update used to fire on each one - dead↔alive
// ping-pong that re-armed the mirror death and spammed gib bursts.
// The roster gate in onPlayerUpdate must drop dead-row echoes, while a
// roster-healed (live) row still revives a stale-dead entity.
describe('netHarness - corpse-window echoes', (): void => {
  // oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
  let h!: ReturnType<typeof makeDeps>;
  beforeEach((): void => { h = makeDeps(); });

  it('dead-row position echoes do not revive; live row does', (): void => {
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION, room: 'r' } as ServerMessage);
    feed(h.nm, { type: 'playerJoined', playerId: 'peer-1', position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 } } as ServerMessage);
    const upd = (x: number, isDead: boolean, hp: number): void => feed(h.nm, {
      type: 'tickUpdate',
      updates: [{ playerId: 'peer-1', position: { x, y: 2, z: 3 }, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 }, health: hp, isDead }],
    } as ServerMessage);
    upd(1, false, 100);
    const rp = h.world.remotePlayers.get('peer-1')!;
    expect(rp.isDead).toBe(false);

    feed(h.nm, { type: 'playerKill', shooterId: 'environment', targetId: 'peer-1' } as ServerMessage);
    expect(rp.isDead).toBe(true);

    // Dead echoes - the corpse window. Each one used to revive the body.
    for (const x of [4, 5, 6]) {
      upd(x, true, 0);
      expect(rp.isDead, `dead echo at x=${x} revived the corpse`).toBe(true);
    }

    // Roster heals to live - the dropped-respawn-echo path still revives.
    upd(9, false, 100);
    expect(rp.isDead).toBe(false);
  });
});
