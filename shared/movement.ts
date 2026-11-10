/**
 * Shared player movement sim - pure math, no renderer deps. The client's
 * MovementController wraps this with THREE.Vector3 + Terrain; the server
 * drives it from inputMove messages so player physics is identical on
 * both ends (the foundation for server-authoritative movement, replay,
 * and honest anti-cheat).
 *
 * Vectors are plain {x,y,z} - THREE Vector3 satisfies that structurally.
 */

// Cross-engine replay: native trig/hypot differ by ULPs between JSC
// (server) and V8 (client); dmath keeps prediction == shadow bitwise.
import { dcos, dhypot2, dhypot3, dsin } from './dmath.ts';

export const MOVEMENT_CONFIG = {
  // Walk cap at speedScale 1 - T2's medium (12 m/s). Class scales hit
  // T2's spread: light ≈15, medium 12, heavy ≈7.
  maxVelocityGround: 12,
  groundAccelerate: 800,
  // T1 traction: GROUNDFORCE/MASS × GROUNDTRACTION = (9·40/9) × 3 = 120 -
  // the bounded accel that converges grounded velocity toward the walk
  // wish. It's the force skiing exists to dodge.
  groundTractionAccel: 120,
  maxPassiveAirvel: 10,
  airControl: 0.2,
  terminalVelocity: 100,
  jumpSpeed: 9.8,
  autoHop: true,
  // Generous grounding - Tribes walkers stay glued: any terrain is
  // walkable at any angle, and a lip/crest under this height never
  // reads airborne (the air-control steal + walk→jump anim flicker a
  // strict gate produced). A real launch - explosion loft, jet burn,
  // jump takeoff - clears the snap via the vel gate.
  groundSnapDistance: 0.6,
  // Walkers glue downhill harder than movers: a descent can drop past
  // the 0.6m band in one step, and without a deeper reach the body
  // goes ballistic over terrain a Tribes walker just walks down
  // (Torque findContact probes BELOW the feet - this is that probe).
  // Only reachable below stickSpeed, so movers can't vacuum to dirt.
  walkGlueDistance: 1.4,
  groundLaunchVel: 3,
  // T1 parity: contact lingers 256ms (MAXJUMPTICKS=8 @ 32ms) after the
  // surface is lost - gentle crest hops stay grounded, real launches don't.
  groundGraceT: 0.256,
  // Skiing: friction toggle only - no artificial accel/boost/lift, but a
  // skier counts as grounded a little higher off the surface.
  skiTargetDistance: 0.5,
  playerHeight: 1.8,
  // Structure ledges within this of the feet claim as floors (stairs);
  // anything taller is a wall. The body's floor query caps at
  // feet + stepUp so an overhead deck can't teleport it up.
  stepUp: 0.55,
  // Jetpack thrust. The kinematics live in the sim; the energy economy
  // is modelled by the server shadow (RoomMoveSim) so a client can't
  // claim more jet than the tank allows - numbers mirror the client's
  // skills.ts economy.
  jetForceUp: 35,
  jetForceDir: 10,
  // Horizontal-speed ceiling for jet thrust's velocity-aligned share:
  // past it only the perpendicular (steering) share applies - jets
  // steer and lift but can't pump forward speed forever. Ports the
  // maxForwardAccelSpeed rule from the Unity RB_Controller jetpack.
  jetMaxFwdAccel: 50,
  // T1 collision damage (floodyberry part 3): every contact kill with
  // -v·n past minSpeed pays (impact - minSpeed) * scale of the health
  // bar. Damage is a FRACTION - callers multiply by maxHealth. The
  // normal-component read is what makes downslope landings free at any
  // speed (skiing exists because v·n ≈ 0, not because of a speed cap).
  fallDamageMinSpeed: 25,
  fallDamageScale: 0.005,
  // Below this share of max hp the landing is absorbed entirely - a
  // grazed knee shouldn't chip the bar (dust + shake still fire).
  fallDamageAbsorbFrac: 0.1,
  // Player-vs-player contact: capsule half-width and the elastic share
  // of the bump - a juggernaut eating a capper keeps most of its line,
  // the light one takes the shove (Tribes bodyblock, not a brick wall).
  playerRadius: 0.6,
  bodyRestitution: 0.55,
  // Gameplay water (a map `water` block - see MoveSim.waterLevel). A body
  // whose feet are below the surface is a buoyant volume: linear drag
  // bleeds every axis (deterministic - no exp), buoyancy cancels gravity
  // at a partial submergence so a swimmer floats with the eye at the
  // surface, a sink clamp keeps a diver off the floor, and a water landing
  // waives fall damage. All scaled by submersion; a map with no water
  // level runs none of it, so every dry map is bit-identical.
  waterDrag: 3.2,        // per-second linear damping at full submergence
  waterBuoy: 46,         // upward accel at full submergence (> |GRAVITY|)
  waterSinkSpeed: 5,     // terminal sink (m/s) - no free dive to the bed
  waterSwimAccel: 260,   // horizontal wish push while submerged (m/s²)
  waterSwimSpeed: 6,     // horizontal speed cap in water (m/s)
  // Water dome (the watersphere pack): a POCKET of sea dropped on the
  // ground. Same drag law as the sea, but no buoyancy (it is a puddle,
  // not a sea - nothing floats up out of it) and no fall-damage waiver.
  // The cap is the slow: a body wading through tops out at the cap
  // instead of its class speed, so a skier blasting past loses the run.
  waterDomeDrag: 6.5,    // per-second linear damping at full submersion (all axes)
  waterDomeSpeed: 5,     // horizontal speed cap inside the dome (m/s)
  // Tether snare (the tether pack): outward speed bled per second by how
  // fast you're going - a full stop under tetherStopSpeed, 20% at
  // tetherMidSpeed, nothing at tetherFreeSpeed. Fast skiers blow through.
  tetherStopSpeed: 20,
  tetherMidSpeed: 60,
  tetherMidSlow: 0.2,
  tetherFreeSpeed: 80 } as const;

/** Fraction of horizontal speed a tether bleeds per second at speed v
 *  (1 = full stop). Piecewise linear through the three MOVEMENT_CONFIG
 *  anchors; zero at and above tetherFreeSpeed. */
