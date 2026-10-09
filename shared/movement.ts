/**
 * Shared player movement sim — pure math, no renderer deps. The client's
 * MovementController wraps this with THREE.Vector3 + Terrain; the server
 * drives it from inputMove messages so player physics is identical on
 * both ends (the foundation for server-authoritative movement, replay,
 * and honest anti-cheat).
 *
 * Vectors are plain {x,y,z} — THREE Vector3 satisfies that structurally.
 */

export const MOVEMENT_CONFIG = {
  maxVelocityGround: 7.0,
  groundAccelerate: 800.0,
  groundFriction: 50.0,
  stopThreshold: 1.0,
  maxPassiveAirvel: 10.0,
  airControl: 0.2,
  terminalVelocity: 100.0,
  jumpSpeed: 7.0,
  autoHop: true,
  // Horizontal overspeed bleed while grounded: blast/slide velocity above
  // the ground cap decays toward it instead of being hard-clamped — the
  // clamp used to truncate knockback impulses (including the loft that
  // makes rocket jumps) before the body ever left the floor.
  overspeedBleed: 4.0,
  // Generous grounding — Tribes walkers stay glued: any terrain is
  // walkable at any angle, and a lip/crest under this height never
  // reads airborne (the air-control steal + walk→jump anim flicker a
  // strict gate produced). A real launch — explosion loft, jet burn,
  // jump takeoff — clears the snap via the vel gate.
  groundSnapDistance: 0.6,
  groundLaunchVel: 3.0,
  // T1 parity: contact lingers 256ms (MAXJUMPTICKS=8 @ 32ms) after the
  // surface is lost — gentle crest hops stay grounded, real launches don't.
  groundGraceT: 0.256,
  // Skiing: friction toggle only — no artificial accel/boost/lift, but a
  // skier counts as grounded a little higher off the surface.
  skiTargetDistance: 0.5,
  playerHeight: 1.8,
  // Structure ledges within this of the feet claim as floors (stairs);
  // anything taller is a wall. The body's floor query caps at
  // feet + stepUp so an overhead deck can't teleport it up.
  stepUp: 0.55,
  // Jetpack thrust. The kinematics live in the sim; the energy economy
  // is modelled by the server shadow (RoomMoveSim) so a client can't
  // claim more jet than the tank allows — numbers mirror the client's
  // skills.ts economy.
  jetForceUp: 35.0,
  jetForceDir: 10.0,
  // Horizontal-speed ceiling for jet thrust's velocity-aligned share:
  // past it only the perpendicular (steering) share applies — jets
  // steer and lift but can't pump forward speed forever. Ports the
  // maxForwardAccelSpeed rule from the Unity RB_Controller jetpack.
  jetMaxFwdAccel: 50.0,
  // Player-vs-player contact: capsule half-width and the elastic share
  // of the bump — a juggernaut eating a capper keeps most of its line,
  // the light one takes the shove (Tribes bodyblock, not a brick wall).
  playerRadius: 0.6,
  bodyRestitution: 0.55,
} as const;

/** Jet/skill energy economy — the authoritative copy for the server
 *  shadow; client skills.ts holds the same numbers for local HUD. */
