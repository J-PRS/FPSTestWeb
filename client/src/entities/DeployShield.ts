import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { tickUnfold, unfoldDone, healDeploy, damageDeploy } from './deployBody.js';
import { makeShieldedMesh, type ShieldBubble } from '../effects/shieldBubble.js';
import type { Terrain, FieldRing } from '../world/terrain.js';
import { makePartPool, takeSlot, releaseSlot, ZERO_M4, type PartPool } from './deployPool.js';

// Barrier dome pack — plants a field emitter that projects a hex-lattice
// energy dome. Hostile shells detonate on the face; friendly fire passes
// through. The counterplay is Tribes-canonical: the emitter takes blast
// damage like any deployable, so shelling the dome cracks the field.
// Same entity contract as DeployStation/DeployTurret (unfold, vitals,
// dep: candidate id) so the pod/owner/blast plumbing treats it alike.

const _metal = new THREE.MeshLambertMaterial({ color: 0x39_43_4E });
const _dark = new THREE.MeshLambertMaterial({ color: 0x1B_22_29 });
const _tipMat = new THREE.MeshBasicMaterial({ color: 0x66_CC_FF });
const _geoBase = new THREE.CylinderGeometry(0.55, 0.8, 0.28, 8);
const _geoMast = new THREE.CylinderGeometry(0.09, 0.14, 1.3, 6);
const _geoTip = new THREE.OctahedronGeometry(0.22, 0);
const _geoStrut = new THREE.BoxGeometry(0.08, 0.6, 0.08);

const POOL_CAP = 128;
interface ShieldPool { base: PartPool; mast: PartPool; strut: PartPool; tip: PartPool; }
let _pool: ShieldPool | null = null;
function poolFor(scene: THREE.Scene): ShieldPool {
  if (!_pool) {
    _pool = {
      base: makePartPool(scene, _geoBase, _dark, POOL_CAP),
      mast: makePartPool(scene, _geoMast, _metal, POOL_CAP),
      strut: makePartPool(scene, _geoStrut, _metal, POOL_CAP * 3),
      tip: makePartPool(scene, _geoTip, _tipMat, POOL_CAP),
    };
  }
  return _pool;
}
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();

// Field-edge contact — a shader-projected terrain decal (same slot
// system the station pad uses). The ring is drawn IN the terrain's own
// fragment shader, so it conforms to the displaced clipmap surface
// exactly — a draped mesh can only approximate it between the 5m
// chords, which is what clipped into bumps before.

export class DeployShield {
  readonly id: number;
  readonly candId: string;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  dead = false;
  health = 120;
  maxHealth = 120;
  armor = 0;

  readonly group = new THREE.Group();
  private tipGlow: THREE.Sprite;
  private tip = new THREE.Group();
  private slot = -1;
  private anchor: THREE.Group | null = null; // world-space dome mount (built post-land)
  private dome: ShieldBubble | null = null;
  private edge: FieldRing | null = null;
  private animT = Math.random() * 10;
  unfoldT = 0;
  private placed = false;
  private scene: THREE.Scene;
  private terrain: Terrain;

  /** Projectile-blocking radius — the dome visual matches exactly, so
   *  shells pop the moment they touch the visible lattice. */
  static readonly RADIUS = 6;

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this.scene = scene;
    this.terrain = terrain;
    this.id = nextTargetId();
    this.candId = `dep:${this.id}`;
    this.pos.copy(pos);
    const bg = terrain.getHeight(pos.x, pos.z);
    if (Number.isFinite(bg)) {this.pos.y = bg;}

