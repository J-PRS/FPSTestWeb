// Demo playback world reconstruction — recreates balls, projectiles, debris,
// and explosion effects from recorded events. Used by both seek reconstruction
// (rebuild full state at an arbitrary timestamp) and forward playback
// (apply events incrementally as they arrive).

import * as THREE from 'three';
import { ProjectileEventType, TargetEventType, isCreatureTargetType, isDeployTargetType, isMiscTargetType, TARGETTYPE_CREATURE_BASE, type ProjectileEvent, type TargetEvent } from './types.js';
import type { Ball } from '../entities/balls.js';
import { reconstructSeekCreature, applyPlaybackCreatureEvent, type PlaybackCreature } from './playbackCreatures.js';
import { reconstructSeekDeployable, applyPlaybackDeployableEvent, type PlaybackDeployable } from './playbackDeployables.js';
import { reconstructSeekMarker, applyPlaybackMarkerEvent } from './playbackMarkers.js';
import type { Player } from '../entities/Player.js';
import { Projectile } from '../projectiles/Projectile.js';
import { BOLT_CONFIG, getProjectileConfig, computeAccuracy } from '../projectiles/index.js';
import type { BallDebris } from '../effects/debris.js';
import { Explosion } from '../effects/explosion.js';
import { Implosion } from '../effects/implosion.js';
import type { DamageNumberManager } from '../effects/damageNumbers.js';
import type { FragMessages } from '../ui/FragMessages.js';
import type { HUD } from '../ui/hud.js';
import type { Terrain } from '../world/terrain.js';
import { ChildLogger } from '../core/Logger.js';
import { reconstructSeekTarget, applyPlaybackTargetEvent } from './playbackTargets.js';
import * as sfxWeapons from '../core/sfx/weapons.js';
import * as sfxExplosions from '../core/sfx/explosions.js';
import * as sfxUtil from '../core/sfx/util.js';
import { fastForward } from './playbackFF.js';

const logger = new ChildLogger('DemoPlayback');

// A fading additive rod from→to — the playback-side twin of
// EffectsManager.spawnBeam, kept local because playback has no
// EffectsManager reference (it owns its own registries, not the live one).
export interface PlaybackBeam {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
}

// Shared mutable game state the reconstruction code needs. Arrays/maps are
// live references — playback mutates them in place.
export interface PlaybackWorld {
  scene: THREE.Scene;
  terrain: Terrain;
  camera: THREE.Camera;
  getPlayer(): Player;
  balls: Ball[];
  debrisList: BallDebris[];
  explosions: Explosion[];
  implosions: Implosion[];
  playbackBallById: Map<number, Ball>;
  playbackCreatureById: Map<number, PlaybackCreature>;
  playbackDeployableById: Map<number, PlaybackDeployable>;
  /** Flag + pickup proxies — keyed by their demo targetIds. */
  playbackFlags: Map<number, THREE.Group>;
  /** Conquest node markers decoded from TARGETTYPE_NODE events —
   *  demoLifecycle mirrors them into world.nodeMarkers for the HUD. */
  playbackNodes: Map<number, { x: number; y: number; z: number; meta: number; gx: number; gz: number; hp: number }>;
  /** Match-meta events project onto world.teamScores/matchEndsAt —
   *  the world state lives outside the playback world, so the lifecycle
   *  supplies the sink. */
  playbackMatchMeta?: (ev: { health: number; peakPosX: number; peakPosY: number; timestamp: number }) => void;
  playbackPickups: Map<number, { mesh: THREE.Object3D; dispose(scene: THREE.Scene): void }>;
  /** Resolves a roster idx to the replayed remote player's rendered pos —
   *  wired by the playback lifecycle so a carried flag can ride its carrier. */
  remotePosAt?: (rosterIdx: number) => THREE.Vector3 | null;
  playbackProjectiles: Projectile[];
  playbackProjectileById: Map<number, Projectile>;
  playbackProjectileOrigin: Map<number, THREE.Vector3>;
  beams: PlaybackBeam[];
  beamPool: PlaybackBeam[];
  damageNumberManager: DamageNumberManager;
  fragMessages: FragMessages;
  hud: HUD;
}

const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
const _beamDir = new THREE.Vector3();
const _beamUp = new THREE.Vector3(0, 1, 0);

// Same keep-floor contract as the live beam pool — a demo-heavy session
// pins peak memory forever otherwise (each beam owns a material).
const BEAM_POOL_KEEP = 32;
export function releasePlaybackBeam(world: PlaybackWorld, b: PlaybackBeam): void {
  if (world.beamPool.length >= BEAM_POOL_KEEP) {b.mat.dispose();}
  else {world.beamPool.push(b);}
}

