import * as THREE from 'three';

import { getHeightfield } from '../world/terrain.js';
import { hmHeight } from '../../../shared/heightfield.js';
import { type SimCrawler, type SimFlyer, type SimRoller, type SimSlither, type SimBaneling, type SimTotem, stepCrawler, stepFlyer, stepRoller, stepSlither, stepBaneling, stepTotem, makeSimCrawler, makeSimFlyer, makeSimRoller, makeSimSlither, makeSimBaneling, makeSimTotem, commitTarget } from '../../../shared/creatureSim.js';
import { Projectile } from '../projectiles/Projectile.js';
import type { Terrain } from '../world/terrain.js';

/** The fields every netDriven melee species needs — duck-typed so each
 *  entity class (Crawler, Scarab, …) delegates here instead of each
 *  growing its own copy of the replay loop. */
export interface NetMeleeLike {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  airborne: boolean;
  health: number;
  dead: boolean;
  sim: SimCrawler | null;
  netAcc: number;
  writeInstances(terrain: Terrain): void;
}

/** Seed the shared sim from a wire spawn — the seeded LCG makes every
 *  client's hop stream identical to the authority's. */
export function bindNetMelee(
  e: NetMeleeLike & { id: number },
  id: number, seed: number, species: string,
  pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number },
  state: SimCrawler['state'], _uber: boolean,
): void {
  e.sim = makeSimCrawler(id, pos.x, pos.y, pos.z, _uber, seed, species);
  e.sim.state = state;
  e.sim.vx = vel.x; e.sim.vy = vel.y; e.sim.vz = vel.z;
  e.pos.set(pos.x, pos.y, pos.z);
  e.vel.set(vel.x, vel.y, vel.z);
  e.airborne = vel.y !== 0;
  e.health = e.sim.health;
}

/** A committed wire edge — snap the local sim into the authority's state. */
export function applyNetEdgeMelee(e: NetMeleeLike, m: {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  targetId: string | null; tp?: { x: number; y: number; z: number } | null;
}): void {
  const s = e.sim;
  if (!s) return;
  s.x = m.position.x; s.y = m.position.y; s.z = m.position.z;
  s.vx = m.velocity.x; s.vy = m.velocity.y; s.vz = m.velocity.z;
  commitTarget(s, m.targetId, m.tp ?? null);
  e.pos.set(s.x, s.y, s.z);
  e.vel.set(s.vx, s.vy, s.vz);
}

/** netDriven takeDamage — a claim, never a kill: the authority's crawlDie
 *  decides. Returns true from the caller's takeDamage contract meaning
 *  "handled, not dead" (the flash telegraph is the only local effect the
 *  species class adds). */
export function claimDamageMelee(
  e: { netId: number },
  damage: number,
  claim: ((netId: number, damage: number) => void) | null,
): boolean {
  claim?.(e.netId, damage);
  return false;
}

/** Replay the shared sim on the 50ms grid and mirror its state into the
 *  entity's visual fields. Callers add their species-specific telegraphs
 *  (squash/glow/dash cues) on top — the state machine is the display's
 *  truth either way. */
export function updateNetMelee(e: NetMeleeLike, dt: number, terrain: Terrain): void {
  const s = e.sim;
  const field = getHeightfield();
  if (!s || !field) return;
  e.netAcc = Math.min(e.netAcc + dt, 0.5);
  const tgt = s.tgtValid ? { x: s.tx, y: s.ty, z: s.tz } : null;
  while (e.netAcc >= 0.05) {
    e.netAcc -= 0.05;
    stepCrawler(s, 0.05, field, tgt, false, Projectile.solidColliders);
  }
  e.pos.set(s.x, s.y, s.z);
  e.vel.set(s.vx, s.vy, s.vz);
  e.yaw = s.yaw;
  e.airborne = s.y > hmHeight(field, s.x, s.z) + 0.05;
  e.health = s.health;
  e.writeInstances(terrain);
}

