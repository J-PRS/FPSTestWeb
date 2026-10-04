import * as THREE from 'three';
import { GRAVITY } from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { BallTrailDots } from '../effects/ballTrails.js';

let _boltGeo: THREE.SphereGeometry | null = null;
function boltGeo(): THREE.SphereGeometry {
  if (!_boltGeo) _boltGeo = new THREE.SphereGeometry(0.16, 8, 6);
  return _boltGeo;
}
let _boltMat: THREE.MeshBasicMaterial | null = null;
function boltMat(): THREE.MeshBasicMaterial {
  if (!_boltMat) _boltMat = new THREE.MeshBasicMaterial({ color: 0xffcc66 });
  return _boltMat;
}
// Ember tint shared by every host's BallTrailDots burst.
const EMBER = new THREE.Color(0xff8830);

export interface Bolt {
  mesh: THREE.Mesh;
  glow: THREE.Sprite;
  pos: THREE.Vector3;
  prevPos: THREE.Vector3; // start-of-frame pos — swept interception is segment-vs-segment
  radius: number;         // intercept envelope (visual sphere is only 0.16 — this is the forgiving hitbox)
  vel: THREE.Vector3;
  life: number;
  trailAcc: number;
}

/** What the bolt pool needs from the turret — flat fields, no class import. */
export interface BoltHost<T> {
  scene: THREE.Scene;
  bolts: Bolt[];
  /** Shared Points-batch sparkle layer — one draw call for all embers
   *  (a firing turret used to emit ~33 separate dot Meshes per second). */
  trailFx: BallTrailDots;
  pos: THREE.Vector3;
  onBoltHit?: (t: T) => void;
  onBoltLand?: (pos: THREE.Vector3) => void;
}

const _v = new THREE.Vector3();

export function spawnBolt<T>(h: BoltHost<T>, vel: THREE.Vector3, muzzle?: THREE.Vector3): void {
  const mesh = new THREE.Mesh(boltGeo(), boltMat());
  const pos = muzzle ? muzzle.clone() : h.pos.clone();
  if (!muzzle) pos.y += 1.0; // muzzle-less hosts keep the old center-top spawn
  mesh.position.copy(pos);
  // Hot halo — the bolt reads at range even when the sphere is subpixel
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: getGlowTexture(), color: 0xffaa44, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  glow.scale.setScalar(1.6);
  glow.position.copy(pos);
  h.scene.add(mesh, glow);
  h.bolts.push({
    mesh, glow, pos,
    prevPos: pos.clone(),
    radius: 1.5, // generous — clipping a 60m/s shell mid-air is a skill shot
    vel: vel.clone(),
    life: 10.0, // lobbed shells are slow arks — long fuse so a shot fired
    // at range actually lands instead of fizzing mid-air
    trailAcc: 0,
  });
}

/** Cooked mid-air by a player shell — same cleanup as a landed bolt, no callbacks. */
export function detonateBolt<T>(h: BoltHost<T>, i: number): void {
  if (!h.bolts[i]) return;
  removeBolt(h, i);
}

function removeBolt<T>(h: BoltHost<T>, i: number): void {
  const b = h.bolts[i];
  if (!b) return;
  h.scene.remove(b.mesh, b.glow);
  (b.glow.material as THREE.SpriteMaterial).dispose();
  h.bolts.splice(i, 1);
}

export function updateBolts<T>(h: BoltHost<T>, t: T, dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
  for (let i = h.bolts.length - 1; i >= 0; i--) {
    const b = h.bolts[i];
    b.life -= dt;
    b.vel.y += GRAVITY * dt;
    b.prevPos.copy(b.pos);
    b.pos.addScaledVector(b.vel, dt);
    b.mesh.position.copy(b.pos);
    b.glow.position.copy(b.pos);
    // Stretch along velocity — a lobbed streak, not a marble
    b.mesh.scale.set(1, 1, 1 + b.vel.length() * 0.05);
    _v.copy(b.vel).normalize();
    b.mesh.lookAt(_v.add(b.pos));

    // Ember trail — one batched point per cadence tick
    b.trailAcc += dt;
    while (b.trailAcc > 0.03) {
      b.trailAcc -= 0.03;
      h.trailFx.burst(1, b.pos, 0.3, EMBER);
    }

    const hitPlayer = b.pos.distanceToSquared(playerPos) < 1.7; // ~1.3m
    const hitGround = b.pos.y < terrain.getHeight(b.pos.x, b.pos.z);
    if (hitPlayer) {
      removeBolt(h, i);
      h.onBoltHit?.(t);
    } else if (hitGround || b.life <= 0) {
      removeBolt(h, i);
      if (hitGround) h.onBoltLand?.(b.pos);
    }
  }

  h.trailFx.fade(dt);
}

export function disposeBolts<T>(h: BoltHost<T>): void {
  for (const b of h.bolts) {
    h.scene.remove(b.mesh, b.glow);
    (b.glow.material as THREE.SpriteMaterial).dispose();
  }
  h.bolts.length = 0;
  h.trailFx.dispose();
}