export function spawnPlaybackBeam(world: PlaybackWorld, from: THREE.Vector3, to: THREE.Vector3, colorHex = 0x99_EE_FF): void {
  _beamDir.subVectors(to, from);
  const len = _beamDir.length();
  if (len < 0.01) {return;}
  let b = world.beamPool.pop();
  if (!b) {
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    b = { mesh: new THREE.Mesh(beamGeo, mat), mat, life: 0, maxLife: 0 };
  }
  b.mesh.position.copy(from).addScaledVector(_beamDir, 0.5);
  b.mesh.quaternion.setFromUnitVectors(_beamUp, _beamDir.normalize());
  b.mesh.scale.set(0.14, len, 0.14);
  b.mat.color.setHex(colorHex);
  b.mat.opacity = 0.85;
  b.maxLife = 0.35;
  b.life = b.maxLife;
  world.scene.add(b.mesh);
  world.beams.push(b);
}

// Advance an entity from its event timestamp to the seek time in fixed
// steps. Lives in playbackFF.ts (leaf module — importing it from here
// made the reconstruction↔applier import cycle); re-exported for compat.
export { fastForward };

// Reconstruct projectile from recorded position + velocity, using weaponType
function spawnPlaybackProjectile(world: PlaybackWorld, ev: ProjectileEvent): Projectile | null {
  const origin = new THREE.Vector3(ev.posX, ev.posY, ev.posZ);
  const velocity = new THREE.Vector3(ev.velX, ev.velY, ev.velZ);
  const cfg = getProjectileConfig(ev.weaponType) ?? BOLT_CONFIG;
  // Bodiless kinds (hitscan beams — speed 0) can't fly a trajectory:
  // paint the beam the live wire path draws and skip the frozen mesh
  // replica that would hover to the backstop (the proj-fuseless class).
  if (cfg.speed <= 0) {
    const len = velocity.lengthSq() > 0 ? velocity.clone().normalize() : new THREE.Vector3(0, 0, 1);
    spawnPlaybackBeam(world, origin, origin.clone().addScaledVector(len, 60), cfg.glowColor);
    return null;
  }
  const r = new Projectile(world.scene, origin, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), cfg);
  r.isRemote = true;
  r.spawnedThisFrame = false;
  r.vel.copy(velocity);
  // Ray-burst replicas discharge deterministically — same hook as the live
  // wire path so replays paint the rail beam too.
  if (cfg.rayBurst) {
    const beamColor = cfg.glowColor;
    r.onRayBurst = (from, to): void => spawnPlaybackBeam(world, from, to, beamColor);
  }
  world.playbackProjectiles.push(r);
  world.playbackProjectileById.set(ev.projectileId, r);
  world.playbackProjectileOrigin.set(ev.projectileId, origin.clone());
  return r;
}

function reconstructSeekProjectile(world: PlaybackWorld, ev: ProjectileEvent, deadIds: Set<number>, seekTime: number): void {
  const { scene, terrain, explosions } = world;

  if (deadIds.has(ev.projectileId)) {
    // For Hit events on dead projectiles, spawn explosion fast-forwarded to seek time
    if (ev.eventType === ProjectileEventType.Hit) {
      const hitPos = new THREE.Vector3(ev.posX, ev.posY, ev.posZ);
      const cfg = getProjectileConfig(ev.weaponType);
      const exp = new Explosion(scene, hitPos, false, 0, terrain, (cfg?.explosionRadius ?? 6) / 6, cfg?.damageColor);
      explosions.push(exp);
      fastForward(seekTime - ev.timestamp, (): boolean => !exp.dead, (s): void => exp.update(s));
    }
    return;
  }

  if (ev.eventType === ProjectileEventType.Fired) {
    const r = spawnPlaybackProjectile(world, ev);
    // Bodiless kinds return null (the beam was painted already) — there
    // is no trajectory to fast-forward.
    if (!r) {return;}
    fastForward(seekTime - ev.timestamp, (): boolean => !r.dead && !r.exploded, (s): void => r.update(s, terrain));
    return;
  }

  if (ev.eventType === ProjectileEventType.Bounce) {
    const r = world.playbackProjectileById.get(ev.projectileId);
    if (!r || r.exploded) {return;}
    r.pos.set(ev.posX, ev.posY, ev.posZ);
    r.vel.set(ev.velX, ev.velY, ev.velZ);
    fastForward(seekTime - ev.timestamp, (): boolean => !r.dead && !r.exploded, (s): void => r.update(s, terrain));
  }
}

