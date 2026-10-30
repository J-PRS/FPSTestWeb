import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { tickUnfold, unfoldDone, healDeploy, damageDeploy } from './deployBody.js';
import type { Terrain } from '../world/terrain.js';
import { DEPLOY_ITEMS } from '../../../shared/deployItems.js';
import { WEAPONS, WeaponType } from '../../../shared/weapons.js';

// Player-deployable chaingun turret — the suppression emplacement. Same
// language as the handheld chaingun: the barrels ARE the gun — three fat
// pipes on an exposed spinning rotor, collar bearing, receiver drum and
// an ammo box slung low. Sprays REAL chaingun bolts (weapon row 3,
// 250 m/s flat) at ~7/s inside a shorter envelope than the rocket
// sentry. Counterplay: it can't touch what it can't see, and its 50hp
// mount folds to two discs.

const RANGE = DEPLOY_ITEMS.cgturret.range!;
// Spray cadence — the wire pulse (DEPLOY_ITEMS.fireInterval) is the
// server's coarse damage tick; the mount itself spits ~7 bolts a second.
const FIRE_INTERVAL = 0.15;
const BOLT_SPEED = WEAPONS[WeaponType.Chaingun]!.speed;
const TURN_RATE = 5.5;      // rad/s — CG mounts track fast, it's their job
const AIM_TOL = 0.09;
const MUZZLE = new THREE.Vector3(0, 0, 1.5); // rotor face, head-local — XY comes from the live barrel angle
const BARREL_COUNT = 3;
const CLUSTER_R = 0.22;    // barrel circle radius — gatling, not a pipe pair
const BARREL_LEN = 1.5;
const SPIN_MAX = 18;       // rad/s rotor speed at full rate

const _metal = new THREE.MeshLambertMaterial({ color: 0x46_50_5C, emissive: 0x12_16_1C });
_metal.userData.__wearInt = 2.2;
const _dark = new THREE.MeshLambertMaterial({ color: 0x22_26_2C, emissive: 0x08_0A_0E });
_dark.userData.__wearInt = 2.2;
const _brass = new THREE.MeshLambertMaterial({ color: 0x8A_74_3C, emissive: 0x18_14_08 });
_brass.userData.__wearInt = 2.2;
const _glow = new THREE.MeshBasicMaterial({ color: 0xFF_AA_55 });
const _geoBase = new THREE.CylinderGeometry(0.8, 1.1, 0.6, 8);
const _geoMast = new THREE.CylinderGeometry(0.26, 0.36, 1.1, 6);
// Gatling head — fat tapered pipes on a collar bearing, brass axle down
// the middle, stubby receiver drum behind, ammo box slung underneath.
const _geoBarrel = new THREE.CylinderGeometry(0.085, 0.11, BARREL_LEN, 8);
const _geoThroat = new THREE.CylinderGeometry(0.11, 0.13, 0.14, 8);
const _geoCollar = new THREE.CylinderGeometry(0.34, 0.38, 0.18, 12);
const _geoAxle = new THREE.CylinderGeometry(0.07, 0.07, BARREL_LEN * 0.7, 8);
const _geoReceiver = new THREE.CylinderGeometry(0.4, 0.46, 1, 12);
const _geoAmmo = new THREE.CylinderGeometry(0.3, 0.3, 0.5, 10);
const _geoEye = new THREE.SphereGeometry(0.16, 6, 5);

const _v = new THREE.Vector3();
const _aim = new THREE.Vector3();

// All CG mounts share instanced part meshes — the ~14 real meshes per
// mount became ~14 draws each; instance matrices compose straight from
// group/head/rotor locals so slew, spin-up, and unfold need no walk.
const POOL_CAP = 128;
const _rx90 = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
const _rz90 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2));
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _receiverLocal = new THREE.Matrix4().compose(_p.set(0, 0, -0.3), _rx90, _s.set(1, 1, 1));
const _ammoLocal = new THREE.Matrix4().compose(_p.set(0, -0.25, -0.55), _rz90, _s.set(1, 1, 1));
const _eyeLocal = new THREE.Matrix4().compose(_p.set(0, 0.4, -0.1), new THREE.Quaternion(), _s.set(1, 1, 1));
const _collarLocal = new THREE.Matrix4().compose(_p.set(0, 0, 0), _rx90, _s.set(1, 1, 1));
const _axleLocal = new THREE.Matrix4().compose(_p.set(0, 0, 0.55), _rx90, _s.set(1, 1, 1));
const _barrelLocals: THREE.Matrix4[] = [];
const _throatLocals: THREE.Matrix4[] = [];
for (let i = 0; i < BARREL_COUNT; i += 1) {
  const a = (i / BARREL_COUNT) * Math.PI * 2;
  const dx = Math.cos(a) * CLUSTER_R, dy = Math.sin(a) * CLUSTER_R;
  _barrelLocals.push(new THREE.Matrix4().compose(_p.set(dx, dy, 0.5), _rx90, _s.set(1, 1, 1)));
  _throatLocals.push(new THREE.Matrix4().compose(_p.set(dx, dy, 0.5 + BARREL_LEN / 2 - 0.1), _rx90, _s.set(1, 1, 1)));
}

