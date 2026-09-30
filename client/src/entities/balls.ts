import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import { GRAVITY, BALL_BASE_RADIUS } from '../core/config.js';

import { Terrain, getHeightfield } from '../world/terrain.js';
import { makeSimBall, type StructureCollider } from '../../../shared/ballSim.js';
import { ColliderIndex } from '../../../shared/solidWorld.js';
import { type Heightfield, hmFingerprint } from '../../../shared/heightfield.js';
import { type NetBag, newNetBag, type NetStatics, type NetSeg, tickNet, isStaleSeg, applySeg } from './ballNet.js';
import { RibbonTrail } from '../projectiles/RibbonTrail.js';
import { BallTrailDots } from './ballTrails.js';
import { tickStallBreaker as tickStall, tickEnrage as tickRage, handleGroundBounce as groundBounce, setEnraged as rageSet } from './ballRage.js';
import { allocSlots, freeSlots, getSwarm, getShadows, type SwarmPart } from './swarms.js';

const BALL_GRAVITY   = GRAVITY;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _enrageTint = new THREE.Color(1, 0.12, 0.08);

// One shared geometry for every ball — radius baked in, per-ball scale lives
// in the instance matrix.
let _ballGeo: THREE.IcosahedronGeometry | null = null;
function ballGeo(): THREE.IcosahedronGeometry {
  if (!_ballGeo) _ballGeo = new THREE.IcosahedronGeometry(BALL_BASE_RADIUS, 0);
  return _ballGeo;
}
let _ballMat: THREE.MeshLambertMaterial | null = null;
function ballMat(): THREE.MeshLambertMaterial {
  // White diffuse — instanceColor carries hue + emissive-style glow
  if (!_ballMat) _ballMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  return _ballMat;
}

export function ballParts(): SwarmPart[] {
  return [{ geometry: ballGeo(), material: ballMat(), castShadow: true }];
}

const BALL_COLORS = [
  new THREE.Color(1.0, 0.25, 0.25),
  new THREE.Color(0.25, 0.85, 0.25),
  new THREE.Color(0.25, 0.55, 1.0),
  new THREE.Color(1.0, 0.85, 0.1),
  new THREE.Color(0.9, 0.25, 0.9),
  new THREE.Color(0.15, 0.9, 0.9),
  new THREE.Color(1.0, 0.5, 0.1),
];

// Anything a projectile can hit / an explosion can push: balls, crawlers.
// combat.ts works against this surface — position, radius, damage, knockback.
export interface Targetable {
  readonly id: number;
  variant: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead: boolean;
  health: number;
  maxHealth?: number;
  radius: number;
  /** Collision radius override — render and physics radius diverge on
   *  tapered bodies (Totem's obelisk is ~0.7× its scale factor). */
  hitRadius?: number;
  /** Tall targets (Totem): hitbox is a vertical capsule from pos to
   *  pos.y + capsuleTop instead of a sphere at the feet. */
  capsuleTop?: number;
  /** Long targets (Overlord): hitbox is a capsule on the segment
   *  pos ± capsuleEnd (heading-aligned). Mutually exclusive w/ capsuleTop. */
  capsuleEnd?: THREE.Vector3;
  color: THREE.Color;
  scale: number;
  takeDamage(damage: number): boolean;
  applyKnockback(from: THREE.Vector3, force: number): void;
  applyPull(to: THREE.Vector3, force: number): void;
  /** Props (Tumbleweed) die visually but shouldn't credit frags. */
  scoreless?: boolean;
  /** Suppress nugget drops — wildlife and pure props. */
  lootless?: boolean;
  /** Suppress floating health bars — set for props, not hostile wildlife. */
  hideHealthBar?: boolean;
  /** 'brush' = fluttering twigs/feathers; 'goo' = sticky splat blobs. */
  debrisKind?: 'rock' | 'brush' | 'goo';
  /** Real fragment geometries for the death burst (tumbleweed twigs) —
   *  debris shards use these instead of generated chunks. */
  debrisGeos?: THREE.BufferGeometry[];
  /** Death-cue override — crawlers splat, weeds rustle, most use default. */
  dieCue?: 'die' | 'splat' | 'rustle' | 'squawk';
  /** Fires once when destroyed — elites split, everything else ignores it. */
  onDeath?: (t: Targetable) => void;
}

