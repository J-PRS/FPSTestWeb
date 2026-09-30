import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import type { Terrain } from '../world/terrain.js';

// Player-deployable escort drone — hovers above/behind the owner's head and
// plinks nearby enemies with the same mini-rocket plumbing the sentry uses.
// Slower + weaker than the sentry: it trades kill power for following you.
// It's a dep: candidate like every deployable — enemies can target and
// kill it, so it buys uptime, not immunity.

const RANGE = 35;           // acquire envelope
const FIRE_INTERVAL = 1.6;  // deliberately weaker than the sentry's 1.25s
const HOVER_UP = 2.5;       // anchor height above the owner's head
const HOVER_BACK = 0.9;     // slight back-offset — keeps it out of the crosshair
const SPRING = 14;          // anchor pull strength — lag is emergent, not faked
const DAMP = 5.5;           // velocity damping — settles without orbit-jitter
const CLEARANCE = 1.1;      // min height above terrain

const _metal = new THREE.MeshLambertMaterial({ color: 0x4a5560 });
const _dark = new THREE.MeshLambertMaterial({ color: 0x23282e });
const _glow = new THREE.MeshBasicMaterial({ color: 0x88ddff });
const _geoHull = new THREE.SphereGeometry(0.3, 10, 6);
const _geoRotor = new THREE.CylinderGeometry(0.34, 0.34, 0.03, 8);
const _geoPod = new THREE.CylinderGeometry(0.07, 0.09, 0.5, 6);
const _geoEye = new THREE.SphereGeometry(0.07, 6, 5);

const _aim = new THREE.Vector3();
const _acc = new THREE.Vector3();
const _anchor = new THREE.Vector3();

export class DeployDrone {
  readonly id: number;
  /** Species-candidate id — what a creature's threat table commits to. */
  readonly candId: string;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3(); // free-flying — knockback matters
  readonly radius = 0.4;
  dead = false;
  health = 50;
  maxHealth = 50;
  armor = 0;

  readonly group = new THREE.Group();
  private rotor: THREE.Mesh;
  private flash: THREE.Sprite;
  private flashT = 0;
  private fireCd = 1.0 + Math.random() * 0.4;
  private terrain: Terrain;
  private unfoldT = 0;

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this.id = nextTargetId();
    this.candId = `dep:${this.id}`;
    this.terrain = terrain;
    this.pos.copy(pos);

    const hull = new THREE.Mesh(_geoHull, _metal);
    hull.scale.set(1.25, 0.55, 1.25); // flattened saucer
    this.rotor = new THREE.Mesh(_geoRotor, _dark);
    this.rotor.position.y = 0.16;
    const pod = new THREE.Mesh(_geoPod, _dark);
    pod.rotation.x = Math.PI / 2;
    pod.position.set(0, -0.08, 0.2); // underslung launch tube
    const eye = new THREE.Mesh(_geoEye, _glow);
    eye.position.set(0, -0.02, 0.3);
    this.group.add(hull, this.rotor, pod, eye);

    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(), color: 0x88ddff, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.flash.scale.setScalar(0.5);
    this.flash.position.y = -0.3;
    this.group.add(this.flash);

    this.group.position.copy(this.pos);
    scene.add(this.group);
  }

  /**
   * Follow + shoot. Anchor hovers above/behind the owner's head; the
   * spring gives the natural trail-behind lag. Returns {muzzle, target}
   * on the firing beat — caller owns the rocket.
   */
  update(dt: number, ownerPos: THREE.Vector3, ownerYaw: number,
         enemies: { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[]):
      { muzzle: THREE.Vector3; target: { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean } } | null {
    if (this.dead) return null;
    if (this.unfoldT < 1) { this.tickUnfold(dt); return null; }
    this.flashT -= dt;
    this.flash.material.opacity = Math.max(0, this.flashT / 0.09);
    this.rotor.rotation.y += dt * 30;

    // Anchor: above the head, biased slightly back — out of view, close
    // enough to read as YOURS. The spring does the "lags behind" part.
    _anchor.set(
      ownerPos.x - Math.sin(ownerYaw) * HOVER_BACK,
      ownerPos.y + HOVER_UP,
      ownerPos.z - Math.cos(ownerYaw) * HOVER_BACK,
    );
    _acc.copy(_anchor).sub(this.pos).multiplyScalar(SPRING);
    _acc.addScaledVector(this.vel, -DAMP);
    this.vel.addScaledVector(_acc, dt);
    this.pos.addScaledVector(this.vel, dt);

    const floor = this.terrain.getHeight(this.pos.x, this.pos.z) + CLEARANCE;
    if (this.pos.y < floor) {
      this.pos.y = floor;
      if (this.vel.y < 0) this.vel.y = 0;
    }

    // Lean into motion — a hover body that doesn't bank reads as a sprite.
    this.group.position.copy(this.pos);
    const lean = THREE.MathUtils.clamp(this.vel.length() * 0.03, 0, 0.45);
    _aim.copy(this.vel).normalize();
    if (_aim.lengthSq() > 0.01) {
      this.group.rotation.set(0, Math.atan2(_aim.x, _aim.z), 0);
      this.group.rotateX(lean);
    }

    let best: (typeof enemies)[0] | null = null;
    let bestD2 = RANGE * RANGE;
    for (const e of enemies) {
      if (!e.alive) continue;
      const d2 = this.pos.distanceToSquared(e.pos);
      if (d2 < bestD2) { bestD2 = d2; best = e; }
    }

    this.fireCd -= dt;
    if (!best || this.fireCd > 0) return null;
    this.fireCd = FIRE_INTERVAL;
    this.flashT = 0.09;
    const muzzle = this.pos.clone();
    muzzle.y -= 0.25; // underslung tube
    return { muzzle, target: best };
  }

  tickUnfold(dt: number): void {
    if (this.unfoldT >= 1) return;
    this.unfoldT = Math.min(1, this.unfoldT + dt / 0.45);
    const k = this.unfoldT - 1;
    this.group.scale.setScalar(Math.max(0.08, 1 + 2.7 * k * k * k + 1.7 * k * k)); // easeOutBack
  }

  unfoldDone(): void {
    this.unfoldT = 1;
    this.group.scale.setScalar(1);
  }

  heal(n: number): void {
    const over = Math.max(0, this.health + n - this.maxHealth);
    this.health = Math.min(this.maxHealth, this.health + n);
    this.armor = Math.min(this.maxHealth * 2, this.armor + over);
  }

  takeDamage(dmg: number): void {
    if (this.dead) return;
    const soak = Math.min(this.armor, dmg);
    this.armor -= soak;
    this.health -= dmg - soak;
    if (this.health <= 0) this.dead = true;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.flash.material.dispose(); // per-instance SpriteMaterial
  }
}
