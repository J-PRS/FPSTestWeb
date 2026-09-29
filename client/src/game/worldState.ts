import type { RemotePlayer } from '../entities/RemotePlayer.js';
import type { Projectile } from '../projectiles/Projectile.js';
import type { BallDebris, PlayerDebris } from '../effects/debris.js';
import type { Explosion } from '../effects/explosion.js';
import type { ScorchDecal } from '../effects/scorch.js';
import type { Implosion } from '../effects/implosion.js';
import type { AoeGizmo } from '../effects/aoeGizmo.js';
import { createProjectileRegistry, type ProjectileRegistry } from './projectileRegistry.js';
import { RemoteSet } from './net/RemoteSet.js';
import type { RemotePlayerState } from '../networking/NetworkManager.js';

/**
 * The shared mutable world: every entity collection the game modules
 * (combat / remotes / netHandlers / demoLifecycle / gameLoop) read or write
 * cross-module. Owning them in one place instead of as main.ts locals passed
 * per-dep makes the ownership boundary visible and lets handlers reference
 * `world.projectiles` without main.ts shuttling each list through deps.
 */
export interface WorldState {
  /** Remote players — lifecycle (spawn/stale/prune) lives in RemoteSet;
   *  hooks are wired by createRemotes once the deps exist. */
  remotePlayers: RemoteSet<RemotePlayer, RemotePlayerState>;
  killCounts: Map<string, number>;
  projectiles: Projectile[];
  projectileRegistry: ProjectileRegistry;
  debrisList: BallDebris[];
  playerDebrisList: PlayerDebris[];
  explosions: Explosion[];
  scorches: ScorchDecal[];
  implosions: Implosion[];
  aoeGizmos: AoeGizmo[]; // ?debug blast-radius wireframes
  // Match meta from the wire — scoreboard needs mode/team/scores to group
  // rows; populated by netHandlers on gameState/teamScore/ffaScore.
  mode?: string;
  localTeam?: 'alpha' | 'bravo';
  ffaScores: Map<string, number>;
  teamScores: { alpha: number; bravo: number } | null;
  /** Match-clock deadline (epoch ms) from gameState — HUD countdown. */
  matchEndsAt: number | null;
  respawnMs: number;
  /** CTF flag status per team — HUD chips (home/carried/dropped). */
  flagStates: { alpha?: 'home' | 'carried' | 'dropped'; bravo?: 'home' | 'carried' | 'dropped' };
  // Demo playback is a different world than the live one — while set, the
  // wire must not mutate the scene (corrections/projectiles/live balls)
  // and we must not stream recorded camera motion to the server.
  playbackMode: boolean;
  /** Self-knockback predictions — stamped when a local explosion already
   *  shoved the player so the server's `knockback` echo (~RTT later)
   *  doesn't apply the same blast twice. */
  selfBlastStamps: { x: number; y: number; z: number; t: number }[];
}

export function createWorldState(): WorldState {
  return {
    // Stub hooks — real ones need scene/terrain/nm which don't exist at
    // world-creation time; createRemotes replaces them before first use.
    remotePlayers: new RemoteSet<RemotePlayer, RemotePlayerState>({ create: () => undefined, isLive: () => true }),
    killCounts: new Map(),
    projectiles: [],
    projectileRegistry: createProjectileRegistry(),
    debrisList: [],
    playerDebrisList: [],
    explosions: [],
    scorches: [],
    implosions: [],
    aoeGizmos: [],
    ffaScores: new Map(),
    teamScores: null,
    matchEndsAt: null,
    respawnMs: 3000,
    flagStates: {},
    playbackMode: false,
    selfBlastStamps: [],
  };
}
