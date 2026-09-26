import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  TOTEM_RADIUS, TOTEM_HEALTH,
  TOTEM_RANGE, TOTEM_MIN_RANGE, TOTEM_REFIRE,
  TOTEM_CHARGE, TOTEM_RELOCATE_HOPS,
  TOTEM_PEAK_RADIUS, TOTEM_PEAK_MIN_GAIN, TOTEM_MATERIALIZE,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { BlobShadow } from '../effects/blobShadow.js';
import { TerrainFoot } from '../effects/terrainFoot.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();

// Shared geometries — a tapered obsidian obelisk with a glowing eye slit
let _shaftGeo: THREE.CylinderGeometry | null = null;
function shaftGeo(): THREE.CylinderGeometry {
  if (!_shaftGeo) _shaftGeo = new THREE.CylinderGeometry(0.35, 0.7, 4.2, 4); // 4-sided obelisk
  return _shaftGeo;
}
let _capGeo: THREE.ConeGeometry | null = null;
function capGeo(): THREE.ConeGeometry {
  if (!_capGeo) _capGeo = new THREE.ConeGeometry(0.5, 1.0, 4);
  return _capGeo;
}
// Aim beam — a thin quad stretched between totem and player during charge
let _beamGeo: THREE.PlaneGeometry | null = null;
function beamGeo(): THREE.PlaneGeometry {
  if (!_beamGeo) {
    _beamGeo = new THREE.PlaneGeometry(1, 1);
    _beamGeo.rotateY(Math.PI / 2); // lies along +z so lookAt aims it
    _beamGeo.translate(0, 0, 0.5); // origin at the totem end
  }
  return _beamGeo;
}

/**
 * Sniper totem — the perpendicular-movement teacher. A static obelisk that
 * teleports to the local high ground (hill-climbing the terrain samples),
 * charges a visible aim-beam at the player, then fires a fast flat bolt.
 * Relocates when the player gets close, when its line of sight is blocked,
 * or after a few shots — it always wants the crest, not the fight.
 * Vulnerable while materializing after a blink.
 */
export class Totem implements Targetable {
  readonly id: number;
  readonly variant = 0;

  pos: THREE.Vector3;
  vel = new THREE.Vector3(); // never ballistic — it blinks, not hops
  dead = false;
  health = TOTEM_HEALTH;
  maxHealth = TOTEM_HEALTH;
  radius = TOTEM_RADIUS;
  // Obelisk is ~6m tall — capsule hitbox covers the whole shaft, not a
  // 1m sphere at the feet (this was the "can't hit him" whiff zone).
  capsuleTop = 4.2 * 1.4;
  color = new THREE.Color(0x2a2438); // dark obsidian violet
  scale = 1.4;

  private scene: THREE.Scene;
  private _terrain: Terrain;
  private mesh: THREE.Group;
  private shaftMat: THREE.MeshLambertMaterial;
  private eyeMat: THREE.SpriteMaterial;
  private eye: THREE.Sprite;
  private beam: THREE.Mesh;
  private beamMat: THREE.MeshBasicMaterial;
  private shadow: BlobShadow;
  private foot: TerrainFoot; // rim→dirt wall — planted look on any slope
  private arriveFx: THREE.Mesh;
  private arriveFxMat: THREE.MeshBasicMaterial;
  private arriveT = 0;

  private state: 'materialize' | 'aim' | 'charge' | 'blinkOut' | 'blinkIn' = 'materialize';
  private stateTimer = TOTEM_MATERIALIZE;
  private chargeTimer = 0;
  private refire = TOTEM_REFIRE;
  private shotsFired = 0;
  private flashTimer = 0;
  private blinkTarget = new THREE.Vector3();
  private lockPoint = new THREE.Vector3(); // beam locks here — dodge by moving after lock
  private lockDir = new THREE.Vector3();   // locked firing direction
  private lockDist = TOTEM_RANGE;          // line length: to terrain or max range
  private beamFade = 0;                    // post-shot beam decay timer

  /** Bolt hit the player — wire sendEnvironmentDamage in entities.ts */
  onBoltHit?: (t: Totem) => void;
  /** Bolt fizzled on terrain — dust/spark hook */
  onBoltLand?: (pos: THREE.Vector3) => void;
  /** Arrival/departure FX hooks (shimmer column) */
  onBlink?: (pos: THREE.Vector3) => void;

