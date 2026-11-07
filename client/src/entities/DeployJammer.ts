import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { tickUnfold, unfoldDone, healDeploy, damageDeploy } from './deployBody.js';
import type { Terrain, FieldRing } from '../world/terrain.js';
import { DEPLOY_ITEMS } from '../../../shared/deployItems.js';

// Jammer emitter - a short pylon whose bubble hides its side from pulse
// detection. The big faint ring IS the contract: it shows exactly which
// ground the bubble covers. Violet reads "electronic warfare" next to
// the pad's cyan and the sensor's amber.

const _metal = new THREE.MeshLambertMaterial({ color: 0x3A_34_4A });
const _dark = new THREE.MeshLambertMaterial({ color: 0x1A_16_24 });
const _glowMat = new THREE.SpriteMaterial({
  map: getGlowTexture(), color: 0xBB_88_FF, transparent: true,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
const _geoPost = new THREE.CylinderGeometry(0.16, 0.3, 1.5, 6);
const _geoHead = new THREE.SphereGeometry(0.34, 8, 6);
const _geoFin = new THREE.BoxGeometry(0.08, 0.5, 0.5);

export class DeployJammer {
  readonly id: number;
  readonly candId: string;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3(); // bolted down
  dead = false;
  health = DEPLOY_ITEMS.jammer.hp;
  maxHealth = DEPLOY_ITEMS.jammer.hp;
  armor = 0;

  readonly group = new THREE.Group();
  private glow: THREE.Sprite;
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

    const post = new THREE.Mesh(_geoPost, _dark);
    post.position.y = 0.75;
    this.group.add(post);
    const head = new THREE.Mesh(_geoHead, _metal);
    head.position.y = 1.6;
    this.group.add(head);
    for (let i = 0; i < 3; i += 1) {
      const fin = new THREE.Mesh(_geoFin, _metal);
      fin.rotation.y = (i / 3) * Math.PI * 2;
      fin.position.y = 1.1;
      this.group.add(fin);
    }
    this.glow = new THREE.Sprite(_glowMat.clone());
    this.glow.scale.setScalar(0.8);
    this.glow.position.y = 1.7;
    this.group.add(this.glow);

    this.group.position.copy(this.pos);
    scene.add(this.group);
  }

  seatNormal(_n: THREE.Vector3): void { /* upright pylon - no tilt */ }

  private buildRing(): void {
    this.ring = this.terrain.addFieldRing(this.pos.x, this.pos.z, DEPLOY_ITEMS.jammer.range!, [0.73, 0.53, 1]);
  }

  update(dt: number): void {
    if (this.dead) {return;}
    this.animT += dt;
    if (!this.armed && this.animT >= DEPLOY_ITEMS.jammer.armS!) {this.armed = true;}
    if (!this.ring) {this.buildRing();}
    const pulse = this.armed ? Math.sin(this.animT * 5) * 0.5 + 0.5 : 0;
    this.glow.material.opacity = this.armed ? 0.4 + pulse * 0.5 : 0.15;
    this.glow.scale.setScalar(0.7 + pulse * 0.4);
    this.ring!.intensity = this.armed ? 0.25 + pulse * 0.3 : 0.1;
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
