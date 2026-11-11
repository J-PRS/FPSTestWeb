/* oxlint-disable typescript/no-explicit-any -- test stubs are deliberately loosely typed */
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
import { vi } from 'vitest';
  const scene = new THREE.Scene();

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
    buffUntil: { regen: 0, dd: 0, shield: 0 },
    absorbShieldDamage(): void { return; }, applyPull(): void { return; }, applyKnockback(): void { return; },
    armory: {
      applyInstagib: vi.fn((): void => { return; }),
      releaseInstagib: vi.fn((): void => { return; }),
      applyGunGame: vi.fn((): void => { return; }),
      releaseGunGame: vi.fn((): void => { return; }),
      setGunGameWeapon: vi.fn((): void => { return; }),
      instagib: false,
      gunGame: false,
      kitLocked: false,
    },
    heal: vi.fn((): void => { return; }), grantJetBoost: vi.fn((): void => { return; }), syncMovement(): void { return; }, markTeleport(): void { return; },
    // Correction render-ease seam — a spy so tests can see the ease fired
    // (and so a missing wiring throws instead of being swallowed).
    noteRenderSnap(jump: THREE.Vector3): void { calls.renderSnap.push(jump.length()); },
    movement: {
      setState(): void { return; }, setInput(): void { return; }, update(): void { return; }, setStructures(): void { return; },
      setWaterLevel(): void { return; }, setWaterDome(): void { return; },
      getState: (): { pos: THREE.Vector3; vel: THREE.Vector3; onGround: boolean; } => ({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), onGround: true }),
    },
  };
  const deps: NetDeps = {
    lazyNetworkManager: (): NetworkManager => nm,
    lazyScene: (): THREE.Scene<THREE.Object3DEventMap> => scene,
    lazyTerrain: (): never => ({ getHeight: (): number => 0, reloadHeightmap(): void { return; }, setWaterLevel(): void { return; } }) as never,
    lazyWeather: (): never => ({ setWeather(): void { return; } }) as never,
    lazyPlayer: (): never => player as never,
    lazyEffects: (): never => ({ spawnJumpDust(): void { return; }, spawnJetpack(): void { return; }, spawnSkiDust(): void { return; }, spawnBeam(): void { return; } }) as never,
    lazyHud: (): never => new Proxy({}, { get: (_t, k): (a?: unknown) => unknown => (a?: unknown): unknown => { calls.hud.push(`${String(k)}`); return a; } }) as never,
    lazyHealthBarSystem: (): never => new Proxy({}, { get: (): () => void => (): void => { return; } }) as never,
    lazyDamageNumbers: (): never => new Proxy({}, { get: (): () => void => (): void => { return; } }) as never,
    lazyCamera: (): never => ({}) as never,
    fragMessages: { show: (m: string): number => calls.frag.push(m) } as never,
    explosionTracker: new ExplosionTracker(),
    // dispatch() swallows handler throws into a warn — in tests a thrown
    // handler is always a bug (partial state applied), so fail loudly.
    logger: {
      debug(): void { return; }, info(): void { return; }, error(): void { return; },
      warn(m: string): void { if (m.startsWith('Handler threw')) {throw new Error(m);} },
    } as never,
    world,
    setLastSentPos(): void { return; },
    entities: (): never => ({
      // wirePickups pushes spawned Nuggets here.
      nuggets: [] as unknown[],
      netBallSpawn: (): number => calls.entities.push('ballSpawn'),
      netBallSegment: (): number => calls.entities.push('ballSegment'),
      netBallDie: (): number => calls.entities.push('ballDie'),
      netBallRoster: (): number => calls.entities.push('ballRoster'),
      deployables: {
        remoteIds: (): number[] => [] as number[],
        remoteSpawn: (id: number): number => calls.deployables.push(`spawn:${id}`),
        remoteRemove: (id: number): number => calls.deployables.push(`gone:${id}`),
        remoteTurretShot: (id: number): number => calls.deployables.push(`shot:${id}`),
        remoteMineBoom: (id: number): number => calls.deployables.push(`boom:${id}`),
        // reconcileDeployables (gameState roster path) reads these — a
        // stub without them throws mid-handler and half-applies state.
        remoteReplicas: (): Map<any, any> => new Map(),
        applyDeployHp: (): void => { return; },
        cullOwn: (): void => { return; },
      },
    }) as never,
  };
  wireNetworkHandlers(deps);
  return { nm: nm as unknown as NmWithDispatch, world, calls, player };
}

export const feed = (nm: NmWithDispatch, m: ServerMessage): void => nm.replayWireMessage(m);
export const feedBin = (nm: NmWithDispatch, frame: Uint8Array): void => nm.replayWireMessage(frame);