export const ENERGY = {
  max: 60,
  jetDrain: 15,      // per second while thrusting
  jetCharge: 8,      // per second while grounded-and-idle
  // T2 sputter lock: bottoming the tank refuses jets for this long even
  // after regen trickles fuel back — kills tap-hopping on fumes.
  jetLockout: 0.5,
  cloakCost: 10,
  // Cloak upkeep is priced by motion: static ~1/s, draining to 10/s at
  // 100 m/s — the infiltrator pays for speed, not for existing.
  cloakDrainMin: 1, cloakDrainMax: 10, cloakDrainSpeedMps: 100,
  shieldCost: 20, shieldDrain: 5,
  mendCost: 20, mendDrain: 15,
  // One-shot skills (blink/dash/slam/warp/bounce) ante the whole burst —
  // priced against the jet tank so a trick always trades mobility.
  skillCost: 50,
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
  /** Team id when the host knows it — lets team-gated colliders (gate
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

/** Full sim picture for deterministic replay — MoveState plus the
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
}

/** What the sim needs from the world: terrain height + surface normal.
 *  `maxTop` bounds which raised floors count (a body's reach is its
 *  feet + stepUp — overhead decks are ceilings, not ground). */
export interface MoveSurface {
  getHeight(x: number, z: number, maxTop?: number): number;
  getNormal(x: number, z: number, out: Vec3Like, maxTop?: number): Vec3Like;
  /** Solid-layer push-out (map structures): surfaces that layer boxes
   *  over terrain resolve wall/ceiling contact here, before the floor
   *  clamp. `height` is the body's eye-above-feet so a heavy's head
   *  clears a taller slab than a light's. Plain heightfield surfaces
   *  leave it undefined. */
  resolveBody?(s: MoveState, height: number): void;
}

/** A neighbor body for contact resolution — eye-position capsule like
 *  the sim's own (feet span y-h..y); vx/vz let the bump price closing
 *  speed instead of pure geometry. Hosts rebuild this list each tick. */
export interface BodyCapsule { x: number; y: number; z: number; h: number; mass: number; vx: number; vz: number; r: number; id?: string }

export const GRAVITY = -28.0;

// Scalar scratch — no Vec3 allocation in the hot path.
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
  /** Fixed-step accumulator — the sim integrates at a constant 60Hz on
   *  both ends so a 144Hz client and a 30Hz server tick produce the same
   *  trajectory for the same input stream (variable dt is the top source
   *  of false divergence). Sub-step remainder carries to the next update. */
  private acc = 0;
  static readonly STEP = 1 / 60;
  /** Cap catch-up work after a stall — a huge dt would otherwise spin
   *  hundreds of steps in one call. */
  static readonly MAX_DT = 0.25;

  constructor(private surface: MoveSurface, initial: MoveState) {
    this.state = initial;
  }

  /** Armor-class ground multiplier (light >1, heavy <1): scales ground
   *  acceleration AND the walk cap. Ski momentum and jet thrust stay
   *  untouched — a heavy still carries ski speed downhill like Tribes. */
  speedScale = 1;
  /** Armor-class mass — jet thrust divides by it (the jet is a force,
   *  not an accel grant) and the server divides blast impulses by it. */
  mass = 1;
  /** Eye height above feet — pos.y IS the eye point; grounded checks and
   *  the floor clamp stand the body this tall. */
  eyeHeight: number = MOVEMENT_CONFIG.playerHeight;
  /** Contact half-width — set per armor class like mass/eyeHeight; a
   *  narrow class is harder to block, same as its hit capsule. */
  bodyRadius: number = MOVEMENT_CONFIG.playerRadius;

  /** Other players' capsules this tick — contact resolve reads it after
   *  terrain so a stand mate is as solid as the deck under him. Hosts
   *  assign the shared list directly; selfId excludes this sim's own
   *  capsule (a zero-distance hit would push it off itself). */
  bodies: BodyCapsule[] = [];
  /** Optional broad-phase: when the host runs many shadows (server),
   *  it passes a per-tick spatial query instead of every shadow
   *  scanning the whole roster — same candidate set, just reachable. */
  bodiesNear?: (x: number, z: number) => Iterable<BodyCapsule>;
  selfId = '';

  setInput(input: Partial<MoveInput>): void { Object.assign(this.input, input); }

  setState(s: MoveState): void {
    this.state.pos.x = s.pos.x; this.state.pos.y = s.pos.y; this.state.pos.z = s.pos.z;
    this.state.vel.x = s.vel.x; this.state.vel.y = s.vel.y; this.state.vel.z = s.vel.z;
    this.state.yaw = s.yaw; this.state.pitch = s.pitch; this.state.onGround = s.onGround;
  }

  /** Everything setState misses: the step residue and the jump/ground
   *  edge bookkeeping. Replaying a window from a bare MoveState loses
   *  the in-flight edges (a jump held across the anchor, the carry
   *  fraction of a step) and the replayed trajectory drifts on the
   *  first boundary — deterministic replay needs the whole picture. */
  snapshot(): SimSnapshot {
    return {
      st: { pos: { ...this.state.pos }, vel: { ...this.state.vel }, yaw: this.state.yaw, pitch: this.state.pitch, onGround: this.state.onGround },
      input: { ...this.input },
      wishJump: this.wishJump, allowNextJump: this.allowNextJump,
      lastJumpableNormal: { ...this.lastJumpableNormal },
      groundedBuffered: this.groundedBuffered, acc: this.acc,
      groundGraceT: this.groundGraceT,
    };
  }

  restore(snap: SimSnapshot): void {
    this.setState(snap.st);
    Object.assign(this.input, snap.input);
    this.wishJump = snap.wishJump; this.allowNextJump = snap.allowNextJump;
    Object.assign(this.lastJumpableNormal, snap.lastJumpableNormal);
    this.groundedBuffered = snap.groundedBuffered; this.acc = snap.acc;
    this.groundGraceT = snap.groundGraceT;
  }

  update(dt: number): void {
    this.acc += Math.min(dt, MoveSim.MAX_DT);
    while (this.acc >= MoveSim.STEP) {
      this.acc -= MoveSim.STEP;
      this.step(MoveSim.STEP);
    }
  }

  private step(dt: number): void {
    // Auto-hop: jump key acts as hold-to-jump.
    this.wishJump = MOVEMENT_CONFIG.autoHop
      ? this.input.jumpHeld
      : (this.input.jumpPressed ? true : this.wishJump && this.input.jumpHeld);

    this.groundedBuffered = this.checkGrounded();

    const anyGrounded = this.state.onGround || this.groundedBuffered;
    if (this.allowNextJump && anyGrounded && this.wishJump) {
      this.allowNextJump = false;
      this.state.onGround = false;
      this.groundedBuffered = false;
      this.jump();
    }

    this.applyMovement(dt);

    // Jetpack thrust rides after collision resolution — same order the
    // client used to apply it post-sync — so ground clamping can't eat
    // the lift and the trajectory stays identical on both ends. A held
    // jet is treated as airborne everywhere it matters (applyGround's
    // friction, the snap band, and the floor-clamp rising gate all
    // exempt jetHeld): without that, the sim parked the body on the
    // ground until vel.y accrued past the 3 m/s launch gate — a ~0.9s
    // dead-zone of paid-for thrust that produced nothing. Mass is
    // real: the config values are force, accel = F/m — a heavy mech
    // climbs slower on the same burn, a light floats.
    if (this.input.jetHeld) {
      const dir = this.inputDirection();
      const s = this.state;
      const im = dt / this.mass;
      s.vel.y += MOVEMENT_CONFIG.jetForceUp * im;
      const hv = Math.hypot(s.vel.x, s.vel.z);
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
    const fwdX = Math.sin(this.state.yaw), fwdZ = Math.cos(this.state.yaw);
    const rgtX = -fwdZ, rgtZ = fwdX;
    const mx = fwdX * this.input.forward + rgtX * this.input.right;
    const mz = fwdZ * this.input.forward + rgtZ * this.input.right;
    _in.x = mx; _in.y = 0; _in.z = mz;
    const len = Math.hypot(mx, mz);
    if (len > 0) { _in.x /= len; _in.z /= len; }
    return _in;
  }

  private jump(): void {
    const dir = this.inputDirection();
    const impulse = MOVEMENT_CONFIG.jumpSpeed;
    const surfaceY = this.lastJumpableNormal.y;
    const dirLen = Math.hypot(dir.x, dir.z);
    const orientation = dirLen > 0
      ? (this.lastJumpableNormal.x * dir.x + this.lastJumpableNormal.z * dir.z)
      : 0;

    this.state.vel.y += impulse * surfaceY;
    if (dirLen === 0) {
      // No movement input — jump along the slope's horizontal component.
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

    // Ski preserves momentum but is not a motor: below walk speed a
    // grounded skier still needs ground physics to push off — otherwise a
    // stationary bot (or human holding ski at a standstill) never moves.
    // A held jet is airborne physics full stop: ground friction would
    // zero the thrust's small per-step velocity gain before it ever
    // accumulated to a launch (the ~0.9s standstill dead-zone).
    const hSpeed = Math.hypot(s.vel.x, s.vel.z);
    if (s.onGround && !this.wishJump && !this.input.jetHeld && !(this.input.skiHeld && hSpeed > MOVEMENT_CONFIG.maxVelocityGround)) {
      this.applyGround(dt, dir);
    }
    if (!s.onGround) {
      // Magnitude-preserving air control (Tribes-style lateral shift).
      const shift = { x: dir.x * MOVEMENT_CONFIG.airControl, y: 0, z: dir.z * MOVEMENT_CONFIG.airControl };
      const startY = s.vel.y;
      s.vel.y = 0;
      const startMag = Math.max(Math.hypot(s.vel.x, s.vel.z), MOVEMENT_CONFIG.maxPassiveAirvel);
      s.vel.x += shift.x; s.vel.z += shift.z;
      const mag = Math.hypot(s.vel.x, s.vel.z);
      if (mag > startMag && mag > 0) { s.vel.x *= startMag / mag; s.vel.z *= startMag / mag; }
      s.vel.y = startY;
    }
    // Gravity applies always — grounded contact kills the into-slope
    // component every tick and only the tangential slide survives
    // (T1 model: no grounded/airborne gravity distinction). The fall
    // clamp stays airborne-only: a skier glued to a downslope feeds
    // tangential speed through the contact, so clamping vel.y while
    // grounded silently capped downhill speed at terminal/sin(slope).
    s.vel.y += GRAVITY * dt;
    if (!s.onGround && s.vel.y < -MOVEMENT_CONFIG.terminalVelocity) s.vel.y = -MOVEMENT_CONFIG.terminalVelocity;

    s.pos.x += s.vel.x * dt;
    s.pos.y += s.vel.y * dt;
    s.pos.z += s.vel.z * dt;

    this.collideTerrain();
    this.collideBodies();
  }

  private collideBodies(): void {
    const s = this.state;
    if (this.bodies.length === 0 && !this.bodiesNear) return;
    const feet = s.pos.y - this.eyeHeight;
    for (const b of this.bodiesNear ? this.bodiesNear(s.pos.x, s.pos.z) : this.bodies) {
      if (b.id === this.selfId) continue;
      const rr = this.bodyRadius + b.r;
      if (feet >= b.y || s.pos.y <= b.y - b.h) continue;
      const dx = s.pos.x - b.x, dz = s.pos.z - b.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2) || 0.001;
      const nx = dx / d, nz = dz / d;
      // Half-separation per side — the neighbor's own sim moves its half
      // on its tick, so a mutual contact opens to the full overlap
      // without either side teleporting.
      const push = (rr - d) * 0.5;
      s.pos.x += nx * push;
      s.pos.z += nz * push;
      const vn1 = s.vel.x * nx + s.vel.z * nz;
      const vn2 = b.vx * nx + b.vz * nz;
      if (vn1 - vn2 < 0) {
        // Momentum-weighted bump along the contact normal — mass is the
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
    const dirLen = Math.hypot(dir.x, dir.z);

    // Tangential speed before input accel — the cap below measures
    // overspeed against this, not the post-accel value, so holding a
    // direction can never grow speed past the cap (that input-pushed
    // equilibrium is what let walking reach absurd speeds).
    const vdn0 = s.vel.x * n.x + s.vel.y * n.y + s.vel.z * n.z;
    const keep0 = Math.max(vdn0, 0);
    const tSpeedIn = Math.hypot(s.vel.x - n.x * keep0, s.vel.y - n.y * keep0, s.vel.z - n.z * keep0);
    if (dirLen > 0) {
      // Project input onto the slope surface.
      const dotN = dir.x * n.x + dir.z * n.z;
      let sx = dir.x - n.x * dotN, sz = dir.z - n.z * dotN;
      const sl = Math.hypot(sx, sz);
      if (sl > 0.0001) {
        sx /= sl; sz /= sl;
        const acc = MOVEMENT_CONFIG.groundAccelerate * this.speedScale;
        s.vel.x += sx * acc * dt;
        s.vel.z += sz * acc * dt;
      }
    } else if (!this.input.skiHeld) {
      const speed = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
      if (speed > MOVEMENT_CONFIG.stopThreshold) {
        const f = MOVEMENT_CONFIG.groundFriction * dt / speed;
        s.vel.x -= s.vel.x * f; s.vel.y -= s.vel.y * f; s.vel.z -= s.vel.z * f;
      } else {
        s.vel.x = s.vel.y = s.vel.z = 0;
      }
    }

    // Redirect velocity along the slope (kill the into-ground component).
    const velDotN = s.vel.x * n.x + s.vel.y * n.y + s.vel.z * n.z;
    if (velDotN < 0) {
      s.vel.x -= n.x * velDotN; s.vel.y -= n.y * velDotN; s.vel.z -= n.z * velDotN;
    }

    // Tangential-only cap: ground speed limits apply along the surface,
    // so a walker climbing a steep face gets the same cap as on flat —
    // a horizontal-only cap let uphill accel pump vel.y unbounded until
    // the launch gate flicked him airborne in cycles. Velocity leaving
    // the surface (positive normal) is ballistic and untouched — blast
    // shoves and landings bleed toward the cap rather than snapping.
    // …but only for a WALKER: T1 skiing is friction decayed ×0.6/tick —
    // slope contact stays slippery, so a held ski preserves the slide
    // (the documented divergence: our grip was slope-agnostic, bleeding
    // every grounded tick even mid-ski — the hard ceiling on cap speed).
    const vdn = s.vel.x * n.x + s.vel.y * n.y + s.vel.z * n.z;
    const keep = Math.max(vdn, 0);
    const tx = s.vel.x - n.x * keep, ty = s.vel.y - n.y * keep, tz = s.vel.z - n.z * keep;
    const tSpeed = Math.hypot(tx, ty, tz);
    const maxGround = MOVEMENT_CONFIG.maxVelocityGround * this.speedScale;
    if (tSpeed > maxGround && !this.input.skiHeld) {
      const base = Math.max(tSpeedIn, maxGround);
      const want = maxGround + (base - maxGround) * Math.max(0, 1 - MOVEMENT_CONFIG.overspeedBleed * dt);
      const k = Math.min(1, want / tSpeed);
      s.vel.x = tx * k + n.x * keep; s.vel.y = ty * k + n.y * keep; s.vel.z = tz * k + n.z * keep;
    }
  }

  private collideTerrain(): void {
    const s = this.state;
    // T1 MAXJUMPTICKS grace: burn the lingering-contact window per step;
    // contact sites below refill it. Launches zero it explicitly.
    if (this.groundGraceT > 0) { this.groundGraceT -= MoveSim.STEP; }
    // Solid layers push the capsule out of walls/ceilings first — the
    // floor clamp below only owns top faces.
    this.surface.resolveBody?.(s, this.eyeHeight);
    const reach = s.pos.y - this.eyeHeight + MOVEMENT_CONFIG.stepUp;
    const groundY = this.surface.getHeight(s.pos.x, s.pos.z, reach) + this.eyeHeight;
    const dist = s.pos.y - groundY;

    if (dist < 0) {
      const n = this.surface.getNormal(s.pos.x, s.pos.z, _n, reach);
      this.lastJumpableNormal.x = n.x; this.lastJumpableNormal.y = n.y; this.lastJumpableNormal.z = n.z;

      const velDotN = s.vel.x * n.x + s.vel.y * n.y + s.vel.z * n.z;
      // Frictionless contact for everyone: the inward component dies
      // completely (tangential speed preserved 100%), the positive
      // leaving component is never touched. The snap band is what
      // keeps the body tracking terrain instead of floating.
      if (velDotN < 0) {
        s.vel.x -= n.x * velDotN; s.vel.y -= n.y * velDotN; s.vel.z -= n.z * velDotN;
      }

      s.pos.y = groundY;
      // Rising impulses still clipping the surface must not re-ground —
      // but "rising" means away from the surface: vel.y reads walking
      // up an 80° face as a launch every step. A blast driven INTO a
      // rising face (velDotN negative) while still climbing world-up
      // is a launch too — grounding it here bleeds the arc that a
      // pre-gate crest launch kept.
      // A held jet reads as a launch: thrust after this clamp is what
      // generates the climb, but re-grounding here would eat the whole
      // burn until vel crosses the 3 m/s gate (~0.9s of dead jet).
      const rising = this.input.jetHeld
        || velDotN > MOVEMENT_CONFIG.groundLaunchVel
        || (velDotN < -MOVEMENT_CONFIG.groundLaunchVel && s.vel.y > MOVEMENT_CONFIG.groundLaunchVel);
      s.onGround = !rising;
      this.allowNextJump = !rising;
      this.groundGraceT = rising ? 0 : MOVEMENT_CONFIG.groundGraceT;
    } else if (dist < MOVEMENT_CONFIG.groundSnapDistance + (this.input.skiHeld ? MOVEMENT_CONFIG.skiTargetDistance : 0)) {
      // Stick to the surface: bumps and crest lips inside the snap
      // distance keep ground contact instead of flipping airborne for a
      // frame or two. The launch gate is surface-normal velocity —
      // slope-following speed stays parallel to the face even on an
      // 80° wall, so only a real launch (jump/jet/blast) reads away.
      // Fast bodies are exempt: snapping a 30 m/s hop into grounded
      // regime buys it the overspeed bleed + friction a pre-band hop
      // never paid — walkers get stability, movers keep their arc.
      const n = this.surface.getNormal(s.pos.x, s.pos.z, _n, reach);
      const velDotN = s.vel.x * n.x + s.vel.y * n.y + s.vel.z * n.z;
      const tx0 = s.vel.x - n.x * Math.max(velDotN, 0), ty0 = s.vel.y - n.y * Math.max(velDotN, 0), tz0 = s.vel.z - n.z * Math.max(velDotN, 0);
      const stickSpeed = MOVEMENT_CONFIG.maxVelocityGround * this.speedScale * 1.5;
      if (velDotN <= MOVEMENT_CONFIG.groundLaunchVel && Math.hypot(tx0, ty0, tz0) <= stickSpeed && !this.input.jetHeld) {
        this.lastJumpableNormal.x = n.x; this.lastJumpableNormal.y = n.y; this.lastJumpableNormal.z = n.z;
        if (velDotN < 0) {
          s.vel.x -= n.x * velDotN; s.vel.y -= n.y * velDotN; s.vel.z -= n.z * velDotN;
        }
        s.pos.y = groundY;
        s.onGround = true;
        this.allowNextJump = true;
        this.groundGraceT = MOVEMENT_CONFIG.groundGraceT;
      } else if (s.vel.y <= MOVEMENT_CONFIG.groundLaunchVel && !this.input.jetHeld && this.groundGraceT > 0) {
        // Geometric skim — velDotN reads launched purely because the surface
        // fell away (crest at speed). World-up velocity separates it from a
        // real impulse takeoff: skims hold the lingering-contact window,
        // launches kill it.
        s.onGround = true;
      } else {
        // Fast/launched inside the snap band — a real launch, not a skim.
        s.onGround = false;
        this.groundGraceT = 0;
      }
    } else if (s.vel.y <= MOVEMENT_CONFIG.groundLaunchVel && !this.input.jetHeld && this.groundGraceT > 0) {
      // Outside the snap band without a launch impulse — the crest-lip
      // case T1 covered with MAXJUMPTICKS: still grounded for the grace.
      s.onGround = true;
    } else {
      s.onGround = false;
      this.groundGraceT = 0;
    }
  }
}
