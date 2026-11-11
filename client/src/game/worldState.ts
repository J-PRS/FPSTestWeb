import type * as THREE from 'three';
import type { RemotePlayer } from '../entities/RemotePlayer.js';
import type { Projectile, SweepObstacle } from '../projectiles/Projectile.js';
import type { BallDebris, PlayerDebris } from '../effects/debris.js';
import type { Explosion } from '../effects/explosion.js';
import type { ScorchDecal } from '../effects/scorch.js';
import type { Implosion } from '../effects/implosion.js';
import type { AoeGizmo } from '../effects/aoeGizmo.js';
import { createProjectileRegistry, type ProjectileRegistry } from './projectileRegistry.js';
import { RemoteSet } from './net/RemoteSet.js';
import type { RemotePlayerState } from '../networking/NetworkManager.js';
import type { TeamId } from '../../../shared/teams.js';
import type { SplatDecal } from '../effects/splat.js';
import type { PickupKind } from '../../../shared/pickups.js';
import type { SpawnPoint } from '../../../shared/mapSpec.js';

/**
 * The shared mutable world: every entity collection the game modules
 * (combat / remotes / netHandlers / demoLifecycle / gameLoop) read or write
 * cross-module. Owning them in one place instead of as main.ts locals passed
 * per-dep makes the ownership boundary visible and lets handlers reference
 * `world.projectiles` without main.ts shuttling each list through deps.
 */
export interface WorldState {
  /** Remote players - lifecycle (spawn/stale/prune) lives in RemoteSet;
   *  hooks are wired by createRemotes once the deps exist. */
  remotePlayers: RemoteSet<RemotePlayer, RemotePlayerState>;
  /** Demo playback mirrors — replayed actors as roster-keyed maps so HUD
   *  systems (health bars) read them through the same shape the wire feeds.
   *  Replayed actors are first-class, not a side lane. */
  playbackPlayers: Map<string, { position: { x: number; y: number; z: number }; isDead: boolean; health?: number; armor?: number; team?: string }>;
  playbackRemotePlayers: Map<string, RemotePlayer>;
  killCounts: Map<string, number>;
  deathCounts: Map<string, number>;
  /** Kills since last local death - drives the SPREE/RAMPAGE subtitle.
   *  Lives on world (not a handler closure) so match boundaries can zero
   *  it: a new match is a new streak, not a continuation. */
  killStreak: number;
  projectiles: Projectile[];
  projectileRegistry: ProjectileRegistry;
  debrisList: BallDebris[];
  playerDebrisList: PlayerDebris[];
  explosions: Explosion[];
  scorches: ScorchDecal[];
  splats: SplatDecal[];
  implosions: Implosion[];
  aoeGizmos: AoeGizmo[]; // ?debug blast-radius wireframes
  // Match meta from the wire - scoreboard needs mode/team/scores to group
  // rows; populated by netHandlers on gameState/teamScore/ffaScore.
  mode?: string;
  /** Room modifier echoed by gameState - loadout UI locks to the
   *  instagib kit while skill/perk stay editable. */
  instagib: boolean;
  /** Gun-game modifiers echoed by gameState - the weapon ladder owns
   *  the loadout band; igun is the ~200-damage variant. */
  gungame: boolean;
  igun: boolean;
  /** Offline gun-game ladder - the server keeps the same map on Room;
   *  absent entries are rung 0. Only populated while world.gungame. */
  gunRungs: Map<string, number>;
  /** Map display name (spec `name` or filename) - scoreboard title. */
  mapName?: string;
  localTeam?: TeamId;
  ffaScores: Map<string, number>;
  teamScores: { alpha: number; bravo: number } | null;
  /** Match-clock deadline (epoch ms) from gameState - HUD countdown. */
  matchEndsAt: number | null;
  respawnMs: number;
  /** CTF flag status per team - HUD chips (home/carried/dropped). */
  flagStates: { alpha?: 'home' | 'carried' | 'dropped'; bravo?: 'home' | 'carried' | 'dropped' };
  /** Last applied map look spec - demo playback restores this on stop. */
  lastAtmo?: { fog?: unknown; weather?: unknown; atmosphere?: unknown; terrain?: unknown; terrainTex?: unknown; terrainPreset?: unknown; heightScale?: unknown; tileSize?: unknown; sky?: unknown };
  /** Set by matchStart: the server's endCleanup resets flags to 'home',
   *  which broadcasts fake carried/dropped→home transitions on the next
   *  flagUpdate - flags.ts swallows announcements on that one update so
   *  a reset never plays a CAPTURED/RETURNED ceremony. */
  flagHomeHush: boolean;
  /** Wire CTF flag meshes + carrier ids - the per-frame loop projects
   *  these into HUD diamonds; flags.ts owns the entries (set on
   *  flagUpdate, deleted on roster prune). `mesh` is the flag alone;
   *  `stand` is the permanent pole+base planted at `home` (homeKnown
   *  gates it until the wire/base spec tells us where that is). */
  flagMarkers: Map<TeamId, { mesh: THREE.Group; stand: THREE.Group; home: THREE.Vector3; homeKnown: boolean; carrier: string | null; wirePos: THREE.Vector3 }>;
  /** Conquest lattice rows - net/nodes.ts owns the map; remotes.ts
   *  projects `show`-flagged entries into HUD diamonds per frame. */
  nodeMarkers: Map<number, { pos: THREE.Vector3; owner: 'alpha' | 'bravo' | 'neutral'; core: boolean; gx: number; gz: number; show: boolean; hot: boolean }>;
  /** Effective spawn pools from the map snapshot (or the solo spec) -
   *  the command map's F1 debug layer draws them. Null on spawn-less maps. */
  spawnPools: { spawns?: SpawnPoint[]; teamSpawns?: { alpha?: SpawnPoint[]; bravo?: SpawnPoint[] } } | null;
  /** Server-owned pickup replicas - net/pickups.ts owns the map; the
   *  §4.7 pickup fidelity hash enumerates it. */
  netPickups: Map<number, { kind: PickupKind }>;
  // Demo playback is a different world than the live one - while set, the
  // wire must not mutate the scene (corrections/projectiles/live balls)
  // and we must not stream recorded camera motion to the server.
  playbackMode: boolean;
  /** Self-knockback predictions - stamped when a local explosion already
   *  shoved the player so the server's `knockback` echo (~RTT later)
   *  doesn't apply the same blast twice. */
  /** Fired after a terrain swap completes - local bots re-seat onto the
   *  new heightmap instead of standing at the old field's altitude. */
  onTerrainApplied?: (file: string | null) => void;
  selfBlastStamps: { x: number; y: number; z: number; t: number; by?: string; self?: boolean; f?: number; m?: number; pid?: string; wt?: number; pop?: string; iv?: { x: number; y: number; z: number }; wireAt?: { x: number; y: number; z: number }; wireT?: number }[];
  /** Local pos/vel ring (~3s @60Hz) sampled by remotes.networkTick -
   *  the server's spawn rewind reads its shadow at 0.7·transit, so a
   *  predicted shell that mirrors the same history epoch flies the
   *  server's arc even when the create echo outlives the fuse. */
  localPosHistory: { t: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }[];
  /** The same dedup run backwards: a knockback echo that arrived BEFORE
   *  its blast's replica exploded applies raw - recorded here so the
   *  delayed predicted shove at the same center doesn't double it. */
  recentKb: { x: number; y: number; z: number; t: number; f?: number }[];
  /** Own banked LG charge, echoed by the server (yourCharge) - the
   *  carrier is excluded from tick fanout so the walking-bomb warning
   *  needs this channel. Decays between echoes; drives the crackle tell. */
  selfCharge: number;
  /** Hosted conquest lattice layer (net/nodes.ts) - owns the crystal
   *  idle motion between roster updates; null outside conquest. */
  nodeLayer?: { tick(dt: number, now: number): void } | null;
  /** Solo conquest lattice sim (offline only) - soloConquest.ts owns it;
   *  the loop ticks it, blastForce feeds it the same blast stream the
   *  server's RoomConquest listens on. */
  soloConquest?: {
    tick(dt: number): void;
    applyBlast(pos: THREE.Vector3, damage: number, radius: number, shooterId: string | undefined, scales?: readonly number[]): void;
    obstacles(): SweepObstacle[];
  } | null;
}

