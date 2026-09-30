import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  TOTEM_RADIUS, TOTEM_HEALTH,
  TOTEM_RANGE, TOTEM_MIN_RANGE, TOTEM_REFIRE,
  TOTEM_CHARGE, TOTEM_RELOCATE_HOPS,
  TOTEM_PEAK_RADIUS, TOTEM_PEAK_MIN_GAIN, TOTEM_MATERIALIZE,
  UBER_TOTEM_RADIUS, UBER_TOTEM_HEALTH, UBER_TOTEM_REFIRE,
  UBER_TOTEM_CHARGE, UBER_TOTEM_HIT_RADIUS, UBER_TOTEM_BEAM_WIDTH,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import { bindNetTotem, applyNetEdgeTotem, updateNetTotem, claimDamageMelee, type NetBindArgs } from '../game/netMelee.js';
import { type SimTotem, makeSimTotem, stepTotem } from '../../../shared/creatureSim.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getShadows } from './swarms.js';
import type { SwarmSlotOwner } from './swarm.js';
import { TerrainFoot } from '../effects/terrainFoot.js';
import { writeTotemInstances } from './totemVisual.js';
export { totemParts } from './totemVisual.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _zeroVel = new THREE.Vector3();

type TotemState = 'materialize' | 'aim' | 'charge' | 'blinkOut' | 'blinkIn';
interface TotemCtx { dt: number; dist: number; playerPos: THREE.Vector3; playerVel?: THREE.Vector3 }

/**
 * Sniper totem — the perpendicular-movement teacher. Blinks to high ground,
 * charges a visible aim-beam at the player, fires a fast flat bolt.
 * Renders into the shared totem swarm; the TerrainFoot stays per-instance —
 * it conforms to the local heightmap, which instancing can't express.
 */
export class Totem implements Targetable, SwarmSlotOwner {
  readonly id: number;
  readonly variant = 0;

  pos: THREE.Vector3;
  vel = new THREE.Vector3(); // never ballistic — it blinks, not hops
  yaw = 0;                     // netDriven: face the committed target
  dead = false;
  readonly uber: boolean;
  health: number;
  maxHealth: number;
  radius: number;
  // Obelisk hitbox: the 4-sided shaft is 0.7×radius at the base corners
  // tapering to ~0.35 — a sphere at scale-radius is ~2× too fat at the
  // top. 0.68 splits the difference (corner-grazes at the base, mildly
  // generous at the tip — better than whiffing the visible shaft).
  hitRadius = 0;
  // Capsule covers feet→cap tip: shaft 4.2 + cap ~1.0, all ×radius scale.
  capsuleTop = 0;
  color: THREE.Color;
  scale: number;

  swarmSlot = -1;
  shadowSlot = -1;
  hasSlots = false; // public — writeTotemInstances gates on it
  private foot: TerrainFoot | null = null;
  private _terrain: Terrain;

  // Visual channel — public so totemVisual.ts can read the flat fields
  // (same host-interface pattern as ballNet).
  bodyScale = 0.3;   // materialize grow-in / blinkOut shrink
  eyeScale = 0.4;
  eyeBright = 0;     // 0..1 charge heat — instanceColor on the eye quad
  beamOn = false;
  beamOpacity = 0;
  beamWidth = 0.65;
  shimmerOn = false;
  shimmerPulse = 0;
  flash = 0;
  chargeGlow = 0;

  state: TotemState = 'materialize';
  private stateTimer = TOTEM_MATERIALIZE;
  // Stagger lock: every hit sets ~2.1s of "can't blink" — sustained fire
  // pins the obelisk in place. That's the counterplay: it can still shoot
  // back, but it can't escape while you're landing damage.
  staggerT = 0;
  private chargeTimer = 0;
  private refire: number;
  private shotsFired = 0;
  private blinkTarget = new THREE.Vector3();
  private blinkCd = 0; // random 2–5s between blinks — no pop-pop-pop escapes
  private lockPoint = new THREE.Vector3(); // beam locks here — dodge by moving after lock
  lockDir = new THREE.Vector3();   // locked firing direction
  lockDist = TOTEM_RANGE;
  beamFade = 0;                    // post-shot beam decay timer

