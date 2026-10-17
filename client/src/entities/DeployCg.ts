import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { tickUnfold, unfoldDone, healDeploy, damageDeploy } from './deployBody.js';
import type { Terrain } from '../world/terrain.js';
import { DEPLOY_ITEMS } from '../../../shared/deployItems.js';
import { WEAPONS, WeaponType } from '../../../shared/weapons.js';

// Player-deployable chaingun turret — the suppression emplacement. Twin
// thin barrels on a fast-tracking dome: sprays REAL chaingun bolts
// (weapon row 3, 250 m/s flat) at ~7/s inside a shorter envelope than
// the rocket sentry. Counterplay: it can't touch what it can't see, and
// its 50hp dome folds to two discs.

const RANGE = DEPLOY_ITEMS.cgturret.range!;
// Spray cadence — the wire pulse (DEPLOY_ITEMS.fireInterval) is the
// server's coarse damage tick; the mount itself spits ~7 bolts a second.
const FIRE_INTERVAL = 0.15;
const BOLT_SPEED = WEAPONS[WeaponType.Chaingun]!.speed;
const TURN_RATE = 5.5;      // rad/s — CG mounts track fast, it's their job
const AIM_TOL = 0.09;
const MUZZLE = new THREE.Vector3(0, 0.1, 0.85); // barrel tip, head-local

const _metal = new THREE.MeshLambertMaterial({ color: 0x46_50_5C });
const _dark = new THREE.MeshLambertMaterial({ color: 0x22_26_2C });
const _glow = new THREE.MeshBasicMaterial({ color: 0xFF_EE_66 });
const _geoBase = new THREE.CylinderGeometry(0.5, 0.75, 0.45, 8);
const _geoMast = new THREE.CylinderGeometry(0.14, 0.2, 0.8, 6);
const _geoDome = new THREE.SphereGeometry(0.36, 10, 8);
const _geoBarrel = new THREE.CylinderGeometry(0.06, 0.075, 1, 6);
const _geoEye = new THREE.SphereGeometry(0.07, 6, 5);

const _v = new THREE.Vector3();
const _aim = new THREE.Vector3();

export class DeployCg {
  readonly id: number;
  readonly candId: string;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly radius = 0.8;
  dead = false;
  health = DEPLOY_ITEMS.cgturret.hp;
  maxHealth = DEPLOY_ITEMS.cgturret.hp;
  armor = 0;

  readonly group = new THREE.Group();
  private head = new THREE.Group();
  private flash: THREE.Sprite;
  private flashT = 0;
  private fireCd = DEPLOY_ITEMS.cgturret.armS!;
  private nextBarrel = 0;
  private idleSpin = Math.random() * Math.PI * 2;
  unfoldT = 0;