// ---- Flyer family -----------------------------------------------------
// Identical contract to the melee helpers — the flyer sim lives behind
// the same edge protocol, so only the bind/replay calls differ.

export interface NetFlyerLike {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  health: number;
  dead: boolean;
  sim: SimFlyer | null;
  netAcc: number;
  writeInstances(terrain: Terrain): void;
}

export function bindNetFlyer(
  e: NetFlyerLike & { id: number },
  id: number, seed: number, species: string,
  pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number },
  state: SimFlyer['state'], _uber: boolean,
): void {
  e.sim = makeSimFlyer(id, pos.x, pos.y, pos.z, _uber, seed, species);
  e.sim.state = state;
  e.sim.vx = vel.x; e.sim.vy = vel.y; e.sim.vz = vel.z;
  e.pos.set(pos.x, pos.y, pos.z);
  e.vel.set(vel.x, vel.y, vel.z);
  e.health = e.sim.health;
}

export function applyNetEdgeFlyer(e: NetFlyerLike, m: {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  targetId: string | null; tp?: { x: number; y: number; z: number } | null;
}): void {
  const s = e.sim;
  if (!s) return;
  s.x = m.position.x; s.y = m.position.y; s.z = m.position.z;
  s.vx = m.velocity.x; s.vy = m.velocity.y; s.vz = m.velocity.z;
  commitTarget(s, m.targetId, m.tp ?? null);
  e.pos.set(s.x, s.y, s.z);
  e.vel.set(s.vx, s.vy, s.vz);
}

export function updateNetFlyer(e: NetFlyerLike, dt: number, terrain: Terrain): void {
  const s = e.sim;
  const field = getHeightfield();
  if (!s || !field) return;
  e.netAcc = Math.min(e.netAcc + dt, 0.5);
  const tgt = s.tgtValid ? { x: s.tx, y: s.ty, z: s.tz } : null;
  while (e.netAcc >= 0.05) {
    e.netAcc -= 0.05;
    stepFlyer(s, 0.05, field, tgt, false, Projectile.solidColliders);
  }
  e.pos.set(s.x, s.y, s.z);
  e.vel.set(s.vx, s.vy, s.vz);
  e.yaw = s.yaw;
  e.health = s.health;
  e.writeInstances(terrain);
}

// ---- Slither family ---------------------------------------------------
// The replay's own wire work is identical to the hop family; the entity
// only additionally wants the sim state mirrored for its coil/lunge pose.

export interface NetSlitherLike {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  health: number;
  dead: boolean;
  sim: SimSlither | null;
  netAcc: number;
  writeInstances(terrain: Terrain): void;
}

export function bindNetSlither(
  e: NetSlitherLike & { id: number },
  id: number, seed: number, species: string,
  pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number },
  _state: string, uber: boolean,
): void {
  e.sim = makeSimSlither(id, pos.x, pos.y, pos.z, uber, seed, species);
  e.sim.vx = vel.x; e.sim.vy = vel.y; e.sim.vz = vel.z;
  e.pos.set(pos.x, pos.y, pos.z);
  e.vel.set(vel.x, vel.y, vel.z);
  e.health = e.sim.health;
}

export function applyNetEdgeSlither(e: NetSlitherLike, m: {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  targetId: string | null; tp?: { x: number; y: number; z: number } | null;
}): void {
  const s = e.sim;
  if (!s) return;
  s.x = m.position.x; s.y = m.position.y; s.z = m.position.z;
  s.vx = m.velocity.x; s.vy = m.velocity.y; s.vz = m.velocity.z;
  commitTarget(s, m.targetId, m.tp ?? null);
  e.pos.set(s.x, s.y, s.z);
  e.vel.set(s.vx, s.vy, s.vz);
}

