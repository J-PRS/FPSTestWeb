import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { tickUnfold, unfoldDone, healDeploy, damageDeploy } from './deployBody.js';
import type { Terrain, FieldRing } from '../world/terrain.js';
import { DEPLOY_ITEMS } from '../../../shared/deployItems.js';
import * as sfx from '../core/sfx.js';

// Player-deployable jump pad - a throw-down launch plate. Reads as a
// dish tilted to the surface normal: the geometry IS the instruction
// (the plate points where you'll fly). The ring decal marks the
// trigger footprint; the glow pulses once it's armed (the unfold beat
// finishes before the server's arm timer lets it fire - same clock).

const _metal = new THREE.MeshLambertMaterial({ color: 0x4A_55_62 });
const _dark = new THREE.MeshLambertMaterial({ color: 0x1C_22_29 });
const _geoDish = new THREE.CylinderGeometry(0.95, 1.15, 0.22, 8);
const _geoRib = new THREE.BoxGeometry(0.16, 0.1, 1.7);
const _geoPad = new THREE.BoxGeometry(1.5, 0.06, 1.5);

export class DeployPad {
  readonly id: number;
  readonly candId: string;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3(); // bolted down
  dead = false;
  health = DEPLOY_ITEMS.pad.hp;
  maxHealth = DEPLOY_ITEMS.pad.hp;
  armor = 0;

  readonly group = new THREE.Group();
  private glow: THREE.Sprite;
  private ring: FieldRing | null = null;
  private animT = 0;
  /** Discharge squash: 1 on boing, decays - the dish dips and re-cocks. */
  private squashT = 0;
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

    this.group.add(new THREE.Mesh(_geoDish, _dark));
    const pad = new THREE.Mesh(_geoPad, _metal);
    pad.position.y = 0.14;
    this.group.add(pad);
    for (let i = 0; i < 3; i += 1) {
      const rib = new THREE.Mesh(_geoRib, _dark);
      rib.rotation.y = (i / 3) * Math.PI * 2;
      rib.position.y = 0.2;
      this.group.add(rib);
    }
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(), color: 0xAA_DD_FF, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.glow.scale.setScalar(0.9);
    this.glow.position.y = 0.5;
    this.group.add(this.glow);

    this.group.position.copy(this.pos);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), terrain.getNormal(pos.x, pos.z));
    scene.add(this.group);
  }

  /** Trigger ring decal - bakes to the dirt on first armed tick. */
  private buildRing(): void {
    this.ring = this.terrain.addFieldRing(this.pos.x, this.pos.z, DEPLOY_ITEMS.pad.triggerDist!, [0.55, 0.8, 1]);
  }

  update(dt: number): void {
    if (this.dead) {return;}
    this.animT += dt;
    if (!this.armed && this.animT >= DEPLOY_ITEMS.pad.armS!) {
      this.armed = true;
      sfx.padArm(this.pos); // the armed state you can HEAR offscreen
    }
    if (!this.ring) {this.buildRing();}
    // Squash snap: the dish dips hard on the launch then re-cocks with
    // an overshoot - reads as the plate physically kicking the body.
    if (this.squashT > 0) {
      this.squashT = Math.max(0, this.squashT - dt * 3.2);
      const k = 1 - this.squashT;
      const dip = this.squashT > 0.7 ? 0.5 + 0.5 * (1 - this.squashT) / 0.3 : 1 + 0.16 * Math.sin(k * 9);
      this.group.scale.set(1, Math.min(1.16, dip), 1);
      this.glow.material.opacity = 0.9;
    } else {
      // Armed read: a slow breathing pulse - nobody reads a HUD line
      // for "pad live", the glow IS the state.
      const pulse = this.armed ? Math.sin(this.animT * 4) * 0.5 + 0.5 : 0;
      this.glow.material.opacity = 0.25 + pulse * 0.5;
      this.glow.scale.setScalar(0.8 + pulse * 0.5);
      this.ring!.intensity = this.armed ? 0.5 + pulse * 0.4 : 0.2;
    }
  }

  /** The launch fired - wire (padBoing) or the offline mirror calls it. */
  boing(): void { this.squashT = 1; }

  tickUnfold(dt: number): void {
    tickUnfold(this, dt);
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
    if (this.ring) { this.terrain.removeFieldRing(this.ring); this.ring = null; }
    this.glow.material.dispose();
  }
}
