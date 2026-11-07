import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { tickUnfold, unfoldDone, healDeploy, damageDeploy } from './deployBody.js';
import type { Terrain, FieldRing } from '../world/terrain.js';
import { DEPLOY_ITEMS } from '../../../shared/deployItems.js';

// Motion sensor - the deployable pack item. A stubby mast with a single
// amber eye; the faint ring marks its detection envelope. It reads
// MOVEMENT through cloak and terrain, so the honest read is "anything
// moving inside the ring is on your team's IFF" - standing still is
// the counter, same as the real thing.

const _metal = new THREE.MeshLambertMaterial({ color: 0x44_3A_28 });
const _dark = new THREE.MeshLambertMaterial({ color: 0x1E_1A_12 });
const _geoMast = new THREE.CylinderGeometry(0.1, 0.22, 1.7, 6);
const _geoEye = new THREE.SphereGeometry(0.3, 8, 6);
const _geoLeg = new THREE.BoxGeometry(0.08, 0.7, 0.08);

export class DeployMotion {
  readonly id: number;
  readonly candId: string;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3(); // bolted down
  dead = false;
  health = DEPLOY_ITEMS.motion.hp;
  maxHealth = DEPLOY_ITEMS.motion.hp;
  armor = 0;

  readonly group = new THREE.Group();
  private glow: THREE.Sprite;
  private eye: THREE.Mesh;
  private ring: FieldRing | null = null;
  private animT = 0;
  unfoldT = 0;
  armed = false;
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

    const mast = new THREE.Mesh(_geoMast, _dark);
    mast.position.y = 0.85;
    this.group.add(mast);
    for (let i = 0; i < 3; i += 1) {
      const leg = new THREE.Mesh(_geoLeg, _metal);
      leg.rotation.y = (i / 3) * Math.PI * 2;
      leg.position.set(Math.cos((i / 3) * Math.PI * 2) * 0.3, 0.3, Math.sin((i / 3) * Math.PI * 2) * 0.3);
      this.group.add(leg);
    }
    this.eye = new THREE.Mesh(_geoEye, _metal);
    this.eye.position.y = 1.85;
    this.group.add(this.eye);
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(), color: 0xFF_BB_44, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.glow.scale.setScalar(0.7);
    this.glow.position.y = 1.85;
    this.group.add(this.glow);

    this.group.position.copy(this.pos);
    scene.add(this.group);
  }

  seatNormal(_n: THREE.Vector3): void { /* upright mast - no tilt */ }

  private buildRing(): void {
    this.ring = this.terrain.addFieldRing(this.pos.x, this.pos.z, DEPLOY_ITEMS.motion.range!, [1, 0.73, 0.27]);
  }

  update(dt: number): void {
    if (this.dead) {return;}
    this.animT += dt;
    if (!this.armed && this.animT >= DEPLOY_ITEMS.motion.armS!) {this.armed = true;}
    if (!this.ring) {this.buildRing();}
    // The eye sweeps - a slow yaw reads "sensor" without any state wire.
    this.eye.rotation.y = this.animT * 1.4;
    const pulse = this.armed ? Math.sin(this.animT * 3.2) * 0.5 + 0.5 : 0;
    this.glow.material.opacity = this.armed ? 0.4 + pulse * 0.5 : 0.15;
    this.ring!.intensity = this.armed ? 0.2 + pulse * 0.25 : 0.08;
  }

  tickUnfold(dt: number): void { tickUnfold(this, dt); }
  unfoldDone(): void { unfoldDone(this); }
  heal(n: number): void { healDeploy(this, n); }
  takeDamage(dmg: number): void { damageDeploy(this, dmg); }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    if (this.ring) { this.terrain.removeFieldRing(this.ring); this.ring = null; }
    this.glow.material.dispose();
  }
}