export function updateNetSlither(e: NetSlitherLike, dt: number, terrain: Terrain): void {
  const s = e.sim;
  const field = getHeightfield();
  if (!s || !field) return;
  e.netAcc = Math.min(e.netAcc + dt, 0.5);
  const tgt = s.tgtValid ? { x: s.tx, y: s.ty, z: s.tz } : null;
  while (e.netAcc >= 0.05) {
    e.netAcc -= 0.05;
    stepSlither(s, 0.05, field, tgt, false, Projectile.solidColliders);
  }
  e.pos.set(s.x, s.y, s.z);
  e.vel.set(s.vx, s.vy, s.vz);
  e.yaw = s.yaw;
  e.health = s.health;
  e.writeInstances(terrain);
}

// ---- Roller family ----------------------------------------------------

export interface NetRollerLike {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  health: number;
  dead: boolean;
  sim: SimRoller | null;
  netAcc: number;
  writeInstances(terrain: Terrain): void;
}

export function bindNetRoller(
  e: NetRollerLike & { id: number },
  id: number, seed: number, species: string,
  pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number },
  _state: string, _uber: boolean,
): void {
  e.sim = makeSimRoller(id, pos.x, pos.y, pos.z, _uber, seed, species);
  e.sim.vx = vel.x; e.sim.vy = vel.y; e.sim.vz = vel.z;
  e.pos.set(pos.x, pos.y, pos.z);
  e.vel.set(vel.x, vel.y, vel.z);
  e.health = e.sim.health;
}

export function applyNetEdgeRoller(e: NetRollerLike, m: {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  targetId: string | null; tp?: { x: number; y: number; z: number } | null;
}): void {
  const s = e.sim;
  if (!s) return;
  s.x = m.position.x; s.y = m.position.y; s.z = m.position.z;
  s.vx = m.velocity.x; s.vy = m.velocity.y; s.vz = m.velocity.z;
  commitTarget(s, m.targetId, m.tp ?? null);
  e.pos.set(s.x, s.y, s.z);
  e.vel.set(s.vx, s.vy, s.vz);
}

export function updateNetRoller(e: NetRollerLike, dt: number, terrain: Terrain): void {
  const s = e.sim;
  const field = getHeightfield();
  if (!s || !field) return;
  e.netAcc = Math.min(e.netAcc + dt, 0.5);
  const tgt = s.tgtValid ? { x: s.tx, y: s.ty, z: s.tz } : null;
  while (e.netAcc >= 0.05) {
    e.netAcc -= 0.05;
    stepRoller(s, 0.05, field, tgt, false, Projectile.solidColliders);
  }
  e.pos.set(s.x, s.y, s.z);
  e.vel.set(s.vx, s.vy, s.vz);
  e.yaw = s.yaw;
  e.health = s.health;
  e.writeInstances(terrain);
}

// ---- Kamikaze family ----------------------------------------------------
// The detonation itself isn't replayed — 'detonate' edge + crawlDie carry
// it; only the chase leg (fuse run-up) is the shared sim's job here.

export interface NetBanelingLike {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  health: number;
  dead: boolean;
  sim: SimBaneling | null;
  netAcc: number;
  writeInstances(terrain: Terrain): void;
}

export function bindNetBaneling(
  e: NetBanelingLike & { id: number },
  id: number, seed: number, species: string,
  pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number },
  _state: string, _uber: boolean,
): void {
  e.sim = makeSimBaneling(id, pos.x, pos.y, pos.z, _uber, seed, species);
  e.sim.vx = vel.x; e.sim.vy = vel.y; e.sim.vz = vel.z;
  e.pos.set(pos.x, pos.y, pos.z);
  e.vel.set(vel.x, vel.y, vel.z);
  e.health = e.sim.health;
}

export function applyNetEdgeBaneling(e: NetBanelingLike, m: {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  targetId: string | null; tp?: { x: number; y: number; z: number } | null;
}): void {
  const s = e.sim;
  if (!s) return;
  s.x = m.position.x; s.y = m.position.y; s.z = m.position.z;
  s.vx = m.velocity.x; s.vy = m.velocity.y; s.vz = m.velocity.z;
  commitTarget(s, m.targetId, m.tp ?? null);
  e.pos.set(s.x, s.y, s.z);
  e.vel.set(s.vx, s.vy, s.vz);
}

