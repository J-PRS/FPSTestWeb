import * as THREE from 'three';
import { GRAVITY } from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import type { BallTrailDots } from '../effects/ballTrails.js';
import { RibbonTrail } from '../effects/RibbonTrail.js';

let _boltGeo: THREE.SphereGeometry | null = null;
function boltGeo(): THREE.SphereGeometry {
  if (!_boltGeo) {_boltGeo = new THREE.SphereGeometry(0.16, 8, 6);}
  return _boltGeo;
}
let _boltMat: THREE.MeshBasicMaterial | null = null;
function boltMat(): THREE.MeshBasicMaterial {
  if (!_boltMat) {_boltMat = new THREE.MeshBasicMaterial({ color: 0xFF_CC_66 });}
  return _boltMat;
}
// Ember tint shared by every host's BallTrailDots burst.
const EMBER = new THREE.Color(0xFF_88_30);

export interface Bolt {
  mesh: THREE.Mesh;
  glow: THREE.Sprite;
  pos: THREE.Vector3;
  prevPos: THREE.Vector3; // start-of-frame pos — swept interception is segment-vs-segment
  radius: number;         // intercept envelope (visual sphere is only 0.16 — this is the forgiving hitbox)
  vel: THREE.Vector3;
  life: number;
  trailAcc: number;
  ribbon: RibbonTrail; // thin ember streak — stops on removal, fades out
}

/** What the bolt pool needs from the turret — flat fields, no class import. */
export interface BoltHost<T> {
  scene: THREE.Scene;
  bolts: Bolt[];
  /** Shared Points-batch sparkle layer — one draw call for all embers
   *  (a firing turret used to emit ~33 separate dot Meshes per second). */
  trailFx: BallTrailDots;
  /** Ribbons whose bolt is gone — owner contract: stop() on death, keep
   *  updating until done, then dispose. updateBolts ticks this list. */
  deadRibbons: RibbonTrail[];
  pos: THREE.Vector3;
  /** pos = the bolt's impact point — damage/knockback must judge from
   *  HERE, not the shooter: a lobbed shell lands tens of meters from the
   *  turret that fired it, so a reach check in the shooter's frame
   *  whiffs every legit hit. */
  onBoltHit?: (t: T, pos: THREE.Vector3) => void;
  onBoltLand?: (pos: THREE.Vector3) => void;
}

const _v = new THREE.Vector3();

export function spawnBolt<T>(h: BoltHost<T>, vel: THREE.Vector3, muzzle?: THREE.Vector3): void {
  const mesh = new THREE.Mesh(boltGeo(), boltMat());
  const pos = muzzle ? muzzle.clone() : h.pos.clone();
  if (!muzzle) {pos.y += 1;} // muzzle-less hosts keep the old center-top spawn
  mesh.position.copy(pos);
  // Hot halo — the bolt reads at range even when the sphere is subpixel
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: getGlowTexture(), color: 0xFF_AA_44, transparent: true,
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
    life: 10, // lobbed shells are slow arks — long fuse so a shot fired
    // at range actually lands instead of fizzing mid-air
    trailAcc: 0,
    // Toned down on purpose: thin + short-lived — a whiff of ember, not
    // the fat ribbon player shells carry.
    ribbon: RibbonTrail.acquire(h.scene, {
      color: 0xFF_88_30, width: 0.12, life: 0.4, billboard: true, tag: 'tbolt',
    }),
  });
}

/** Cooked mid-air by a player shell — same cleanup as a landed bolt, no callbacks. */
export function detonateBolt<T>(h: BoltHost<T>, i: number): void {
  if (!h.bolts[i]) {return;}
  removeBolt(h, i);
}

function removeBolt<T>(h: BoltHost<T>, i: number): void {
  const b = h.bolts[i];
  if (!b) {return;}
  h.scene.remove(b.mesh, b.glow);
  (b.glow.material as THREE.SpriteMaterial).dispose();
  b.ribbon.stop(); // streak stops emitting; deadRibbons fades+disposes it
  h.deadRibbons.push(b.ribbon);
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

    // Ember trail — one batched point per cadence tick + the streak
    b.trailAcc += dt;
    while (b.trailAcc > 0.03) {
      b.trailAcc -= 0.03;
      h.trailFx.burst(1, b.pos, 0.3, EMBER);
    }
    b.ribbon.follow = b.pos;
    b.ribbon.push(b.pos, b.vel);
    b.ribbon.update(dt);

    const hitPlayer = b.pos.distanceToSquared(playerPos) < 1.7; // ~1.3m
    const hitGround = b.pos.y < terrain.getHeight(b.pos.x, b.pos.z);
    if (hitPlayer) {
      removeBolt(h, i);
      h.onBoltHit?.(t, b.pos);
    } else if (hitGround || b.life <= 0) {
      removeBolt(h, i);
      if (hitGround) {h.onBoltLand?.(b.pos);}
    }
  }

  h.trailFx.fade(dt);

  // Dying streaks fade out over their life window, then free the slot.
  for (let i = h.deadRibbons.length - 1; i >= 0; i--) {
    const r = h.deadRibbons[i]!;
    r.update(dt);
    if (r.done) { r.dispose(); h.deadRibbons.splice(i, 1); }
  }
}

export function disposeBolts<T>(h: BoltHost<T>): void {
  for (const b of h.bolts) {
    h.scene.remove(b.mesh, b.glow);
    (b.glow.material as THREE.SpriteMaterial).dispose();
    b.ribbon.dispose(); // host is gone — no fade-out, just free the slots
  }
  h.bolts.length = 0;
  for (const r of h.deadRibbons) {r.dispose();}
  h.deadRibbons.length = 0;
  h.trailFx.dispose();
}
