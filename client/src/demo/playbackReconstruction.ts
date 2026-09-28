// Demo playback world reconstruction — recreates balls, projectiles, debris,
// and explosion effects from recorded events. Used by both seek reconstruction
// (rebuild full state at an arbitrary timestamp) and forward playback
// (apply events incrementally as they arrive).

import * as THREE from 'three';
import type { ProjectileEvent, TargetEvent } from './types.js';
import { ProjectileEventType, TargetEventType } from './types.js';
import { Ball } from '../entities/balls.js';
import type { Player } from '../entities/Player.js';
import { Projectile } from '../projectiles/Projectile.js';
import { ROCKET_CONFIG, getProjectileConfig, computeAccuracy } from '../projectiles/index.js';
import { BallDebris } from '../effects/debris.js';
import { Explosion } from '../effects/explosion.js';
import { Implosion } from '../effects/implosion.js';
import type { DamageNumberManager } from '../effects/damageNumbers.js';
import type { FragMessages } from '../ui/FragMessages.js';
import type { HUD } from '../ui/hud.js';
import type { Terrain } from '../world/terrain.js';
import { ChildLogger } from '../core/Logger.js';

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

export function spawnPlaybackBeam(world: PlaybackWorld, from: THREE.Vector3, to: THREE.Vector3, colorHex = 0x99eeff): void {
  _beamDir.subVectors(to, from);
  const len = _beamDir.length();
  if (len < 0.01) return;
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
  b.life = b.maxLife = 0.35;
  world.scene.add(b.mesh);
  world.beams.push(b);
}

const FF_DT = 1 / 60;

// Advance an entity from its event timestamp to the seek time in fixed steps
function fastForward(ffTime: number, alive: () => boolean, step: (dt: number) => void): void {
  let rem = ffTime;
  while (rem > 0 && alive()) {
    const s = Math.min(FF_DT, rem);
    step(s);
    rem -= s;
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
  // Pre-scan: a ball is dead if it has a Destroyed event, OR a Hit event that
  // reduced its health to <= 0 (some recordings emit Hit-with-kill without a
  // follow-up Destroyed). Treat both as terminal.
  const deadBallIds = new Set<number>();
  for (const ev of events.targets) {
    if (ev.eventType === TargetEventType.Destroyed) {
      deadBallIds.add(ev.targetId);
    } else if (ev.eventType === TargetEventType.Hit && ev.health <= 0) {
      deadBallIds.add(ev.targetId);
    }
  }

  // Targets first so balls exist before projectile hits reference them
  for (const ev of events.targets) {
    reconstructSeekTarget(world, ev, deadBallIds, seekTime);
  }
  for (const ev of events.projectiles) {
    reconstructSeekProjectile(world, ev, deadProjectileIds, seekTime);
  }
}

function reconstructSeekTarget(world: PlaybackWorld, ev: TargetEvent, deadBallIds: Set<number>, seekTime: number): void {
  const { scene, terrain, balls, debrisList, playbackBallById } = world;
  const playerPos = world.getPlayer().pos;

  if (deadBallIds.has(ev.targetId)) {
    // For Destroyed events on dead balls, spawn debris fast-forwarded to seek time
    if (ev.eventType === TargetEventType.Destroyed) {
      const debris = new BallDebris(scene, terrain, ev.posX, ev.posY, ev.posZ, new THREE.Color(0xffffff), 1);
      debrisList.push(debris);
      fastForward(seekTime - ev.timestamp, () => !debris.dead, (s) => debris.update(s));
    }
    return;
  }

  if (ev.eventType === TargetEventType.Spawned) {
    const ball = new Ball(scene, terrain, ev.targetType as 0 | 1 | 2 | 3);
    ball.pos.set(ev.posX, ev.posY, ev.posZ);
    ball.vel.set(ev.velX, ev.velY, ev.velZ);
    playbackBallById.set(ev.targetId, ball);
    balls.push(ball);
    ball.update(0, terrain, playerPos); // sync mesh (ctor doesn't copy pos)
    fastForward(seekTime - ev.timestamp, () => !ball.dead, (s) => ball.update(s, terrain, playerPos));
    return;
  }

  if (ev.eventType === TargetEventType.Bounce || ev.eventType === TargetEventType.StateChanged || ev.eventType === TargetEventType.Hit) {
    const ball = playbackBallById.get(ev.targetId);
    if (!ball || ball.dead) return;
    ball.pos.set(ev.posX, ev.posY, ev.posZ);
    ball.vel.set(ev.velX, ev.velY, ev.velZ);
    if (ev.eventType === TargetEventType.Hit) {
      ball.health = ev.health;
      if (ball.health <= 0) ball.dead = true;
    }
    ball.update(0, terrain, playerPos);
    fastForward(seekTime - ev.timestamp, () => !ball.dead, (s) => ball.update(s, terrain, playerPos));
  }
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
      fastForward(seekTime - ev.timestamp, () => !exp.dead, (s) => exp.update(s));
    }
    return;
  }

  if (ev.eventType === ProjectileEventType.Fired) {
    const r = spawnPlaybackProjectile(world, ev);
    fastForward(seekTime - ev.timestamp, () => !r.dead && !r.exploded, (s) => r.update(s, terrain));
    return;
  }

  if (ev.eventType === ProjectileEventType.Bounce) {
    const r = world.playbackProjectileById.get(ev.projectileId);
    if (!r || r.exploded) return;
    r.pos.set(ev.posX, ev.posY, ev.posZ);
    r.vel.set(ev.velX, ev.velY, ev.velZ);
    fastForward(seekTime - ev.timestamp, () => !r.dead && !r.exploded, (s) => r.update(s, terrain));
  }
}

