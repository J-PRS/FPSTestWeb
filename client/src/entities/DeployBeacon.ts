import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { tickUnfold, unfoldDone, damageDeploy } from './deployBody.js';
import type { Terrain } from '../world/terrain.js';
import { makePartPool, takeSlot, releaseSlot, type PartPool } from './deployPool.js';

// Targeting beacon pack — a thrown puck that plants a holo emitter. Its
// job is to be SEEN: the sky pillar and spinning diamond are the far-read,
// and the HUD solves the mortar arc onto it (deployables.ts). Same entity
// contract as the other deployables so pods/owner/blast treat it alike.

const _dark = new THREE.MeshLambertMaterial({ color: 0x1B2229 });
const _metal = new THREE.MeshLambertMaterial({ color: 0x39434E });
const _geoBase = new THREE.CylinderGeometry(0.3, 0.45, 0.16, 8);
const _geoMast = new THREE.CylinderGeometry(0.05, 0.08, 0.7, 6);
const _geoHolo = new THREE.OctahedronGeometry(0.16, 0);
const _holoMat = new THREE.MeshBasicMaterial({
  color: 0x7DF9FF, transparent: true, opacity: 0.85,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
// Sky pillar — unit-height additive shaft anchored at the emitter base
// (translated so y=0 sits at the origin); update() stretches it to the
// lob apex so the beam literally reaches the aim arc.
const _geoPillar = new THREE.CylinderGeometry(0.18, 0.6, 1, 6, 1, true);
_geoPillar.translate(0, 0.5, 0);
const _UP = new THREE.Vector3(0, 1, 0);
const _pillarMat = new THREE.MeshBasicMaterial({
  color: 0x44DDEE, transparent: true, opacity: 0.12,
  blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
});

const POOL_CAP = 128;
interface BeaconPool { base: PartPool; mast: PartPool; holo: PartPool; pillar: PartPool; }
let _pool: BeaconPool | null = null;
function poolFor(scene: THREE.Scene): BeaconPool {
  if (!_pool) {
    _pool = {
      base: makePartPool(scene, _geoBase, _dark, POOL_CAP),
      mast: makePartPool(scene, _geoMast, _metal, POOL_CAP),
      holo: makePartPool(scene, _geoHolo, _holoMat, POOL_CAP),
      pillar: makePartPool(scene, _geoPillar, _pillarMat, POOL_CAP),
    };
  }
  return _pool;
}
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _hide = new THREE.Matrix4().makeScale(0, 0, 0);

export class DeployBeacon {
  readonly id: number;
  readonly candId: string;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  dead = false;
  health = 10;
  maxHealth = 10;
  armor = 0;

  readonly group = new THREE.Group();
  private slot = -1;
  private holoYaw = Math.random() * Math.PI * 2;
  private holoY = 1;
  private holoGlow: THREE.Sprite;
  private landed = false;
  // The shaft doubles as an aim pointer: the owner's beacon stretches it
  // to the lob apex so it visibly reaches toward the HUD reticle.
  private readonly aimDir = new THREE.Vector3(0, 1, 0);
  private aimLen = 40;
  private animT = Math.random() * 10;
  unfoldT = 0;


  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this.id = nextTargetId();
    this.candId = `dep:${this.id}`;
    this.pos.copy(pos);
    this.pos.y = terrain.getHeight(pos.x, pos.z);

    this.slot = takeSlot(poolFor(scene).base);

    this.holoGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(), color: 0x7DF9FF, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.holoGlow.scale.setScalar(0.8);
    this.holoGlow.position.y = 1;
    this.group.add(this.holoGlow);

    // Nothing glows until touchdown — a lit shaft streaking through the
    // air reads as a trajectory bug, not a thrown device.
    this.holoGlow.visible = false;

    this.group.position.copy(this.pos);
    this.group.quaternion.setFromUnitVectors(_UP, terrain.getNormal(pos.x, pos.z));
    scene.add(this.group);
    this.syncMatrices();
  }

  private syncMatrices(): void {
    if (this.slot < 0 || !_pool) return;
    const pool = _pool;
    const i = this.slot;
    const g = _m.compose(this.group.position, this.group.quaternion, this.group.scale).clone();
    pool.base.mesh.setMatrixAt(i, _m2.makeTranslation(0, 0.08, 0).premultiply(g));
    pool.base.mesh.instanceMatrix.needsUpdate = true;
    pool.mast.mesh.setMatrixAt(i, _m2.makeTranslation(0, 0.5, 0).premultiply(g));
    pool.mast.mesh.instanceMatrix.needsUpdate = true;
    if (this.landed) {
      _q.setFromAxisAngle(_UP, this.holoYaw);
      pool.holo.mesh.setMatrixAt(i, _m2.compose(_p.set(0, this.holoY, 0), _q, _s.set(1, 1, 1)).premultiply(g));
    } else {
      pool.holo.mesh.setMatrixAt(i, _hide);
    }
    pool.holo.mesh.instanceMatrix.needsUpdate = true;
    // The shaft is world-mounted (not in the slope-tilted group) so the
    // aim-pointer orientation isn't skewed by banked ground.
    if (this.landed) {
      _q.setFromUnitVectors(_UP, this.aimDir);
      pool.pillar.mesh.setMatrixAt(i, _m2.compose(this.pos, _q, _s.set(1, this.aimLen, 1)));
    } else {
      pool.pillar.mesh.setMatrixAt(i, _hide);
    }
    pool.pillar.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Stretch the sky shaft along a direction for a given length — the
   *  owner's beacon reaches it to the solved lob apex; defaults are a
   *  40m straight-up column. */
  setAim(dir: THREE.Vector3, len: number): void {
    this.aimDir.copy(dir).normalize();
    this.aimLen = len;
  }

  update(dt: number): void {
    if (this.dead) {return;}
    this.animT += dt;
    this.holoYaw += dt * 3;
    this.holoY = 1 + Math.sin(this.animT * 2.2) * 0.06;
    const pulse = 0.7 + Math.sin(this.animT * 4) * 0.3;
    this.holoGlow.material.opacity = 0.4 + pulse * 0.4;
    this.holoGlow.scale.setScalar(0.6 + pulse * 0.4);
    _pillarMat.opacity = 0.18 + pulse * 0.14;
    this.syncMatrices();
  }

  tickUnfold(dt: number): void {
    tickUnfold(this, dt);
    this.syncMatrices();
  }

  unfoldDone(): void {
    unfoldDone(this);
    this.landed = true;
    this.holoGlow.visible = true;
  }

  takeDamage(dmg: number): void {
    damageDeploy(this, dmg);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    if (_pool) {
      releaseSlot(_pool.base, this.slot);
      releaseSlot(_pool.mast, this.slot);
      releaseSlot(_pool.holo, this.slot);
      releaseSlot(_pool.pillar, this.slot);
      this.slot = -1;
    }
    this.holoGlow.material.dispose();
  }
}
