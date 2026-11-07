import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { tickUnfold, unfoldDone, healDeploy, damageDeploy } from './deployBody.js';
import type { Terrain } from '../world/terrain.js';
import { DEPLOY_ITEMS } from '../../../shared/deployItems.js';
import * as sfx from '../core/sfx.js';

// Spider mine - the ground-bound loiter. A low dome on stilt legs that
// scuttles toward GROUNDED hostiles and detonates in reach. Air is the
// counter: its trigger only fires on feet near the dirt, so a jetting
// or falling body sails over it untouched.

const _shell = new THREE.MeshLambertMaterial({ color: 0x3A_2E_22 });
const _legMat = new THREE.MeshLambertMaterial({ color: 0x16_12_0C });
const _geoBody = new THREE.SphereGeometry(0.32, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.6);
const _geoLeg = new THREE.BoxGeometry(0.06, 0.45, 0.06);

export class DeploySpider {
  readonly id: number;
  readonly candId: string;
  readonly pos: THREE.Vector3;
  readonly group = new THREE.Group();
  private legs: THREE.Mesh[] = [];
  private glow: THREE.Sprite;
  private animT = 0;
  unfoldT = 0;
  armed = false;
  private scene: THREE.Scene;
  private terrain: Terrain;
  /** Fires once on detonation commit - the adopter paints the blast. */
  detonated = false;

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this.id = nextTargetId();
    this.candId = `dep:${this.id}`;
    this.scene = scene;
    this.terrain = terrain;
    this.pos = pos.clone();
    const bg = terrain.getHeight(pos.x, pos.z);
    if (Number.isFinite(bg)) {this.pos.y = bg;}

    const body = new THREE.Mesh(_geoBody, _shell);
    body.position.y = 0.3;
    body.castShadow = true;
    this.group.add(body);
    for (let i = 0; i < 4; i += 1) {
      const leg = new THREE.Mesh(_geoLeg, _legMat);
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      leg.position.set(Math.cos(a) * 0.28, 0.22, Math.sin(a) * 0.28);
      leg.rotation.z = Math.cos(a) * 0.5;
      leg.rotation.x = -Math.sin(a) * 0.5;
      this.legs.push(leg);
      this.group.add(leg);
    }
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(32), color: 0xFF_44_22, transparent: true,
      opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.glow.position.y = 0.45;
    this.glow.scale.setScalar(0.4);
    this.group.add(this.glow);

    this.group.position.copy(this.pos);
    scene.add(this.group);
  }

  private readonly _aim = new THREE.Vector3();
  /** Scuttle tick - chases the nearest GROUNDED foe in the ring (feet
   *  within ~3m of the surface; airborne bodies don't exist to it).
   *  Returns true on detonation commit - the caller owns the blast. */
  update(dt: number, foes?: { pos: THREE.Vector3; alive: boolean }[]): boolean {
    if (this.dead || this.detonated) {return false;}
    this.animT += dt;
    if (!this.armed && this.animT >= DEPLOY_ITEMS.loiter.armS!) {
      this.armed = true;
      sfx.padArm(this.pos);
    }
    const def = DEPLOY_ITEMS.spider;
    // The surface under the spider - it crawls, not hovers.
    const bg = this.terrain.getHeight(this.pos.x, this.pos.z);
    if (Number.isFinite(bg)) {this.pos.y = bg;}
    const pulse = this.armed ? Math.sin(this.animT * 6) * 0.5 + 0.5 : 0;
    this.glow.material.opacity = 0.25 + pulse * 0.55;

    let hunting = false;
    if (foes && this.armed) {
      const tr = def.triggerDist!;
      let best = tr * tr, fp: THREE.Vector3 | null = null;
      for (const f of foes) {
        if (!f.alive) {continue;}
        // GROUNDED only - a flying body never trips it. Cheap read:
        // feet within ~3m of the surface the spider crawls on.
        const fg = this.terrain.getHeight(f.pos.x, f.pos.z);
        if (Number.isFinite(fg) && f.pos.y - fg > 3) {continue;}
        const dx = f.pos.x - this.pos.x, dy = f.pos.y - this.pos.y, dz = f.pos.z - this.pos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best) { best = d2; fp = f.pos; }
      }
      if (fp) {
        hunting = true;
        const dx = fp.x - this.pos.x, dz = fp.z - this.pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 1e-4) {
          const step = Math.min(def.launchSpeed! * dt, dist);
          this.pos.x += dx / dist * step;
          this.pos.z += dz / dist * step;
          this.group.rotation.y = Math.atan2(dx, dz); // face the chase
        }
        const dy = fp.y - this.pos.y;
        if (dist < 1.8 && Math.abs(dy) < 2.5) {
          this.detonated = true;
          return true; // caller paints the blast + spends the item
        }
      }
    }
    // Scuttle gait: legs jitter in a gallop while hunting, idle sway off.
    const gait = hunting ? this.animT * 26 : this.animT * 2;
    for (let i = 0; i < this.legs.length; i += 1) {
      this.legs[i]!.position.y = 0.22 + Math.abs(Math.sin(gait + i * Math.PI / 2)) * (hunting ? 0.09 : 0.02);
    }
    this.group.position.copy(this.pos);
    return false;
  }

  tickUnfold(dt: number): void {
    tickUnfold(this, dt);
  }

  unfoldDone(): void { unfoldDone(this); }

  get dead(): boolean { return this.health <= 0; }
  health = DEPLOY_ITEMS.spider.hp;
  armor = 0;
  maxHealth = DEPLOY_ITEMS.spider.hp;
  takeDamage(dmg: number): void { damageDeploy(this, dmg); }
  heal(dmg: number): void { healDeploy(this, dmg); }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.glow.material.dispose();
  }
}
