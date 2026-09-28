/**
 * netHarness — drives real decoded wire messages through the actual
 * NetworkManager dispatch + netHandlers wiring, headless. This is the
 * missing layer between the offline demo decoder and a browser: handler
 * bugs (roster reconcile, stale gates, ghost entities) surface here
 * without a render loop.
 *
 * Deps are hand stubs recording calls; Scene is real THREE (headless-safe),
 * Chat/Logger ride the setup.ts DOM stubs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

vi.mock('../core/sfx.js', () => ({ at: () => {}, shotAt: () => {}, init: () => {} }));
// RemotePlayer's GLTF model fetch can't run headless — visual shell only,
// the lifecycle under test lives in RemoteSet, not the mesh.
vi.mock('../entities/PlayerModel.js', () => ({
  PlayerModel: class {
    load() { return Promise.resolve(); }
    setPosition() {} setRotation() {} setColliderVisible() {} setVisible() {}
    dispose() {} update() {}
  },
}));
// Lobby is constructed async inside wireNetworkHandlers off a fetch() —
// keep it pending forever so it never builds DOM in tests.
globalThis.fetch = () => new Promise<Response>(() => {});

import { NetworkManager } from '../networking/NetworkManager.js';
import { wireNetworkHandlers, type NetDeps } from '../game/netHandlers.js';
import { createWorldState } from '../game/worldState.js';
import { ExplosionTracker } from '../utils/ExplosionTracker.js';
import { PROTOCOL_VERSION } from "../../../shared/protocol.js";
import type { ServerMessage } from '../../../shared/protocol.js';

// handleMessage is `private` (compile-time only) — call it through a
// structural cast rather than `any`, per repo lint rules.
interface NmWithDispatch { handleMessage(d: ServerMessage): void; }

function makeDeps() {
  const nm = new NetworkManager();
  nm.setPlayerId('tester-local');
  const world = createWorldState();
  const calls = { hud: [] as string[], frag: [] as string[], entities: [] as string[], deployables: [] as string[] };
  const player = {
    pos: new THREE.Vector3(0, 5, 0),
    vel: new THREE.Vector3(),
    yaw: 0, pitch: 0, onGround: true,
    health: 100, armor: 0, isDead: false, isShielded: false,
    buffUntil: { regen: 0, dd: 0 },
    absorbShieldDamage() {}, applyPull() {}, applyKnockback() {},
    heal() {}, grantJetBoost() {}, syncMovement() {},
    movement: {
      setState() {}, setInput() {}, update() {},
      getState: () => ({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), onGround: true }),
    },
  };
  const deps: NetDeps = {
    lazyNetworkManager: () => nm,
    lazyScene: () => scene,
    lazyTerrain: () => ({ getHeight: () => 0, reloadHeightmap() {} }) as never,
    lazyPlayer: () => player as never,
    lazyEffects: () => ({ spawnJumpDust() {}, spawnJetpack() {}, spawnBeam() {} }) as never,
    lazyHud: () => new Proxy({}, { get: (_t, k) => (a?: unknown) => { calls.hud.push(`${String(k)}`); return a; } }) as never,
    lazyHealthBarSystem: () => ({ spawn() {} }) as never,
    fragMessages: { show: (m: string) => calls.frag.push(m) } as never,
    explosionTracker: new ExplosionTracker(),
    logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    world,
    setLastSentPos() {},
    entities: () => ({
      netBallSpawn() {}, netBallSegment() {}, netBallDie() {}, netBallRoster() {},
      deployables: {
        remoteIds: () => [] as number[],
        remoteSpawn: (id: number) => calls.deployables.push(`spawn:${id}`),
        remoteRemove: (id: number) => calls.deployables.push(`gone:${id}`),
        remoteTurretShot: (id: number) => calls.deployables.push(`shot:${id}`),
        remoteMineBoom: (id: number) => calls.deployables.push(`boom:${id}`),
      },
    }) as never,
  };
  const scene = new THREE.Scene();
  wireNetworkHandlers(deps);
  return { nm: nm as unknown as NmWithDispatch, world, calls, player };
}

const feed = (nm: NmWithDispatch, m: ServerMessage) => nm.handleMessage(m);

describe('netHarness — real wire messages through real handlers', () => {
  let h: ReturnType<typeof makeDeps>;
  beforeEach(() => { h = makeDeps(); });

  it('gameState populates world meta + remote roster', () => {
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

  it('playerJoined → update → left lifecycle through RemoteSet', () => {
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION, room: 'r' } as ServerMessage);
    feed(h.nm, { type: 'playerJoined', playerId: 'peer-1', position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 } } as ServerMessage);
    // Join only registers the roster row — the RemotePlayer materializes
    // on the first tickUpdate carrying that id.
    feed(h.nm, { type: 'tickUpdate', updates: [{ playerId: 'peer-1', position: { x: 1, y: 2, z: 3 }, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 }, health: 100, isDead: false }] } as ServerMessage);
    expect(h.world.remotePlayers.has('peer-1')).toBe(true);
    feed(h.nm, { type: 'playerLeft', playerId: 'peer-1' } as ServerMessage);
    expect(h.world.remotePlayers.has('peer-1')).toBe(false);
  });

  it('playerKill routes into frag feed with weapon context', () => {
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION } as ServerMessage);
    feed(h.nm, { type: 'playerKill', shooterId: 'peer-1', targetId: 'tester-local', weaponType: 1 } as ServerMessage);
    // Local death → HUD death overlay, no frag banner for our own death.
    expect(h.calls.hud).toContain('setDeathOverlay');
  });

  it('pickup spawn/gone and gem collect grant local effects', () => {
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION } as ServerMessage);
    feed(h.nm, { type: 'pickupSpawn', id: 7, pos: { x: 0, y: 0, z: 0 }, kind: 'gem' } as ServerMessage);
    feed(h.nm, { type: 'pickupGone', id: 7, by: 'tester-local' } as ServerMessage);
    // no throw = pass; gem collect calls heal+grantJetBoost on the stub
  });

  it('deploySpawn/Gone reach the deployables manager', () => {
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

  it('flagUpdate writes flagStates', () => {
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION } as ServerMessage);
    feed(h.nm, { type: 'flagUpdate', flags: [{ team: 'alpha', pos: { x: 1, y: 0, z: 1 }, state: 'carried', carrier: 'peer-1' }] } as ServerMessage);
    expect(h.world.flagStates.alpha).toBe('carried');
  });

  it('correction below 0.5m is ignored; above snaps local pos', () => {
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION } as ServerMessage);
    feed(h.nm, { type: 'correction', seq: 1, position: { x: 0.1, y: 5, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 } } as ServerMessage);
    expect(h.player.pos.x).toBe(0);
    feed(h.nm, { type: 'correction', seq: 2, position: { x: 10, y: 5, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 } } as ServerMessage);
    expect(h.player.pos.x).toBe(10);
  });
});
