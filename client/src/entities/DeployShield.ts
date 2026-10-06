import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { makeShieldedMesh, type ShieldBubble } from '../effects/shieldBubble.js';
import type { Terrain, FieldRing } from '../world/terrain.js';

// Barrier dome pack — plants a field emitter that projects a hex-lattice
// energy dome. Hostile shells detonate on the face; friendly fire passes
// through. The counterplay is Tribes-canonical: the emitter takes blast
// damage like any deployable, so shelling the dome cracks the field.
// Same entity contract as DeployStation/DeployTurret (unfold, vitals,
// dep: candidate id) so the pod/owner/blast plumbing treats it alike.

const _metal = new THREE.MeshLambertMaterial({ color: 0x39434e });
const _dark = new THREE.MeshLambertMaterial({ color: 0x1b2229 });
const _tipMat = new THREE.MeshBasicMaterial({ color: 0x66ccff });
const _geoBase = new THREE.CylinderGeometry(0.55, 0.8, 0.28, 8);
const _geoMast = new THREE.CylinderGeometry(0.09, 0.14, 1.3, 6);
const _geoTip = new THREE.OctahedronGeometry(0.22, 0);
const _geoStrut = new THREE.BoxGeometry(0.08, 0.6, 0.08);

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
  private anchor: THREE.Group | null = null; // world-space dome mount (built post-land)
  private dome: ShieldBubble | null = null;
  private edge: FieldRing | null = null;
  private animT = Math.random() * 10;
  private unfoldT = 0;
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
    this.pos.y = terrain.getHeight(pos.x, pos.z);

    const base = new THREE.Mesh(_geoBase, _dark);
    base.position.y = 0.14;
    const mast = new THREE.Mesh(_geoMast, _metal);
    mast.position.y = 0.8;
    this.group.add(base, mast);
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Mesh(_geoStrut, _metal);
      const a = (i / 3) * Math.PI * 2;
      s.position.set(Math.cos(a) * 0.48, 0.24, Math.sin(a) * 0.48);
      s.rotation.z = Math.cos(a) * -0.5;
      s.rotation.x = Math.sin(a) * 0.5;
      this.group.add(s);
    }
    // Emitter tip — the node the dome radiates from.
    const t = new THREE.Mesh(_geoTip, _tipMat);
    this.tip.add(t);
    this.tip.position.y = 1.55;
    this.group.add(this.tip);
    this.tipGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(), color: 0x66ccff, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.tipGlow.scale.setScalar(1.1);
    this.tipGlow.position.y = 1.55;
    this.group.add(this.tipGlow);

    this.group.position.copy(this.pos);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), terrain.getNormal(pos.x, pos.z));
    scene.add(this.group);
  }

  /** The dome only exists once the emitter lands — a sphere centered on
   *  the pad, half-buried, reads as a dome on any slope without any
   *  terrain-conforming logic (same trick as DeployStation's field). */
  private buildDome(): void {
    this.anchor = new THREE.Group();
    this.anchor.position.copy(this.pos);
    this.scene.add(this.anchor);
    this.dome = makeShieldedMesh(this.anchor, new THREE.SphereGeometry(DeployShield.RADIUS * 0.99, 36, 24), 0x66ccee);
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
    if (this.dead) return;
    this.animT += dt;
    if (this.placed && !this.dome) this.buildDome();
    this.dome?.update(dt);
    if (this.edge) {
      this.edge.intensity = 0.5 + Math.sin(this.animT * 2.6) * 0.12;
    }
    // Tip idles a slow spin + glow pulse — the emitter shows it's live.
    this.tip.rotation.y += dt * 2.4;
    const pulse = 0.85 + Math.sin(this.animT * 3.2) * 0.15;
    this.tipGlow.material.opacity = 0.5 + pulse * 0.4;
    this.tipGlow.scale.setScalar(0.9 + pulse * 0.35);
  }

  tickUnfold(dt: number): void {
    if (this.unfoldT >= 1) return;
    this.unfoldT = Math.min(1, this.unfoldT + dt / 0.45);
    const k = this.unfoldT - 1;
    this.group.scale.setScalar(Math.max(0.08, 1 + 2.7 * k * k * k + 1.7 * k * k)); // easeOutBack
  }

  unfoldDone(): void {
    this.unfoldT = 1;
    this.placed = true;
    this.group.scale.setScalar(1);
  }

  heal(n: number): void {
    const over = Math.max(0, this.health + n - this.maxHealth);
    this.health = Math.min(this.maxHealth, this.health + n);
    this.armor = Math.min(this.maxHealth * 2, this.armor + over);
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
    this.tipGlow.material.dispose();
    // Dome + anchor + ring slot are per-instance, baked to THIS landing spot.
    this.dome?.dispose();
    if (this.anchor) this.scene.remove(this.anchor);
    if (this.edge) {
      this.terrain.removeFieldRing(this.edge);
      this.edge = null;
    }
  }
}