export function updateNetBaneling(e: NetBanelingLike, dt: number, terrain: Terrain): void {
  const s = e.sim;
  const field = getHeightfield();
  if (!s || !field) return;
  e.netAcc = Math.min(e.netAcc + dt, 0.5);
  const tgt = s.tgtValid ? { x: s.tx, y: s.ty, z: s.tz } : null;
  while (e.netAcc >= 0.05) {
    e.netAcc -= 0.05;
    stepBaneling(s, 0.05, field, tgt, false, Projectile.solidColliders);
  }
  e.pos.set(s.x, s.y, s.z);
  e.vel.set(s.vx, s.vy, s.vz);
  e.yaw = s.yaw;
  e.health = s.health;
  e.writeInstances(terrain);
}

// ---- Totem family ------------------------------------------------------
// Stationary, so there's no motion to drift — the predictor only needs the
// committed edges. 'charge' solves the beam identically on both sides
// (terrain is static); 'fire' is a pure display edge (the discharge flash);
// 'blink' commits the destination and the sim teleports on the same tick.

export interface NetTotemLike {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  health: number;
  dead: boolean;
  sim: SimTotem | null;
  netAcc: number;
  /** Display hook for the beam discharge — 'fire' edges and the
   *  predictor's own stepTotem 'fire' returns both land here. */
  onSimFire(): void;
  writeInstances(terrain: Terrain): void;
}

export function bindNetTotem(
  e: NetTotemLike & { id: number },
  id: number, seed: number, species: string,
  pos: { x: number; y: number; z: number }, _vel: { x: number; y: number; z: number },
  state: string, uber: boolean,
): void {
  e.sim = makeSimTotem(id, pos.x, pos.y, pos.z, uber, seed, species);
  e.sim.state = (state === 'charge' || state === 'blinkOut' || state === 'blinkIn') ? state : 'aim';
  e.pos.set(pos.x, pos.y, pos.z);
  e.health = e.sim.health;
}

export function applyNetEdgeTotem(e: NetTotemLike, m: {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  kind: string;
  targetId: string | null; tp?: { x: number; y: number; z: number } | null;
}): void {
  const s = e.sim;
  if (!s) return;
  // 'blink' position = the committed DESTINATION, not the totem's pos —
  // force the blink cycle so a client that missed the decision still
  // teleports to the same perch.
  if (m.kind === 'blink') {
    s.blinkX = m.position.x; s.blinkY = m.position.y; s.blinkZ = m.position.z;
    if (s.state !== 'blinkOut' && s.state !== 'blinkIn') {
      s.state = 'blinkOut';
      s.hopTimer = s.sp.BLINK_OUT_S;
    }
  }
  if (m.kind === 'fire') e.onSimFire();
  if (m.kind !== 'blink' && s.state !== 'blinkOut' && s.state !== 'blinkIn') {
    s.x = m.position.x; s.y = m.position.y; s.z = m.position.z;
    e.pos.set(s.x, s.y, s.z);
  }
  commitTarget(s, m.targetId, m.tp ?? null);
}

export function updateNetTotem(e: NetTotemLike, dt: number, terrain: Terrain): void {
  const s = e.sim;
  const field = getHeightfield();
  if (!s || !field) return;
  e.netAcc = Math.min(e.netAcc + dt, 0.5);
  const tgt = s.tgtValid ? { x: s.tx, y: s.ty, z: s.tz } : null;
  while (e.netAcc >= 0.05) {
    e.netAcc -= 0.05;
    // Solid colliders ride the projectile-static set — same list the
    // server sims, so the predictor clips the beam identically.
    if (stepTotem(s, 0.05, field, tgt, false, Projectile.solidColliders) === 'fire') e.onSimFire();
  }
  e.pos.set(s.x, s.y, s.z);
  e.health = s.health;
  e.writeInstances(terrain);
}
