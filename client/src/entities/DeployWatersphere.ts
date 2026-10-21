import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { tickUnfold, unfoldDone, damageDeploy } from './deployBody.js';
import type { Terrain, FieldRing } from '../world/terrain.js';
import { DEPLOY_ITEMS } from '../../../shared/deployItems.js';
import { getGlowTexture } from '../effects/glowTexture.js';

// Watersphere — a pocket of sea planted on dry ground: a full translucent
// sphere centered on the seed, half-buried (DeployShield's trick — reads
// as water on any slope with no terrain-conforming mesh). The waterline
// is a shader-projected terrain decal (addFieldRing domeY mode) that
// traces the TRUE sphere∩terrain contour, so slopes get a lopsided
// shoreline instead of a floating torus. The slow is judged by the
// shared sim (waterDome) and the server; this is the visual contract.

const R = DEPLOY_ITEMS.watersphere.waterRadius ?? 7;
const _sphere = new THREE.SphereGeometry(R, 36, 24);
// Phong, not Lambert: the specular glint is the whole "wet" read — a
// matte dome is glass/plastic, a shiny one is liquid.
const _water = new THREE.MeshPhongMaterial({
  color: 0x1B_4E_79, specular: 0xAA_DD_FF, shininess: 90,
  transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide,
});
const _sheen = new THREE.SpriteMaterial({
  color: 0x9A_D0_FF, transparent: true, opacity: 0.5,
  map: getGlowTexture(64, 0.3, 0.7), blending: THREE.AdditiveBlending, depthWrite: false,
});
const _core = new THREE.SphereGeometry(0.4, 8, 6);
const _coreMat = new THREE.MeshLambertMaterial({ color: 0x18_38_55 });
// Waterline tint — pale sea-foam blue.
const SHORE_TINT: readonly [number, number, number] = [0.55, 0.82, 0.95];

export class DeployWatersphere {
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
  private readonly dome: THREE.Mesh;
  private readonly sheenTop: THREE.Sprite;
  private edge: FieldRing | null = null;
  private readonly terrain: Terrain;
  private animT = Math.random() * 10;

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this.id = nextTargetId();
    this.candId = `dep:${this.id}`;
    this.terrain = terrain;
    this.pos.copy(pos);
    const bg = terrain.getHeight(pos.x, pos.z);
    if (Number.isFinite(bg)) {this.pos.y = bg;}
    this.dome = new THREE.Mesh(_sphere, _water);
    this.group.add(this.dome);
    // The seed — a dark wet pebble at the sphere's heart, the destructible
    // bit the eye should find.
    const core = new THREE.Mesh(_core, _coreMat);
    core.position.y = 0.25;
    this.group.add(core);
    // Sun-glint on the dome crown — the "this is WATER" read at distance.
    this.sheenTop = new THREE.Sprite(_sheen);
    this.sheenTop.scale.setScalar(R * 1.6);
    this.sheenTop.position.y = R * 0.55;
    this.group.add(this.sheenTop);
    this.group.position.copy(this.pos);
    scene.add(this.group);

    // Shoreline decal — dome-contact slot: passes the sphere center's Y
    // so the terrain shader traces the true sphere∩terrain contour
    // (same slot system the shield dome uses; a draped ring can't follow
    // the clipmap's displaced surface).
    this.edge = terrain.addFieldRing(this.pos.x, this.pos.z, R, SHORE_TINT, this.pos.y);
  }

  update(dt: number): void {
    if (this.dead) {return;}
    this.animT += dt;
    // Breathing surface — water that sits perfectly still reads as glass.
    const w = Math.sin(this.animT * 1.7);
    this.dome.scale.set(1 + w * 0.015, 1 - w * 0.01, 1 + w * 0.015);
    _water.opacity = 0.28 + 0.05 * Math.sin(this.animT * 2.3);
    if (this.edge) {this.edge.intensity = 0.5 + Math.sin(this.animT * 2.1) * 0.12;}
  }

  tickUnfold(dt: number): void {
    tickUnfold(this, dt);
  }

  unfoldDone(): void {
    unfoldDone(this);
  }

  takeDamage(dmg: number): void {
    damageDeploy(this, dmg);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    if (this.edge) {
      this.terrain.removeFieldRing(this.edge);
      this.edge = null;
    }
  }
}
