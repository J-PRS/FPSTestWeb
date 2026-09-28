import type { RemotePlayer } from '../entities/RemotePlayer.js';
import type { Projectile } from '../projectiles/Projectile.js';
import type { BallDebris, PlayerDebris } from '../effects/debris.js';
import type { Explosion } from '../effects/explosion.js';
import type { ScorchDecal } from '../effects/scorch.js';
import type { Implosion } from '../effects/implosion.js';
import type { AoeGizmo } from '../effects/aoeGizmo.js';
import { createProjectileRegistry, type ProjectileRegistry } from './projectileRegistry.js';

/**
 * The shared mutable world: every entity collection the game modules
 * (combat / remotes / netHandlers / demoLifecycle / gameLoop) read or write
 * cross-module. Owning them in one place instead of as main.ts locals passed
 * per-dep makes the ownership boundary visible and lets handlers reference
 * `world.projectiles` without main.ts shuttling each list through deps.
 */
export interface WorldState {
  remotePlayers: Map<string, RemotePlayer>;
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
  // Demo playback is a different world than the live one — while set, the
  // wire must not mutate the scene (corrections/projectiles/live balls)
  // and we must not stream recorded camera motion to the server.
  playbackMode: boolean;
}

export function createWorldState(): WorldState {
  return {
    remotePlayers: new Map(),
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
    playbackMode: false,
  };
}
