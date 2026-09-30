import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  TOTEM_RADIUS, TOTEM_HEALTH,
  TOTEM_RANGE, TOTEM_REFIRE,
  TOTEM_MATERIALIZE,
  UBER_TOTEM_RADIUS, UBER_TOTEM_HEALTH, UBER_TOTEM_REFIRE,
  UBER_TOTEM_BEAM_WIDTH,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import { bindNetTotem, applyNetEdgeTotem, updateNetTotem, claimDamageMelee, type NetBindArgs } from '../game/netMelee.js';
import { TOTEM_STATES, type TotemState, type TotemCtx } from './totemFsm.js';
import { type SimTotem, makeSimTotem, stepTotem } from '../../../shared/creatureSim.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getShadows } from './swarms.js';
import type { SwarmSlotOwner } from './swarm.js';
import { TerrainFoot } from '../effects/terrainFoot.js';
import { writeTotemInstances } from './totemVisual.js';
export { totemParts } from './totemVisual.js';
import { beginBlinkF, lineClear, solveBeam, fireBeam, blastPush, blastPull } from './totemBeam.js';


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
  // back, but it can't escape while you're landing damage.
  staggerT = 0;
  chargeTimer = 0;
  refire: number;
  shotsFired = 0;
  blinkTarget = new THREE.Vector3();
  blinkCd = 0; // random 2–5s between blinks — no pop-pop-pop escapes
  lockPoint = new THREE.Vector3(); // beam locks here — dodge by moving after lock
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
    this.terrain = terrain;
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

  // FSM lives in totemFsm.ts — states mutate this totem's flat fields
  // via the TotemFsmHost interface; only the shared scratch ctx stays.
  private static readonly _ctx: TotemCtx = { dt: 0, dist: 0, playerPos: null as never };

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
    TOTEM_STATES[this.state](this, ctx);

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
          this.foot!.conform(this.pos.x, this.pos.z, this.pos.y, this.terrain);
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

  beginBlink(playerPos: THREE.Vector3): void { beginBlinkF(this, playerPos); }
  lineClear(target: THREE.Vector3): boolean { return lineClear(this, target); }
  solveBeam(): void { solveBeam(this); }
  fireBeam(playerPos: THREE.Vector3): void { fireBeam(this, playerPos); }
  applyKnockback(from: THREE.Vector3, force: number): void { blastPush(this, from, force); }
  applyPull(to: THREE.Vector3, force: number): void { blastPull(this, to, force); }

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

  dispose(): void {
    this.foot?.dispose();
    if (this.hasSlots) {
      freeSlots('totem', this);
      this.hasSlots = false;
    }
  }
}