interface Pool {
  base: THREE.InstancedMesh; mast: THREE.InstancedMesh;
  receiver: THREE.InstancedMesh; ammo: THREE.InstancedMesh; eye: THREE.InstancedMesh;
  collar: THREE.InstancedMesh; axle: THREE.InstancedMesh;
  barrel: THREE.InstancedMesh; throat: THREE.InstancedMesh;
  free: number[];
}
let _pool: Pool | null = null;

function makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, count: number, scene: THREE.Scene): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, count);
  m.count = count;
  m.frustumCulled = false;
  m.castShadow = !(mat instanceof THREE.MeshBasicMaterial);
  for (let i = 0; i < count; i += 1) {m.setMatrixAt(i, _zero);}
  scene.add(m);
  return m;
}

function poolFor(scene: THREE.Scene): Pool {
  if (!_pool) {
    _pool = {
      base: makeInstanced(_geoBase, _dark, POOL_CAP, scene),
      mast: makeInstanced(_geoMast, _metal, POOL_CAP, scene),
      receiver: makeInstanced(_geoReceiver, _metal, POOL_CAP, scene),
      ammo: makeInstanced(_geoAmmo, _dark, POOL_CAP, scene),
      eye: makeInstanced(_geoEye, _glow, POOL_CAP, scene),
      collar: makeInstanced(_geoCollar, _dark, POOL_CAP, scene),
      axle: makeInstanced(_geoAxle, _brass, POOL_CAP, scene),
      barrel: makeInstanced(_geoBarrel, _metal, POOL_CAP * BARREL_COUNT, scene),
      throat: makeInstanced(_geoThroat, _brass, POOL_CAP * BARREL_COUNT, scene),
      free: [],
    };
    for (let i = POOL_CAP - 1; i >= 0; i -= 1) {_pool.free.push(i);}
  }
  return _pool;
}

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
  private rotor = new THREE.Group(); // the spinning barrel cluster
  private slot = -1;                 // instanced-pool index; -1 = overflow
  private flash: THREE.Sprite;
  private flashT = 0;
  private fireCd = DEPLOY_ITEMS.cgturret.armS!;
  private nextBarrel = 0;
  private spinV = 0;                 // rotor wind-up — fires at speed
  private idleSpin = Math.random() * Math.PI * 2;
  unfoldT = 0;

  constructor(scene: THREE.Scene, private terrain: Terrain, pos: THREE.Vector3) {
    this.id = nextTargetId();
    this.candId = `dep:${this.id}`;
    this.pos.copy(pos);
    const bg = terrain.getHeight(pos.x, pos.z);
    if (Number.isFinite(bg)) {this.pos.y = bg;}

    this.slot = poolFor(scene).free.pop() ?? -1;

    this.head.position.y = 1.25;
    // Rotor sits fully ahead of the head pivot — barrels end at z=0 so
    // pitching can never sweep them through the mast behind.
    this.rotor.position.z = 0.25;
    this.head.add(this.rotor);
    this.group.add(this.head);

    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(), color: 0xFF_EE_88, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.flash.scale.setScalar(0.7);
    this.flash.position.copy(MUZZLE);
    this.head.add(this.flash);

    this.group.position.copy(this.pos);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), terrain.getNormal(pos.x, pos.z));
    scene.add(this.group);
    this.syncMatrices();
  }

  /** Write this mount's instance slots from group/head/rotor transforms —
   *  the real meshes are pool-owned; the nodes only carry the slew/spin
   *  state and the flash sprite. */
  private syncMatrices(): void {
    if (this.slot < 0 || !_pool) {return;}
    const pool = _pool;
    const i = this.slot;
    const g = _m.compose(this.group.position, this.group.quaternion, this.group.scale).clone();
    const headM = _m2.compose(this.head.position, this.head.quaternion, _s.set(1, 1, 1)).premultiply(g).clone();
    const rotorM = _m3.compose(this.rotor.position, this.rotor.quaternion, _s.set(1, 1, 1)).premultiply(headM).clone();

    pool.base.setMatrixAt(i, _m3.makeTranslation(0, 0.22, 0).premultiply(g));
    pool.mast.setMatrixAt(i, _m3.makeTranslation(0, 0.75, 0).premultiply(g));
    pool.receiver.setMatrixAt(i, _m3.copy(_receiverLocal).premultiply(headM));
    pool.ammo.setMatrixAt(i, _m3.copy(_ammoLocal).premultiply(headM));
    pool.eye.setMatrixAt(i, _m3.copy(_eyeLocal).premultiply(headM));
    pool.collar.setMatrixAt(i, _m3.copy(_collarLocal).premultiply(rotorM));
    pool.axle.setMatrixAt(i, _m3.copy(_axleLocal).premultiply(rotorM));
    for (let b = 0; b < BARREL_COUNT; b += 1) {
      pool.barrel.setMatrixAt(i * BARREL_COUNT + b, _m3.copy(_barrelLocals[b]!).premultiply(rotorM));
      pool.throat.setMatrixAt(i * BARREL_COUNT + b, _m3.copy(_throatLocals[b]!).premultiply(rotorM));
    }

    for (const mesh of [pool.base, pool.mast, pool.receiver, pool.ammo, pool.eye, pool.collar, pool.axle, pool.barrel, pool.throat]) {
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Returns {muzzle, vel} when a bolt leaves a barrel — caller spawns
   *  the real CG Projectile (offline) or the wire paints the burst
   *  (connected). LOS-gated like the sentry: no spray through dirt. */
  update(dt: number, enemies: { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[]):
      { muzzle: THREE.Vector3; vel: THREE.Vector3 } | null {
    if (this.dead) {return null;}
    if (this.unfoldT < 1) { tickUnfold(this, dt); this.syncMatrices(); return null; }
    this.flashT -= dt;
    this.flash.material.opacity = Math.max(0, this.flashT / 0.06);
    this.flash.visible = this.flashT > 0; // opacity-0 sprites still cost a draw call
    this.fireCd -= dt;
    let best: (typeof enemies)[0] | null = null;
    let bestD2 = RANGE * RANGE;
    for (const e of enemies) {
      if (!e.alive) {continue;}
      const d2 = this.pos.distanceToSquared(e.pos);
      if (d2 < bestD2) { bestD2 = d2; best = e; }
    }
    // Rotor wind-up — spools while it has a target, spins down idle.
    this.spinV = Math.max(0, Math.min(SPIN_MAX, this.spinV + (best ? dt * 10 : -dt * 8)));
    this.rotor.rotation.z += this.spinV * dt;
    if (!best) { this.scan(dt); this.syncMatrices(); return null; }

    // Lead the runner — a real bolt has travel time, aim at where the
    // target will be, not where it is.
    const dist = Math.sqrt(bestD2);
    const flight = dist / BOLT_SPEED;
    const ax = best.pos.x + best.vel.x * flight;
    const ay = best.pos.y + 1 + best.vel.y * flight * 0.5;
    const az = best.pos.z + best.vel.z * flight;
    const aimed = this.slewTo(ax, ay, az, dt);
    if (this.fireCd > 0 || !aimed) { this.syncMatrices(); return null; }
    if (this.blockedTo(ax, ay, az)) { this.fireCd = 0.25; this.syncMatrices(); return null; }

    this.fireCd = FIRE_INTERVAL;
    this.flashT = 0.06;
    this.spinV = SPIN_MAX;
    // Bolt leaves the NEXT barrel on the spinning cluster — muzzle is the
    // live rotor angle, not a fixed side offset.
    const bi = this.nextBarrel;
    this.nextBarrel = (this.nextBarrel + 1) % BARREL_COUNT;
    const a = this.rotor.rotation.z + (bi / BARREL_COUNT) * Math.PI * 2;
    this.head.updateWorldMatrix(true, false);
    const muzzle = _v.set(Math.cos(a) * CLUSTER_R, Math.sin(a) * CLUSTER_R, MUZZLE.z)
      .applyMatrix4(this.head.matrixWorld).clone();
    const vel = new THREE.Vector3(ax - muzzle.x, ay - muzzle.y, az - muzzle.z)
      .normalize().multiplyScalar(BOLT_SPEED);
    this.syncMatrices();
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
    if (_pool && this.slot >= 0) {
      for (const mesh of [_pool.base, _pool.mast, _pool.receiver, _pool.ammo, _pool.eye, _pool.collar, _pool.axle]) {
        mesh.setMatrixAt(this.slot, _zero);
        mesh.instanceMatrix.needsUpdate = true;
      }
      for (let b = 0; b < BARREL_COUNT; b += 1) {
        _pool.barrel.setMatrixAt(this.slot * BARREL_COUNT + b, _zero);
        _pool.throat.setMatrixAt(this.slot * BARREL_COUNT + b, _zero);
      }
      _pool.barrel.instanceMatrix.needsUpdate = true;
      _pool.throat.instanceMatrix.needsUpdate = true;
      _pool.free.push(this.slot);
      this.slot = -1;
    }
    this.flash.material.dispose(); // per-instance SpriteMaterial
    // Shared geometries/materials intentionally not disposed — module-owned.
  }
}
