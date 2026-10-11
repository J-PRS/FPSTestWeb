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
  const calls = { hud: [] as string[], frag: [] as string[], entities: [] as string[], deployables: [] as string[], renderSnap: [] as number[] };
  const player = {
    pos: new THREE.Vector3(0, 5, 0),
    vel: new THREE.Vector3(),
    yaw: 0, pitch: 0, onGround: true,
    health: 100, armor: 0, isDead: false, isShielded: false,
    buffUntil: { regen: 0, dd: 0 },
    absorbShieldDamage() { return; }, applyPull() { return; }, applyKnockback() { return; },
    heal() { return; }, grantJetBoost() { return; }, syncMovement() { return; }, markTeleport() { return; },
    // Correction render-ease seam — a spy so tests can see the ease fired
    // (and so a missing wiring throws instead of being swallowed).
    noteRenderSnap(jump: THREE.Vector3) { calls.renderSnap.push(jump.length()); },
    movement: {
      setState() { return; }, setInput() { return; }, update() { return; }, setStructures() { return; },
      getState: () => ({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), onGround: true }),
    },
  };
  const deps: NetDeps = {
    lazyNetworkManager: () => nm,
    lazyScene: () => scene,
    lazyTerrain: () => ({ getHeight: () => 0, reloadHeightmap() { return; } }) as never,
    lazyPlayer: () => player as never,
    lazyEffects: () => ({ spawnJumpDust() { return; }, spawnJetpack() { return; }, spawnBeam() { return; } }) as never,
    lazyHud: () => new Proxy({}, { get: (_t, k) => (a?: unknown) => { calls.hud.push(`${String(k)}`); return a; } }) as never,
    lazyHealthBarSystem: () => new Proxy({}, { get: () => () => { return; } }) as never,
    fragMessages: { show: (m: string) => calls.frag.push(m) } as never,
    explosionTracker: new ExplosionTracker(),
    // dispatch() swallows handler throws into a warn — in tests a thrown
    // handler is always a bug (partial state applied), so fail loudly.
    logger: {
      debug() { return; }, info() { return; }, error() { return; },
      warn(m: string) { if (m.startsWith('Handler threw')) {throw new Error(m);} },
    } as never,
    world,
    setLastSentPos() { return; },
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
        // reconcileDeployables (gameState roster path) reads these — a
        // stub without them throws mid-handler and half-applies state.
        remoteReplicas: () => new Map(),
        applyDeployHp: () => { return; },
        cullOwn: () => { return; },
      },
    }) as never,
  };
  const scene = new THREE.Scene();
  wireNetworkHandlers(deps);
  return { nm: nm as unknown as NmWithDispatch, world, calls, player };
}

export const feed = (nm: NmWithDispatch, m: ServerMessage) => nm.replayWireMessage(m);
export const feedBin = (nm: NmWithDispatch, frame: Uint8Array) => nm.replayWireMessage(frame);