export function tetherSlow(v: number): number {
  const c = MOVEMENT_CONFIG;
  if (v <= c.tetherStopSpeed) {return 1;}
  if (v <= c.tetherMidSpeed) {return 1 - (1 - c.tetherMidSlow) * (v - c.tetherStopSpeed) / (c.tetherMidSpeed - c.tetherStopSpeed);}
  if (v >= c.tetherFreeSpeed) {return 0;}
  return c.tetherMidSlow * (c.tetherFreeSpeed - v) / (c.tetherFreeSpeed - c.tetherMidSpeed);
}

/** Jet/skill energy economy - the authoritative copy for the server
 *  shadow; client skills.ts holds the same numbers for local HUD. */
export const ENERGY = {
  max: 60,
  jetDrain: 15,      // per second while thrusting
  jetCharge: 8,      // per second off the jet - held skill channels suppress it
  // T2 sputter lock: bottoming the tank refuses jets for this long even
  // after regen trickles fuel back - kills tap-hopping on fumes.
  jetLockout: 0.5,
  cloakCost: 10,
  // Cloak upkeep is priced by motion: static ~1/s, draining to 10/s at
  // 100 m/s - the infiltrator pays for speed, not for existing.
  cloakDrainMin: 1, cloakDrainMax: 10, cloakDrainSpeedMps: 100,
  shieldCost: 20, shieldDrain: 5,
  mendCost: 20, mendDrain: 15,
  // One-shot skills (blink/dash/slam/warp/bounce) ante the whole burst -
  // priced against the jet tank so a trick always trades mobility.
  skillCost: 30,
  shieldDmgPerEnergy: 10, // absorbed damage burns this much of a point
} as const;

/** Cloak drain per second at a given horizontal speed (m/s). */
export function cloakDrainPerSec(speed: number): number {
  const t = Math.min(Math.max(speed, 0) / ENERGY.cloakDrainSpeedMps, 1);
  return ENERGY.cloakDrainMin + (ENERGY.cloakDrainMax - ENERGY.cloakDrainMin) * t;
}

export interface Vec3Like { x: number; y: number; z: number }

export interface MoveState {
  pos: Vec3Like;
  vel: Vec3Like;
  yaw: number;
  pitch: number;
  onGround: boolean;
  /** Team id when the host knows it - lets team-gated colliders (gate
   *  shields) pass allies while blocking enemies. Absent = unaffiliated,
   *  shields treat the body as hostile. */
  team?: string;
}

export interface MoveInput {
  forward: number; // -1..1
  right: number; // -1..1
  jumpPressed: boolean;
  jumpHeld: boolean;
  skiHeld: boolean;
  jetHeld: boolean;
}

/** Full sim picture for deterministic replay - MoveState plus the
 *  scratch the step function carries between quanta. */
export interface SimSnapshot {
  st: MoveState;
  input: MoveInput;
  wishJump: boolean;
  allowNextJump: boolean;
  lastJumpableNormal: Vec3Like;
  groundedBuffered: boolean;
  acc: number;
  groundGraceT: number;
  /** Eye-above-floor gap at last collideTerrain - gates the grounded
   *  gravity cancel. Restored so replay keeps the same glue window. */
  bandDist: number;
  /** Post-impulse airtime window - restored so replay keeps the same
   *  re-ground suppression on a blast-launched body. */
  impulseT: number;
  /** Last step's skiHeld - the Jumpstart boost is edge-triggered; a
   *  snapshot taken mid-press must not re-fire it on restore. */
  wasSkiHeld?: boolean;
}

/** What the sim needs from the world: terrain height + surface normal.
 *  `maxTop` bounds which raised floors count (a body's reach is its
 *  feet + stepUp - overhead decks are ceilings, not ground). */
export interface MoveSurface {
  getHeight(x: number, z: number, maxTop?: number): number;
  getNormal(x: number, z: number, out: Vec3Like, maxTop?: number): Vec3Like;
  /** Solid-layer push-out (map structures): surfaces that layer boxes
   *  over terrain resolve wall/ceiling contact here, before the floor
   *  clamp. `height` is the body's eye-above-feet so a heavy's head
   *  clears a taller slab than a light's. Plain heightfield surfaces
   *  leave it undefined. */
  resolveBody?(s: MoveState, height: number, impact?: { v: number }): void;
}

/** A neighbor body for contact resolution - eye-position capsule like
 *  the sim's own (feet span y-h..y); vx/vz let the bump price closing
 *  speed instead of pure geometry. Hosts rebuild this list each tick. */
export interface BodyCapsule { x: number; y: number; z: number; h: number; mass: number; vx: number; vz: number; r: number; id?: string }

export const GRAVITY = -28;

// Scalar scratch - no Vec3 allocation in the hot path.
const _in = { x: 0, y: 0, z: 0 };
const _n = { x: 0, y: 1, z: 0 };

export class MoveSim {
  readonly state: MoveState;
  readonly input: MoveInput = { forward: 0, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: false, jetHeld: false };

  private groundedBuffered = false;
  private wishJump = false;
  private lastJumpableNormal = { x: 0, y: 1, z: 0 };
  private groundGraceT = 0;
  private allowNextJump = true;
  /** Fixed-step accumulator - the sim integrates at a constant 60Hz on
   *  both ends so a 144Hz client and a 30Hz server tick produce the same
   *  trajectory for the same input stream (variable dt is the top source
   *  of false divergence). Sub-step remainder carries to the next update. */
  private acc = 0;
  static readonly STEP = 1 / 60;
  /** Cap catch-up work after a stall - a huge dt would otherwise spin
   *  hundreds of steps in one call. */
  static readonly MAX_DT = 0.25;

  constructor(private surface: MoveSurface, initial: MoveState) {
    this.state = initial;
  }

