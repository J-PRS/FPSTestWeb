import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import type { Terrain } from '../world/terrain.js';

// Targeting beacon pack — a thrown puck that plants a holo emitter. Its
// job is to be SEEN: the sky pillar and spinning diamond are the far-read,
// and the HUD solves the mortar arc onto it (deployables.ts). Same entity
// contract as the other deployables so pods/owner/blast treat it alike.

const _dark = new THREE.MeshLambertMaterial({ color: 0x1b2229 });
const _metal = new THREE.MeshLambertMaterial({ color: 0x39434e });
const _geoBase = new THREE.CylinderGeometry(0.3, 0.45, 0.16, 8);
const _geoMast = new THREE.CylinderGeometry(0.05, 0.08, 0.7, 6);
const _geoHolo = new THREE.OctahedronGeometry(0.16, 0);
const _holoMat = new THREE.MeshBasicMaterial({
  color: 0x7df9ff, transparent: true, opacity: 0.85,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
// Sky pillar — unit-height additive shaft anchored at the emitter base
// (translated so y=0 sits at the origin); update() stretches it to the
// lob apex so the beam literally reaches the aim arc.
const _geoPillar = new THREE.CylinderGeometry(0.18, 0.6, 1, 6, 1, true);
_geoPillar.translate(0, 0.5, 0);
const _UP = new THREE.Vector3(0, 1, 0);
const _pillarMat = new THREE.MeshBasicMaterial({
  color: 0x44ddee, transparent: true, opacity: 0.12,
  blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
});

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
  private holo: THREE.Mesh;
  private holoGlow: THREE.Sprite;
  private pillar: THREE.Mesh;
  // The shaft doubles as an aim pointer: the owner's beacon stretches it
  // to the lob apex so it visibly reaches toward the HUD reticle.
  private readonly aimDir = new THREE.Vector3(0, 1, 0);
  private aimLen = 40;
  private animT = Math.random() * 10;
  private unfoldT = 0;
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this.scene = scene;
    this.id = nextTargetId();
    this.candId = `dep:${this.id}`;
    this.pos.copy(pos);
    this.pos.y = terrain.getHeight(pos.x, pos.z);

    const base = new THREE.Mesh(_geoBase, _dark);
    base.position.y = 0.08;
    const mast = new THREE.Mesh(_geoMast, _metal);
    mast.position.y = 0.5;
    this.group.add(base, mast);

    this.holo = new THREE.Mesh(_geoHolo, _holoMat);
    this.holo.position.y = 1.0;
    this.group.add(this.holo);

    this.holoGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(), color: 0x7df9ff, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.holoGlow.scale.setScalar(0.8);
    this.holoGlow.position.y = 1.0;
    this.group.add(this.holoGlow);

    // The shaft is world-mounted (not in the slope-tilted group) so the
    // aim-pointer orientation isn't skewed by banked ground.
    this.pillar = new THREE.Mesh(_geoPillar, _pillarMat);
    this.pillar.position.copy(this.pos);
    // Nothing glows until touchdown — a lit shaft streaking through the
    // air reads as a trajectory bug, not a thrown device.
    this.pillar.visible = false;
    this.holo.visible = false;
    this.holoGlow.visible = false;
    scene.add(this.pillar);

    this.group.position.copy(this.pos);
    this.group.quaternion.setFromUnitVectors(_UP, terrain.getNormal(pos.x, pos.z));
    scene.add(this.group);
  }

  /** Stretch the sky shaft along a direction for a given length — the
   *  owner's beacon reaches it to the solved lob apex; defaults are a
   *  40m straight-up column. */
  setAim(dir: THREE.Vector3, len: number): void {
    this.aimDir.copy(dir).normalize();
    this.aimLen = len;
  }

  update(dt: number): void {
    if (this.dead) return;
    this.animT += dt;
    // The emitter's pos can move after construction (pod flight → touchdown);
    // the pillar tracks it here rather than at plant sites.
    this.pillar.position.copy(this.pos);
    this.pillar.quaternion.setFromUnitVectors(_UP, this.aimDir);
    this.pillar.scale.set(1, this.aimLen, 1);
    this.holo.rotation.y += dt * 3.0;
    this.holo.position.y = 1.0 + Math.sin(this.animT * 2.2) * 0.06;
    const pulse = 0.7 + Math.sin(this.animT * 4.0) * 0.3;
    this.holoGlow.material.opacity = 0.4 + pulse * 0.4;
    this.holoGlow.scale.setScalar(0.6 + pulse * 0.4);
    _pillarMat.opacity = 0.18 + pulse * 0.14;
  }

  tickUnfold(dt: number): void {
    if (this.unfoldT >= 1) return;
    this.unfoldT = Math.min(1, this.unfoldT + dt / 0.45);
    const k = this.unfoldT - 1;
    this.group.scale.setScalar(Math.max(0.08, 1 + 2.7 * k * k * k + 1.7 * k * k));
  }

  unfoldDone(): void {
    this.unfoldT = 1;
    this.group.scale.setScalar(1);
    this.pillar.visible = true;
    this.holo.visible = true;
    this.holoGlow.visible = true;
  }

  takeDamage(dmg: number): void {
    if (this.dead) return;
    const soak = Math.min(this.armor, dmg);
    this.armor -= soak;
    this.health -= dmg - soak;
    if (this.health <= 0) this.dead = true;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    scene.remove(this.pillar);
    this.holoGlow.material.dispose();
    void this.scene;
  }
}