/** FX pools that refuse spawns while the tab is hidden - wire handlers
 *  run per-message regardless of rAF throttling, so bursts queued
 *  off-screen decay at hidden-crawl speed and all detonate on return as
 *  a wall of stale explosions. Gating at the array covers every spawn
 *  site (a blast nobody can see is never worth keeping). */
class HiddenFxArray<T> extends Array<T> {
  override push(...items: T[]): number {
    return document.hidden ? this.length : super.push(...items);
  }
}

export function createWorldState(): WorldState {
  return {
    // Stub hooks - real ones need scene/terrain/nm which don't exist at
    // world-creation time; createRemotes replaces them before first use.
    remotePlayers: new RemoteSet<RemotePlayer, RemotePlayerState>({ create: (): undefined => undefined, isLive: (): true => true }),
    playbackPlayers: new Map(),
    playbackRemotePlayers: new Map(),
    killCounts: new Map(),
    deathCounts: new Map(),
    killStreak: 0,
    projectiles: [],
    projectileRegistry: createProjectileRegistry(),
    debrisList: [],
    playerDebrisList: [],
    explosions: new HiddenFxArray<Explosion>(),
    scorches: [],
    splats: [],
    implosions: new HiddenFxArray<Implosion>(),
    aoeGizmos: [],
    ffaScores: new Map(),
    instagib: false,
    gungame: false,
    igun: false,
    gunRungs: new Map(),
    teamScores: null,
    matchEndsAt: null,
    respawnMs: 3000,
    flagStates: {},
    flagHomeHush: false,
    flagMarkers: new Map(),
    nodeMarkers: new Map(),
    spawnPools: null,
    netPickups: new Map(),
    playbackMode: false,
    selfBlastStamps: [],
    localPosHistory: [],
    recentKb: [],
    selfCharge: 0,
  };
}