    this.slot = takeSlot(poolFor(scene).base);
    this.tip.position.y = 1.55;
    this.group.add(this.tip);
    this.tipGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(), color: 0x66_CC_FF, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.tipGlow.scale.setScalar(1.1);
    this.tipGlow.position.y = 1.55;
    this.group.add(this.tipGlow);

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
    pool.base.mesh.setMatrixAt(i, _m2.makeTranslation(0, 0.14, 0).premultiply(g));
    pool.base.mesh.instanceMatrix.needsUpdate = true;
    pool.mast.mesh.setMatrixAt(i, _m2.makeTranslation(0, 0.8, 0).premultiply(g));
    pool.mast.mesh.instanceMatrix.needsUpdate = true;
    for (let s = 0; s < 3; s++) {
      const a = (s / 3) * Math.PI * 2;
      _q.setFromEuler(new THREE.Euler(Math.sin(a) * 0.5, 0, Math.cos(a) * -0.5));
      pool.strut.mesh.setMatrixAt(i * 3 + s, _m2.compose(
        _p.set(Math.cos(a) * 0.48, 0.24, Math.sin(a) * 0.48), _q, _s.set(1, 1, 1),
      ).premultiply(g));
    }
    pool.strut.mesh.instanceMatrix.needsUpdate = true;
    const tipM = _m2.compose(this.tip.position, this.tip.quaternion, _s.set(1, 1, 1)).premultiply(g);
    pool.tip.mesh.setMatrixAt(i, tipM);
    pool.tip.mesh.instanceMatrix.needsUpdate = true;
  }

  /** The dome only exists once the emitter lands — a sphere centered on
   *  the pad, half-buried, reads as a dome on any slope without any
   *  terrain-conforming logic (same trick as DeployStation's field). */
  private buildDome(): void {
    this.anchor = new THREE.Group();
    this.anchor.position.copy(this.pos);
    this.scene.add(this.anchor);
    this.dome = makeShieldedMesh(this.anchor, new THREE.SphereGeometry(DeployShield.RADIUS * 0.99, 36, 24), 0x66_CC_EE);
    this.dome.mesh.visible = true;

    // Ground contact glow — dome-contact slot: passes the sphere's
    // center height so the shader traces the TRUE sphere∩terrain
    // contour (a circle only on flat ground — uphill it bites in,
    // downhill it runs wide, exactly where the shell pierces dirt).
    this.edge = this.terrain.addFieldRing(this.pos.x, this.pos.z, DeployShield.RADIUS, [0.4, 0.8, 0.93], this.pos.y);
  }

  /** A hostile shell touched the field — flare the lattice. */
  flash(): void { this.dome?.flash(); }

  update(dt: number): void {
    if (this.dead) {return;}
    this.animT += dt;
    if (this.placed && !this.dome) {this.buildDome();}
    this.dome?.update(dt);
    if (this.edge) {
      this.edge.intensity = 0.5 + Math.sin(this.animT * 2.6) * 0.12;
    }
    // Tip idles a slow spin + glow pulse — the emitter shows it's live.
    this.tip.rotation.y += dt * 2.4;
    const pulse = 0.85 + Math.sin(this.animT * 3.2) * 0.15;
    this.tipGlow.material.opacity = 0.5 + pulse * 0.4;
    this.tipGlow.scale.setScalar(0.9 + pulse * 0.35);
    this.syncMatrices();
  }

  tickUnfold(dt: number): void {
    tickUnfold(this, dt);
    this.syncMatrices();
  }

  unfoldDone(): void {
    unfoldDone(this);
    this.placed = true;
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
      releaseSlot(_pool.tip, this.slot);
      for (let s = 0; s < 3; s++) {
        _pool.strut.mesh.setMatrixAt(this.slot * 3 + s, ZERO_M4);
      }
      _pool.strut.mesh.instanceMatrix.needsUpdate = true;
      _pool.strut.free.push(this.slot);
      this.slot = -1;
    }
    this.tipGlow.material.dispose();
    // Dome + anchor + ring slot are per-instance, baked to THIS landing spot.
    this.dome?.dispose();
    if (this.anchor) {this.scene.remove(this.anchor);}
    if (this.edge) {
      this.terrain.removeFieldRing(this.edge);
      this.edge = null;
    }
  }
}