// Reconstruct projectile from recorded position + velocity, using weaponType
function spawnPlaybackProjectile(world: PlaybackWorld, ev: ProjectileEvent): Projectile {
  const origin = new THREE.Vector3(ev.posX, ev.posY, ev.posZ);
  const velocity = new THREE.Vector3(ev.velX, ev.velY, ev.velZ);
  const cfg = getProjectileConfig(ev.weaponType) ?? ROCKET_CONFIG;
  const r = new Projectile(world.scene, origin, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), cfg);
  r.isRemote = true;
  r.spawnedThisFrame = false;
  r.vel.copy(velocity);
  // Ray-burst replicas discharge deterministically — same hook as the live
  // wire path so replays paint the rail beam too.
  if (cfg.rayBurst) {
    const beamColor = cfg.glowColor;
    r.onRayBurst = (from, to) => spawnPlaybackBeam(world, from, to, beamColor);
  }
  world.playbackProjectiles.push(r);
  world.playbackProjectileById.set(ev.projectileId, r);
  world.playbackProjectileOrigin.set(ev.projectileId, origin.clone());
  return r;
}

// Keyframe snapping policy: balls are resimulated with the live render dt between
// keyframes, so their trajectory drifts slightly from the recording (different dt).
// Hard-snapping every keyframe (including the 0.5s periodic snapshots) produces
// visible micro-jumps. Instead, only hard-snap when drift is large (real desync from
// a bounce-timing mismatch or teleport); for small drift, gently correct toward the
// recorded state so the motion stays smooth and drift stays bounded over long arcs.
const PLAYBACK_HARD_SNAP_DIST = 1.5; // meters — large desync -> hard snap
const PLAYBACK_SMOOTH_FACTOR = 0.25; // per-event gentle correction for small drift

function smoothSnapBall(ball: Ball, ex: number, ey: number, ez: number, evx: number, evy: number, evz: number): void {
  const dx = ball.pos.x - ex, dy = ball.pos.y - ey, dz = ball.pos.z - ez;
  const drift = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (drift >= PLAYBACK_HARD_SNAP_DIST) {
    ball.pos.set(ex, ey, ez);
    ball.vel.set(evx, evy, evz);
  } else {
    const a = PLAYBACK_SMOOTH_FACTOR;
    ball.pos.x += (ex - ball.pos.x) * a;
    ball.pos.y += (ey - ball.pos.y) * a;
    ball.pos.z += (ez - ball.pos.z) * a;
    ball.vel.x += (evx - ball.vel.x) * a;
    ball.vel.y += (evy - ball.vel.y) * a;
    ball.vel.z += (evz - ball.vel.z) * a;
  }
}

// Normal playback event processing (forward playback, not seeking)
export function applyPlaybackEvents(world: PlaybackWorld, events: { projectiles: ProjectileEvent[], targets: TargetEvent[] }): void {
  // Targets first so balls are spawned/updated before projectile hits reference them
  for (const ev of events.targets) {
    applyPlaybackTargetEvent(world, ev);
  }
  for (const ev of events.projectiles) {
    applyPlaybackProjectileEvent(world, ev);
  }
}

