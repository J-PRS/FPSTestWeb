/**
 * Shared headless harness: a real NetworkManager + real netHandlers wiring
 * with hand-stubbed game deps. Import this from test files; the module mocks
 * (sfx, PlayerModel GLB fetch) must live in each test file since vi.mock is
 * per-file. `feed`/`feedBin` drive the real dispatch + binary decode paths.
 */
import * as THREE from 'three';
import { NetworkManager, type RemotePlayerState } from '../networking/NetworkManager.js';
import { wireNetworkHandlers, type NetDeps } from '../game/netHandlers.js';
import { createWorldState } from '../game/worldState.js';
import { ExplosionTracker } from '../utils/ExplosionTracker.js';
import type { ServerMessage } from '../../../shared/protocol.js';

// replayWireMessage is the public wire-feed seam — same dispatch path a
// live socket rides (JSON or binary both route through it).
export interface NmWithDispatch {
  replayWireMessage(d: ServerMessage | Uint8Array): void;
  getPlayers(): Map<string, RemotePlayerState>;
}

export function makeDeps() {
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
    heal() {}, grantJetBoost() {}, syncMovement() {}, markTeleport() {},
    movement: {
      setState() {}, setInput() {}, update() {}, setStructures() {},
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
    lazyHealthBarSystem: () => new Proxy({}, { get: () => () => {} }) as never,
    fragMessages: { show: (m: string) => calls.frag.push(m) } as never,
    explosionTracker: new ExplosionTracker(),
    logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    world,
    setLastSentPos() {},
    entities: () => ({
      netBallSpawn: () => calls.entities.push('ballSpawn'),
      netBallSegment: () => calls.entities.push('ballSegment'),
      netBallDie: () => calls.entities.push('ballDie'),
      netBallRoster: () => calls.entities.push('ballRoster'),
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

export const feed = (nm: NmWithDispatch, m: ServerMessage) => nm.replayWireMessage(m);
export const feedBin = (nm: NmWithDispatch, frame: Uint8Array) => nm.replayWireMessage(frame);