// Seek reconstruction: re-create all in-flight objects at their state as of
// the seek time. Skip objects that died before it. Effects are suppressed.
export function reconstructSeek(world: PlaybackWorld, events: { projectiles: ProjectileEvent[], targets: TargetEvent[] }, seekTime: number): void {
  // Pre-scan: projectile IDs with terminal events (Hit/Destroyed) are dead at seek time
  const deadProjectileIds = new Set<number>();
  for (const ev of events.projectiles) {
    if (ev.eventType === ProjectileEventType.Hit || ev.eventType === ProjectileEventType.Destroyed) {
      deadProjectileIds.add(ev.projectileId);
    }
  }
  // Pre-scan: a target is dead if it has a Destroyed event, OR a Hit event
  // that reduced its health to <= 0 (some recordings emit Hit-with-kill
  // without a follow-up Destroyed). Treat both as terminal.
  // Keyed by (targetType, targetId), not raw id: the u16 targetId space is
  // shared by a wrap-around allocator, so a ball's id eventually lands in
  // the creature/deployable namespaces — a raw-id set would let one lane's
  // Destroyed kill a live entity in another.
  const deadBallIds = new Set<number>();
  for (const ev of events.targets) {
    if (ev.eventType === TargetEventType.Destroyed) {
      deadBallIds.add(ev.targetType * 65_536 + ev.targetId);
    } else if (ev.eventType === TargetEventType.Hit && ev.health <= 0) {
      deadBallIds.add(ev.targetType * 65_536 + ev.targetId);
    }
  }

  // Targets first so balls/creatures exist before projectile hits reference them
  for (const ev of events.targets) {
    if (isCreatureTargetType(ev.targetType)) {
      reconstructSeekCreature(world, ev, deadBallIds, seekTime);
    } else if (isDeployTargetType(ev.targetType)) {
      reconstructSeekDeployable(world, ev, deadBallIds, seekTime);
    } else if (isMiscTargetType(ev.targetType)) {
      reconstructSeekMarker(world, ev, seekTime);
    } else {
      reconstructSeekTarget(world, ev, deadBallIds, seekTime);
    }
  }
  for (const ev of events.projectiles) {
    reconstructSeekProjectile(world, ev, deadProjectileIds, seekTime);
  }
}

// Keyframe snapping policy: balls are resimulated with the live render dt between
// keyframes, so their trajectory drifts slightly from the recording (different dt).
// Hard-snapping every keyframe (including the 0.5s periodic snapshots) produces
// visible micro-jumps. Instead, only hard-snap when drift is large (real desync from
// a bounce-timing mismatch or teleport); for small drift, gently correct toward the
// recorded state so the motion stays smooth and drift stays bounded over long arcs.
function applyPlaybackProjectileHit(world: PlaybackWorld, ev: ProjectileEvent, r: Projectile): void {
  const { scene, terrain, explosions, implosions } = world;

  // Compute accuracy using the recorded target position when available.
  // v6 targetType tells us the victim's lane — without it a creature/
  // deployable id aliasing a live ball would mis-score the frag. Files
  // before v6 read targetType 0 (ball lane), which their data was anyway.
  const ball = ev.targetId && ev.targetId !== 0xFF_FF && ev.targetType < TARGETTYPE_CREATURE_BASE
    ? world.playbackBallById.get(ev.targetId) : undefined;
  let directHit = false;
  let accRaw = 0;
  if (ball) {
    const distToBall = r.pos.distanceTo(ball.pos);
    directHit = distToBall <= ball.radius + r.config.bodyRadius;
    accRaw = Math.max(0, distToBall - ball.radius);
  }
  const acc = computeAccuracy(accRaw, directHit);

  // Spawn correct effect (explosion for push, implosion for pull) — the
  // VFX is playback-owned but the boom rides the same sfx call the live
  // impact path makes (combat/impact.ts).
  if (r.config.forceMode === 'push') {
    explosions.push(new Explosion(scene, r.pos, directHit, r.age, terrain, r.explosionRadius / 6, r.config.damageColor, r.config.vfx));
    sfxExplosions.explosionAt(r.pos, directHit, ev.weaponType);
  } else {
    implosions.push(new Implosion(scene, r.pos, r.age, terrain));
    sfxExplosions.implosionAt(r.pos, directHit);
  }

  // Compute frag message from playback data (skip terrain hits)
  const origin = world.playbackProjectileOrigin.get(ev.projectileId);
  if (origin && ev.targetId !== 0) {
    const dist = r.pos.distanceTo(origin);
    const air = r.age;
    const score = Math.round(acc * dist * air);
    world.fragMessages.showScore(`${acc.toFixed(1)} · ${Math.round(dist)} · ${air.toFixed(2)}s\n${score}`, air);
    world.hud.showHitMarker();
  }

  // Debug: compare projectile hit position with ball position
  if (ball) {
    const distBall = r.pos.distanceTo(ball.pos);
    logger.debug(`Projectile Hit: projPos=(${ev.posX.toFixed(1)},${ev.posY.toFixed(1)},${ev.posZ.toFixed(1)}) ballPos=(${ball.pos.x.toFixed(1)},${ball.pos.y.toFixed(1)},${ball.pos.z.toFixed(1)}) dist=${distBall.toFixed(1)}m`);
  } else if (ev.targetId && ev.targetId !== 0xFF_FF && ev.targetId !== 0) {
    logger.debug(`Projectile Hit: projPos=(${ev.posX.toFixed(1)},${ev.posY.toFixed(1)},${ev.posZ.toFixed(1)}) ball ${ev.targetId} not found`);
  }
}

