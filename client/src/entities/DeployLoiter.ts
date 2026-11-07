import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { tickUnfold, unfoldDone, healDeploy, damageDeploy } from './deployBody.js';
import type { Terrain, FieldRing } from '../world/terrain.js';
import { DEPLOY_ITEMS } from '../../../shared/deployItems.js';
import * as sfx from '../core/sfx.js';

// Loiter munition - a throw-down kamikaze dart. The pod lands, pops to
// a hover above the plant spot, and circles until a hostile enters the
// dive ring; then it dives and detonates on contact. The dart's spin +
// bob IS the armed read; the ring decal is the dive envelope.

const _metal = new THREE.MeshLambertMaterial({ color: 0x5A_4E_3A });
const _dark = new THREE.MeshLambertMaterial({ color: 0x1E_1A_14 });
const _geoHull = new THREE.ConeGeometry(0.22, 0.9, 6);
const _geoRing = new THREE.TorusGeometry(0.42, 0.05, 6, 10);
const _geoFin = new THREE.BoxGeometry(0.08, 0.3, 0.5);

export class DeployLoiter {
  readonly id: number;
  readonly candId: string;
  readonly pos: THREE.Vector3;
  readonly group = new THREE.Group();
  private dart = new THREE.Group();
  private glow: THREE.Sprite;
  private ring: FieldRing | null = null;
  private animT = 0;
  unfoldT = 0;
  armed = false;
  /** Dive state set by dive() - the dart leaves the hover for the wire line. */
  private diving: { p: THREE.Vector3; vel: THREE.Vector3 } | null = null;
  private scene: THREE.Scene;
  private terrain: Terrain;

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this.id = nextTargetId();
    this.candId = `dep:${this.id}`;
    this.scene = scene;
    this.terrain = terrain;
    this.pos = pos.clone();
    const bg = terrain.getHeight(pos.x, pos.z);
    if (Number.isFinite(bg)) {this.pos.y = bg;}

    const hull = new THREE.Mesh(_geoHull, _metal);
    hull.rotation.x = Math.PI; // nose DOWN - reads "munition waiting to drop"
    hull.castShadow = true;
    this.dart.add(hull);
    const rotor = new THREE.Mesh(_geoRing, _dark);
    rotor.rotation.x = Math.PI / 2;
    rotor.position.y = 0.35;
    this.dart.add(rotor);
    for (let i = 0; i < 3; i += 1) {
      const fin = new THREE.Mesh(_geoFin, _metal);
      const a = i * (Math.PI * 2 / 3);
      fin.position.set(Math.cos(a) * 0.22, -0.3, Math.sin(a) * 0.22);
      fin.rotation.y = -a;
      this.dart.add(fin);
    }
    this.group.add(this.dart);

    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(64), color: 0xFF_66_33, transparent: true,
      opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.glow.scale.setScalar(0.7);
    this.dart.add(this.glow);

    this.group.position.copy(this.pos);
    scene.add(this.group);
  }

  /** The dive ring - the footprint where a hostile commits the dive. */
  private buildRing(): void {
    this.ring = this.terrain.addFieldRing(this.pos.x, this.pos.z, DEPLOY_ITEMS.loiter.triggerDist!, [1, 0.5, 0.2]);
  }

  private readonly _hover = new THREE.Vector3();
  /** Point the dart loiters at / dives from - pos + hoverUp. */
  hoverPos(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.pos).setY(this.pos.y + DEPLOY_ITEMS.loiter.hoverUp!);
  }

  /** Offline scan - nearest foe inside the dive ring commits. Returns
   *  the dive line ({hover, vel}) once, then the item is spent. */
  update(dt: number, foes?: { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[]): { hover: THREE.Vector3; vel: THREE.Vector3 } | null {
    if (this.dead) {return null;}
    this.animT += dt;
    if (!this.armed && this.animT >= DEPLOY_ITEMS.loiter.armS!) {
      this.armed = true;
      sfx.padArm(this.pos); // same "it's live" chirp the pad uses
    }
    if (!this.ring) {this.buildRing();}
    // Rotor spins always; armed adds a fast wobble-bob so "live" reads
    // from across the field without a HUD line.
    this.dart.rotation.y += dt * (this.armed ? 9 : 3);
    if (this.diving) {
      this.diving.p.addScaledVector(this.diving.vel, dt);
      this.group.position.copy(this.diving.p);
      return null;
    }
    this.hoverPos(this._hover);
    this._hover.y += Math.sin(this.animT * 2.2 + this.id) * (this.armed ? 0.5 : 0.15);
    this.group.position.copy(this._hover);
    const pulse = this.armed ? Math.sin(this.animT * 5) * 0.5 + 0.5 : 0;
    this.glow.material.opacity = 0.3 + pulse * 0.6;
    this.ring!.intensity = this.armed ? 0.45 + pulse * 0.3 : 0.15;

    if (!foes || !this.armed) {return null;}
    const def = DEPLOY_ITEMS.loiter;
    const tr = def.triggerDist!;
    let best = tr * tr, fp: THREE.Vector3 | null = null, fv: THREE.Vector3 | null = null;
    for (const f of foes) {
      if (!f.alive) {continue;}
      const dx = f.pos.x - this._hover.x, dy = f.pos.y - this._hover.y, dz = f.pos.z - this._hover.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) { best = d2; fp = f.pos; fv = f.vel; }
    }
    if (!fp || !fv) {return null;}
    // Lead the runner like the server's solve - the dart commits to a
    // straight powered line; the projectile carries the honest blast.
    const sp = def.launchSpeed!;
    const flight = Math.sqrt(best) / sp;
    const aim = new THREE.Vector3(fp.x + fv.x * flight, fp.y + fv.y * flight, fp.z + fv.z * flight);
    const vel = aim.sub(this._hover).normalize().multiplyScalar(sp);
    return { hover: this._hover.clone(), vel };
  }

  /** Commit the dive visual - wire (loiterDive) or the offline pick. */
  dive(hover: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }): void {
    this.diving = { p: new THREE.Vector3(hover.x, hover.y, hover.z), vel: new THREE.Vector3(vel.x, vel.y, vel.z) };
    // Pitch the dart onto the dive line - the nose IS the intent.
    this.dart.rotation.x = Math.PI + Math.atan2(Math.hypot(vel.x, vel.z), -vel.y) * 0.5;
    sfx.dash();
  }

  tickUnfold(dt: number): void {
    tickUnfold(this, dt);
  }

  unfoldDone(): void { unfoldDone(this); }

  get dead(): boolean { return this.health <= 0; }
  health = DEPLOY_ITEMS.loiter.hp;
  armor = 0;
  maxHealth = DEPLOY_ITEMS.loiter.hp;
  takeDamage(dmg: number): void { damageDeploy(this, dmg); }
  heal(dmg: number): void { healDeploy(this, dmg); }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    if (this.ring) { this.terrain.removeFieldRing(this.ring); this.ring = null; }
    this.glow.material.dispose();
  }
}