  /** netDriven = server-authoritative replay — the shared SimTotem drives
   *  the state machine; this class only mirrors it into the visuals. */
  netDriven = false;
  netId = 0;
  sim: SimTotem | null = null;
  netAcc = 0;
  static hitClaim: ((netId: number, damage: number) => void) | null = null;

  bindNet(b: NetBindArgs): void {
    const pos = b.pos;
    this.netDriven = true;
    this.netId = b.id;
    bindNetTotem(this, b, makeSimTotem);
    this.pos.copy(this.sim ? new THREE.Vector3(this.sim.x, this.sim.y, this.sim.z) : pos);
    this.health = this.maxHealth = this.sim?.health ?? this.health;
    this.state = this.sim?.state === 'blinkOut' ? 'blinkOut' : 'aim';
  }

  applyNetEdge(m: { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; kind: string; targetId: string | null; tp?: { x: number; y: number; z: number } | null }): void {
    applyNetEdgeTotem(this, m);
    if (m.kind === 'blink') {
      this.state = 'blinkOut';
      this.stateTimer = 0.25;
      this.beamOn = false;
      this.onBlink?.(this.pos);
    }
    if (m.kind === 'charge' && this.sim) {
      this.state = 'charge';
      this.chargeTimer = this.sim.hopTimer;
      this.lockDir.set(this.sim.lockDirX, this.sim.lockDirY, this.sim.lockDirZ);
      this.lockDist = this.sim.lockDist;
      this.beamOn = true;
    }
  }

  /** 'fire' edge — the discharge flash; damage is the authority's job. */
  onSimFire(): void {
    this.beamWidth = this.uber ? UBER_TOTEM_BEAM_WIDTH * 0.5 : 0.3;
    this.beamOpacity = 1.0;
    this.beamFade = 0.35;
    this.beamOn = true;
    this.eyeScale = 1.1;
    this.chargeGlow = 0;
  }

  onBoltHit?: (t: Totem) => void;
  onBoltLand?: (pos: THREE.Vector3) => void;
  onBlink?: (pos: THREE.Vector3) => void;

  get disposed(): boolean { return this.dead; }
  private get intangible(): boolean { return this.state === 'blinkOut' || this.state === 'blinkIn'; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    this._terrain = terrain;
    this.id = nextTargetId();
    this.uber = uber;
    this.health = this.maxHealth = uber ? UBER_TOTEM_HEALTH : TOTEM_HEALTH;
    this.radius = uber ? UBER_TOTEM_RADIUS : TOTEM_RADIUS;
    this.hitRadius = this.radius * 0.68;
    this.capsuleTop = 5.2 * this.radius; // visual top: cap tip at 5.2r
    this.refire = uber ? UBER_TOTEM_REFIRE : TOTEM_REFIRE;
    // Uber reads as a crowned elder — gold-bronze massif, not obsidian
    this.color = new THREE.Color(uber ? 0x5a4020 : 0x2a2438);
    this.scale = uber ? 2.4 : 1.4;

    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z);

    this.hasSlots = allocSlots('totem', this);
    if (!this.hasSlots) this.dead = true;