  /** Armor-class ground multiplier (light >1, heavy <1): scales ground
   *  acceleration AND the walk cap. Ski momentum and jet thrust stay
   *  untouched - a heavy still carries ski speed downhill like Tribes. */
  speedScale = 1;
  /** Armor-class mass - jet thrust divides by it (the jet is a force,
   *  not an accel grant) and the server divides blast impulses by it. */
  mass = 1;
  /** Eye height above feet - pos.y IS the eye point; grounded checks and
   *  the floor clamp stand the body this tall. */
  eyeHeight: number = MOVEMENT_CONFIG.playerHeight;
  /** Contact half-width - set per armor class like mass/eyeHeight; a
   *  narrow class is harder to block, same as its hit capsule. */
  bodyRadius: number = MOVEMENT_CONFIG.playerRadius;
  /** Airborne downward speed cap (m/s); <=0 disables the clamp entirely. */
  terminalVelocity: number = MOVEMENT_CONFIG.terminalVelocity;
  /** Sea-surface height in world meters - the map's water.level. Undefined
   *  on a dry map, where water physics is exactly zero. Every host that
   *  runs a sim (server shadow, client prediction, bots, judge probe)
   *  copies the level in so the replay stays identical. */
  waterLevel?: number;
  /** A local pocket of water - the watersphere pack plants a dome of sea
   *  on the ground. Its top is a hemisphere over (x,y,z), so the water
   *  surface at horizontal distance d is y + sqrt(r²-d²). Bodies inside
   *  wade: the sea's drag law, no buoyancy, no fall-damage waiver.
   *  Undefined = no dome. Hosts that run a sim copy it in so the replay
   *  stays identical - same law as waterLevel. */
  waterDome?: { x: number; y: number; z: number; r: number };
  /** Jumpstart perk m/s - granted once on the ski-press edge, only while
   *  below the class walk cap. Hosts set it from perkMods; 0 = no perk. */
  jumpstart = 0;
  /** The tether snare this body is standing in (enemy-side only - the host
   *  clears it otherwise). Same copy-in law as waterDome. */
  tether?: { x: number; y: number; z: number; r: number };
  /** Slow fraction the tether applied on the last step - the host reads it
   *  to size the detach zap; transient, never on the wire. */
  tetherSlowNow = 0;
  /** 0..1 submersion (feet-below-surface / eyeHeight) at the last step -
   *  host/HUD readout, transient by design (never carried on the wire). */
  waterSubmersion = 0;

  /** Other players' capsules this tick - contact resolve reads it after
   *  terrain so a stand mate is as solid as the deck under him. Hosts
   *  assign the shared list directly; selfId excludes this sim's own
   *  capsule (a zero-distance hit would push it off itself). */
  bodies: BodyCapsule[] = [];
  /** Optional broad-phase: when the host runs many shadows (server),
   *  it passes a per-tick spatial query instead of every shadow
   *  scanning the whole roster - same candidate set, just reachable. */
  bodiesNear?: (x: number, z: number) => Iterable<BodyCapsule>;
  selfId = '';
  /** Last measured eye-above-floor gap, written by collideTerrain -
   *  0 at contact, the band distance inside the glue band, Infinity
   *  airborne. Gates the grounded gravity cancel (applyMovement) so a
   *  body grounded mid-band while still falling doesn't freeze.
   *  Starts at contact: a grounded sim that has never collided yet is
   *  walking, not floating - Infinity starved its first-tick traction. */
  private bandDist = 0;
  /** Post-impulse airtime window - the ground glue can't re-ground a
   *  blast-launched body before the arc plays out (see impulse()). */
  private impulseT = 0;
  /** Previous step's skiHeld - the Jumpstart boost fires on the press
   *  EDGE, so replay must carry it like wishJump (see snapshot()). */
  private wasSkiHeld = false;
  /** Worst -v·n (m/s) recorded at a contact kill during this update() -
   *  the T1 impact speed: callers past fallDamageMinSpeed pay
   *  (impact - min) * scale * maxHealth. Read after update(); transient
   *  by design (replay re-derives it, snapshots never carry it). */
  landingImpact = 0;
  /** Transient fall-damage multiplier - the howitzer's recoil arms it
   *  so the launcher-kick pays like a real fall without juicing the
   *  impulse itself. Decays to 1 inside update(); transient by design
   *  (replay re-derives it, snapshots never carry it). */
  fallBoost = 1;
  /** Arm the fall-damage multiplier for the next landing window. */
  armFallBoost(n: number): void { this.fallBoost = Math.max(this.fallBoost, n); }
  /** resolveBody's out-sink - solid contacts record -v·n here so wall
   *  and ceiling slams pay the same price as a floor landing (T1's
   *  impactDot is any surface's normal component). */
  private readonly _solidImpact = { v: 0 };

  setInput(input: Partial<MoveInput>): void {
    // Claimed input is the trust boundary - the server replays these on a
    // shadow sim, so a doctored magnitude (forward=999) or a NaN bitfield
    // is a speedhack/poison lane, not just a bad local frame.
    if (input.forward !== undefined) {this.input.forward = Number.isFinite(input.forward) ? Math.max(-1, Math.min(1, input.forward)) : 0;}
    if (input.right !== undefined) {this.input.right = Number.isFinite(input.right) ? Math.max(-1, Math.min(1, input.right)) : 0;}
    if (input.jumpPressed !== undefined) {this.input.jumpPressed = Boolean(input.jumpPressed);}
    if (input.jumpHeld !== undefined) {this.input.jumpHeld = Boolean(input.jumpHeld);}
    if (input.skiHeld !== undefined) {this.input.skiHeld = Boolean(input.skiHeld);}
    if (input.jetHeld !== undefined) {this.input.jetHeld = Boolean(input.jetHeld);}
  }

  /** External impulse (blast knockback). An upward shove IS a launch -
   *  impulse velocity isn't contact velocity, but the ground-glue launch
   *  gate (velDotN > groundLaunchVel) can't tell them apart and quietly
   *  absorbed every sub-3 m/s blast pop: the victim's shadow sat on the
   *  floor through the arc (blastShove measured ~0m mid-flight). */
  impulse(dv: Vec3Like): void {
    if (!Number.isFinite(dv.x + dv.y + dv.z)) {return;}
    const v = this.state.vel;
    v.x += dv.x; v.y += dv.y; v.z += dv.z;
    if (dv.y > 0 || (dv.y < -8 && this.state.onGround)) {
      this.state.onGround = false;
      this.groundedBuffered = false;
      this.groundGraceT = 0;
      // Without the window the very next collideTerrain re-grounds it:
      // a sub-3 m/s shove reads velDotN below the launch gate and the
      // band keeps the body grounded while the arc drains into glue.
      // Downward kicks (howitzer recoil) unground too - the body must be
      // airborne for the floor contact to record a landing impact; the
      // ground-glue would cancel the shove silently otherwise.
      this.impulseT = 0.35;
    }
  }

