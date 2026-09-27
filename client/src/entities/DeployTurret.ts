import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import type { Terrain } from '../world/terrain.js';

// Player-deployable sentry — the T2 base-economy seed. A tripod dome that
// hitscan-snaps to the nearest hostile (creature or enemy bot) inside its
// envelope. Real meshes, not swarm instances: counts are capped at a
// handful per player, so instancing buys nothing.
//
// It is deliberately NOT in entities.targets — your own rockets shouldn't
// detonate your own turret. Creatures break it through the speciesKit
// gnaw funnel (they commit to it like any candidate and chew it down).

const RANGE = 42;           // acquire envelope
const FIRE_INTERVAL = 0.45; // ~2.2 shots/sec — reads as a sentry, not a hose
const MUZZLE = new THREE.Vector3(0, 1.35, 0.55); // local to head pivot

const _v = new THREE.Vector3();
const _aim = new THREE.Vector3();

// Shared across all sentries — a handful of turrets doesn't justify
// per-instance materials/geometries; geometries die with the module.
const _metal = new THREE.MeshLambertMaterial({ color: 0x4a5560 });
const _dark = new THREE.MeshLambertMaterial({ color: 0x23282e });
const _glow = new THREE.MeshBasicMaterial({ color: 0x66ddff });
const _geoBase = new THREE.CylinderGeometry(0.55, 0.8, 0.5, 8);
const _geoMast = new THREE.CylinderGeometry(0.16, 0.22, 0.9, 6);
const _geoDome = new THREE.SphereGeometry(0.42, 10, 8);
const _geoBarrel = new THREE.BoxGeometry(0.12, 0.12, 0.9);
const _geoEye = new THREE.SphereGeometry(0.09, 6, 5);

export class DeployTurret {
  readonly id: number;
  /** Species-candidate id — what a creature's threat table commits to. */
  readonly candId: string;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3(); // bolted down — gnaw knockback no-ops
  readonly radius = 0.9;
  dead = false;
  health = 60;
  maxHealth = 60;

  readonly group = new THREE.Group();
  private head = new THREE.Group();
  private flash: THREE.Sprite;
  private flashT = 0;
  private fireCd = 0.6 + Math.random() * 0.4; // stagger multi-turret volleys
  private idleSpin = Math.random() * Math.PI * 2;

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this.id = nextTargetId();
    this.candId = `dep:${this.id}`;
    this.pos.copy(pos);
    this.pos.y = terrain.getHeight(pos.x, pos.z);

    const base = new THREE.Mesh(_geoBase, _dark);
    base.position.y = 0.25;
    const mast = new THREE.Mesh(_geoMast, _metal);
    mast.position.y = 0.9;
    this.group.add(base, mast);

    const dome = new THREE.Mesh(_geoDome, _metal);
    const barrel = new THREE.Mesh(_geoBarrel, _dark);
    barrel.position.set(0, 0.05, 0.45);
    const eye = new THREE.Mesh(_geoEye, _glow);
    eye.position.set(0, 0.12, 0.42);
    this.head.add(dome, barrel, eye);
    this.head.position.y = 1.4;
    this.group.add(this.head);

    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(), color: 0xaaddff, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.flash.scale.setScalar(0.6);
    this.flash.position.copy(MUZZLE);
    this.head.add(this.flash);

    this.group.position.copy(this.pos);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), terrain.getNormal(pos.x, pos.z));
    scene.add(this.group);
  }

  /**
   * Returns a shot {muzzle, hit} when the fire cycle lands on a live enemy
   * in range — the caller owns damage + tracer visuals. Leading with a
   * small velocity compensation so movers still get clipped.
   */
  update(dt: number, enemies: { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[]):
      { muzzle: THREE.Vector3; hit: THREE.Vector3 } | null {
    if (this.dead) return null;
    this.flashT -= dt;
    this.flash.material.opacity = Math.max(0, this.flashT / 0.09);

    let best: (typeof enemies)[0] | null = null;
    let bestD2 = RANGE * RANGE;
    for (const e of enemies) {
      if (!e.alive) continue;
      const d2 = this.pos.distanceToSquared(e.pos);
      if (d2 < bestD2) { bestD2 = d2; best = e; }
    }

    if (best) {
      _aim.copy(best.pos).sub(this.pos);
      const yaw = Math.atan2(_aim.x, _aim.z);
      // Slew the head — a snapped turret reads as a debug helper
      const cur = this.head.rotation.y;
      let dy = yaw - cur;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.head.rotation.y = cur + dy * Math.min(1, dt * 10);
      this.head.rotation.x = THREE.MathUtils.clamp(-Math.atan2(_aim.y, Math.hypot(_aim.x, _aim.z)), -0.9, 0.5);
    } else {
      this.head.rotation.y = (this.idleSpin += dt * 0.6); // scanning sweep
      this.head.rotation.x *= 1 - Math.min(1, dt * 4);
    }

    this.fireCd -= dt;
    if (!best || this.fireCd > 0) return null;
    this.fireCd = FIRE_INTERVAL;
    this.flashT = 0.09;

    // Hitscan with a 0.2s velocity lead — under-lead keeps skiiers honest
    // without making the turret omniscient.
    const muzzle = _v.copy(MUZZLE).applyQuaternion(this.head.getWorldQuaternion(new THREE.Quaternion())).add(this.pos).clone();
    const hit = _aim.copy(best.pos).addScaledVector(best.vel, 0.2);
    hit.y += 0.6; // center-mass, not feet
    return { muzzle, hit };
  }

  takeDamage(dmg: number): void {
    if (this.dead) return;
    this.health -= dmg;
    if (this.health <= 0) this.dead = true;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    // Shared materials/geometries intentionally not disposed — module-owned.
    this.flash.material.dispose(); // per-instance SpriteMaterial
  }
}