    // Foundation foot — obelisk rim extruded into the dirt. Per-instance:
    // it conform-samples the heightmap, which an InstancedMesh can't express.
    this.foot = new TerrainFoot(scene, this.radius * 0.66);
    this.foot.conform(this.pos.x, this.pos.z, this.pos.y, terrain);
  }

  // Static state table + shared scratch ctx — see Seeker for the pattern.
  private static readonly _ctx: TotemCtx = { dt: 0, dist: 0, playerPos: null as never };
  private static readonly STATES: Record<TotemState, (t: Totem, c: TotemCtx) => void> = {
    materialize(t, _c) {
      const p = 1 - Math.max(0, t.stateTimer / TOTEM_MATERIALIZE);
      t.bodyScale = 0.3 + p * 0.7;
      t.eyeScale = 0.4 + p * 0.4;
      t.eyeBright = p * 0.5;
      if (t.stateTimer <= 0) {
        t.state = 'aim';
        t.bodyScale = 1;
        t.eyeBright = 0.8;
      }
    },
    aim(t, c) {
      t.refire -= c.dt;
      t.eyeBright = 0.8;
      t.eyeScale = 1.1;
      if (t.staggerT <= 0 && t.blinkCd <= 0 &&
          (c.dist < TOTEM_MIN_RANGE ||
          (t.shotsFired >= TOTEM_RELOCATE_HOPS) ||
          (t.refire <= 0 && !t.lineClear(c.playerPos)))) {
        t.beginBlink(c.playerPos);
        return;
      }
      if (t.refire <= 0 && c.dist < TOTEM_RANGE) {
        t.state = 'charge';
        const charge = t.uber ? UBER_TOTEM_CHARGE : TOTEM_CHARGE;
        t.chargeTimer = charge;
        if (t.uber) {
          // PREDICTIVE LOCK — the beam locks where you WILL BE when it
          // fires, not where you are: pos + vel × charge. Holding a
          // strafe line gets you tagged; the only dodge is changing
          // direction after the lock shows.
          t.lockPoint.copy(c.playerPos)
            .addScaledVector(c.playerVel ?? _zeroVel, charge);
        } else {
          t.lockPoint.copy(c.playerPos); // LOCK the line now — no more tracking
        }
        t.solveBeam();
        t.beamOn = true;
      }
    },
    charge(t, c) {
      t.chargeTimer -= c.dt;
      const charge = t.uber ? UBER_TOTEM_CHARGE : TOTEM_CHARGE;
      const w0 = t.uber ? UBER_TOTEM_BEAM_WIDTH : 0.65;
      const p = 1 - Math.max(0, t.chargeTimer / charge);
      t.beamWidth = w0 - p * (w0 - 0.1);
      t.beamOpacity = 0.3 + p * 0.55;
      t.eyeBright = 0.8 + p * 0.2;
      t.eyeScale = 1.1 + p * 1.4;
      t.chargeGlow = p * 0.5; // violet charge bleed on the shaft
      if (t.chargeTimer <= 0) {
        t.fireBeam(c.playerPos);
        t.eyeScale = 1.1;
        t.chargeGlow = 0;
        t.state = 'aim';
        t.refire = TOTEM_REFIRE;
        t.shotsFired++;
      }
    },
    blinkOut(t, _c) {
      t.bodyScale = Math.max(0, t.stateTimer / 0.25);
      if (t.stateTimer <= 0) {
        t.pos.copy(t.blinkTarget);
        t.pos.y = t._terrain.getHeight(t.pos.x, t.pos.z);
        t.bodyScale = 0;
        t.foot!.mesh.visible = false;
        t.state = 'blinkIn';
        t.stateTimer = 1.1; // long arrival telegraph — shimmer warns before the body exists
      }
    },
    blinkIn(t, _c) {
      // Shimmer column stands at the arrival spot well before the body
      // appears — a ~1s warning shimmer you can pre-aim or just walk to.
      t.shimmerOn = true;
      t.shimmerPulse = 0.7 * Math.abs(Math.sin(t.stateTimer * 20));
      if (t.stateTimer <= 0) {
        t.shimmerOn = false;
        t.bodyScale = 1;
        t.foot!.conform(t.pos.x, t.pos.z, t.pos.y, t._terrain);
        t.foot!.mesh.visible = true;
        t.state = 'materialize';
        t.stateTimer = TOTEM_MATERIALIZE;
        t.shotsFired = 0;
        // Blink cooldown — random so it doesn't feel metronome-y, long
        // enough that it can't chain-hop away from a chasing player.
        t.blinkCd = 2 + Math.random() * 3;
        t.onBlink?.(t.pos);
      }
    },
  };

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3, playerVel?: THREE.Vector3): void {
    if (this.dead) return;
    if (this.netDriven) { this.updateNet(dt, terrain); return; }
    if (this.flash > 0) this.flash -= dt;
    if (this.staggerT > 0) this.staggerT -= dt;
    if (this.blinkCd > 0) this.blinkCd -= dt;

    this.stateTimer -= dt;
    const dist = this.pos.distanceTo(playerPos);
    const ctx = Totem._ctx;
    ctx.dt = dt; ctx.dist = dist; ctx.playerPos = playerPos; ctx.playerVel = playerVel;
    Totem.STATES[this.state](this, ctx);

    // Beam afterglow — the fired rail flash decays out
    if (this.beamFade > 0) {
      this.beamFade -= dt;
      this.beamOpacity = Math.max(0, this.beamFade / 0.3) * 0.95;
      if (this.beamFade <= 0) this.beamOn = false;
    }

    this.writeInstances();
    if (this.foot) getShadows()?.set(this, this.pos, this.radius * 0.9, 0.35);
  }

  /** netDriven leg — the shared sim owns the state machine; this maps its
   *  state onto the same visual fields the offline path animates. */
  private updateNet(dt: number, terrain: Terrain): void {
    const s = this.sim;
    if (!s) return;
    if (this.flash > 0) this.flash -= dt;
    const prevState = s.state;
    updateNetTotem(this, dt, terrain, stepTotem);

    // Mirror sim state → visual fields
    this.state = s.state === 'aim' ? 'aim' : (s.state as TotemState);
    if (s.state === 'charge') {
      const charge = s.sp.CHARGE;
      const w0 = s.uber ? UBER_TOTEM_BEAM_WIDTH : 0.65;
      const p = 1 - Math.max(0, s.hopTimer / charge);
      this.beamWidth = w0 - p * (w0 - 0.1);
      this.beamOpacity = 0.3 + p * 0.55;
      this.eyeBright = 0.8 + p * 0.2;
      this.eyeScale = 1.1 + p * 1.4;
      this.chargeGlow = p * 0.5;
      this.beamOn = true;
      this.lockDir.set(s.lockDirX, s.lockDirY, s.lockDirZ);
      this.lockDist = s.lockDist;
    } else {
      this.chargeGlow = 0;
      if (s.state === 'blinkOut') {
        this.bodyScale = Math.max(0, s.hopTimer / 0.25);
        this.beamOn = false;
      } else if (s.state === 'blinkIn') {
        this.bodyScale = 0;
        this.shimmerOn = true;
        this.shimmerPulse = 0.7 * Math.abs(Math.sin(s.hopTimer * 20));
        this.beamOn = false;
        this.foot!.mesh.visible = false;
      } else {
        // aim — body fully materialized; post-blink arrival re-foots.
        if (prevState === 'blinkIn' || this.bodyScale < 1) {
          this.bodyScale = 1;
          this.shimmerOn = false;
          this.foot!.conform(this.pos.x, this.pos.z, this.pos.y, this._terrain);
          this.foot!.mesh.visible = true;
        }
        this.eyeBright = 0.8;
        this.eyeScale = 1.1;
      }
      // Beam afterglow decay — same as offline.
      if (this.beamFade > 0) {
        this.beamFade -= dt;
        this.beamOpacity = Math.max(0, this.beamFade / 0.3) * 0.95;
        if (this.beamFade <= 0) this.beamOn = false;
      }
    }
    this.staggerT = s.stunTimer; // the pin telegraph rides the same field
    if (this.foot) getShadows()?.set(this, this.pos, this.radius * 0.9, 0.35);
  }

  writeInstances(_terrain?: import('../world/terrain.js').Terrain): void {
    writeTotemInstances(this);
  }

  private beginBlink(playerPos: THREE.Vector3): void {
    // Gate: staggered (damage-locked) or still on post-blink cooldown —
    // the caller treats a no-op as "stay put".
    if (this.staggerT > 0 || this.blinkCd > 0) return;
    // Peak-seek: sample a ring of terrain around the PLAYER'S general
    // bearing, pick the highest point that keeps firing range.
    let bestH = -Infinity;
    let found = false;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + Math.random() * 0.4;
      const r = 15 + Math.random() * TOTEM_PEAK_RADIUS;
      const x = this.pos.x + Math.cos(a) * r;
      const z = this.pos.z + Math.sin(a) * r;
      const h = this._terrain.getHeight(x, z);
      const pd = Math.hypot(playerPos.x - x, playerPos.z - z);
      if (pd > TOTEM_RANGE * 0.9) continue;
      if (h > bestH) { bestH = h; this.blinkTarget.set(x, h, z); found = true; }
    }
    if (!found || bestH < this._terrain.getHeight(this.pos.x, this.pos.z) + TOTEM_PEAK_MIN_GAIN) {
      const a = Math.random() * Math.PI * 2;
      const r = 30 + Math.random() * 20;
      this.blinkTarget.set(playerPos.x + Math.cos(a) * r, 0, playerPos.z + Math.sin(a) * r);
    }
    this.state = 'blinkOut';
    this.stateTimer = 0.25;
    this.beamOn = false;
    this.onBlink?.(this.pos);
  }

  // LOS check — sampled straight-ish line; totem fires nearly flat bolts
  // so terrain grazing matters more than arc clearance.
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
  // full length — terrain hit or TOTEM_RANGE.
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

  // Railgun fire: instant hitscan along the LOCKED line. Sidestep during
  // charge and the locked line whiffs you entirely.
  private fireBeam(playerPos: THREE.Vector3): void {
    _v.set(this.pos.x, this.pos.y + 3.9 * this.radius, this.pos.z);
    _dir.copy(this.lockDir);
    const dist = this.lockDist;
    const hitGround = dist < TOTEM_RANGE;

    _v2.subVectors(playerPos, _v);
    const proj = _v2.dot(_dir);
    // Uber's death ray is a fat line — a wider catch envelope matches the
    // telegraph width. It can't miss a held course; it CAN miss a juke.
    const hitR2 = this.uber ? UBER_TOTEM_HIT_RADIUS * UBER_TOTEM_HIT_RADIUS : 1.7;
    if (proj > 0 && proj < dist && _v2.addScaledVector(_dir, -proj).lengthSq() < hitR2) {
      this.onBoltHit?.(this);
    } else if (hitGround) {
      _v2.copy(_v).addScaledVector(_dir, dist);
      this.onBoltLand?.(_v2);
    }

    // Post-shot flash: the DISCHARGE — starts wide like the charge beam's
    // full envelope (energy leaving the whole line), snaps thin as it
    // decays. beamFade drives the white-hot color in writeInstances.
    this.beamWidth = this.uber ? UBER_TOTEM_BEAM_WIDTH * 0.5 : 0.3;
    this.beamOpacity = 1.0;
    this.beamFade = 0.35;
    this.beamOn = true;
  }

  takeDamage(damage: number): boolean {
    if (this.netDriven) {
      // Claim-only — the authority decides; a local flash still telegraphs.
      this.flash = 0.12;
      return claimDamageMelee(this, damage, Totem.hitClaim);
    }
    if (this.intangible) return false;
    this.health -= damage;
    this.flash = 0.12;
    this.staggerT = Math.max(this.staggerT, 2.1); // pinned — can't blink
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    // Anchored — a blast during charge drops the aim. Staggered it can't
    // even flee: the charge fizzles but the totem holds its ground.
    if (this.state !== 'charge' || force <= 8) return;
    if (this.staggerT > 0 || this.blinkCd > 0) { this.state = 'aim'; this.refire = Math.max(this.refire, 0.4); this.beamOn = false; }
    else this.beginBlink(from);
  }

  applyPull(to: THREE.Vector3, force: number): void {
    if (this.state !== 'charge' || force <= 8) return;
    if (this.staggerT > 0 || this.blinkCd > 0) { this.state = 'aim'; this.refire = Math.max(this.refire, 0.4); this.beamOn = false; }
    else this.beginBlink(to);
  }

  dispose(): void {
    this.foot?.dispose();
    if (this.hasSlots) {
      freeSlots('totem', this);
      this.hasSlots = false;
    }
  }
}