export class Ball {
  // Camera position synced by the main loop once per frame — feeds the
  // billboarded ribbon trails (avoids threading camPos through every
  // update() call site including demo playback fast-forward).
  static readonly viewPos = new THREE.Vector3();
  readonly id: number;
  readonly variant: 0 | 1 | 2 | 3;
  /** Elite split hook — wired by entities.ts for variant 3. */
  onDeath?: (t: Targetable) => void;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  color: THREE.Color;

  // Renders through the 'ball' swarm — instanceColor carries hue plus the
  // enrage/dash/flash glow (values >1 fake emissive).
  swarmSlot = -1;
  shadowSlot = -1;

  private scene: THREE.Scene;
  scale: number;
  emissive = new THREE.Color(0, 0, 0); // additive glow — folded into instanceColor; public so ballNet can mirror enrage state onto it
  // Public flat fields — ballRage's BallRageHost mutates them (the same
  // state-bag pattern as the *Visual splits).
  trails: BallTrailDots;
  ribbons: RibbonTrail[];
  private _lastTrailPos = new THREE.Vector3();
  private flashTimer = 0;
  private meshRemoved = false; // swarm slot freed; name kept — it gates dead-ball cleanup
  private _disposed = false;

  // True once the ball and its trail are fully cleaned up (safe to remove)
  get disposed(): boolean { return this._disposed; }

  // Callbacks for demo keyframe recording
  onBounce?: (pos: THREE.Vector3, vel: THREE.Vector3) => void;
  onPeak?: (pos: THREE.Vector3, vel: THREE.Vector3) => void;
  private prevVelY = 0;
  lastBounceEnergy = 0; // Track total mechanical energy (KE + PE) after last bounce for loss detection

  // Enrage mode (replaces teleport when BALL_ENRAGE_ENABLED): out-of-range
  // balls get pulled toward the player while still bouncing normally.
  // Public: ballNet mirrors the sim's enrage bits onto these every tick.
  enraged = false;
  /** Minimap reads this — enraged balls are threats, not ambient cyan. */
  get isEnraged(): boolean { return this.enraged; }
  enrageTimer = 0;
  slowTimer = 0; // seconds under BALL_MIN_SPEED — fires the stall breaker
  dampNextBounce = false; // set by the enrage dash — next ground bounce reflects at 50%
  dashFlash = 0; // brief white-hot pop right after a lunge

  // ---- Server-driven mode (shared PvE) ---------------------------------
  // A netDriven ball replays shared/ballSim.ts NON-authoritatively: server
  // `ballSegment` events snap pos/vel/target, and between events the local
  // stepper predicts the same arc against the same heightfield — bounce-for
  // -bounce identical, so corrections are invisible unless latency spikes.
  netDriven = false;
  netId = 0;
  get netTargetId(): string | null { return this.netS.netTargetId; }
  readonly netS: NetBag = newNetBag();
  private static field: Heightfield | null = null;
  /** Read-only for desync forensics (netBalls logs its fingerprint on
   *  rubberbands). Mutate via initNetMode only. */
  static get netField(): Heightfield | null { return Ball.field; }
  /** True while a terrain swap is loading — prediction still runs on the
   *  previous field until initNetMode(true) rebinds it, so rubberband
   *  warns in this window are expected, not desync signal. */
  static terrainSwapping = false;

