import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { tickUnfold, unfoldDone, healDeploy, damageDeploy } from './deployBody.js';
import type { Terrain } from '../world/terrain.js';
import { DEPLOY_ITEMS } from '../../../shared/deployItems.js';
import { GRAVITY } from '../../../shared/movement.js';

// Player-deployable mortar — artillery twin of the sentry. A squat tripod
// with one fat angled tube; it lobs REAL mortar shells (weapon row 4
// speed/gravity/arming) over cover onto hostiles inside a [minRange,
// range] band. Point-blank is a dead zone by design — the tube can't
// depress, so rushing it is the counter. Cap 1 per owner.

const RANGE = DEPLOY_ITEMS.mortar.range!;
const MIN_RANGE = DEPLOY_ITEMS.mortar.minRange!;
const FIRE_INTERVAL = DEPLOY_ITEMS.mortar.fireInterval!;
const SHELL_SPEED = DEPLOY_ITEMS.mortar.projSpeed!;
const TURN_RATE = 1.8;       // rad/s — artillery slews slower than a sentry
const AIM_TOL = 0.12;
const MUZZLE_UP = 1.6;       // tube mouth height — matches server tickMortar
const G = Math.abs(GRAVITY);

const _metal = new THREE.MeshLambertMaterial({ color: 0x6A_70_5C, emissive: 0x1A_1E_14 });
_metal.userData.__wearInt = 2.2;
const _dark = new THREE.MeshLambertMaterial({ color: 0x3A_3E_34, emissive: 0x0A_0E_08 });
_dark.userData.__wearInt = 2.2;
const _glow = new THREE.MeshBasicMaterial({ color: 0xFF_AA_55 });
const _geoBase = new THREE.CylinderGeometry(0.9, 1.15, 0.5, 8);
const _geoPost = new THREE.CylinderGeometry(0.24, 0.34, 0.7, 8);
const _geoLeg = new THREE.CylinderGeometry(0.12, 0.15, 1.5, 6);
// Cannon barrel — closed tube (open-ended renders its black interior),
// a fat breech at the butt and a glowing muzzle ring at the mouth.
const _geoTube = new THREE.CylinderGeometry(0.22, 0.3, 2.2, 10);
// Chunky drum breech — a fat cylinder on the bore axis, not a cube.
const _geoBreech = new THREE.CylinderGeometry(0.42, 0.5, 1, 10);
const _geoBreechCap = new THREE.CylinderGeometry(0.42, 0.2, 0.3, 10);
const _geoRing = new THREE.TorusGeometry(0.28, 0.06, 6, 12);
const _geoMouth = new THREE.CircleGeometry(0.24, 10);

const _v = new THREE.Vector3();

export class DeployMortar {
  readonly id: number;
  readonly candId: string;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly radius = 1.1;
  dead = false;
  health = DEPLOY_ITEMS.mortar.hp;
  maxHealth = DEPLOY_ITEMS.mortar.hp;
  armor = 0;

  readonly group = new THREE.Group();
  /** Yaw-pivoted head — the tube tilts with the solved launch pitch. */
  private head = new THREE.Group();
  private tube = new THREE.Mesh(_geoTube, _metal);
  private flash: THREE.Sprite;
  private flashT = 0;
  private fireCd = DEPLOY_ITEMS.mortar.armS!; // assemble, then load
  private kick = 0;
  private idleSpin = Math.random() * Math.PI * 2;
  unfoldT = 0;