  setState(s: MoveState): void {
    // The one write site for the sim anchor - a non-finite state from
    // ANY caller (wire restore, replay snapshot, spawn seed) poisons
    // every integration step after it. Callers gate too, but the law
    // holds only if it's enforced where the write happens.
    if (!Number.isFinite(s.pos.x + s.pos.y + s.pos.z + s.vel.x + s.vel.y + s.vel.z + s.yaw + s.pitch)) {return;}
    this.state.pos.x = s.pos.x; this.state.pos.y = s.pos.y; this.state.pos.z = s.pos.z;
    this.state.vel.x = s.vel.x; this.state.vel.y = s.vel.y; this.state.vel.z = s.vel.z;
    this.state.yaw = s.yaw; this.state.pitch = s.pitch; this.state.onGround = s.onGround;
  }

  /** Everything setState misses: the step residue and the jump/ground
   *  edge bookkeeping. Replaying a window from a bare MoveState loses
   *  the in-flight edges (a jump held across the anchor, the carry
   *  fraction of a step) and the replayed trajectory drifts on the
   *  first boundary - deterministic replay needs the whole picture. */
  snapshot(): SimSnapshot {
    return {
      st: { pos: Object.assign({}, this.state.pos), vel: Object.assign({}, this.state.vel), yaw: this.state.yaw, pitch: this.state.pitch, onGround: this.state.onGround },
      input: Object.assign({}, this.input),
      wishJump: this.wishJump, allowNextJump: this.allowNextJump,
      lastJumpableNormal: Object.assign({}, this.lastJumpableNormal),
      groundedBuffered: this.groundedBuffered, acc: this.acc,
      groundGraceT: this.groundGraceT,
      bandDist: this.bandDist,
      impulseT: this.impulseT, wasSkiHeld: this.wasSkiHeld };
  }

  restore(snap: SimSnapshot): void {
    this.setState(snap.st);
    Object.assign(this.input, snap.input);
    this.wishJump = snap.wishJump; this.allowNextJump = snap.allowNextJump;
    Object.assign(this.lastJumpableNormal, snap.lastJumpableNormal);
    this.groundedBuffered = snap.groundedBuffered;
    this.acc = Number.isFinite(snap.acc) ? snap.acc : 0;
    this.groundGraceT = snap.groundGraceT;
    // Legacy snapshots predate bandDist - derive it from the restored
    // contact flag: grounded = contact, airborne = outside the band.
    this.bandDist = snap.bandDist ?? (snap.st.onGround ? 0 : Infinity);
    this.impulseT = snap.impulseT ?? 0;
    // Legacy snapshots predate the ski edge - assume the held state
    // persisted so a restore mid-hold can't re-fire a Jumpstart boost.
    this.wasSkiHeld = snap.wasSkiHeld ?? snap.input.skiHeld;
  }

  update(dt: number): void {
    // NaN dt would poison acc permanently - `NaN >= STEP` never drains
    // and the sim freezes until a snapshot/setState reseed.
    if (!Number.isFinite(dt)) {return;}
    this.landingImpact = 0;
    this.fallBoost = Math.max(1, this.fallBoost - 3 * dt); // ~0.66s from 3x
    this.tetherSlowNow = 0;
    this.acc += Math.min(dt, MoveSim.MAX_DT);
    while (this.acc >= MoveSim.STEP) {
      this.acc -= MoveSim.STEP;
      this.step(MoveSim.STEP);
    }
  }

  // Jumpstart perk: on the ski-press edge a body at/below its class
  // walk cap gets a flat +jumpstart m/s launch - max payout is
  // cap + jumpstart, and pressing at pace (> cap) buys nothing.
  // Fires here in step() (not setInput) so the edge lands inside the
  // fixed-step stream and client prediction and server shadow replay
  // it identically.
  private jumpstartKick(): void {
    if (this.jumpstart <= 0) {return;}
    // LAUNCH means ground: an airborne ski-press was a free +8 m/s
    // horizontal boost — an uncapped air-jump, not a perk.
    const s = this.state;
    if (!(s.onGround || this.groundedBuffered)) {return;}
    const hs = dhypot2(s.vel.x, s.vel.z);
    if (hs > MOVEMENT_CONFIG.maxVelocityGround * this.speedScale + 0.001) {return;}
    const dir = this.inputDirection();
    const dl = dhypot2(dir.x, dir.z);
    let ux: number, uz: number;
    if (hs > 0.5) { ux = s.vel.x / hs; uz = s.vel.z / hs; }
    else if (dl > 0) { ux = dir.x; uz = dir.z; }
    else { ux = dsin(s.yaw); uz = dcos(s.yaw); }
    s.vel.x += ux * this.jumpstart;
    s.vel.z += uz * this.jumpstart;
  }

