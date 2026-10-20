import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { tickUnfold, unfoldDone, damageDeploy } from './deployBody.js';
import type { Terrain } from '../world/terrain.js';

// Tether snare — a black gooey knot on the ground with tendrils lashing
// out. Reads as a trap, not a turret: low, dark, and always moving. The
// snare itself is server-judged (movement drag + energy zap); this is the
// visual contract only.

const _ink = new THREE.MeshLambertMaterial({ color: 0x14_0E_18 });
const _knot = new THREE.SphereGeometry(0.35, 8, 6);
const _tendril = new THREE.CylinderGeometry(0.03, 0.08, 1.2, 5);
_tendril.translate(0, 0.6, 0);
const TENDRILS = 7;

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
    const knot = new THREE.Mesh(_knot, _ink);
    knot.scale.y = 0.5;
    knot.position.y = 0.1;
    this.group.add(knot);
    for (let i = 0; i < TENDRILS; i += 1) {
      const a = (i / TENDRILS) * Math.PI * 2;
      const t = new THREE.Mesh(_tendril, _ink);
      t.position.set(Math.cos(a) * 0.25, 0.05, Math.sin(a) * 0.25);
      t.rotation.set(Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6);
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
      this.tendrils[i]!.scale.y = 1 + 0.15 * Math.sin(this.animT * 3 + i);
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
