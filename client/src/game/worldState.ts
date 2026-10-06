import type * as THREE from 'three';
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
import type { TeamId } from '../../../shared/teams.js';

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
  /** Kills since last local death — drives the SPREE/RAMPAGE subtitle.
   *  Lives on world (not a handler closure) so match boundaries can zero
   *  it: a new match is a new streak, not a continuation. */
  killStreak: number;
  projectiles: Projectile[];
  projectileRegistry: ProjectileRegistry;
  debrisList: BallDebris[];
  playerDebrisList: PlayerDebris[];
  explosions: Explosion[];
  scorches: ScorchDecal[];
  splats: import('../effects/splat.js').SplatDecal[];
  implosions: Implosion[];
  aoeGizmos: AoeGizmo[]; // ?debug blast-radius wireframes
  // Match meta from the wire — scoreboard needs mode/team/scores to group
  // rows; populated by netHandlers on gameState/teamScore/ffaScore.
  mode?: string;
  /** Map display name (spec `name` or filename) — scoreboard title. */
  mapName?: string;
  localTeam?: TeamId;
  ffaScores: Map<string, number>;
  teamScores: { alpha: number; bravo: number } | null;
  /** Match-clock deadline (epoch ms) from gameState — HUD countdown. */
  matchEndsAt: number | null;
  respawnMs: number;
  /** CTF flag status per team — HUD chips (home/carried/dropped). */
  flagStates: { alpha?: 'home' | 'carried' | 'dropped'; bravo?: 'home' | 'carried' | 'dropped' };
  /** Set by matchStart: the server's endCleanup resets flags to 'home',
   *  which broadcasts fake carried/dropped→home transitions on the next
   *  flagUpdate — flags.ts swallows announcements on that one update so
   *  a reset never plays a CAPTURED/RETURNED ceremony. */
  flagHomeHush: boolean;
  /** Wire CTF flag meshes + carrier ids — the per-frame loop projects
   *  these into HUD diamonds; flags.ts owns the entries (set on
   *  flagUpdate, deleted on roster prune). `mesh` is the flag alone;
   *  `stand` is the permanent pole+base planted at `home` (homeKnown
   *  gates it until the wire/base spec tells us where that is). */
  flagMarkers: Map<TeamId, { mesh: THREE.Group; stand: THREE.Group; home: THREE.Vector3; homeKnown: boolean; carrier: string | null; wirePos: THREE.Vector3 }>;
  /** Server-owned pickup replicas — net/pickups.ts owns the map; the
   *  §4.7 pickup fidelity hash enumerates it. */
  netPickups: Map<number, { kind: import('../../../shared/pickups.js').PickupKind }>;
  // Demo playback is a different world than the live one — while set, the
  // wire must not mutate the scene (corrections/projectiles/live balls)
  // and we must not stream recorded camera motion to the server.
  playbackMode: boolean;
  /** Self-knockback predictions — stamped when a local explosion already
   *  shoved the player so the server's `knockback` echo (~RTT later)
   *  doesn't apply the same blast twice. */
  /** Fired after a terrain swap completes — local bots re-seat onto the
   *  new heightmap instead of standing at the old field's altitude. */
  onTerrainApplied?: (file: string | null) => void;
  selfBlastStamps: { x: number; y: number; z: number; t: number }[];
  /** Own banked LG charge, echoed by the server (yourCharge) — the
   *  carrier is excluded from tick fanout so the walking-bomb warning
   *  needs this channel. Decays between echoes; drives the crackle tell. */
  selfCharge: number;
}

export function createWorldState(): WorldState {
  return {
    // Stub hooks — real ones need scene/terrain/nm which don't exist at
    // world-creation time; createRemotes replaces them before first use.
    remotePlayers: new RemoteSet<RemotePlayer, RemotePlayerState>({ create: () => undefined, isLive: () => true }),
    killCounts: new Map(),
    killStreak: 0,
    projectiles: [],
    projectileRegistry: createProjectileRegistry(),
    debrisList: [],
    playerDebrisList: [],
    explosions: [],
    scorches: [],
    splats: [],
    implosions: [],
    aoeGizmos: [],
    ffaScores: new Map(),
    teamScores: null,
    matchEndsAt: null,
    respawnMs: 3000,
    flagStates: {},
    flagHomeHush: false,
    flagMarkers: new Map(),
    netPickups: new Map(),
    playbackMode: false,
    selfBlastStamps: [],
    selfCharge: 0,
  };
}