  private step(dt: number): void {
    // Auto-hop: jump key acts as hold-to-jump.
    if (MOVEMENT_CONFIG.autoHop) {this.wishJump = this.input.jumpHeld;}
    else if (this.input.jumpPressed) {this.wishJump = true;}
    else {this.wishJump = this.wishJump && this.input.jumpHeld;}

    this.groundedBuffered = this.checkGrounded();
    this.impulseT = Math.max(0, this.impulseT - dt);

    const skiEdge = this.input.skiHeld && !this.wasSkiHeld;
    this.wasSkiHeld = this.input.skiHeld;
    if (skiEdge) {this.jumpstartKick();}

    const anyGrounded = this.state.onGround || this.groundedBuffered;
    if (this.allowNextJump && anyGrounded && this.wishJump) {
      this.allowNextJump = false;
      this.state.onGround = false;
      this.groundedBuffered = false;
      this.jump();
    }

    this.applyMovement(dt);

    // Jetpack thrust rides after collision resolution - same order the
    // client used to apply it post-sync - so ground clamping can't eat
    // the lift and the trajectory stays identical on both ends. A held
    // jet is treated as airborne everywhere it matters (applyGround's
    // friction, the snap band, and the floor-clamp rising gate all
    // exempt jetHeld): without that, the sim parked the body on the
    // ground until vel.y accrued past the 3 m/s launch gate - a ~0.9s
    // dead-zone of paid-for thrust that produced nothing. Mass is
    // real: the config values are force, accel = F/m - a heavy mech
    // climbs slower on the same burn, a light floats.
    if (this.input.jetHeld) {
      const dir = this.inputDirection();
      const s = this.state;
      const im = dt / this.mass;
      s.vel.y += MOVEMENT_CONFIG.jetForceUp * im;
      const hv = dhypot2(s.vel.x, s.vel.z);
      let tx = dir.x, tz = dir.z;
      if (hv >= MOVEMENT_CONFIG.jetMaxFwdAccel && hv > 0) {
        // Past the cap the velocity-aligned thrust component drops out
        // (SplitVector + alignedWithVelocity=0 in the Unity original);
        // the perpendicular steering share still applies.
        const vx = s.vel.x / hv, vz = s.vel.z / hv;
        const aligned = tx * vx + tz * vz;
        tx -= vx * aligned; tz -= vz * aligned;
      }
      s.vel.x += tx * MOVEMENT_CONFIG.jetForceDir * im;
      s.vel.z += tz * MOVEMENT_CONFIG.jetForceDir * im;
      s.onGround = false;
    }
  }

  private checkGrounded(threshold = 0.2, offset = this.eyeHeight): boolean {
    const reach = this.state.pos.y - offset + MOVEMENT_CONFIG.stepUp;
    const groundY = this.surface.getHeight(this.state.pos.x, this.state.pos.z, reach) + offset;
    const dist = this.state.pos.y - groundY;
    return this.input.skiHeld
      ? dist < threshold + MOVEMENT_CONFIG.skiTargetDistance
      : dist < threshold;
  }

  private inputDirection(): Vec3Like {
    const fwdX = dsin(this.state.yaw), fwdZ = dcos(this.state.yaw);
    const rgtX = -fwdZ, rgtZ = fwdX;
    const mx = fwdX * this.input.forward + rgtX * this.input.right;
    const mz = fwdZ * this.input.forward + rgtZ * this.input.right;
    _in.x = mx; _in.y = 0; _in.z = mz;
    const len = dhypot2(mx, mz);
    if (len > 0) { _in.x /= len; _in.z /= len; }
    return _in;
  }

  private jump(): void {
    const dir = this.inputDirection();
    const impulse = MOVEMENT_CONFIG.jumpSpeed;
    const surfaceY = this.lastJumpableNormal.y;
    const dirLen = dhypot2(dir.x, dir.z);
    const orientation = dirLen > 0
      ? (this.lastJumpableNormal.x * dir.x + this.lastJumpableNormal.z * dir.z)
      : 0;

    this.state.vel.y += impulse * surfaceY;
    if (dirLen === 0) {
      // No movement input - jump along the slope's horizontal component.
      this.state.vel.x += this.lastJumpableNormal.x * impulse;
      this.state.vel.z += this.lastJumpableNormal.z * impulse;
    } else if (orientation > 0) {
      this.state.vel.x += dir.x * impulse * orientation;
      this.state.vel.z += dir.z * impulse * orientation;
    }
  }