function applyPlaybackProjectileEvent(world: PlaybackWorld, ev: ProjectileEvent): void {
  if (ev.eventType === ProjectileEventType.Fired) {
    spawnPlaybackProjectile(world, ev);
    // Playback has no net handlers — the recorded fire event is where
    // muzzle audio lives in a live game, so it has to play here.
    sfxWeapons.shotAt(new THREE.Vector3(ev.posX, ev.posY, ev.posZ), ev.weaponType);
    return;
  }

  const r = world.playbackProjectileById.get(ev.projectileId);

  if (ev.eventType === ProjectileEventType.Hit) {
    if (r) {
      r.pos.set(ev.posX, ev.posY, ev.posZ);
      if (!r.exploded) {r.explode();}
      applyPlaybackProjectileHit(world, ev, r);
      // Terminal event — drop the lookup entries so a long demo doesn't
      // accumulate dead shells forever (same contract as netCrawlerById).
      world.playbackProjectileById.delete(ev.projectileId);
      world.playbackProjectileOrigin.delete(ev.projectileId);
    } else {
      // The replayed sim runs live collision — a shell can self-detonate
      // (or finish draining and unmap) BEFORE its recorded edge arrives.
      // The recording is the truth: spawn the blast at the recorded
      // point, or the demo silently loses the explosion.
      const { scene, terrain, explosions, implosions } = world;
      const cfg = getProjectileConfig(ev.weaponType) ?? BOLT_CONFIG;
      const hitPos = new THREE.Vector3(ev.posX, ev.posY, ev.posZ);
      if (cfg.forceMode === 'push') {
        explosions.push(new Explosion(scene, hitPos, false, 0, terrain, (cfg.explosionRadius ?? 6) / 6, cfg.damageColor, cfg.vfx));
        sfxExplosions.explosionAt(hitPos, false, ev.weaponType);
      } else {
        implosions.push(new Implosion(scene, hitPos, 0, terrain));
        sfxExplosions.implosionAt(hitPos, false);
      }
    }
    return;
  }

  if (!r || r.exploded) {return;}

  if (ev.eventType === ProjectileEventType.Bounce) {
    r.pos.set(ev.posX, ev.posY, ev.posZ);
    r.vel.set(ev.velX, ev.velY, ev.velZ);
    // Live path pings a ricochet on bounce (projCollide) — only for
    // bouncing shells (mortar pre-arm etc.), same bounceSfx gate.
    if (r.config.bounceSfx) {
      const gain = Math.min(1, r.vel.length() / 40);
      sfxUtil.at(r.pos, `ricochet${1 + Math.floor(Math.random() * 3)}`, gain, 1, r.vel);
    }
  } else if (ev.eventType === ProjectileEventType.Destroyed) {
    // Remove projectile without explosion (e.g. timeout)
    r.pos.set(ev.posX, ev.posY, ev.posZ);
    r.explode();
    world.playbackProjectileById.delete(ev.projectileId);
    world.playbackProjectileOrigin.delete(ev.projectileId);
  }
}

// Normal playback event processing (forward playback, not seeking)
export function applyPlaybackEvents(world: PlaybackWorld, events: { projectiles: ProjectileEvent[], targets: TargetEvent[] }): void {
  // Targets first so balls are spawned/updated before projectile hits reference them
  for (const ev of events.targets) {
    if (isCreatureTargetType(ev.targetType)) {
      applyPlaybackCreatureEvent(world, ev);
    } else if (isDeployTargetType(ev.targetType)) {
      applyPlaybackDeployableEvent(world, ev);
    } else if (isMiscTargetType(ev.targetType)) {
      applyPlaybackMarkerEvent(world, ev, true);
    } else {
      applyPlaybackTargetEvent(world, ev);
    }
  }
  for (const ev of events.projectiles) {
    applyPlaybackProjectileEvent(world, ev);
  }
}
