import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { markProbe } from '../core/fxDiag.js';
import { tickUnfold, unfoldDone, healDeploy, damageDeploy } from './deployBody.js';
import type { Terrain, FieldRing } from '../world/terrain.js';
import { DEPLOY_ITEMS } from '../../../shared/deployItems.js';
import { makePartPool, takeSlot, releaseSlot, ZERO_M4, type PartPool } from './deployPool.js';

// Player-deployable recharge pad — the T2 remote-inventory-station role:
// a field post you stand beside to refill health + energy. Destructible:
// the wildlife targets it like any deployable (dep:N candidate), so a pad
// you throw down buys you uptime, not safety — defend it or lose it.
// Real meshes, not swarm instances: capped at one per player anyway.

// Shared module resources — one pad per player doesn't justify instancing.
const _metal = new THREE.MeshLambertMaterial({ color: 0x3A_45_50 });
const _dark = new THREE.MeshLambertMaterial({ color: 0x1E_24_2B });
const _crystalMat = new THREE.MeshBasicMaterial({ color: 0x55_FF_CC });
const _geoBase = new THREE.CylinderGeometry(0.7, 0.95, 0.3, 8);
const _geoMast = new THREE.CylinderGeometry(0.1, 0.16, 1.1, 6);
const _geoCrystal = new THREE.OctahedronGeometry(0.32, 0);
const _geoStrut = new THREE.BoxGeometry(0.08, 0.7, 0.08);

const POOL_CAP = 128;
interface StationPool { base: PartPool; mast: PartPool; strut: PartPool; crystal: PartPool; }
let _pool: StationPool | null = null;
function poolFor(scene: THREE.Scene): StationPool {
  if (!_pool) {
    _pool = {
      base: makePartPool(scene, _geoBase, _dark, POOL_CAP),
      mast: makePartPool(scene, _geoMast, _metal, POOL_CAP),
      strut: makePartPool(scene, _geoStrut, _metal, POOL_CAP * 3),
      crystal: makePartPool(scene, _geoCrystal, _crystalMat, POOL_CAP),
    };
  }
  return _pool;
}
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

// The ground ring is a projected terrain-shader decal (Terrain.addFieldRing)
// — it conforms to the displaced surface by construction. A draped mesh
// can't: the clipmap renders 5m chords, so ANY denser grid drowns under
// terrain bumps between render verts. Same mechanism as scorch marks.

const MOTE_COUNT = 48;

export class DeployStation {
  readonly id: number;
  /** Species-candidate id — what a creature's threat table commits to. */
  readonly candId: string;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3(); // bolted down — gnaw knockback no-ops
  dead = false;
  health = 90;
  maxHealth = 90;
  armor = 0;

  readonly group = new THREE.Group();
  private crystal = new THREE.Group();
  private glow: THREE.Sprite;
  private slot = -1;
  // Envelope visuals: the ground ring is a terrain-shader decal slot,
  // dome + motes stay world-space meshes (a tilted parent would shear
  // them, so they never ride the normal-aligned group either).
  private ring: FieldRing | null = null;
  private dome: THREE.Mesh | null = null;
  private motes: THREE.Points | null = null;
  private moteData: { x: number; z: number; y: number; sp: number }[] = [];
  private animT = Math.random() * 10;
  unfoldT = 0;
  private scene: THREE.Scene;
  private terrain: Terrain;

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this.scene = scene;
    this.terrain = terrain;
    this.id = nextTargetId();
    this.candId = `dep:${this.id}`;
    this.pos.copy(pos);
    const bg = terrain.getHeight(pos.x, pos.z);
    if (Number.isFinite(bg)) {this.pos.y = bg;}

    this.slot = takeSlot(poolFor(scene).base);
    this.group.add(this.crystal);

    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(), color: 0x55_FF_CC, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.glow.scale.setScalar(1.4);
    this.glow.position.y = 1.55;
    this.group.add(this.glow);