  private applyMovement(dt: number): void {
    const dir = this.inputDirection();
    const s = this.state;

    // Ski preserves momentum and nothing else - no motor, no push-off:
    // a stationary skier stays stopped until they walk (release ski) or
    // fire the Jumpstart edge. Below the (unscaled) speed gate they
    // still need ground physics for the slope/band machinery.
    // A held jet is airborne physics full stop: ground friction would
    // zero the thrust's small per-step velocity gain before it ever
    // accumulated to a launch (the ~0.9s standstill dead-zone).
    const hSpeed = dhypot2(s.vel.x, s.vel.z);
    if (s.onGround && !this.wishJump && !this.input.jetHeld && !(this.input.skiHeld && hSpeed > MOVEMENT_CONFIG.maxVelocityGround * this.speedScale)) {
      this.applyGround(dt, dir);
    }
    if (!s.onGround) {
      // Magnitude-preserving air control (Tribes-style lateral shift).
      const shift = { x: dir.x * MOVEMENT_CONFIG.airControl, y: 0, z: dir.z * MOVEMENT_CONFIG.airControl };
      const startY = s.vel.y;
      s.vel.y = 0;
      const startMag = Math.max(dhypot2(s.vel.x, s.vel.z), MOVEMENT_CONFIG.maxPassiveAirvel);
      s.vel.x += shift.x; s.vel.z += shift.z;
      const mag = dhypot2(s.vel.x, s.vel.z);
      if (mag > startMag && mag > 0) { s.vel.x *= startMag / mag; s.vel.z *= startMag / mag; }
      s.vel.y = startY;
    }
    // Gravity applies always - grounded contact kills the into-slope
    // component every tick and only the tangential slide survives
    // (T1 model: no grounded/airborne gravity distinction). The fall
    // clamp stays airborne-only: a skier glued to a downslope feeds
    // tangential speed through the contact, so clamping vel.y while
    // grounded silently capped downhill speed at terminal/sin(slope).
    s.vel.y += GRAVITY * dt;
    if (!s.onGround && this.terminalVelocity > 0 && s.vel.y < -this.terminalVelocity) {s.vel.y = -this.terminalVelocity;}
    // Gameplay water: below the surface the body is buoyant. Depth is how
    // far the FEET sit under; submersion (0..1) scales every force. Drag
    // runs on all three axes so a fast entry bleeds off, buoyancy cancels
    // gravity near sub≈0.6 (eye at the surface), the sink clamp stops a
    // free dive to the bed, and a horizontal swim force + cap keeps water
    // playable. Past half-submerged the terrain glue is cleared - buoyancy,
    // not the floor, holds the body. No level → none of this runs.
    if (this.waterLevel === undefined) {
      this.waterSubmersion = 0;
    } else {
      const depth = this.waterLevel - (s.pos.y - this.eyeHeight);
      if (depth > 0) {
        const sub = Math.min(depth / this.eyeHeight, 1);
        this.waterSubmersion = sub;
        s.vel.y += MOVEMENT_CONFIG.waterBuoy * sub * dt;
        const k = Math.max(0, 1 - MOVEMENT_CONFIG.waterDrag * sub * dt);
        s.vel.x *= k; s.vel.y *= k; s.vel.z *= k;
        if (sub > 0.15) {
          const acc = MOVEMENT_CONFIG.waterSwimAccel * sub * dt;
          s.vel.x += dir.x * acc; s.vel.z += dir.z * acc;
          const hs = dhypot2(s.vel.x, s.vel.z);
          if (hs > MOVEMENT_CONFIG.waterSwimSpeed) {
            const f = MOVEMENT_CONFIG.waterSwimSpeed / hs;
            s.vel.x *= f; s.vel.z *= f;
          }
        }
        if (s.vel.y < -MOVEMENT_CONFIG.waterSinkSpeed) {s.vel.y = -MOVEMENT_CONFIG.waterSinkSpeed;}
        if (sub > 0.5) { s.onGround = false; this.bandDist = Infinity; }
      } else {
        this.waterSubmersion = 0;
      }
    }
    // Water dome (the watersphere pack) - a pocket of sea standing on the
    // ground. The dome's top is a hemisphere over its centre, so the
    // water surface at horizontal distance d is y + sqrt(r²-d²): a body
    // at the centre stands fully under it, a body at the rim is dry.
    // All-axis exponential damp like the sea's drag, plus a horizontal
    // cap - no buoyancy (nothing floats out of a puddle) and no
    // fall-damage waiver (a puddle is not a safe landing). The cap is
    // what slows a skier: inside the dome a body tops out at the cap
    // instead of its class speed.
    if (this.waterDome !== undefined) {
      const dm = this.waterDome;
      const ddx = s.pos.x - dm.x, ddz = s.pos.z - dm.z;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 < dm.r * dm.r) {
        const surf = dm.y + Math.sqrt(dm.r * dm.r - d2);
        const depth = surf - (s.pos.y - this.eyeHeight);
        if (depth > 0) {
          const sub = Math.min(depth / this.eyeHeight, 1);
          const k = Math.max(0, 1 - MOVEMENT_CONFIG.waterDomeDrag * sub * dt);
          s.vel.x *= k; s.vel.y *= k; s.vel.z *= k;
          const hs = dhypot2(s.vel.x, s.vel.z);
          const cap = MOVEMENT_CONFIG.waterDomeSpeed * sub;
          if (hs > cap && hs > 0) {
            const f = cap / hs;
            s.vel.x *= f; s.vel.z *= f;
          }
        }
      }
    }
    // Tether snare: only the OUTWARD radial component inside the ring is
    // bled - walking in and strafing along the ring are free, the drag
    // lands when you try to leave. Full stop bleeds the whole radial push
    // so a crawl can't creep past the rim on drag rounding.
    if (this.tether !== undefined) {
      const tt = this.tether;
      const tdx = s.pos.x - tt.x, tdz = s.pos.z - tt.z;
      const rr = tdx * tdx + tdz * tdz;
      const hs = dhypot2(s.vel.x, s.vel.z);
      const rad = tdx * s.vel.x + tdz * s.vel.z;
      if (rr < tt.r * tt.r && rr > 0 && rad > 0) {
        const f = tetherSlow(hs);
        this.tetherSlowNow = Math.max(this.tetherSlowNow, f);
        // vRad = vel·r̂ - the outward share, cut by the slow fraction.
        // Tangential motion is untouched: you circle the snare freely.
        const inv = 1 / Math.sqrt(rr);
        const vRad = rad * inv;
        const bleed = f >= 1 ? vRad : vRad * f * dt;
        s.vel.x -= tdx * inv * bleed; s.vel.z -= tdz * inv * bleed;
      }
    }
    // T1 ground glue: while grounded AT CONTACT distance, cancel
    // gravity's into-surface share BEFORE integrating - the Torque
    // order (normal force kills acc·n each tick) keeps velocity
    // slope-parallel, so a walker follows the face downhill instead of
    // leaving a one-step gap the snap band has to chase. Without this,
    // walking down any real slope detached into a ballistic hop every
    // few steps. The cancel must NOT fire in the outer glue band: a
    // body falling into the band gets grounded (T1 contact distance)
    // while still above the floor - canceling gravity there freezes it
    // mid-air at band edge forever (drop-on-stand tests float ~1.8m up).
    // Contact = ~0.1m, not groundSnapDistance - at exactly the band's
    // inner edge the body parked in contact-without-touch and still
    // floated (0.6m up).
    if (s.onGround && this.bandDist <= 0.1) {
      const n = this.surface.getNormal(s.pos.x, s.pos.z, _n);
      const vdn = s.vel.x * n.x + s.vel.y * n.y + s.vel.z * n.z;
      if (vdn < 0) {
        s.vel.x -= n.x * vdn; s.vel.y -= n.y * vdn; s.vel.z -= n.z * vdn;
      }
    }

    s.pos.x += s.vel.x * dt;
    s.pos.y += s.vel.y * dt;
    s.pos.z += s.vel.z * dt;

