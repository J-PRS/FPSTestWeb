import * as THREE from 'three';

import { getHeightfield } from '../world/terrain.js';
import { hmHeight, type Heightfield } from '../../../shared/heightfield.js';
import { commitTarget, type SimTotem } from '../../../shared/creatureSim.js';
import type { SimVec, StructureCollider } from '../../../shared/ballSim.js';
import { Projectile } from '../projectiles/Projectile.js';
import type { Terrain } from '../world/terrain.js';

/** The state fields every netDriven shared sim carries — the concrete
 *  structs (SimCrawler, SimFlyer, …) extend this per family. */
export interface NetSimState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number;
  health: number;
  state: string;
  targetId: string | null;
  tx: number; ty: number; tz: number;
  tgtValid: boolean;
}

/** The fields every netDriven species entity needs — duck-typed so each
 *  entity class (Crawler, Scarab, …) delegates here instead of each
 *  growing its own copy of the replay loop. */
export interface NetDrivenLike<S extends NetSimState> {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  health: number;
  dead: boolean;
  sim: S | null;
  netAcc: number;
  writeInstances(terrain: Terrain): void;
}

/** Options object for the wire spawn — one signature across all species. */
export interface NetBindArgs {
  id: number;
  seed: number;
  pos: SimVec;
  vel: SimVec;
  state: string;
  uber: boolean;
  species: string;
}

export type MakeSim<S extends NetSimState> =
  (id: number, pos: SimVec, uber: boolean, seed: number, species: string) => S;
export type StepSim<S extends NetSimState> =
  (s: S, dt: number, field: Heightfield, target: SimVec | null, authoritative: boolean,
   colliders?: readonly StructureCollider[]) => unknown;

/** A committed wire edge — snap the local sim into the authority's state. */
export interface NetEdgeMsg {
  position: SimVec;
  velocity: SimVec;
  kind?: string;
  targetId: string | null;
  tp?: SimVec | null;
}

/** Seed the shared sim from a wire spawn — the seeded LCG makes every
 *  client's replay identical to the authority's. */
export function bindNetSim<S extends NetSimState>(
  e: NetDrivenLike<S>, make: MakeSim<S>, b: NetBindArgs,
): void {
  e.sim = make(b.id, b.pos, b.uber, b.seed, b.species);
  e.sim.state = b.state as S['state'];
  e.sim.vx = b.vel.x; e.sim.vy = b.vel.y; e.sim.vz = b.vel.z;
  e.pos.set(b.pos.x, b.pos.y, b.pos.z);
  e.vel.set(b.vel.x, b.vel.y, b.vel.z);
  e.health = e.sim.health;
}

export function applyNetEdgeSim<S extends NetSimState>(e: NetDrivenLike<S>, m: NetEdgeMsg): void {
  const s = e.sim;
  if (!s) {return;}
  s.x = m.position.x; s.y = m.position.y; s.z = m.position.z;
  s.vx = m.velocity.x; s.vy = m.velocity.y; s.vz = m.velocity.z;
  commitTarget(s, m.targetId, m.tp ?? null);
  e.pos.set(s.x, s.y, s.z);
  e.vel.set(s.vx, s.vy, s.vz);
}

/** Replay the shared sim on the 50ms grid and mirror its state into the
 *  entity's visual fields. Callers add their species-specific telegraphs
 *  (squash/glow/dash cues) on top — the state machine is the display's
 *  truth either way. */
export function updateNetSim<S extends NetSimState>(
  e: NetDrivenLike<S>, dt: number, terrain: Terrain, step: StepSim<S>,
  opts?: { grounded?: boolean },
): void {
  const s = e.sim;
  const field = getHeightfield();
  if (!s || !field) {return;}
  e.netAcc = Math.min(e.netAcc + dt, 0.5);
  const tgt = s.tgtValid ? { x: s.tx, y: s.ty, z: s.tz } : null;
  while (e.netAcc >= 0.05) {
    e.netAcc -= 0.05;
    step(s, 0.05, field, tgt, false, Projectile.solidColliders);
  }
  e.pos.set(s.x, s.y, s.z);
  e.vel.set(s.vx, s.vy, s.vz);
  e.yaw = s.yaw;
  // Grounded species (hop family) surface airborne for anim — the
  // interface keeps it off the contract since flyers don't have one.
  if (opts?.grounded) {
    (e as { airborne?: boolean }).airborne = s.y > hmHeight(field, s.x, s.z) + 0.05;
  }
  e.health = s.health;
  e.writeInstances(terrain);
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

export function bindNetTotem(e: NetTotemLike, b: NetBindArgs, make: MakeSim<SimTotem>): void {
  e.sim = make(b.id, b.pos, b.uber, b.seed, b.species);
  e.sim.state = (b.state === 'charge' || b.state === 'blinkOut' || b.state === 'blinkIn') ? b.state : 'aim';
  e.pos.set(b.pos.x, b.pos.y, b.pos.z);
  e.health = e.sim.health;
}

export function applyNetEdgeTotem(e: NetTotemLike, m: NetEdgeMsg): void {
  const s = e.sim;
  if (!s) {return;}
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
  if (m.kind === 'fire') {e.onSimFire();}
  if (m.kind !== 'blink' && s.state !== 'blinkOut' && s.state !== 'blinkIn') {
    s.x = m.position.x; s.y = m.position.y; s.z = m.position.z;
    e.pos.set(s.x, s.y, s.z);
  }
  commitTarget(s, m.targetId, m.tp ?? null);
}

export function updateNetTotem(
  e: NetTotemLike, dt: number, terrain: Terrain, step: StepSim<NonNullable<NetTotemLike['sim']>>,
): void {
  const s = e.sim;
  const field = getHeightfield();
  if (!s || !field) {return;}
  e.netAcc = Math.min(e.netAcc + dt, 0.5);
  const tgt = s.tgtValid ? { x: s.tx, y: s.ty, z: s.tz } : null;
  while (e.netAcc >= 0.05) {
    e.netAcc -= 0.05;
    // Solid colliders ride the projectile-static set — same list the
    // server sims, so the predictor clips the beam identically.
    if (step(s, 0.05, field, tgt, false, Projectile.solidColliders) === 'fire') {e.onSimFire();}
  }
  e.pos.set(s.x, s.y, s.z);
  e.health = s.health;
  e.writeInstances(terrain);
}