    // Charge envelope (terrain-conforming decal + dome + heal motes) is
    // built lazily on the first update AFTER unfold — the thrown pod's
    // pos isn't the landing spot, and the decal bakes to dirt.

    this.group.position.copy(this.pos);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), terrain.getNormal(pos.x, pos.z));
    scene.add(this.group);
    this.syncMatrices();
  }

  private syncMatrices(): void {
    if (this.slot < 0 || !_pool) {return;}
    const pool = _pool;
    const i = this.slot;
    const g = _m.compose(this.group.position, this.group.quaternion, this.group.scale).clone();
    pool.base.mesh.setMatrixAt(i, _m2.makeTranslation(0, 0.15, 0).premultiply(g));
    pool.base.mesh.instanceMatrix.needsUpdate = true;
    pool.mast.mesh.setMatrixAt(i, _m2.makeTranslation(0, 0.75, 0).premultiply(g));
    pool.mast.mesh.instanceMatrix.needsUpdate = true;
    for (let s = 0; s < 3; s++) {
      const a = (s / 3) * Math.PI * 2;
      _q.setFromEuler(new THREE.Euler(Math.sin(a) * 0.5, 0, Math.cos(a) * -0.5));
      pool.strut.mesh.setMatrixAt(i * 3 + s, _m2.compose(
        _p.set(Math.cos(a) * 0.55, 0.28, Math.sin(a) * 0.55), _q, _s.set(1, 1, 1),
      ).premultiply(g));
    }
    pool.strut.mesh.instanceMatrix.needsUpdate = true;
    pool.crystal.mesh.setMatrixAt(i, _m2.compose(
      _p.set(0, this.crystal.position.y, 0),
      _q.setFromAxisAngle(_up, this.crystal.rotation.y),
      _s.set(1, 1, 1),
    ).premultiply(g));
    pool.crystal.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Recharge envelope — the aura ring is drawn at exactly this radius. */
  static readonly RANGE = DEPLOY_ITEMS.station.range!;
  /** Energy refill while in the envelope — 3× the ambient regen. */
  static readonly JET_RATE = 24;
  /** Health refill as a fraction of max per second (~11s to full). */
  static readonly HP_RATE = DEPLOY_ITEMS.station.healRate!;
  /** Pulse intensity 0..1 — drives the crystal spin speed + glow flare. */
  private charge = 0;

  /** Returns true while a player stands in the envelope — caller applies
   *  the actual refill (energy + health) so authority stays one place. */
  update(dt: number, playerPos: THREE.Vector3): boolean {
    if (this.dead) {return false;}
    this.animT += dt;
    const inRange = this.pos.distanceToSquared(playerPos) < DeployStation.RANGE * DeployStation.RANGE;
    this.charge += ((inRange ? 1 : 0) - this.charge) * Math.min(1, dt * 4);
    // Crystal: spin faster + flare while charging someone — the pad shows
    // its work, you don't need a HUD line to know it's live.
    this.crystal.rotation.y += dt * (1.2 + this.charge * 4);
    this.crystal.position.y = 1.55 + Math.sin(this.animT * 1.8) * 0.08;
    this.glow.material.opacity = 0.5 + this.charge * 0.5;
    this.glow.scale.setScalar(1.1 + this.charge * 0.7 + Math.sin(this.animT * 3) * 0.08);
    if (!this.ring) {this.buildEnvelope();}
    this.tickEnvelope(dt);
    this.syncMatrices();
    return inRange;
  }

  /** Ground ring as a shader-projected terrain decal — conforms exactly,
   *  zero mesh. Plus the dome bubble and rising heal motes. */
  private buildEnvelope(): void {
    const R = DeployStation.RANGE;
    this.ring = this.terrain.addFieldRing(this.pos.x, this.pos.z, R, [0.33, 1, 0.8]);

    // FULL sphere centered on the pad — a hemisphere dome planted at
    // pod height carves a bright rim through any slope it sits on. A
    // sphere buries its lower half evenly on every side, so the visible
    // cap conforms to ANY terrain with zero conforming logic.
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(R * 0.98, 28, 20),
      new THREE.MeshBasicMaterial({
        color: 0x44_EE_BB, transparent: true, opacity: 0.05,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
    this.dome.position.copy(this.pos);
    this.dome.renderOrder = 2;
    this.scene.add(this.dome);

    // Heal motes — a fixed Points cloud drifting up inside the dome.
    const pts = new Float32Array(MOTE_COUNT * 3);
    this.moteData.length = 0;
    for (let i = 0; i < MOTE_COUNT; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * R * 0.9;
      const x = this.pos.x + Math.cos(a) * r;
      const z = this.pos.z + Math.sin(a) * r;
      const y = this.terrain.getHeight(x, z) + Math.random() * 2.4;
      this.moteData.push({ x, z, y, sp: 0.5 + Math.random() * 0.8 });
      pts.set([x, y, z], i * 3);
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    this.motes = new THREE.Points(mg, new THREE.PointsMaterial({
      map: getGlowTexture(), color: 0x77_FF_CC, size: 0.22, transparent: true,
      opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false,
      sizeAttenuation: true,
    }));
    this.motes.renderOrder = 3;
    this.scene.add(this.motes);
    markProbe(this.motes, { kind: 'fxMesh', label: 'stationMotes' });
  }

  private tickEnvelope(dt: number): void {
    const pulse = Math.sin(this.animT * 2.4) * 0.5 + 0.5;
    this.ring!.intensity = 0.45 + this.charge * 0.4 + pulse * 0.1;
    (this.dome!.material as THREE.MeshBasicMaterial).opacity = 0.035 + this.charge * 0.06 + pulse * 0.015;
    const attr = this.motes!.geometry.getAttribute('position') as THREE.BufferAttribute;
    const lift = 1 + this.charge * 1.6; // motes race while someone's charging
    for (let i = 0; i < MOTE_COUNT; i++) {
      const m = this.moteData[i]!;
      m.y += m.sp * lift * dt;
      const ground = this.terrain.getHeight(m.x, m.z);
      if (m.y > ground + 3.2) {m.y = ground + 0.1;} // respawn at the dirt
      attr.setXYZ(i, m.x, m.y, m.z);
    }
    attr.needsUpdate = true;
    (this.motes!.material as THREE.PointsMaterial).opacity = 0.4 + this.charge * 0.45;
  }

  /** Unfold beat while the thrown pod is airborne — same contract as
   *  DeployTurret so the pod path can treat them identically. */
  tickUnfold(dt: number): void {
    tickUnfold(this, dt);
    this.syncMatrices();
  }

  unfoldDone(): void {
    unfoldDone(this);
  }

  heal(n: number): void {
    healDeploy(this, n);
  }

  takeDamage(dmg: number): void {
    damageDeploy(this, dmg);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    if (_pool) {
      releaseSlot(_pool.base, this.slot);
      releaseSlot(_pool.mast, this.slot);
      releaseSlot(_pool.crystal, this.slot);
      for (let s = 0; s < 3; s++) {
        _pool.strut.mesh.setMatrixAt(this.slot * 3 + s, ZERO_M4);
      }
      _pool.strut.mesh.instanceMatrix.needsUpdate = true;
      _pool.strut.free.push(this.slot);
      this.slot = -1;
    }
    // Shared materials/geometries intentionally not disposed — module-owned.
    this.glow.material.dispose();
    // The ring slot is a terrain-uniform lease — release it or the decal
    // outlives the pad.
    if (this.ring) { this.terrain.removeFieldRing(this.ring); this.ring = null; }
    // Envelope pieces are per-instance (baked to THIS landing spot).
    for (const o of [this.dome, this.motes]) {
      if (!o) {continue;}
      this.scene.remove(o);
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }
}