    this.collideTerrain();
    this.collideBodies();
  }

  private collideBodies(): void {
    const s = this.state;
    if (this.bodies.length === 0 && !this.bodiesNear) {return;}
    const feet = s.pos.y - this.eyeHeight;
    for (const b of this.bodiesNear ? this.bodiesNear(s.pos.x, s.pos.z) : this.bodies) {
      if (b.id === this.selfId) {continue;}
      const rr = this.bodyRadius + b.r;
      if (feet >= b.y || s.pos.y <= b.y - b.h) {continue;}
      const dx = s.pos.x - b.x, dz = s.pos.z - b.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) {continue;}
      const d = Math.sqrt(d2) || 0.001;
      const nx = dx / d, nz = dz / d;
      // Half-separation per side - the neighbor's own sim moves its half
      // on its tick, so a mutual contact opens to the full overlap
      // without either side teleporting.
      const push = (rr - d) * 0.5;
      s.pos.x += nx * push;
      s.pos.z += nz * push;
      const vn1 = s.vel.x * nx + s.vel.z * nz;
      const vn2 = b.vx * nx + b.vz * nz;
      if (vn1 - vn2 < 0) {
        // Momentum-weighted bump along the contact normal - mass is the
        // whole point of a juggernaut eating a light capper's line.
        const m1 = this.mass, m2 = b.mass;
        const vn1p = (m1 * vn1 + m2 * vn2 + MOVEMENT_CONFIG.bodyRestitution * m2 * (vn2 - vn1)) / (m1 + m2);
        s.vel.x += (vn1p - vn1) * nx;
        s.vel.z += (vn1p - vn1) * nz;
      }
    }
  }

  private applyGround(dt: number, dir: Vec3Like): void {
    const s = this.state;
    const n = this.surface.getNormal(s.pos.x, s.pos.z, _n);
    const dirLen = dhypot2(dir.x, dir.z);
    const maxGround = MOVEMENT_CONFIG.maxVelocityGround * this.speedScale;
    // Ski is a friction toggle: no overspeed bleed, but legs still
    // work - below the class walk cap a held direction gets the SAME
    // bounded converge-to-wish force a walker does, so a stopped skier
    // still pushes off (pure removal froze ski-held bots at rest: the
    // capper stall). Above the cap ski adds and bleeds nothing.
    // The old groundAccelerate branch instead pumped to the UNSCALED
    // gate in one step - +8.9 to +12.2 m/s bought on flat, medium hit
    // 23 m/s at a ski press (_docs/2026-10-23_SKI_FLAT_OVERSPEED.md).
    const skiPushOff = this.input.skiHeld && dirLen > 0 && dhypot2(s.vel.x, s.vel.z) < maxGround;

    // Redirect velocity along the slope (kill the into-ground component).
    // Contact-distance only - a body grounded mid-band (glue range, not
    // touching) must keep falling: killing velDotN here parked a drop at
    // band edge ~0.9m above the face forever.
    const velDotN = s.vel.x * n.x + s.vel.y * n.y + s.vel.z * n.z;
    if (velDotN < 0 && this.bandDist <= 0.1) {
      s.vel.x -= n.x * velDotN; s.vel.y -= n.y * velDotN; s.vel.z -= n.z * velDotN;
    }

    // T1 Friction(): while in contact, ground force converges TANGENTIAL
    // velocity toward the desired move speed with a bounded accel
    // (GROUNDFORCE/MASS × GROUNDTRACTION = 40×3 = 120 in T1 units).
    // Traction is why a Tribes walker holds ~walk speed downhill - the
    // slope pump is drained every contact tick - instead of sliding
    // into a ski run. It also owns stopping (wish=0) and overspeed
    // (shoves bleed to cap at the same force). Skiers exempt by design:
    // ski is literally "break contact with this force".
    // Contact-distance only: mid-band the force bleeds the FALL too -
    // a drop grounded inside glue range parachuted at crawl speed.
    if ((!this.input.skiHeld || skiPushOff) && this.bandDist <= 0.1) {
      // Idle feet must hold against gravity's tangential drip: collide
      // kills only the normal part of this step's GRAVITY*dt, so converge
      // the velocity gravity is ABOUT to leave behind - otherwise one
      // step's worth of slide residue escapes traction and integrates
      // into a constant downhill creep. Input ticks keep the plain
      // converge - a steering walker owns its slope pump.
      const gravY = dirLen === 0 ? s.vel.y + GRAVITY * dt : s.vel.y;
      const vdn = s.vel.x * n.x + gravY * n.y + s.vel.z * n.z;
      const keep = Math.max(vdn, 0);
      const tx = s.vel.x - n.x * keep, ty = gravY - n.y * keep, tz = s.vel.z - n.z * keep;
      // Wish velocity projected onto the face, capped at walk speed.
      const wx = dir.x * maxGround, wz = dir.z * maxGround;
      const wdn = wx * n.x + wz * n.z;
      const dx = wx - n.x * wdn - tx, dy = -n.y * wdn - ty, dz = wz - n.z * wdn - tz;
      const dLen = dhypot3(dx, dy, dz);
      const force = MOVEMENT_CONFIG.groundTractionAccel * this.speedScale * dt;
      const k = dLen > force && dLen > 0 ? force / dLen : 1;
      s.vel.x += dx * k; s.vel.y += dy * k; s.vel.z += dz * k;
    }
  }

  // oxlint-disable-next-line complexity -- the terrain contact state machine (penetration / band / grace) is one decision surface; splitting it re-tunes the branches it interleaves
  private collideTerrain(): void {
    const s = this.state;
    // T1 MAXJUMPTICKS grace: burn the lingering-contact window per step;
    // contact sites below refill it. Launches zero it explicitly.
    if (this.groundGraceT > 0) { this.groundGraceT -= MoveSim.STEP; }
    // Solid layers push the capsule out of walls/ceilings first - the
    // floor clamp below only owns top faces. Impact speeds feed the
    // fall-damage meter the same way terrain contact does (T1 charges
    // any surface's -v·n, not just floors).
    this._solidImpact.v = 0;
    this.surface.resolveBody?.(s, this.eyeHeight, this._solidImpact);
    // A water landing is absorbed - splash, no hurt. Only dry contacts
    // (and the submerged body's own slams) feed the fall-damage meter.
    if (this.waterSubmersion <= 0) {this.landingImpact = Math.max(this.landingImpact, this._solidImpact.v);}
    const reach = s.pos.y - this.eyeHeight + MOVEMENT_CONFIG.stepUp;
    const groundY = this.surface.getHeight(s.pos.x, s.pos.z, reach) + this.eyeHeight;
    const dist = s.pos.y - groundY;

    if (dist < 0) {
      this.bandDist = 0;
      const n = this.surface.getNormal(s.pos.x, s.pos.z, _n, reach);
      this.lastJumpableNormal.x = n.x; this.lastJumpableNormal.y = n.y; this.lastJumpableNormal.z = n.z;

      const velDotN = s.vel.x * n.x + s.vel.y * n.y + s.vel.z * n.z;
      // Frictionless contact for everyone: the inward component dies
      // completely (tangential speed preserved 100%), the positive
      // leaving component is never touched. The snap band is what
      // keeps the body tracking terrain instead of floating.
      // The pre-kill -v·n is T1's impactDot - fall damage reads it.
      if (velDotN < 0) {
        if (this.waterSubmersion <= 0) {this.landingImpact = Math.max(this.landingImpact, -velDotN);}
        s.vel.x -= n.x * velDotN; s.vel.y -= n.y * velDotN; s.vel.z -= n.z * velDotN;
      }

      s.pos.y = groundY;
      // T1: contact is contact - grounded state has no velocity gate.
      // "Rising" can only mean leaving the surface (velDotN past the
      // launch gate) or a takeoff input; a walker climbing a steep face
      // legitimately carries vel.y > 3 slope-parallel and must not read
      // as a launch (the uphill airborne flicker that gate produced).
      // A real blast launch still separates: velDotN > gate, or the
      // position simply leaves the band next step.
      const inputTakeoff = this.input.jetHeld || this.input.jumpHeld || this.input.jumpPressed;
      const rising = velDotN > MOVEMENT_CONFIG.groundLaunchVel || (inputTakeoff && velDotN > 0)
        || (this.impulseT > 0 && velDotN > 0);
      // A takeoff input held THROUGH a landing (velDotN < 0) is a landing,
      // not a launch - mark airborne so traction doesn't grip the frame,
      // but re-arm the jump so held-hop chains refire next step. Gating
      // rising on bare inputTakeoff made one hop then a permanent slide.
      s.onGround = !rising && !inputTakeoff;
      this.allowNextJump = !rising;
      this.groundGraceT = rising || inputTakeoff ? 0 : MOVEMENT_CONFIG.groundGraceT;
    } else if (dist < MOVEMENT_CONFIG.groundSnapDistance + (this.input.skiHeld ? MOVEMENT_CONFIG.skiTargetDistance : MOVEMENT_CONFIG.walkGlueDistance)) {
      this.bandDist = dist;
      // Stick to the surface: bumps and crest lips inside the snap
      // distance keep ground contact instead of flipping airborne for a
      // frame or two. The launch gate is surface-normal velocity -
      // slope-following speed stays parallel to the face even on an
      // 80° wall, so only a real launch (jump/jet/blast) reads away.
      // Fast bodies are exempt: snapping a 30 m/s hop into grounded
      // regime buys it the overspeed bleed + friction a pre-band hop
      // never paid - walkers get stability, movers keep their arc.
      const n = this.surface.getNormal(s.pos.x, s.pos.z, _n, reach);
      const velDotN = s.vel.x * n.x + s.vel.y * n.y + s.vel.z * n.z;
      const tx0 = s.vel.x - n.x * Math.max(velDotN, 0), tz0 = s.vel.z - n.z * Math.max(velDotN, 0);
      const stickSpeed = MOVEMENT_CONFIG.maxVelocityGround * this.speedScale * 1.5;
      // Inside the band the surface is still in contact range - grounded
      // persists (T1 contact distance) UNLESS the body is really taking
      // off: a world-up velocity past the launch gate is an impulse
      // launch (blast, bounce), and re-grounding it eats the knock flat
      // - the server sim then diverges from every predicting client
      // (latency soak: corrections 52 -> 72 after the gate was dropped).
      // Skims are safe: crest lip reads velDotN launched while vel.y
      // stays small, so the world-up gate keeps them grounded.
      const takeoff = this.input.jetHeld || this.input.jumpHeld || this.input.jumpPressed;
      // Launch = leaving the face (velDotN), not world-up speed - a
      // steep-face walker's vel.y > 3 is slope-parallel, not a launch.
      // An impulse's upward velocity IS a launch no matter its size -
      // impulseT keeps the blast shove from re-grounding in the band.
      if (!takeoff && velDotN <= MOVEMENT_CONFIG.groundLaunchVel && !(this.impulseT > 0 && velDotN > 0)) {
        this.groundGraceT = MOVEMENT_CONFIG.groundGraceT;
        s.onGround = true;
      } else {
        s.onGround = false;
        this.groundGraceT = 0;
      }
      // In-band means NEAR the ground, not touching - only the jump is
      // re-armed and the normal refreshed. T1 redirects velocity only on
      // real penetration: killing inward vel here (with the pos snap
      // gone) parachuted landings at ~0.5m/s inside the band and stalled
      // held-hop chains for seconds before the next contact.
      if (velDotN <= MOVEMENT_CONFIG.groundLaunchVel && dhypot2(tx0, tz0) <= stickSpeed
        && !(takeoff && velDotN > 0)) {
        this.lastJumpableNormal.x = n.x; this.lastJumpableNormal.y = n.y; this.lastJumpableNormal.z = n.z;
        this.allowNextJump = true;
      }
    } else {
      // Outside the snap band without a takeoff input - the crest-lip
      // case T1 covered with MAXJUMPTICKS: still grounded for the grace.
      // Launch gate is surface-normal like everywhere else: a steep-face
      // walker's vel.y is slope-parallel and keeps the linger, while a
      // real impulse launch leaves the face and flies (the world-up gate
      // here blurred prediction after a stale reseed ~1m).
      const noTakeoff = !this.input.jetHeld && !this.input.jumpHeld;
      const ng = this.surface.getNormal(s.pos.x, s.pos.z, _n, reach);
      const away = s.vel.x * ng.x + s.vel.y * ng.y + s.vel.z * ng.z;
      s.onGround = noTakeoff && this.groundGraceT > 0 && away <= MOVEMENT_CONFIG.groundLaunchVel;
      if (!s.onGround) { this.groundGraceT = 0; }
      this.bandDist = Infinity;
    }
  }
}