function applyPlaybackTargetEvent(world: PlaybackWorld, ev: TargetEvent): void {
  const { scene, terrain, balls, playbackBallById } = world;
  const playerPos = world.getPlayer().pos;

  if (ev.eventType === TargetEventType.Spawned) {
    const ball = new Ball(scene, terrain, ev.targetType as 0 | 1 | 2 | 3);
    ball.pos.set(ev.posX, ev.posY, ev.posZ);
    ball.vel.set(ev.velX, ev.velY, ev.velZ);
    // Apply recorded health when available (e.g. synthetic Spawned from a Hit/Bounce snapshot)
    if (ev.health > 0) {
      ball.health = ev.health;
    }
    playbackBallById.set(ev.targetId, ball);
    balls.push(ball);
    ball.update(0, terrain, playerPos); // sync mesh (ctor doesn't copy pos)
    return;
  }

  const ball = playbackBallById.get(ev.targetId);
  if (!ball || ball.dead) return;

  if (ev.eventType === TargetEventType.Bounce || ev.eventType === TargetEventType.StateChanged) {
    // Correct toward recorded keyframe; hard-snap only on large drift
    smoothSnapBall(ball, ev.posX, ev.posY, ev.posZ, ev.velX, ev.velY, ev.velZ);
    ball.update(0, terrain, playerPos);
  } else if (ev.eventType === TargetEventType.Hit) {
    // Snap ball to recorded hit position to ensure explosion aligns
    ball.pos.set(ev.posX, ev.posY, ev.posZ);
    ball.vel.set(ev.velX, ev.velY, ev.velZ);
    // Flash the ball and then sync to the recorded post-hit health
    ball.takeDamage(1); // health is force-synced from the event — amount is cosmetic
    ball.health = ev.health;
    ball.dead = ball.health <= 0;
    ball.update(0, terrain, playerPos);
    world.damageNumberManager.spawn(ball.pos, 1, '#ffffff', world.camera);
  } else if (ev.eventType === TargetEventType.Destroyed) {
    ball.dead = true;
    world.debrisList.push(new BallDebris(scene, terrain, ball.pos.x, ball.pos.y, ball.pos.z, ball.color, ball.scale));
  }
}

function applyPlaybackProjectileEvent(world: PlaybackWorld, ev: ProjectileEvent): void {
  if (ev.eventType === ProjectileEventType.Fired) {
    spawnPlaybackProjectile(world, ev);
    return;
  }

  const r = world.playbackProjectileById.get(ev.projectileId);
  if (!r || r.exploded) return;

  if (ev.eventType === ProjectileEventType.Bounce) {
    r.pos.set(ev.posX, ev.posY, ev.posZ);
    r.vel.set(ev.velX, ev.velY, ev.velZ);
  } else if (ev.eventType === ProjectileEventType.Hit) {
    r.pos.set(ev.posX, ev.posY, ev.posZ);
    r.explode();
    applyPlaybackProjectileHit(world, ev, r);
  } else if (ev.eventType === ProjectileEventType.Destroyed) {
    // Remove projectile without explosion (e.g. timeout)
    r.pos.set(ev.posX, ev.posY, ev.posZ);
    r.explode();
  }
}

function applyPlaybackProjectileHit(world: PlaybackWorld, ev: ProjectileEvent, r: Projectile): void {
  const { scene, terrain, explosions, implosions } = world;

  // Compute accuracy using the recorded target position when available
  const ball = ev.targetId && ev.targetId !== 0xFFFF ? world.playbackBallById.get(ev.targetId) : undefined;
  let directHit = false;
  let accRaw = 0;
  if (ball) {
    const distToBall = r.pos.distanceTo(ball.pos);
    directHit = distToBall <= ball.radius + r.config.bodyRadius;
    accRaw = Math.max(0, distToBall - ball.radius);
  }
  const acc = computeAccuracy(accRaw, directHit);

  // Spawn correct effect (explosion for push, implosion for pull)
  if (r.config.forceMode === 'push') {
    explosions.push(new Explosion(scene, r.pos, directHit, r.age, terrain, r.explosionRadius / 6, r.config.damageColor));
  } else {
    implosions.push(new Implosion(scene, r.pos, r.age, terrain));
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
  } else if (ev.targetId && ev.targetId !== 0xFFFF && ev.targetId !== 0) {
    logger.debug(`Projectile Hit: projPos=(${ev.posX.toFixed(1)},${ev.posY.toFixed(1)},${ev.posZ.toFixed(1)}) ball ${ev.targetId} not found`);
  }
}