  get disposed(): boolean { return this.dead; }
  // Blinking counts as briefly un-hittable? No — takeDamage guards on state.
  private get intangible(): boolean { return this.state === 'blinkOut' || this.state === 'blinkIn'; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this.scene = scene;
    this._terrain = terrain;
    this.id = nextTargetId();

    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z);

    this.mesh = new THREE.Group();
    const shaftMat = this.shaftMat = new THREE.MeshLambertMaterial({ color: this.color, emissive: 0x120a20 });
    const shaft = new THREE.Mesh(shaftGeo(), shaftMat);
    shaft.position.y = 2.1;
    shaft.castShadow = true;
    this.mesh.add(shaft);
    const cap = new THREE.Mesh(capGeo(), shaftMat);
    cap.position.y = 4.7;
    this.mesh.add(cap);

    // The eye — slit glow near the top, charges blinding-white before a shot
    this.eyeMat = new THREE.SpriteMaterial({
      map: getGlowTexture(), color: 0x66ddff, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.eye = new THREE.Sprite(this.eyeMat);
    this.eye.scale.setScalar(1.1);
    this.eye.position.y = 3.9;
    this.mesh.add(this.eye);
    this.mesh.position.copy(this.pos);
    this.mesh.scale.setScalar(this.radius);
    scene.add(this.mesh);

    // Aim beam — additive plane stretched to the player while charging
    this.beamMat = new THREE.MeshBasicMaterial({
      color: 0xff3344, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.beam = new THREE.Mesh(beamGeo(), this.beamMat);
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    scene.add(this.beam);

    // Arrival shimmer — a brief additive column that stands where it lands
    this.arriveFxMat = new THREE.MeshBasicMaterial({
      color: 0x8899ff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.arriveFx = new THREE.Mesh(shaftGeo(), this.arriveFxMat);
    this.arriveFx.visible = false;
    scene.add(this.arriveFx);

    this.shadow = new BlobShadow(scene, this.radius * 0.9, 0.35);

    // Foundation foot — the obelisk's rim extruded into the dirt. Upright
    // (no tilt quaternion): the shaft is 4-sided but the foot is round,
    // tucked just inside the circumradius so it reads as a root collar.
    this.foot = new TerrainFoot(scene, this.radius * 0.66);
    this.foot.conform(this.pos.x, this.pos.z, this.pos.y, terrain);
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3, playerVel?: THREE.Vector3): void {
    if (this.dead) return;
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.shaftMat.color.copy(this.color);
    }

    this.stateTimer -= dt;
    const dist = this.pos.distanceTo(playerPos);

    switch (this.state) {
      case 'materialize': {
        // Fresh blink-in — grows in from the shimmer column, eye warming up.
        // The shoot window.
        const t = 1 - Math.max(0, this.stateTimer / TOTEM_MATERIALIZE);
        this.mesh.scale.setScalar(this.radius * (0.3 + t * 0.7));
        this.eyeMat.opacity = t * 0.5;
        this.eye.scale.setScalar(0.4 + t * 0.4);
        if (this.stateTimer <= 0) {
          this.state = 'aim';
          this.mesh.scale.setScalar(this.radius);
          this.eyeMat.opacity = 0.8;
        }
        break;
      }
      case 'aim': {
        this.refire -= dt;
        // Flee rules: too close → blink away; blocked LOS → blink away;
        // after enough shots → fresh perch before you bracket it
        if (dist < TOTEM_MIN_RANGE ||
            (this.shotsFired >= TOTEM_RELOCATE_HOPS) ||
            (this.refire <= 0 && !this.lineClear(playerPos))) {
          this.beginBlink(playerPos);
          break;
        }
        if (this.refire <= 0 && dist < TOTEM_RANGE) {
          this.state = 'charge';
          this.chargeTimer = TOTEM_CHARGE;
          this.lockPoint.copy(playerPos); // LOCK the line now — no more tracking
          this.solveBeam(); // locked dir + full-length line endpoint
          this.beam.visible = true;
        }
        break;
      }
      case 'charge': {
        // The beam points at the LOCKED point — its narrowing is the dodge
        // timer. Direction never re-tracks; move and it whiffs.
        this.chargeTimer -= dt;
        const t = 1 - Math.max(0, this.chargeTimer / TOTEM_CHARGE);
        this.updateBeam(t);
        this.eyeMat.opacity = 0.8 + t * 0.2;
        this.eye.scale.setScalar(1.1 + t * 1.4);
        this.shaftMat.emissive.setRGB(t * 0.3, t * 0.15, t * 0.5); // violet charge bleed
        if (this.chargeTimer <= 0) {
          this.fireBeam(playerPos);
          this.eye.scale.setScalar(1.1);
          this.shaftMat.emissive.setHex(0x120a20);
          this.state = 'aim';
          this.refire = TOTEM_REFIRE;
          this.shotsFired++;
        }
        break;
      }
      case 'blinkOut': {
        // Shrink + sink — gone in a blink
        const t = Math.max(0, this.stateTimer / 0.25);
        this.mesh.scale.setScalar(this.radius * t);
        if (this.stateTimer <= 0) {
          this.pos.copy(this.blinkTarget);
          this.pos.y = this._terrain.getHeight(this.pos.x, this.pos.z);
          this.mesh.position.copy(this.pos);
          this.mesh.visible = false;
          this.foot.mesh.visible = false;
          this.state = 'blinkIn';
          this.stateTimer = 0.3;
        }
        break;
      }
      case 'blinkIn': {
        // Shimmer column stands at the arrival spot before the body appears —
        // you get a beat to see where it went
        this.arriveFx.visible = true;
        this.arriveFx.position.set(this.pos.x, this.pos.y + 2.4, this.pos.z);
        this.arriveFx.scale.set(this.radius, 1.3, this.radius);
            this.arriveFxMat.opacity = 0.7 * Math.abs(Math.sin(this.stateTimer * 20));
        if (this.stateTimer <= 0) {
          this.arriveFx.visible = false;
          this.mesh.visible = true;
          this.mesh.scale.setScalar(this.radius); // undo blinkOut's shrink
          this.foot.conform(this.pos.x, this.pos.z, this.pos.y, this._terrain);
          this.foot.mesh.visible = true;
          this.state = 'materialize';
          this.stateTimer = TOTEM_MATERIALIZE;
          this.shotsFired = 0;
          this.onBlink?.(this.pos);
        }
        break;
      }
    }

    // Beam afterglow — the fired rail flash decays out
    if (this.beamFade > 0) {
      this.beamFade -= dt;
      this.beamMat.opacity = Math.max(0, this.beamFade / 0.3) * 0.95;
      if (this.beamFade <= 0) this.beam.visible = false;
    }

    this.mesh.position.copy(this.pos);
    this.shadow.update(this.pos, terrain);
  }

  private beginBlink(playerPos: THREE.Vector3): void {
    // Peak-seek: sample a ring of terrain around the PLAYER'S general
    // bearing, pick the highest point that keeps firing range. It literally
    // hill-climbs toward the crests.
    let bestH = -Infinity;
    let found = false;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + Math.random() * 0.4;
      const r = 15 + Math.random() * TOTEM_PEAK_RADIUS;
      const x = this.pos.x + Math.cos(a) * r;
      const z = this.pos.z + Math.sin(a) * r;
      const h = this._terrain.getHeight(x, z);
      // Must keep range on the player — a peak behind a ridge is useless
      const pd = Math.hypot(playerPos.x - x, playerPos.z - z);
      if (pd > TOTEM_RANGE * 0.9) continue;
      if (h > bestH) { bestH = h; this.blinkTarget.set(x, h, z); found = true; }
    }
    if (!found || bestH < this._terrain.getHeight(this.pos.x, this.pos.z) + TOTEM_PEAK_MIN_GAIN) {
      // No better perch — just ring-shift sideways instead of standing still
      const a = Math.random() * Math.PI * 2;
      const r = 30 + Math.random() * 20;
      this.blinkTarget.set(playerPos.x + Math.cos(a) * r, 0, playerPos.z + Math.sin(a) * r);
    }
    this.state = 'blinkOut';
    this.stateTimer = 0.25;
    this.beam.visible = false;
    this.onBlink?.(this.pos);
  }

  // LOS check — a straight-ish line, sampled. The totem fires nearly flat
  // bolts so terrain grazing matters more than arc clearance.
  private lineClear(target: THREE.Vector3): boolean {
    const sy = this.pos.y + 3.9 * this.radius;
    for (let i = 1; i <= 10; i++) {
      const t = i / 10;
      const x = this.pos.x + (target.x - this.pos.x) * t;
      const z = this.pos.z + (target.z - this.pos.z) * t;
      const y = sy + (target.y - sy) * t;
      if (y < this._terrain.getHeight(x, z) + 0.4) return false;
    }
    return true;
  }

  // Solve the locked beam once: direction at lockPoint, extended to its
  // full length — terrain hit or TOTEM_RANGE. The line ALWAYS renders past
  // the player, so backing off never shows a floating endpoint mid-air.
  private solveBeam(): void {
    _v.set(this.pos.x, this.pos.y + 3.9 * this.radius, this.pos.z); // eye
    this.lockDir.copy(this.lockPoint).sub(_v).normalize();
    this.lockDist = TOTEM_RANGE;
    for (let t = 1; t <= TOTEM_RANGE; t += 1) {
      const x = _v.x + this.lockDir.x * t,
            y = _v.y + this.lockDir.y * t,
            z = _v.z + this.lockDir.z * t;
      if (y < this._terrain.getHeight(x, z)) { this.lockDist = t; break; }
    }
  }

  private updateBeam(chargeT: number): void {
    _v.set(this.pos.x, this.pos.y + 3.9 * this.radius, this.pos.z);
    this.beam.position.copy(_v);
    _v2.copy(_v).addScaledVector(this.lockDir, this.lockDist);
    this.beam.lookAt(_v2);
    // Telegraph narrows as it locks: wide diffuse aim-line → razor line.
    this.beam.scale.set(1, 0.65 - chargeT * 0.55, this.lockDist);
    this.beamMat.opacity = 0.3 + chargeT * 0.55;
    this.beamMat.color.setRGB(1, 0.35 - chargeT * 0.2, 0.3 + chargeT * 0.25);
  }

  // Railgun fire: instant hitscan along the LOCKED line. The beam quad
  // flashes bright at full length, then fades out over ~0.3s. Hit test is
  // point-to-line distance vs the player's live position — sidestep during
  // charge and the locked line whiffs you entirely.
  private fireBeam(playerPos: THREE.Vector3): void {
    _v.set(this.pos.x, this.pos.y + 3.9 * this.radius, this.pos.z); // eye
    _dir.copy(this.lockDir); // the locked line — solved at charge start
    const dist = this.lockDist;
    const hitGround = dist < TOTEM_RANGE;

    // Point-to-ray distance — the player only eats it if they stayed on line
    _v2.subVectors(playerPos, _v);
    const proj = _v2.dot(_dir);
    if (proj > 0 && proj < dist && _v2.addScaledVector(_dir, -proj).lengthSq() < 1.7) {
      this.onBoltHit?.(this);
    } else if (hitGround) {
      _v2.copy(_v).addScaledVector(_dir, dist);
      this.onBoltLand?.(_v2);
    }

    // The shot: beam goes thin + blinding white along the locked line
    _v2.copy(_v).addScaledVector(_dir, dist);
    this.beam.position.copy(_v);
    this.beam.lookAt(_v2);
    this.beam.scale.set(1, 0.18, dist);
    this.beamMat.opacity = 0.95;
    this.beamMat.color.setRGB(1, 0.9, 0.95);
    this.beamFade = 0.3;
  }

  takeDamage(): boolean {
    if (this.intangible) return false; // mid-blink — nothing to hit
    this.health--;
    this.flashTimer = 0.12;
    this.shaftMat.color.set(0xffffff);
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    // Anchored — but a blast during charge drops the aim (it blinks to safety)
    if (this.state === 'charge' && force > 8) this.beginBlink(_v);
    void from;
  }

  applyPull(to: THREE.Vector3, force: number): void {
    if (this.state === 'charge' && force > 8) this.beginBlink(to);
  }

  dispose(): void {
    this.shadow.dispose();
    this.foot.dispose();
    this.scene.remove(this.mesh, this.beam, this.arriveFx);
    this.shaftMat.dispose();
    this.eyeMat.dispose();
    this.beamMat.dispose();
    this.arriveFxMat.dispose();
    // geometry is shared — never dispose
  }
}
