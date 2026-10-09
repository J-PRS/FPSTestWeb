import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { tickUnfold, unfoldDone, healDeploy, damageDeploy } from './deployBody.js';
import type { Terrain } from '../world/terrain.js';
import { DEPLOY_ITEMS } from '../../../shared/deployItems.js';

// Player-deployable sentry — the T2 base-economy seed. A tripod dome that
// hitscan-snaps to the nearest hostile (creature or enemy bot) inside its
// envelope. Real meshes, not swarm instances: counts are capped at a
// handful per player, so instancing buys nothing.
//
// It is deliberately NOT in entities.targets — your own rockets shouldn't
// detonate your own turret. Creatures break it through the speciesKit
// gnaw funnel (they commit to it like any candidate and chew it down).

const RANGE = DEPLOY_ITEMS.turret.range!;           // acquire envelope
const FIRE_INTERVAL = DEPLOY_ITEMS.turret.fireInterval!; // mini-rockets: heavier shots, longer beat
const TURN_RATE = 2.6;      // rad/s traverse — a real slew, not a snap
const AIM_TOL = 0.18;       // must be on-target within this to fire
const MUZZLE = new THREE.Vector3(0, 0.05, 0.95); // local to head pivot — tube mouth

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
// Rocket pod: a housing block with two fat launch tubes — the silhouette
// reads "missile sentry", not "pin gun".
const _geoPod = new THREE.BoxGeometry(0.5, 0.34, 0.72);
const _geoTube = new THREE.CylinderGeometry(0.15, 0.17, 1.1, 8);
const _geoEye = new THREE.SphereGeometry(0.09, 6, 5);

// All sentries share instanced part meshes: 8 draws per turret became 6
// InstancedMesh draws total once 16v16 deploy farms showed ~40 turrets a
// frame. Instance matrices are composed straight from group/head locals,
// so slew, recoil, and unfold need no scene-graph walk.
const POOL_CAP = 192;
const _rx90 = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

interface Pool {
  base: THREE.InstancedMesh;
  mast: THREE.InstancedMesh;
  dome: THREE.InstancedMesh;
  pod: THREE.InstancedMesh;
  tube: THREE.InstancedMesh;
  eye: THREE.InstancedMesh;
  free: number[];
}
let _pool: Pool | null = null;

function makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, count: number, scene: THREE.Scene): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, count);
  m.count = count;
  m.frustumCulled = false; // turrets span the map
  m.castShadow = false;
  for (let i = 0; i < count; i++) {m.setMatrixAt(i, _zero);}
  scene.add(m);
  return m;
}

