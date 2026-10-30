import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { tickUnfold, unfoldDone, damageDeploy } from './deployBody.js';
import type { Terrain } from '../world/terrain.js';
import { getGlowTexture } from '../effects/glowTexture.js';

// Tether snare - a black gooey knot on the ground with tendrils lashing
// out. Reads as a trap, not a turret: low, dark, and always moving. The
// snare itself is server-judged (movement drag + energy zap); this is the
// visual contract only.

const _ink = new THREE.MeshLambertMaterial({ color: 0x14_0E_18 });
const _slick = new THREE.MeshBasicMaterial({ color: 0x0A_06_0E, transparent: true, opacity: 0.8, map: getGlowTexture(64, 0.55, 0.8), depthWrite: false });
const _puddle = new THREE.CircleGeometry(1.5, 24);
_puddle.rotateX(-Math.PI / 2);
const _knot = new THREE.SphereGeometry(0.55, 10, 6);
const _tendril = new THREE.CylinderGeometry(0.015, 0.09, 1.6, 5);
_tendril.translate(0, 0.8, 0);
const TENDRILS = 11;

// Instanced like the rest of the deployable family - 13 meshes per
// snare was the last big un-pooled draw bucket in the bastion census.
const POOL_CAP = 128;
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _e = new THREE.Euler();
const _yaw = new THREE.Quaternion();
const _layQ = new THREE.Quaternion();
const _X = new THREE.Vector3(1, 0, 0);

interface Pool {
  slick: THREE.InstancedMesh;
  knot: THREE.InstancedMesh;
  tendril: THREE.InstancedMesh;
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
      slick: makeInstanced(_puddle, _slick, POOL_CAP, scene),
      knot: makeInstanced(_knot, _ink, POOL_CAP, scene),
      tendril: makeInstanced(_tendril, _ink, POOL_CAP * TENDRILS, scene),
      free: [],
    };
    for (let i = POOL_CAP - 1; i >= 0; i -= 1) {_pool.free.push(i);}
  }
  return _pool;
}

export class DeployTether {
  readonly id: number;
  readonly candId: string;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  dead = false;
  health = 30;
  maxHealth = 30;
  armor = 0;
  unfoldT = 0;

  readonly group = new THREE.Group();
  private slot = -1;
  // Per-tendril local pose state - writhe animates `lay` each frame.
  private readonly tendrilA: number[] = [];
  private readonly tendrilLen: number[] = [];
  private readonly tendrilLay: number[] = [];
  private readonly tendrilR: number[] = [];
  private animT = Math.random() * 10;

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this.id = nextTargetId();
    this.candId = `dep:${this.id}`;
    this.pos.copy(pos);
    const bg = terrain.getHeight(pos.x, pos.z);
    if (Number.isFinite(bg)) {this.pos.y = bg;}

    this.slot = poolFor(scene).free.pop() ?? -1;
    // Tendrils lie near-flat, crawling out across the dirt - irregular
    // lengths, directions, and root offsets so the mass reads as spilled
    // goo, not a fan. A few rear up like feelers tasting the air.
    for (let i = 0; i < TENDRILS; i += 1) {
      const j1 = Math.sin(i * 12.9898) * 0.5 + 0.5; // deterministic spread
      const j2 = Math.sin(i * 78.233) * 0.5 + 0.5;
      const j3 = Math.sin(i * 39.425) * 0.5 + 0.5;
      this.tendrilA.push((i / TENDRILS) * Math.PI * 2 + j1 * 1.4);
      this.tendrilLen.push(0.5 + j2 * 0.9);
      // Most lie flat; every third rears up partway - the "searching" read.
      this.tendrilLay.push(i % 3 === 0 ? Math.PI / 2 - 0.7 - j3 * 0.4 : Math.PI / 2 - 0.06 - j3 * 0.3);
      this.tendrilR.push(j1 * 0.55); // roots sit anywhere on the slick
    }
    this.group.position.copy(this.pos);
    scene.add(this.group);
    this.syncMatrices();
  }

  /** Write slick/knot/tendril instance slots from group transform +
   *  per-tendril writhe state - meshes are pool-owned. */
  private syncMatrices(): void {
    if (this.slot < 0 || !_pool) {return;}
    const pool = _pool;
    const i = this.slot;
    const g = _m.compose(this.group.position, this.group.quaternion, this.group.scale).clone();

    pool.slick.setMatrixAt(i, _m2.makeTranslation(0, 0.015, 0).premultiply(g));
    pool.knot.setMatrixAt(i, _m2.compose(_p.set(0, 0.06, 0), _q.identity(), _s.set(1, 0.28, 1)).premultiply(g));
    for (let t = 0; t < TENDRILS; t += 1) {
      const a = this.tendrilA[t]!;
      // Original order: rotation.set(0,-a,0) then rotateX(lay) =
      // yaw-then-local-pitch = Q(yaw)*Q(lay).
      _yaw.setFromEuler(_e.set(0, -a, 0));
      _layQ.setFromAxisAngle(_X, this.tendrilLay[t]! + Math.sin(this.animT * 2.4 + t * 1.7) * 0.05);
      _q.copy(_yaw).multiply(_layQ);
      const r = this.tendrilR[t]!;
      pool.tendril.setMatrixAt(i * TENDRILS + t, _m2.compose(
        _p.set(Math.cos(a) * r, 0.02, Math.sin(a) * r),
        _q,
        _s.set(1, this.tendrilLen[t]!, 1),
      ).premultiply(g));
    }
    pool.slick.instanceMatrix.needsUpdate = true;
    pool.knot.instanceMatrix.needsUpdate = true;
    pool.tendril.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    if (this.dead) {return;}
    this.animT += dt;
    // Writhe: tips breathe up and down a few cm - the "alive" read is
    // applied on top of tendrilLay in syncMatrices.
    this.syncMatrices();
  }

  tickUnfold(dt: number): void {
    tickUnfold(this, dt);
    this.syncMatrices();
  }

  unfoldDone(): void {
    unfoldDone(this);
  }

  takeDamage(dmg: number): void {
    damageDeploy(this, dmg);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    if (_pool && this.slot >= 0) {
      _pool.slick.setMatrixAt(this.slot, _zero);
      _pool.knot.setMatrixAt(this.slot, _zero);
      for (let t = 0; t < TENDRILS; t += 1) {_pool.tendril.setMatrixAt(this.slot * TENDRILS + t, _zero);}
      _pool.slick.instanceMatrix.needsUpdate = true;
      _pool.knot.instanceMatrix.needsUpdate = true;
      _pool.tendril.instanceMatrix.needsUpdate = true;
      _pool.free.push(this.slot);
      this.slot = -1;
    }
    // Shared geometries/materials intentionally not disposed - module-owned.
  }
}