  /** Prediction-state snapshot for the rubberband warn — answers "which
   *  regime diverged" in one line: simT≫simNow = free-ran past the clock
   *  gate; inert legAge pinned at ~8 = stale anchor extrapolating blind. */
  get netDiag(): { simT: number; simNow: number | null; legT0: number; legAge: number; enraged: boolean; tgtValid: boolean } | null {
    const sim = this.netS.sim;
    if (!sim) return null;
    const simNow = Ball.netSimNow?.() ?? null;
    const legAge = simNow !== null && Number.isFinite(simNow) && this.netS.legT0 >= 0
      ? simNow - this.netS.legT0 : -1;
    return {
      simT: this.netS.simT, simNow, legT0: this.netS.legT0, legAge,
      enraged: sim.enraged, tgtValid: sim.tgtValid,
    };
  }
  /** Map-structure colliders from gameState — prediction ricochets off
   *  walls/pillars identically to the server. Set by netHandlers. */
  static colliders: readonly StructureCollider[] = [];
  static colliderIndex: ColliderIndex | null = null;
  /** Sim-time the ball's pos is evaluated at — server grid multiples of
   *  0.05. Steps fire only while the next cell is behind the server clock
   *  estimate: free-running ahead is what bounced early and snapped back. */
  private simT = 0;
  /** Server-sim "now" estimate — wired by netBalls from stamped events. */
  static netSimNow: (() => number) | null = null;
  /** entities.ts wires this once — hit claims go to the server, not local health. */
  static hitClaim: ((netId: number, damage: number, ix: number, iy: number, iz: number) => void) | null = null;
  private _netImp = new THREE.Vector3(); // pending knockback impulse → next claim
  /** ballNet reads Ball's statics through closures — no circular import. */
  private static readonly NET_S: NetStatics = {
    field: () => Ball.field,
    simNow: () => Ball.netSimNow?.(),
    colliders: () => Ball.colliders,
    colliderIndex: () => Ball.colliderIndex,
  };
  readonly renderOffset = new THREE.Vector3(); // public: ballNet blends segment corrections into it
  readonly _rpos = new THREE.Vector3(); // pos + renderOffset, scratch

  private static lastBoundFp = '';

  /** One-time init: the heightfield the shared sim needs for bounce prediction. */
  static initNetMode(force = false): void {
    if (force || !Ball.field) {
      Ball.field = getHeightfield();
      if (Ball.field) {
        const fp = hmFingerprint(Ball.field);
        if (fp !== Ball.lastBoundFp) {
          Ball.lastBoundFp = fp;
          console.info(`[Ball] netmode field bound fp=${fp}`);
        }
      }
    }
  }

  constructor(scene: THREE.Scene, terrain: Terrain, variant: 0 | 1 | 2 | 3 = 0,
    netSpawn?: { id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; colorIdx: number }) {
    this.scene = scene;
    this.id = nextTargetId();
    this.variant = variant;

    if (variant === 3) {
      // Elite — big violet splitter; death spawns two children
      this.scale = 2.4; this.health = 350;
      this.color = new THREE.Color(0.45, 0.2, 0.85);
    } else if (variant === 2) {
      this.scale = 3.0; this.health = 130;
      this.color = new THREE.Color(1.0, 0.25, 0.25);
    } else if (variant === 1) {
      this.scale = 2.0; this.health = 70;
      this.color = new THREE.Color(0.25, 0.85, 0.25);
    } else {
      this.scale = 1.0; this.health = 30;
      this.color = BALL_COLORS[Math.floor(Math.random() * BALL_COLORS.length)].clone();
    }
    this.maxHealth = this.health;
    this.radius = BALL_BASE_RADIUS * this.scale;

    // Two-lane billboarded ribbon: wide tinted halo + thin near-white core,
    // same structure as the disc trails but the strip always faces the camera.
    const coreColor = this.color.clone().lerp(new THREE.Color(1, 1, 1), 0.7);
    // Scale color energy down — additive stacking made full-strength colors
    // eye-searing; these are emission intensities, not hues
    this.trails = new BallTrailDots(scene);
    this.ribbons = [
      RibbonTrail.acquire(scene, this.color.clone().multiplyScalar(0.55).getHex(), this.radius * 1.2, 0.5, 0, true),
      RibbonTrail.acquire(scene, coreColor.multiplyScalar(0.7).getHex(), this.radius * 0.45, 0.4, 0, true),
    ];

    if (netSpawn) {
      // Server-owned spawn — pos/vel/color come off the wire, nothing rolled
      this.netDriven = true;
      this.netId = netSpawn.id;
      this.id = 0x40000000 + netSpawn.id; // net namespace — can't collide with local targetIds
      this.pos = new THREE.Vector3(netSpawn.x, netSpawn.y, netSpawn.z);
      this.vel = new THREE.Vector3(netSpawn.vx, netSpawn.vy, netSpawn.vz);
      if (variant === 0) this.color = BALL_COLORS[netSpawn.colorIdx % BALL_COLORS.length]!.clone();
      this.netS.sim = makeSimBall(netSpawn.id, variant, netSpawn.colorIdx,
        { x: netSpawn.x, y: netSpawn.y, z: netSpawn.z },
        { x: netSpawn.vx, y: netSpawn.vy, z: netSpawn.vz });
    } else {
      const rx = (Math.random() - 0.5) * 400;
      const rz = (Math.random() - 0.5) * 400;
      const gy = terrain.getHeight(rx, rz);
      this.pos = new THREE.Vector3(rx, gy + 80 + Math.random() * 60, rz);

      const ang = Math.random() * Math.PI * 2;
      const spd = Math.random() * 20;
      this.vel = new THREE.Vector3(Math.cos(ang) * spd, -2, Math.sin(ang) * spd);
    }

    if (!allocSlots('ball', this)) { this.dead = true; this._disposed = true; }
    this.writeInstance();
  }