function poolFor(scene: THREE.Scene): Pool {
  if (!_pool) {
    _pool = {
      base: makeInstanced(_geoBase, _dark, POOL_CAP, scene),
      mast: makeInstanced(_geoMast, _metal, POOL_CAP, scene),
      dome: makeInstanced(_geoDome, _metal, POOL_CAP, scene),
      pod: makeInstanced(_geoPod, _metal, POOL_CAP, scene),
      tube: makeInstanced(_geoTube, _dark, POOL_CAP * 2, scene),
      eye: makeInstanced(_geoEye, _glow, POOL_CAP, scene),
      free: [],
    };
    for (let i = POOL_CAP - 1; i >= 0; i--) {_pool.free.push(i);}
  }
  return _pool;
}

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
  // Repair-tool overheal — armor soaks hits before health does.
  armor = 0;

  readonly group = new THREE.Group();
  private head = new THREE.Group();
  private slot = -1;         // instanced-pool index; -1 = overflow (invisible)
  private tubeKick = [0, 0];   // per-tube recoil spring — alternate tubes per shot
  private nextTube = 0;
  private flash: THREE.Sprite;
  private flashT = 0;
  private fireCd = 0.6 + Math.random() * 0.4; // stagger multi-turret volleys
  private idleSpin = Math.random() * Math.PI * 2;
  // Unfold beat: the thrown pod carries a folded sentry that assembles
  // mid-air — group scales up with a back-ease overshoot, mast rises.
  // Firing is gated until it finishes.
  unfoldT = 0;

  constructor(scene: THREE.Scene, private terrain: Terrain, pos: THREE.Vector3) {
    this.id = nextTargetId();
    this.candId = `dep:${this.id}`;
    this.pos.copy(pos);
    this.pos.y = terrain.getHeight(pos.x, pos.z);

    this.slot = poolFor(scene).free.pop() ?? -1;
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
    this.syncMatrices();
  }

  /** Write this sentry's 7 instance slots from the group/head transforms
   *  (the real meshes are pool-owned; `group`/`head` only carry the flash
   *  sprite and muzzle math now). */
  private syncMatrices(): void {
    if (this.slot < 0 || !_pool) return;
    const pool = _pool;
    const i = this.slot;
    // G = terrain-aligned base transform (pos + tilt + unfold scale)
    const g = _m.compose(this.group.position, this.group.quaternion, this.group.scale).clone();
    const headM = _m2.compose(this.head.position, this.head.quaternion, _s.set(1, 1, 1)).premultiply(g).clone();

    pool.base.setMatrixAt(i, _m3.makeTranslation(0, 0.25, 0).premultiply(g));
    pool.mast.setMatrixAt(i, _m3.makeTranslation(0, 0.9, 0).premultiply(g));
    pool.dome.setMatrixAt(i, headM);
    pool.pod.setMatrixAt(i, _m3.makeTranslation(0, 0.08, 0.3).premultiply(headM));
    for (let t = 0; t < 2; t++) {
      const k = this.tubeKick[t]!;
      pool.tube.setMatrixAt(i * 2 + t, _m3.compose(
        _p.set(t === 0 ? -0.14 : 0.14, 0.08, 0.55 - k * 0.10),
        _rx90,
        _s.set(1, 1 - k * 0.22, 1),
      ).premultiply(headM));
    }
    pool.eye.setMatrixAt(i, _m3.makeTranslation(0, 0.3, 0.3).premultiply(headM));

    for (const mesh of [pool.base, pool.mast, pool.dome, pool.pod, pool.tube, pool.eye]) {
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Returns a shot {muzzle, target} when the fire cycle lands on a live
   * enemy in range — the caller owns the rocket body, steering, and the
   * blast. The target entry is handed back so the rocket can home on it.
   */
  update(dt: number, enemies: { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[]):
      { muzzle: THREE.Vector3; target: { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean } } | null {
    if (this.dead) return null;
    if (this.unfoldT < 1) { this.tickUnfold(dt); return null; } // still assembling
    this.flashT -= dt;
    this.flash.material.opacity = Math.max(0, this.flashT / 0.09);
    // Barrel recoil: each fired tube slides back AND shortens — the tail
    // must stay inside the pod housing (a knock-back that pokes through
    // the rear face reads as a bug, not a cannon). z-slide gives the
    // shove; y-scale (barrel axis, mesh rotated to +Z) hides the tail.
    for (let i = 0; i < 2; i++) {
      const k = this.tubeKick[i]!;
      if (k <= 0.001) continue;
      this.tubeKick[i] = k * Math.exp(-dt * 10);
    }
    const shot = this.stepFire(dt, enemies);
    this.syncMatrices();
    return shot;
  }

  private stepFire(dt: number, enemies: { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[]):
      { muzzle: THREE.Vector3; target: { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean } } | null {

    let best: (typeof enemies)[0] | null = null;
    let bestD2 = RANGE * RANGE;
    for (const e of enemies) {
      if (!e.alive) continue;
      const d2 = this.pos.distanceToSquared(e.pos);
      if (d2 < bestD2) { bestD2 = d2; best = e; }
    }

    // Rate-limited traverse — see slewTo for the rule. Only fires when
    // the head is actually on target: a fast jinker earns real dodge time.
    const aimed = best ? this.slewTo(best.pos, dt) : (this.scan(dt), false);

    this.fireCd -= dt;
    // No firing off-bore: a fast jinker earns real dodge time while the
    // head traverses. The cooldown keeps ticking so it's ready on target.
    if (!best || !aimed || this.fireCd > 0) return null;

    // LOS gate — a rocket is a straight-ish missile, not a mortar: when
    // the muzzle→target line runs into a hill, firing just detonates on
    // dirt. Hold fire and re-check soon; the head keeps tracking.
    if (this.blockedTo(best.pos)) { this.fireCd = 0.25; return null; }

    this.fireCd = FIRE_INTERVAL;
    this.flashT = 0.09;
    this.tubeKick[this.nextTube] = 1;
    this.nextTube ^= 1; // volleys alternate tubes

    // Launch point: the tube mouth in world space. MUZZLE is local to the
    // head pivot — go through its world matrix so the +1.4 mast height and
    // the group's terrain tilt are both in the transform. (The old path
    // rotated the offset but added `pos` at ground height — rockets
    // spawned at the tripod's feet and ate the terrain check instantly.)
    this.head.updateWorldMatrix(true, false);
    const muzzle = _v.copy(MUZZLE).applyMatrix4(this.head.matrixWorld).clone();
    return { muzzle, target: best };
  }

  /** Slew the head toward `pos` at TURN_RATE — a snapped sentry reads as
   *  a debug helper and gives the target no dodge window. Returns true
   *  when the head is within AIM_TOL of the bearing (fire gate). */
  private slewTo(pos: THREE.Vector3, dt: number): boolean {
    _aim.copy(pos).sub(this.pos);
    const yaw = Math.atan2(_aim.x, _aim.z);
    let dy = yaw - this.head.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const step = TURN_RATE * dt;
    this.head.rotation.y += Math.abs(dy) <= step ? dy : Math.sign(dy) * step;
    const pitch = THREE.MathUtils.clamp(-Math.atan2(_aim.y, Math.hypot(_aim.x, _aim.z)), -0.9, 0.5);
    const dp = pitch - this.head.rotation.x;
    this.head.rotation.x += Math.abs(dp) <= step ? dp : Math.sign(dp) * step;
    return Math.abs(dy) <= AIM_TOL && Math.abs(dp) <= AIM_TOL;
  }

  /** Muzzle→target line-of-sight: march the straight segment, comparing
   *  terrain height to the line. 8 samples is enough — ridges blocking
   *  a sentry stand meters tall, not sub-meter lips. Slight −0.15 bias
   *  so grass-blade bumps don't blind a legit shot. */
  private blockedTo(target: THREE.Vector3): boolean {
    this.head.updateWorldMatrix(true, false);
    _v.copy(MUZZLE).applyMatrix4(this.head.matrixWorld);
    for (let i = 1; i < 8; i++) {
      const t = i / 8;
      const x = _v.x + (target.x - _v.x) * t;
      const y = _v.y + (target.y - _v.y) * t;
      const z = _v.z + (target.z - _v.z) * t;
      if (this.terrain.getHeight(x, z) > y - 0.15) return true;
    }
    return false;
  }

  /** No target: idle scanning sweep, pitch drifting back to level. */
  private scan(dt: number): void {
    this.head.rotation.y = (this.idleSpin += dt * 0.6);
    this.head.rotation.x *= 1 - Math.min(1, dt * 4);
  }

  /** Advance the unfold anim. The throw pod drives this while airborne so
   *  the sentry lands already deployed — not springing up post-touchdown. */
  tickUnfold(dt: number): void {
    tickUnfold(this, dt);
    this.head.position.y = 0.6 + this.unfoldT * 0.8; // mast rises out of the base
    this.syncMatrices();
  }

  unfoldDone(): void {
    unfoldDone(this);
    this.head.position.y = 1.4;
  }

  /** Repair beam: heal refills health first, overflow banks as armor. */
  heal(n: number): void {
    healDeploy(this, n);
  }

  takeDamage(dmg: number): void {
    damageDeploy(this, dmg);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    if (_pool && this.slot >= 0) {
      for (const mesh of [_pool.base, _pool.mast, _pool.dome, _pool.pod, _pool.eye]) {
        mesh.setMatrixAt(this.slot, _zero);
        mesh.instanceMatrix.needsUpdate = true;
      }
      _pool.tube.setMatrixAt(this.slot * 2, _zero);
      _pool.tube.setMatrixAt(this.slot * 2 + 1, _zero);
      _pool.tube.instanceMatrix.needsUpdate = true;
      _pool.free.push(this.slot);
      this.slot = -1;
    }
    // Shared materials/geometries intentionally not disposed — module-owned.
    this.flash.material.dispose(); // per-instance SpriteMaterial
  }
}
