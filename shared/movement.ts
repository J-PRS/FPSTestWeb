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
  // Skiing: friction toggle only — no artificial accel/boost/lift, but a
  // skier counts as grounded a little higher off the surface.
  skiTargetDistance: 0.5,
  playerHeight: 1.8,
  // Jetpack thrust. The kinematics live in the sim; the energy economy
  // is modelled by the server shadow (RoomMoveSim) so a client can't
  // claim more jet than the tank allows — numbers mirror the client's
  // skills.ts economy.
  jetForceUp: 35.0,
  jetForceDir: 10.0,
} as const;

/** Jet/skill energy economy — the authoritative copy for the server
 *  shadow; client skills.ts holds the same numbers for local HUD. */
export const ENERGY = {
  max: 60,
  jetDrain: 15,      // per second while thrusting
  jetCharge: 8,      // per second while grounded-and-idle
  cloakCost: 20, cloakDrain: 5,
  shieldCost: 20, shieldDrain: 5,
  mendCost: 20, mendDrain: 15,
  shieldDmgPerEnergy: 10, // absorbed damage burns this much of a point
} as const;

export interface Vec3Like { x: number; y: number; z: number }

export interface MoveState {
  pos: Vec3Like;
  vel: Vec3Like;
  yaw: number;
  pitch: number;
  onGround: boolean;
}

export interface MoveInput {
  forward: number; // -1..1
  right: number; // -1..1
  jumpPressed: boolean;
  jumpHeld: boolean;
  skiHeld: boolean;
  jetHeld: boolean;
}

/** What the sim needs from the world: terrain height + surface normal. */
export interface MoveSurface {
  getHeight(x: number, z: number): number;
  getNormal(x: number, z: number, out: Vec3Like): Vec3Like;
}

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
  private allowNextJump = true;

  constructor(private surface: MoveSurface, initial: MoveState) {
    this.state = initial;
  }

  setInput(input: Partial<MoveInput>): void { Object.assign(this.input, input); }

  setState(s: MoveState): void {
    this.state.pos.x = s.pos.x; this.state.pos.y = s.pos.y; this.state.pos.z = s.pos.z;
    this.state.vel.x = s.vel.x; this.state.vel.y = s.vel.y; this.state.vel.z = s.vel.z;
    this.state.yaw = s.yaw; this.state.pitch = s.pitch; this.state.onGround = s.onGround;
  }

  update(dt: number): void {
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
    // the lift and the trajectory stays identical on both ends.
    if (this.input.jetHeld) {
      const dir = this.inputDirection();
      const s = this.state;
      s.vel.y += MOVEMENT_CONFIG.jetForceUp * dt;
      s.vel.x += dir.x * MOVEMENT_CONFIG.jetForceDir * dt;
      s.vel.z += dir.z * MOVEMENT_CONFIG.jetForceDir * dt;
      s.onGround = false;
    }
  }

  private checkGrounded(threshold = 0.2, offset = MOVEMENT_CONFIG.playerHeight): boolean {
    const groundY = this.surface.getHeight(this.state.pos.x, this.state.pos.z) + offset;
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

    if (s.onGround && !this.wishJump && !this.input.skiHeld) {
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
      // Gravity + terminal velocity, air only.
      s.vel.y += GRAVITY * dt;
      if (s.vel.y < -MOVEMENT_CONFIG.terminalVelocity) s.vel.y = -MOVEMENT_CONFIG.terminalVelocity;
    }

    s.pos.x += s.vel.x * dt;
    s.pos.y += s.vel.y * dt;
    s.pos.z += s.vel.z * dt;

    this.collideTerrain();
  }

  private applyGround(dt: number, dir: Vec3Like): void {
    const s = this.state;
    const n = this.surface.getNormal(s.pos.x, s.pos.z, _n);
    const dirLen = Math.hypot(dir.x, dir.z);

    if (dirLen > 0) {
      // Project input onto the slope surface.
      const dotN = dir.x * n.x + dir.z * n.z;
      let sx = dir.x - n.x * dotN, sz = dir.z - n.z * dotN;
      const sl = Math.hypot(sx, sz);
      if (sl > 0.0001) {
        sx /= sl; sz /= sl;
        s.vel.x += sx * MOVEMENT_CONFIG.groundAccelerate * dt;
        s.vel.z += sz * MOVEMENT_CONFIG.groundAccelerate * dt;
      }
    } else {
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

    const speed = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
    if (speed > MOVEMENT_CONFIG.maxVelocityGround) {
      const k = MOVEMENT_CONFIG.maxVelocityGround / speed;
      s.vel.x *= k; s.vel.y *= k; s.vel.z *= k;
    }
  }

  private collideTerrain(): void {
    const s = this.state;
    const groundY = this.surface.getHeight(s.pos.x, s.pos.z) + MOVEMENT_CONFIG.playerHeight;
    const dist = s.pos.y - groundY;

    if (dist < 0) {
      const anyGrounded = s.onGround || this.groundedBuffered;
      const n = this.surface.getNormal(s.pos.x, s.pos.z, _n);
      this.lastJumpableNormal.x = n.x; this.lastJumpableNormal.y = n.y; this.lastJumpableNormal.z = n.z;

      const velDotN = s.vel.x * n.x + s.vel.y * n.y + s.vel.z * n.z;
      if (this.input.skiHeld && anyGrounded) {
        // Skiing: preserve speed, kill ~98% of the into-slope component.
        const d = velDotN * 0.98;
        s.vel.x -= n.x * d; s.vel.y -= n.y * d; s.vel.z -= n.z * d;
      } else if (velDotN < 0) {
        s.vel.x -= n.x * velDotN; s.vel.y -= n.y * velDotN; s.vel.z -= n.z * velDotN;
      }

      s.pos.y = groundY;
      // Rising explosion impulses still clipping the surface must not re-ground.
      const rising = s.vel.y > 0.1;
      s.onGround = !rising;
      this.allowNextJump = !rising;
    } else if (dist < 0.2 && s.vel.y <= 0.1) {
      s.onGround = true;
      this.allowNextJump = true;
    } else {
      s.onGround = false;
    }
  }
}