  constructor(scene: THREE.Scene, private terrain: Terrain, pos: THREE.Vector3) {
    this.id = nextTargetId();
    this.candId = `dep:${this.id}`;
    this.pos.copy(pos);
    const bg = terrain.getHeight(pos.x, pos.z);
    if (Number.isFinite(bg)) {this.pos.y = bg;}

    const base = new THREE.Mesh(_geoBase, _dark);
    base.position.y = 0.22;
    const mast = new THREE.Mesh(_geoMast, _metal);
    mast.position.y = 0.75;
    this.group.add(base, mast);

    this.head.position.y = 1.25;
    const dome = new THREE.Mesh(_geoDome, _metal);
    dome.scale.set(1.15, 0.8, 1.15); // squashed casemate
    this.head.add(dome);
    for (const side of [-1, 1]) {
      const b = new THREE.Mesh(_geoBarrel, _dark);
      b.position.set(side * 0.14, 0.02, 0.5);
      b.rotation.x = Math.PI / 2;
      this.head.add(b);
    }
    const eye = new THREE.Mesh(_geoEye, _glow);
    eye.position.set(0, 0.22, 0.3);
    this.head.add(eye);
    this.group.add(this.head);

    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(), color: 0xFF_EE_88, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.flash.scale.setScalar(0.5);
    this.flash.position.copy(MUZZLE);
    this.head.add(this.flash);

    this.group.position.copy(this.pos);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), terrain.getNormal(pos.x, pos.z));
    scene.add(this.group);
  }

  /** Returns {muzzle, vel} when a bolt leaves a barrel — caller spawns
   *  the real CG Projectile (offline) or the wire paints the burst
   *  (connected). LOS-gated like the sentry: no spray through dirt. */
  update(dt: number, enemies: { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[]):
      { muzzle: THREE.Vector3; vel: THREE.Vector3 } | null {
    if (this.dead) {return null;}
    if (this.unfoldT < 1) { tickUnfold(this, dt); return null; }
    this.flashT -= dt;
    this.flash.material.opacity = Math.max(0, this.flashT / 0.06);
    this.fireCd -= dt;
    let best: (typeof enemies)[0] | null = null;
    let bestD2 = RANGE * RANGE;
    for (const e of enemies) {
      if (!e.alive) {continue;}
      const d2 = this.pos.distanceToSquared(e.pos);
      if (d2 < bestD2) { bestD2 = d2; best = e; }
    }
    if (!best) { this.scan(dt); return null; }

    // Lead the runner — a real bolt has travel time, aim at where the
    // target will be, not where it is.
    const dist = Math.sqrt(bestD2);
    const flight = dist / BOLT_SPEED;
    const ax = best.pos.x + best.vel.x * flight;
    const ay = best.pos.y + 1 + best.vel.y * flight * 0.5;
    const az = best.pos.z + best.vel.z * flight;
    const aimed = this.slewTo(ax, ay, az, dt);
    if (this.fireCd > 0 || !aimed) {return null;}
    if (this.blockedTo(ax, ay, az)) { this.fireCd = 0.25; return null; }

    this.fireCd = FIRE_INTERVAL;
    this.flashT = 0.06;
    const side = this.nextBarrel;
    this.nextBarrel ^= 1;
    this.head.updateWorldMatrix(true, false);
    const muzzle = _v.copy(MUZZLE).add(_aim.set(side === 0 ? -0.14 : 0.14, 0, 0))
      .applyMatrix4(this.head.matrixWorld).clone();
    const vel = new THREE.Vector3(ax - muzzle.x, ay - muzzle.y, az - muzzle.z)
      .normalize().multiplyScalar(BOLT_SPEED);
    return { muzzle, vel };
  }

  private slewTo(x: number, y: number, z: number, dt: number): boolean {
    _aim.set(x - this.pos.x, y - this.pos.y, z - this.pos.z);
    const yaw = Math.atan2(_aim.x, _aim.z);
    let dy = yaw - this.head.rotation.y;
    while (dy > Math.PI) {dy -= Math.PI * 2;}
    while (dy < -Math.PI) {dy += Math.PI * 2;}
    const step = TURN_RATE * dt;
    this.head.rotation.y += Math.abs(dy) <= step ? dy : Math.sign(dy) * step;
    const pitch = THREE.MathUtils.clamp(-Math.atan2(_aim.y, Math.hypot(_aim.x, _aim.z)), -0.7, 0.6);
    const dp = pitch - this.head.rotation.x;
    this.head.rotation.x += Math.abs(dp) <= step ? dp : Math.sign(dp) * step;
    return Math.abs(dy) <= AIM_TOL && Math.abs(dp) <= AIM_TOL;
  }

  /** Muzzle→aim LOS over terrain — same 8-sample march the sentry does:
   *  a CG bolt is a flat line, so a ridge in the way means hold fire. */
  private blockedTo(x: number, y: number, z: number): boolean {
    this.head.updateWorldMatrix(true, false);
    _v.copy(MUZZLE).applyMatrix4(this.head.matrixWorld);
    for (let i = 1; i < 8; i += 1) {
      const t = i / 8;
      if (this.terrain.getHeight(
        _v.x + (x - _v.x) * t, _v.z + (z - _v.z) * t,
      ) > _v.y + (y - _v.y) * t - 0.15) {return true;}
    }
    return false;
  }

  private scan(dt: number): void {
    this.idleSpin += dt * 1.4; // faster idle sweep — sentry-on-alert read
    this.head.rotation.y = this.idleSpin;
    this.head.rotation.x *= 1 - Math.min(1, dt * 4);
  }

  tickUnfold(dt: number): void { tickUnfold(this, dt); }
  unfoldDone(): void { unfoldDone(this); }
  heal(n: number): void { healDeploy(this, n); }
  takeDamage(dmg: number): void { damageDeploy(this, dmg); }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.flash.material.dispose(); // per-instance SpriteMaterial
    // Shared geometries/materials intentionally not disposed — module-owned.
  }
}
