import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  TOTEM_RADIUS,
  TOTEM_MATERIALIZE,
  UBER_TOTEM_RADIUS,
  UBER_TOTEM_BEAM_WIDTH,
} from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import { bindNetTotem, applyNetEdgeTotem, updateNetTotem, updateLocalSim, claimDamageMelee, type NetBindArgs } from '../game/netMelee.js';
import { type SimTotem, makeSimTotem, stepTotem, applyTotemDamage, totemBeamHit, commitTarget } from '../../../shared/creatureSim.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getShadows } from './swarms.js';
import type { SwarmSlotOwner } from './swarm.js';
import { TerrainFoot } from '../effects/terrainFoot.js';
import { writeTotemInstances } from './totemVisual.js';
export { totemParts } from './totemVisual.js';

// 'materialize' is spawn dressing — the shared sim has no state for it;
// the entity runs the grow-in, then hands control to stepTotem.
type TotemState = 'materialize' | 'aim' | 'charge' | 'blinkOut' | 'blinkIn';

const _v = new THREE.Vector3();


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
  foot: TerrainFoot | null = null; // public — totemFsm conforms it on arrival
  terrain: Terrain;               // public — totemFsm height-samples blinks

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
  stateTimer = TOTEM_MATERIALIZE;
  // Stagger lock: every hit sets ~2.1s of "can't blink" — sustained fire
  // pins the obelisk in place. That's the counterplay: it can still shoot
  // back, but it can't escape while you're landing damage. Mirrors the
  // sim's stunTimer.
  staggerT = 0;
  lockDir = new THREE.Vector3();   // locked firing direction — mirrored from the sim's committed line
  lockDist = 0;
  beamFade = 0;                    // post-shot beam decay timer

  /** netDriven = server-authoritative replay — the shared SimTotem drives
   *  the state machine; this class only mirrors it into the visuals. */
  netDriven = false;
  netId = 0;
  sim: SimTotem | null = null;
  netAcc = 0;
  static hitClaim: ((netId: number, damage: number) => void) | null = null;

  bindNet(b: NetBindArgs): void {
    const {pos} = b;
    this.netDriven = true;
    this.netId = b.id;
    bindNetTotem(this, b, makeSimTotem);
    this.pos.copy(this.sim ? new THREE.Vector3(this.sim.x, this.sim.y, this.sim.z) : pos);
    this.maxHealth = this.sim?.health ?? this.health;
    this.health = this.maxHealth;
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
      this.lockDir.set(this.sim.lockDirX, this.sim.lockDirY, this.sim.lockDirZ);
      this.lockDist = this.sim.lockDist;
      this.beamOn = true;
    }
  }

  /** 'fire' edge — the discharge flash; damage is the authority's job. */
  onSimFire(): void {
    this.beamWidth = this.uber ? UBER_TOTEM_BEAM_WIDTH * 0.5 : 0.3;
    this.beamOpacity = 1;
    this.beamFade = 0.35;
    this.beamOn = true;
    this.eyeScale = 1.1;
    this.chargeGlow = 0;
  }

  /** pos = beam impact point — the sniper sits a map away from where the
   *  ray lands. */
  onBoltHit?: (t: Totem, pos: THREE.Vector3) => void;
  onBoltLand?: (pos: THREE.Vector3) => void;
  onBlink?: (pos: THREE.Vector3) => void;

  get disposed(): boolean { return this.dead; }
  private get intangible(): boolean { return this.state === 'blinkOut' || this.state === 'blinkIn'; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    this.terrain = terrain;
    this.id = nextTargetId();
    this.uber = uber;
    this.radius = uber ? UBER_TOTEM_RADIUS : TOTEM_RADIUS;
    this.hitRadius = this.radius * 0.68;
    this.capsuleTop = 5.2 * this.radius; // visual top: cap tip at 5.2r
    // Uber reads as a crowned elder — gold-bronze massif, not obsidian
    this.color = new THREE.Color(uber ? 0x5A_40_20 : 0x2A_24_38);
    this.scale = uber ? 2.4 : 1.4;

    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z);

    // Local authority: the same shared sim the wire replays — aim/charge/
    // blink state machine, lock line, blink perch picks all live there.
    this.sim = makeSimTotem(this.id, { x: this.pos.x, y: this.pos.y, z: this.pos.z }, uber, this.id, 'totem');
    this.health = this.sim.health;
    this.maxHealth = this.sim.maxHealth;

    this.hasSlots = allocSlots('totem', this);
    if (!this.hasSlots) {this.dead = true;}

    // Foundation foot — obelisk rim extruded into the dirt. Per-instance:
    // it conform-samples the heightmap, which an InstancedMesh can't express.
    this.foot = new TerrainFoot(scene, this.radius * 0.66);
    this.foot.conform(this.pos.x, this.pos.z, this.pos.y, terrain);
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3, playerVel?: THREE.Vector3): void {
    if (this.dead) {return;}
    if (this.netDriven) { this.updateNet(dt, terrain); return; }
    if (this.flash > 0) {this.flash -= dt;}
    const s = this.sim;

    if (this.state === 'materialize' || !s) {
      // Grow-in dressing — the sim has no materialize state; it idles in
      // 'aim' until the body exists.
      this.stateTimer -= dt;
      const p = 1 - Math.max(0, this.stateTimer / TOTEM_MATERIALIZE);
      this.bodyScale = 0.3 + p * 0.7;
      this.eyeScale = 0.4 + p * 0.4;
      this.eyeBright = p * 0.5;
      if (this.stateTimer <= 0) {
        this.state = 'aim';
        this.bodyScale = 1;
        this.eyeBright = 0.8;
      }
    } else {
      commitTarget(s, 'local', playerPos);
      const prevState = s.state;
      const ev = updateLocalSim(this, dt, terrain, stepTotem, playerPos);
      this.mirrorSim(dt, prevState);
      if (ev === 'blink') {this.onBlink?.(this.pos);}
      if (ev === 'fire') {
        this.onSimFire();
        // Local authority resolves the locked beam against the LIVE
        // position — same contract as totemFireTargets on the server.
        const ex = s.x, ey = s.y + s.sp.EYE_HEIGHT * s.radius, ez = s.z;
        if (totemBeamHit(s, playerPos.x, playerPos.y + 1, playerPos.z)) {
          const proj = (playerPos.x - ex) * s.lockDirX + (playerPos.y + 1 - ey) * s.lockDirY + (playerPos.z - ez) * s.lockDirZ;
          _v.set(ex + s.lockDirX * proj, ey + s.lockDirY * proj, ez + s.lockDirZ * proj);
          this.onBoltHit?.(this, _v);
        } else if (s.lockDist < s.sp.RANGE) {
          _v.set(ex + s.lockDirX * s.lockDist, ey + s.lockDirY * s.lockDist, ez + s.lockDirZ * s.lockDist);
          this.onBoltLand?.(_v);
        }
      }
      if (s.dead) {this.dead = true; return;}
    }

    this.writeInstances();
    if (this.foot) {getShadows()?.set(this, this.pos, this.radius * 0.9, 0.35);}
  }

  /** netDriven leg — the shared sim owns the state machine; this maps its
   *  state onto the same visual fields the offline path animates. */
  private updateNet(dt: number, terrain: Terrain): void {
    const s = this.sim;
    if (!s) {return;}
    if (this.flash > 0) {this.flash -= dt;}
    const prevState = s.state;
    updateNetTotem(this, dt, terrain, stepTotem);
    this.mirrorSim(dt, prevState);
    if (this.foot) {getShadows()?.set(this, this.pos, this.radius * 0.9, 0.35);}
  }

  /** Sim state → visual fields — shared by the net replay and the local
   *  authority paths so blink/charge read identically either way. */
  private mirrorSim(dt: number, prevState: SimTotem['state']): void {
    const s = this.sim!;
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
          this.foot!.conform(this.pos.x, this.pos.z, this.pos.y, this.terrain);
          this.foot!.mesh.visible = true;
        }
        this.eyeBright = 0.8;
        this.eyeScale = 1.1;
      }
      // Beam afterglow decay — the net path's only decay site (local
      // update() runs its own after the state step).
      if (this.beamFade > 0) {
        this.beamFade -= dt;
        this.beamOpacity = Math.max(0, this.beamFade / 0.3) * 0.95;
        if (this.beamFade <= 0) {this.beamOn = false;}
      }
    }
    this.staggerT = s.stunTimer; // the pin telegraph rides the same field
  }

  writeInstances(_terrain?: Terrain): void {
    writeTotemInstances(this);
  }

  // Anchored — a blast during charge drops the aim. Staggered it can't
  // even flee: the charge fizzles but the totem holds its ground. Unpinned,
  // the blast spends the shot budget and the sim relocates on its next
  // aim step (its own perch rules, not a caller-issued blink).
  private blastFizzle(): void {
    const s = this.sim;
    if (!s || s.state !== 'charge') {return;}
    if (s.stunTimer > 0 || s.blinkCd > 0) {
      s.state = 'aim';
      s.windupTimer = Math.max(s.windupTimer, 0.4); // fizzle — refire isn't free
    } else {
      s.state = 'aim';
      s.shotsFired = s.sp.RELOCATE_SHOTS; // relocate check fires next aim step
    }
    this.beamOn = false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    if (Number.isFinite(from.x + from.y + from.z + force) && force > 8) {this.blastFizzle();}
  }

  applyPull(to: THREE.Vector3, force: number): void {
    if (Number.isFinite(to.x + to.y + to.z + force) && force > 8) {this.blastFizzle();}
  }

  takeDamage(damage: number, opts?: { serverPaid?: boolean }): boolean {
    if (this.netDriven) {
      // Claim-only — the authority decides; a local flash still telegraphs.
      this.flash = 0.12;
      return claimDamageMelee(this, damage, Totem.hitClaim, opts?.serverPaid);
    }
    if (this.intangible) {return false;}
    this.flash = 0.12;
    const s = this.sim;
    if (s) { if (applyTotemDamage(s, damage)) { this.dead = true; return true; } }
    else if ((this.health -= damage) <= 0) { this.dead = true; return true; }
    return false;
  }

  dispose(): void {
    this.foot?.dispose();
    if (this.hasSlots) {
      freeSlots('totem', this);
      this.hasSlots = false;
    }
  }
}