  // Ball body → swarm slot; instanceColor = hue + emissive glow.
  private writeInstance(): void {
    if (this.meshRemoved || this.swarmSlot < 0) return;
    const swarm = getSwarm('ball');
    if (!swarm) return;
    this._rpos.copy(this.pos).add(this.renderOffset);
    _m.compose(this._rpos, _q.identity(), _s.setScalar(this.scale));
    swarm.setMatrix(0, this.swarmSlot, _m);
    if (this.flashTimer > 0) {
      swarm.setColor(0, this.swarmSlot, 4, 4, 4);
    } else {
      _c.copy(this.color).add(this.emissive);
      swarm.setColor(0, this.swarmSlot, _c.r, _c.g, _c.b);
    }
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) {
      this.updateDead(dt);
      return;
    }

    this.prevVelY = this.vel.y;
    if (this.netDriven && this.netS.sim && Ball.field) {
      tickNet(Ball.NET_S, this.netS, this, dt);
    } else {
      this.vel.y += BALL_GRAVITY * dt;
      this.pos.addScaledVector(this.vel, dt);
    }

    this.tickRenderPos(dt);

    // Peak detection: vel.y crossed from positive to negative (apex of arc)
    if (this.prevVelY > 0 && this.vel.y <= 0 && this.onPeak) {
      this.onPeak(this.pos.clone(), this.vel.clone());
    }

    tickRage(this, dt, terrain, playerPos);

