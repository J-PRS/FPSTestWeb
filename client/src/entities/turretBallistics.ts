/**
 * turretBallistics — the Turretter's throw/solve family: ballistic hop
 * (updateAir/launch), terrain seating (seat), and the lob solvers
 * (solveBolt/pathClear). Flat fields ride on the turret via BalHost —
 * the same state-bag pattern as the *Visual splits.
 */
import * as THREE from 'three';
import {
  GRAVITY, TURRET_HOP_T, TURRET_BOLT_SPEED,
} from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import type { TerrainFoot } from '../effects/terrainFoot.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

const TURRET_BURROW = 0.18;

/** Flat fields the ballistics family reads/writes on the turret. */
export interface BalHost {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  radius: number;
  planted: boolean;
  dwell: number;
  meshYOffset: number;
  rootQuat: THREE.Quaternion;
  terrain: Terrain;
  foot: TerrainFoot;
  onLanded?: (pos: THREE.Vector3) => void;
  onLaunch?: (pos: THREE.Vector3) => void;
}

export function updateAir(t: BalHost, dt: number, terrain: Terrain): void {
  t.vel.y += GRAVITY * dt;
  t.pos.addScaledVector(t.vel, dt);
  // Tumble slightly in flight — reads as "thrown", not "flying"
  _q.setFromEuler(_e.set(dt * 2.2, 0, dt * 1.4));
  t.rootQuat.premultiply(_q);

  const gy = terrain.getHeight(t.pos.x, t.pos.z);
  if (t.pos.y - t.radius * 0.5 <= gy) {
    t.pos.y = gy + t.radius * 0.5;
    t.planted = true;
    t.dwell = 0;
    t.vel.set(0, 0, 0);
    seat(t, terrain);
    t.onLanded?.(t.pos);
  }
}

// Seat the base onto the terrain:
//  1. Tilt to the ground normal (works on any slope)
//  2. Sink the base bottom a shallow burrow under CENTER ground — no
//     footprint chasing; the skirt owns the gap now, so the base never
//     needs to dive for the lowest dirt (that was the squash bug).
//  3. Drape the skirt: hem = terrain per-vertex, shoulder = base rim —
//     ground contact is a geometric guarantee on any relief.
// No yaw here — the turret head owns all aiming.
export function seat(t: BalHost, terrain: Terrain): void {
  const n = terrain.getNormal(t.pos.x, t.pos.z);
  _v.set(0, 1, 0);
  t.rootQuat.setFromUnitVectors(_v, n);

  const cx = t.pos.x, cz = t.pos.z;
  const gy = terrain.getHeight(cx, cz);
  t.pos.y = gy + t.radius * 0.5;

  const baseBottomWorldY = gy - TURRET_BURROW;
  t.meshYOffset = baseBottomWorldY - t.pos.y;

  // Weld the foot wall: rim ring tracks the tilted body, bottom ring is
  // driven under the terrain at each column — no gap can form.
  t.foot.conform(cx, cz, t.pos.y + t.meshYOffset, terrain, t.rootQuat);
  t.foot.mesh.visible = true;
}

// Perfect ballistic arc onto the player's predicted position — fixed
// flight time, solve for the launch velocity. Inert from here on out.
export function launch(t: BalHost, playerPos: THREE.Vector3, playerVel?: THREE.Vector3): void {
  _v.copy(playerPos);
  if (playerVel) {_v.addScaledVector(playerVel, TURRET_HOP_T * 0.7);} // lead, not lag
  _v.y = 0; // land at terrain height — solve on XZ + terrain
  const tx = _v.x, tz = _v.z;
  const ty = playerPos.y; // aim at the player's feet-ish
  const dt = TURRET_HOP_T;
  const dx = tx - t.pos.x, dz = tz - t.pos.z;
  const dy = ty - t.pos.y;
  t.vel.set(dx / dt, (dy + 0.5 * Math.abs(GRAVITY) * dt * dt) / dt, dz / dt);
  t.planted = false;
  t.meshYOffset = 0; // in flight the mesh rides the body exactly
  t.rootQuat.identity(); // reset tilt — tumble owns the rotation
  t.foot.mesh.visible = false; // foundation stays behind
  // Dome goes hot mid-air via writeInstances' instanceColor — "shoot me now"
  t.onLaunch?.(t.pos);
}

// Solve the bolt launch velocity for the player's predicted position:
// fixed 60 m/s, elevation from the range equation, low arc preferred.
// Returns null when the target is beyond max range (disc < 0).
export function solveBolt(t: BalHost, playerPos: THREE.Vector3, playerVel?: THREE.Vector3): THREE.Vector3 | null {
  const muzzleY = t.pos.y + 1;
  const v = TURRET_BOLT_SPEED;
  const g = Math.abs(GRAVITY);

  // First pass at the un-led distance for a flight-time estimate,
  // then aim at the player's position predicted over that time.
  const pd = Math.hypot(playerPos.x - t.pos.x, playerPos.z - t.pos.z) || 0.001;
  _v.copy(playerPos);
  if (playerVel) {_v.addScaledVector(playerVel, (pd / v) * 0.5);}

  const dx = _v.x - t.pos.x;
  const dz = _v.z - t.pos.z;
  const dy = _v.y - muzzleY;
  const d = Math.hypot(dx, dz) || 0.001;

  // tan θ = (v² ∓ √(v⁴ - g(g·d² + 2·dy·v²))) / (g·d) — take the low arc.
  const disc = v * v * v * v - g * (g * d * d + 2 * dy * v * v);
  if (disc < 0) {return null;} // out of range entirely
  const theta = Math.atan((v * v - Math.sqrt(disc)) / (g * d));
  const cosT = Math.cos(theta), sinT = Math.sin(theta);
  return new THREE.Vector3((dx / d) * v * cosT, v * sinT, (dz / d) * v * cosT);
}

// March the solved arc and check it clears terrain — 12 samples is plenty
// for a 1s flight. Cheap: no allocation, getHeight is a heightmap read.
export function pathClear(t: BalHost, vel: THREE.Vector3): boolean {
  const muzzle = t.pos.y + 1;
  const g = Math.abs(GRAVITY);
  const tEnd = Math.min(1.5, 2 * vel.y / g + 0.3); // up-and-down time + margin
  for (let i = 1; i <= 12; i++) {
    const tt = (i / 12) * tEnd;
    const x = t.pos.x + vel.x * tt;
    const z = t.pos.z + vel.z * tt;
    const y = muzzle + vel.y * tt - 0.5 * g * tt * tt;
    if (y < t.terrain.getHeight(x, z) + 0.3) {return false;} // arc clips terrain
  }
  return true;
}