  constructor(scene: THREE.Scene, private terrain: Terrain, pos: THREE.Vector3) {
    this.id = nextTargetId();
    this.candId = `dep:${this.id}`;
    this.pos.copy(pos);
    // Seat on the LOWEST ground in the footprint — a crest-edge plant
    // would otherwise hang its downhill side in the air.
    let bg = terrain.getHeight(pos.x, pos.z);
    for (const [ox, oz] of [[0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8]]) {
      const h = terrain.getHeight(pos.x + ox, pos.z + oz);
      if (Number.isFinite(h) && h < bg) {bg = h;}
    }
    if (Number.isFinite(bg)) {this.pos.y = bg;}

    const base = new THREE.Mesh(_geoBase, _dark);
    base.position.y = 0.25;
    this.group.add(base);
    for (let i = 0; i < 3; i += 1) {
      const leg = new THREE.Mesh(_geoLeg, _metal);
      const a = (i / 3) * Math.PI * 2;
      leg.position.set(Math.cos(a) * 0.7, 0.55, Math.sin(a) * 0.7);
      leg.rotation.set(-Math.sin(a) * 0.5, 0, Math.cos(a) * 0.5);
      this.group.add(leg);
    }
    const post = new THREE.Mesh(_geoPost, _dark);
    post.position.y = 0.65;
    this.group.add(post);
    this.head.position.y = 0.9;
    this.tube.position.y = 0.7;
    this.tube.rotation.x = 0.9; // resting ~50 deg elevation toward facing - cannon, not chimney
    const breech = new THREE.Mesh(_geoBreech, _dark);
    breech.position.y = -0.75;
    this.tube.add(breech);
    const breechCap = new THREE.Mesh(_geoBreechCap, _metal);
    breechCap.position.y = -0.6;
    breech.add(breechCap);
    const ring = new THREE.Mesh(_geoRing, _dark);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 1;
    this.tube.add(ring);
    const mouth = new THREE.Mesh(_geoMouth, _glow);
    mouth.rotation.x = -Math.PI / 2;
    mouth.position.y = 1;
    this.tube.add(mouth);
    this.head.add(this.tube);
    this.group.add(this.head);

    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(), color: 0xFF_CC_66, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.flash.scale.setScalar(1.2);
    this.flash.position.y = 1.15;
    this.tube.add(this.flash);

    this.group.position.copy(this.pos);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), terrain.getNormal(pos.x, pos.z));
    this.group.traverse((o): void => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !(m.material instanceof THREE.MeshBasicMaterial)) {m.castShadow = true;}
    });
    scene.add(this.group);
  }

  /** Returns {muzzle, vel} when the fire cycle lands a shell — caller
   *  spawns the real mortar Projectile (offline) or waits for the
   *  server's mortarShot arc (connected). Foes OUTSIDE the [minRange,
   *  range] band are unreachable — no LOS gate, that's the point. */
  update(dt: number, enemies: { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[]):
      { muzzle: THREE.Vector3; vel: THREE.Vector3 } | null {
    if (this.dead) {return null;}
    if (this.unfoldT < 1) { tickUnfold(this, dt); return null; }
    this.flashT -= dt;
    this.flash.material.opacity = Math.max(0, this.flashT / 0.15);
    if (this.kick > 0.001) { this.kick *= Math.exp(-dt * 6); this.tube.position.y = 0.7 - this.kick * 0.2; }

    this.fireCd -= dt;
    let best: (typeof enemies)[0] | null = null;
    let bestD2 = RANGE * RANGE;
    const minD2 = MIN_RANGE * MIN_RANGE;
    for (const e of enemies) {
      if (!e.alive) {continue;}
      const dx = e.pos.x - this.pos.x, dz = e.pos.z - this.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2 && d2 >= minD2) { bestD2 = d2; best = e; }
    }
    if (!best) { this.scan(dt); return null; }

    const arc = this.solveArc(best.pos, best.vel);
    if (!arc) {return null;} // in the band but unreachable — hold fire
    const wantYaw = Math.atan2(arc.vx, arc.vz);
    const wantTilt = Math.PI / 2 - arc.pitch; // tilt +Y barrel toward local +Z = aim dir
    this.slewTo(wantTilt, wantYaw, dt);
    const dyaw = wantYaw - this.head.rotation.y;
    const yawErr = Math.abs(Math.atan2(Math.sin(dyaw), Math.cos(dyaw)));
    if (this.fireCd <= 0 && yawErr <= AIM_TOL && Math.abs(wantTilt - this.tube.rotation.x) <= AIM_TOL) {
      this.fireCd = FIRE_INTERVAL;
      this.flashT = 0.15;
      this.kick = 1;
      const muzzle = this.muzzleWorld(_v).clone();
      return { muzzle, vel: new THREE.Vector3(arc.vx, arc.vy, arc.vz) };
    }
    return null;
  }

  /** Low-lob ballistic solve toward the led target point — same family
   *  as server tickMortar so the painted arc matches the real blast. */
  private solveArc(tp: THREE.Vector3, tv: THREE.Vector3):
      { vx: number; vy: number; vz: number; pitch: number } | null {
    const s2 = SHELL_SPEED * SHELL_SPEED;
    let ax = tp.x, ay = tp.y + 0.5, az = tp.z;
    let out: { vx: number; vy: number; vz: number; pitch: number } | null = null;
    for (let it = 0; it < 2; it += 1) {
      const dx = ax - this.pos.x, dz = az - this.pos.z;
      const R = Math.hypot(dx, dz);
      const dy = ay - (this.pos.y + MUZZLE_UP);
      const disc = s2 * s2 - G * (G * R * R + 2 * dy * s2);
      if (disc <= 0 || R < 1) {return null;}
      const pitch = Math.atan2(s2 - Math.sqrt(disc), G * R);
      const c = Math.cos(pitch);
      const flight = R / (SHELL_SPEED * c);
      out = { vx: (dx / R) * SHELL_SPEED * c, vy: SHELL_SPEED * Math.sin(pitch), vz: (dz / R) * SHELL_SPEED * c, pitch };
      ax = tp.x + tv.x * flight;
      ay = tp.y + 0.5 + tv.y * flight * 0.5;
      az = tp.z + tv.z * flight;
    }
    return out;
  }

  private slewTo(wantTilt: number, yaw: number, dt: number): void {
    let dy = yaw - this.head.rotation.y;
    while (dy > Math.PI) {dy -= Math.PI * 2;}
    while (dy < -Math.PI) {dy += Math.PI * 2;}
    const step = TURN_RATE * dt;
    this.head.rotation.y += Math.abs(dy) <= step ? dy : Math.sign(dy) * step;
    const dp = wantTilt - this.tube.rotation.x;
    this.tube.rotation.x += Math.abs(dp) <= step ? dp : Math.sign(dp) * step;
  }

  private scan(dt: number): void {
    this.idleSpin += dt * 0.3;
    this.head.rotation.y = this.idleSpin;
    const drift = 0.9 - this.tube.rotation.x; // rest ~50° elevation
    this.tube.rotation.x += Math.abs(drift) <= dt * 0.5 ? drift : Math.sign(drift) * dt * 0.5;
  }

  /** World-space tube tip — where shells and the muzzle flash leave. */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    this.tube.updateWorldMatrix(true, false);
    return out.set(0, 1, 0).applyMatrix4(this.tube.matrixWorld);
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