    if (!this.netDriven) {
      groundBounce(this, terrain, playerPos);
      tickStall(this, dt, playerPos);
    }
    getShadows()?.set(this, this._rpos, this.radius, 0.3);
    this.writeInstance();

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.emissive.setRGB(0, 0, 0);
    }

    this.tickTrails(dt);
  }

  // Render position = sim pos + decaying correction offset; enraged legs
  // additionally extrapolate over the sub-50ms remainder so the ball
  // doesn't step at ~20fps. (Inert legs already integrate continuously.)
  private tickRenderPos(dt: number): void {
    // Segment corrections drain back to zero — exp decay, ~0.2s time constant.
    if (this.renderOffset.lengthSq() > 0.0001) {
      this.renderOffset.multiplyScalar(Math.exp(-dt * 10));
    } else {
      this.renderOffset.set(0, 0, 0);
    }
    this._rpos.copy(this.pos).add(this.renderOffset);
    const sim = this.netS.sim;
    if (!(this.netDriven && sim && sim.enraged && sim.tgtValid)) return;
    const rem = this.netS.netAcc;
    if (rem <= 0) return;
    this._rpos.x += this.vel.x * rem;
    this._rpos.y += this.vel.y * rem + 0.5 * BALL_GRAVITY * rem * rem;
    this._rpos.z += this.vel.z * rem;
  }

  private tickTrails(dt: number): void {
    this.trails.emit(dt, this._rpos, this.vel, this.radius, this.enraged ? _enrageTint : this.color);
    this.trails.fade(dt);
    // Position discontinuity (teleport or playback keyframe snap) — cut the
    // ribbons so they don't streak across the jump
    if (this._rpos.distanceToSquared(this._lastTrailPos) > 400) {
      for (const r of this.ribbons) r.clear();
    }
    this._lastTrailPos.copy(this._rpos);
    if (this.vel.lengthSq() > 0.5) {
      for (const r of this.ribbons) r.push(this._rpos, this.vel);
    }
    for (const r of this.ribbons) r.update(dt, Ball.viewPos);
  }

  // Dead ball: swarm slot freed, just fade out remaining trail dots/ribbons
  private updateDead(dt: number): void {
    if (!this.meshRemoved) {
      for (const r of this.ribbons) r.stop();
      freeSlots('ball', this);
      this.meshRemoved = true;
    }
    this.trails.fade(dt);
    for (const r of this.ribbons) r.update(dt, Ball.viewPos);
    if (this.trails.size === 0 && this.ribbons.every(r => r.done)) {
      // Final cleanup — caller splices on `disposed` without dispose()
      this.trails.dispose();
      for (const r of this.ribbons) r.dispose(this.scene);
      this._disposed = true;
    }
  }

  /** Director hook — enrage storms light up every ball at once. */
  enrage(): void { rageSet(this, true); }

  hitTest(px: number, py: number, pz: number, extraRadius = 0): boolean {
    const dx = px - this.pos.x;
    const dy = py - this.pos.y;
    const dz = pz - this.pos.z;
    const r = this.radius + extraRadius;
    return dx * dx + dy * dy + dz * dz <= r * r;
  }

  takeDamage(damage: number): boolean {
    if (this.netDriven) {
      // Server-authoritative: claim the hit (with any knockback the caller
      // already staged), flash locally, and let ballDie decide death.
      Ball.hitClaim?.(this.netId, damage, this._netImp.x, this._netImp.y, this._netImp.z);
      this._netImp.set(0, 0, 0);
      this.flashTimer = 0.15;
      // Predicted health — the claim carries exactly this damage, so the
      // floating bar can tick down NOW instead of one RTT late. Death is
      // still the server's call; clamp at 0, never set `dead`.
      this.health = Math.max(0, this.health - damage);
      return false;
    }
    this.health -= damage;
    this.flashTimer = 0.15;
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    const dir = this.pos.clone().sub(from).normalize();
    if (this.netDriven) { this._netImp.addScaledVector(dir, force); return; }
    this.vel.addScaledVector(dir, force);
  }

  applyPull(to: THREE.Vector3, force: number): void {
    const dir = to.clone().sub(this.pos).normalize();
    if (this.netDriven) { this._netImp.addScaledVector(dir, force); return; }
    this.vel.addScaledVector(dir, force);
  }

  isStaleSegment(t: number | undefined): boolean { return isStaleSeg(this.netS, t); }

  applyNetSegment(seg: NetSeg): void { applySeg(this.netS, this, seg); }

  /** Server said dead — the updateDead path fades trails as usual. */
  netKill(): void {
    this.dead = true;
  }

  dispose(): void {
    if (!this.meshRemoved) { freeSlots('ball', this); this.meshRemoved = true; }
    this.trails.dispose();
    for (const r of this.ribbons) r.dispose(this.scene);
  }
}

export type { NetSeg } from './ballNet.js';

export function pickVariant(): 0 | 1 | 2 | 3 {
  const r = Math.random();
  if (r < 0.08) return 3; // elites are rare — each one is an event
  if (r < 0.18) return 2;
  if (r < 0.38) return 1;
  return 0;
}
