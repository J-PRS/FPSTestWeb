import * as THREE from 'three';

import { getHeightfield } from '../world/terrain.js';
import { hmHeight } from '../../../shared/heightfield.js';
import { type SimCrawler, stepCrawler, makeSimCrawler, commitTarget } from '../../../shared/creatureSim.js';
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
    stepCrawler(s, 0.05, field, tgt, false);
  }
  e.pos.set(s.x, s.y, s.z);
  e.vel.set(s.vx, s.vy, s.vz);
  e.yaw = s.yaw;
  e.airborne = s.y > hmHeight(field, s.x, s.z) + 0.05;
  e.health = s.health;
  e.writeInstances(terrain);
}
