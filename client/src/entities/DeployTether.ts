import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { tickUnfold, unfoldDone, damageDeploy } from './deployBody.js';
import type { Terrain } from '../world/terrain.js';
import { getGlowTexture } from '../effects/glowTexture.js';

// Tether snare — a black gooey knot on the ground with tendrils lashing
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
  private readonly tendrils: THREE.Mesh[] = [];
  private animT = Math.random() * 10;

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this.id = nextTargetId();
    this.candId = `dep:${this.id}`;
    this.pos.copy(pos);
    const bg = terrain.getHeight(pos.x, pos.z);
    if (Number.isFinite(bg)) {this.pos.y = bg;}
    // The slick — a dark wet patch the whole mess sits in; sells "goo"
    // before any strand moves.
    const slick = new THREE.Mesh(_puddle, _slick);
    slick.position.y = 0.015;
    this.group.add(slick);
    const knot = new THREE.Mesh(_knot, _ink);
    knot.scale.y = 0.28;
    knot.position.y = 0.06;
    this.group.add(knot);
    // Tendrils lie near-flat, crawling out across the dirt — irregular
    // lengths, directions, and root offsets so the mass reads as spilled
    // goo, not a fan. A few rear up like feelers tasting the air.
    for (let i = 0; i < TENDRILS; i += 1) {
      const j1 = Math.sin(i * 12.9898) * 0.5 + 0.5; // deterministic spread
      const j2 = Math.sin(i * 78.233) * 0.5 + 0.5;
      const j3 = Math.sin(i * 39.425) * 0.5 + 0.5;
      const a = (i / TENDRILS) * Math.PI * 2 + j1 * 1.4;
      const t = new THREE.Mesh(_tendril, _ink);
      const len = 0.5 + j2 * 0.9;
      t.scale.set(1, len, 1);
      // Most lie flat; every third rears up partway — the "searching" read.
      const lay = i % 3 === 0 ? Math.PI / 2 - 0.7 - j3 * 0.4 : Math.PI / 2 - 0.06 - j3 * 0.3;
      t.rotation.set(0, -a, 0);
      t.rotateX(lay);
      t.userData.lay = t.rotation.x;
      // Roots sit anywhere on the slick, not all at the knot.
      const r = j1 * 0.55;
      t.position.set(Math.cos(a) * r, 0.02, Math.sin(a) * r);
      this.group.add(t);
      this.tendrils.push(t);
    }
    this.group.position.copy(this.pos);
    scene.add(this.group);
  }

  update(dt: number): void {
    if (this.dead) {return;}
    this.animT += dt;
    for (let i = 0; i < this.tendrils.length; i += 1) {
      const t = this.tendrils[i]!;
      // Writhe: tips breathe up and down a few cm — the "alive" read.
      t.rotation.x = t.userData.lay + Math.sin(this.animT * 2.4 + i * 1.7) * 0.05;
    }
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
  }
}
