import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import { GRAVITY, BALL_MAX_DIST, BALL_TELE_MIN, BALL_TELE_MAX, BALL_TELE_HEIGHT, BALL_BASE_RADIUS, BALL_ENRAGE_ENABLED, BALL_ENRAGE_FORCE, BALL_ENRAGE_TIMEOUT, BALL_ENRAGE_DASH_DIST, BALL_ENRAGE_DASH_SPEED, BALL_ENRAGE_TELEGRAPH_H } from '../core/config.js';

import { Terrain, getHeightfield } from '../world/terrain.js';
import { makeSimBall, stepBall, BALL_OVERSPEED, BALL_MIN_SPEED, BALL_STALL_TIME, type SimBall } from '../../../shared/ballSim.js';
import { type Heightfield } from '../../../shared/heightfield.js';
import { RibbonTrail } from '../projectiles/RibbonTrail.js';
import { ChildLogger } from '../core/Logger.js';
import { allocSlots, freeSlots, getSwarm, getShadows, type SwarmPart } from './swarms.js';

const logger = new ChildLogger('Ball');

const BALL_GRAVITY   = GRAVITY;
const BOUNCE         = 1.0;
const TRAIL_COUNT    = 14;
const TRAIL_INTERVAL = 0.04;

// scratch — trail dot spawn jitter
const _spawn = new THREE.Vector3();
const _scatter = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _enrageTint = new THREE.Color(1, 0.12, 0.08);
const _white = new THREE.Color(1, 1, 1);

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

interface TrailDot {
  halo: THREE.Sprite;
  core: THREE.Sprite;
  age: number;
  life: number;    // per-dot random lifetime
  haloSz: number;  // per-dot random base scales
  coreSz: number;
}

// Shared radial-gradient sprite texture: hot center -> colored mid -> soft
// transparent rim. Per-dot sprites tint it; additive blending accumulates
// overlapping dots into the "bright core / soft halo" layered trail look.
let _trailTex: THREE.Texture | null = null;
function getTrailTex(): THREE.Texture {
  if (!_trailTex) {
    const S = 64, c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(S/2, S/2, 0, S/2, S/2, S/2);
    g.addColorStop(0,    'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.18)');
    g.addColorStop(1,    'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    _trailTex = new THREE.CanvasTexture(c);
  }
  return _trailTex;
}

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
  private emissive = new THREE.Color(0, 0, 0); // additive glow — folded into instanceColor
  private trailDots: TrailDot[] = [];
  private ribbons: RibbonTrail[];
  private _lastTrailPos = new THREE.Vector3();
  private trailTimer = 0;
  private flashTimer = 0;
  private meshRemoved = false; // swarm slot freed; name kept — it gates dead-ball cleanup
  private _disposed = false;

  // True once the ball and its trail are fully cleaned up (safe to remove)
  get disposed(): boolean { return this._disposed; }

  // Callbacks for demo keyframe recording
  onBounce?: (pos: THREE.Vector3, vel: THREE.Vector3) => void;
  onPeak?: (pos: THREE.Vector3, vel: THREE.Vector3) => void;
  private prevVelY = 0;
  private lastBounceEnergy = 0; // Track total mechanical energy (KE + PE) after last bounce for loss detection

  // Enrage mode (replaces teleport when BALL_ENRAGE_ENABLED): out-of-range
  // balls get pulled toward the player while still bouncing normally
  private enraged = false;
  /** Minimap reads this — enraged balls are threats, not ambient cyan. */
  get isEnraged(): boolean { return this.enraged; }
  private enrageTimer = 0;
  private slowTimer = 0; // seconds under BALL_MIN_SPEED — fires the stall breaker
  private dampNextBounce = false; // set by the enrage dash — next ground bounce reflects at 50%
  private dashFlash = 0; // brief white-hot pop right after a lunge
  private static _enrageDir = new THREE.Vector3(); // scratch

  // ---- Server-driven mode (shared PvE) ---------------------------------
  // A netDriven ball replays shared/ballSim.ts NON-authoritatively: server
  // `ballSegment` events snap pos/vel/target, and between events the local
  // stepper predicts the same arc against the same heightfield — bounce-for
  // -bounce identical, so corrections are invisible unless latency spikes.
  netDriven = false;
  netId = 0;
  netTargetId: string | null = null;
  private sim: SimBall | null = null;
  private static field: Heightfield | null = null;
  /** entities.ts wires this once — hit claims go to the server, not local health. */
  static hitClaim: ((netId: number, damage: number, ix: number, iy: number, iz: number) => void) | null = null;
  private _netImp = new THREE.Vector3(); // pending knockback impulse → next claim
  private netAcc = 0; // fixed-dt accumulator — prediction steps at server rate
  private static _simTarget = { x: 0, y: 0, z: 0 };
  // Render-only correction: segment snaps shift `pos` to truth instantly
  // (gameplay stays exact), while this offset carries the visual error and
  // decays over ~0.2s — the ball slides instead of teleporting.
  private readonly renderOffset = new THREE.Vector3();
  private readonly _rpos = new THREE.Vector3(); // pos + renderOffset, scratch

  /** One-time init: the heightfield the shared sim needs for bounce prediction. */
  static initNetMode(): void {
    if (!Ball.field) Ball.field = getHeightfield();
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
      this.sim = makeSimBall(netSpawn.id, variant, netSpawn.colorIdx,
        netSpawn.x, netSpawn.y, netSpawn.z, netSpawn.vx, netSpawn.vy, netSpawn.vz);
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
    if (this.netDriven && this.sim && Ball.field) {
      // Predict the shared sim — stepped at the SERVER's fixed 50ms, not
      // render dt. Discrete bounce detection is step-granularity sensitive:
      // a 16ms client finds a different contact point than the 50ms server,
      // the reflection heading diverges, and elastic bounces compound it
      // into hundreds of meters. Same dt + same code = same trajectory.
      this.netAcc = Math.min(this.netAcc + dt, 0.5); // cap vs spiral-of-death on stalls
      const s = this.sim;
      // Pull/lunge aim = the snapshot the server carried on the last
      // segment — replaying the SAME input, not our live view of the
      // target, is what keeps the two sims glued together.
      const tp = Ball._simTarget;
      tp.x = s.tx; tp.y = s.ty; tp.z = s.tz;
      const tgt = s.tgtValid ? tp : null;
      while (this.netAcc >= 0.05) {
        this.netAcc -= 0.05;
        s.x = this.pos.x; s.y = this.pos.y; s.z = this.pos.z;
        s.vx = this.vel.x; s.vy = this.vel.y; s.vz = this.vel.z;
        stepBall(s, 0.05, Ball.field, tgt, false);
        this.pos.set(s.x, s.y, s.z);
        this.vel.set(s.vx, s.vy, s.vz);
      }
      this.enraged = s.enraged;
      this.enrageTimer = s.enrageTimer;
      this.dampNextBounce = s.dampNextBounce;
      if (s.dead && !this.dead) this.dead = true;
    } else {
      this.vel.y += BALL_GRAVITY * dt;
      this.pos.addScaledVector(this.vel, dt);
    }

    // Segment corrections drain back to zero — exp decay, ~0.2s time constant.
    if (this.renderOffset.lengthSq() > 0.0001) {
      this.renderOffset.multiplyScalar(Math.exp(-dt * 10));
    } else {
      this.renderOffset.set(0, 0, 0);
    }
    this._rpos.copy(this.pos).add(this.renderOffset);
    if (this.netDriven && this.sim) {
      // The sim only advances in 50ms quanta; the leftover netAcc is elapsed
      // time the ball has visually "not moved" through. Extrapolate the
      // render pos ballistically over it or the ball steps at ~20fps.
      const rem = this.netAcc;
      if (rem > 0) {
        this._rpos.x += this.vel.x * rem;
        this._rpos.y += this.vel.y * rem + 0.5 * BALL_GRAVITY * rem * rem;
        this._rpos.z += this.vel.z * rem;
      }
    }

    // Peak detection: vel.y crossed from positive to negative (apex of arc)
    if (this.prevVelY > 0 && this.vel.y <= 0 && this.onPeak) {
      this.onPeak(this.pos.clone(), this.vel.clone());
    }

    // Enraged balls are pulled toward the player — a linear accel, so they
    // still bounce and arc naturally instead of homing like missiles.
    // (netDriven: the shared stepper already applied this pull above.)
    if (this.enraged && !this.netDriven) {
      this.enrageTimer += dt;
      Ball._enrageDir.subVectors(playerPos, this.pos);
      Ball._enrageDir.y += this.radius; // aim at the body, not the feet
      const d = Ball._enrageDir.length();
      if (d > 0.001) {
        this.vel.addScaledVector(Ball._enrageDir.multiplyScalar(1 / d), BALL_ENRAGE_FORCE * dt);
      }
      // Calm down once back in play range; give up and teleport if it can
      // never catch up (player teleporting/skiing away at speed)
      // Rage only discharges via a lunge (in handleGroundBounce) or the
      // timeout fallback — a ball that can't catch up eventually teleports
      if (this.enrageTimer > BALL_ENRAGE_TIMEOUT) {
        this.setEnraged(false);
        this.teleportNearPlayer(terrain, playerPos);
      }
    }

    // Dash telegraph: while enraged inside lunge range, burn hotter as the
    // ball descends — a falling white-hot ball reads as "it's about to dash"
    if (this.enraged) {
      const ddx = this.pos.x - playerPos.x;
      const ddz = this.pos.z - playerPos.z;
      if (ddx * ddx + ddz * ddz <= BALL_ENRAGE_DASH_DIST * BALL_ENRAGE_DASH_DIST) {
        const h = this.pos.y - terrain.getHeight(this.pos.x, this.pos.z) - this.radius;
        const t = Math.min(1, Math.max(0, 1 - h / BALL_ENRAGE_TELEGRAPH_H));
        this.emissive.setRGB(0.55 + 0.45 * t, 0.45 * t, 0.35 * t); // red → white-hot
      } else {
        // Pulsing red burn — a static tint reads as texture; a ~2.5Hz throb
        // reads as "hostile". Bright enough to push past any base hue.
        const p = 0.75 + 0.85 * (0.5 + 0.5 * Math.sin(this.enrageTimer * 15));
        this.emissive.setRGB(p, p * 0.1, p * 0.08);
      }
    }
    if (this.dashFlash > 0) {
      this.dashFlash -= dt;
      this.emissive.setRGB(1, 0.9, 0.7); // post-dash pop
      if (this.dashFlash <= 0 && this.enraged) this.emissive.setRGB(0.55, 0, 0);
    }

    if (!this.netDriven) this.handleGroundBounce(terrain, playerPos);

    // Stall breaker — loitering under MIN_SPEED for STALL_TIME earns a free
    // spring launch at the target (same skill as the enrage launch, fired
    // on boredom instead of distance). Mirrors shared/ballSim.ts — a ball
    // resting in a dip can't just sit there being scenery.
    if (!this.netDriven) {
      const sp = this.vel.length();
      this.slowTimer = sp < BALL_MIN_SPEED ? this.slowTimer + dt : 0;
      if (this.slowTimer >= BALL_STALL_TIME) {
        this.slowTimer = 0;
        this.launchAt(playerPos, Math.SQRT1_2);
        this.dashFlash = 0.15;
        for (let i = 0; i < 8; i++) this.spawnDot();
        this.onBounce?.(this.pos.clone(), this.vel.clone());
      }
    }
    getShadows()?.set(this, this._rpos, this.radius, 0.3);
    this.writeInstance();

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.emissive.setRGB(0, 0, 0);
    }

    this.emitTrailDot(dt);
    this.fadeTrailDots(dt);
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
    this.fadeTrailDots(dt);
    for (const r of this.ribbons) r.update(dt, Ball.viewPos);
    if (this.trailDots.length === 0 && this.ribbons.every(r => r.done)) {
      // Final cleanup — caller splices on `disposed` without dispose()
      for (const d of this.dotPool) {
        d.halo.material.dispose();
        d.core.material.dispose();
      }
      this.dotPool = [];
      for (const r of this.ribbons) r.dispose(this.scene);
      this._disposed = true;
    }
  }

  private handleGroundBounce(terrain: Terrain, playerPos: THREE.Vector3): void {
    const gy = terrain.getHeight(this.pos.x, this.pos.z);
    if (this.pos.y - this.radius > gy) return;
    this.pos.y = gy + this.radius;
    const n = terrain.getNormal(this.pos.x, this.pos.z);
    const dot = this.vel.dot(n);

    // Only treat as a bounce when the ball is moving INTO the surface (dot < 0).
    // This prevents a spurious re-bounce when update() is called with dt=0 right
    // after a playback keyframe snap: the ball sits exactly on the ground with
    // upward velocity, and without this guard the reflection would flip it back
    // downward, causing a one-frame dip/stutter (and a possible stray teleport).
    if (dot >= 0) return;

    // Enraged lunge: touching down within range launches at the player
    // instead of a normal bounce — velocity is REPLACED (clean readable dash,
    // not a bounce that adds up unpredictably)
    if (this.enraged) {
      const pdx = playerPos.x - this.pos.x;
      const pdz = playerPos.z - this.pos.z;
      const pd2 = pdx * pdx + pdz * pdz;
      if (pd2 <= BALL_ENRAGE_DASH_DIST * BALL_ENRAGE_DASH_DIST) {
        // Ballistic lunge — solve vy so the arc lands ON the player
        this.dashAt(playerPos);
        this.dashFlash = 0.15;
        this.setEnraged(false); // lunge discharges the rage
        this.dampNextBounce = true; // the landing bounce is deadened — no slingshot flyout
        for (let i = 0; i < 8; i++) this.spawnDot(); // dust-burst at takeoff
        this.lastBounceEnergy = 0;
        this.onBounce?.(this.pos.clone(), this.vel.clone());
        return;
      }
    }

    // Calculate total mechanical energy at bounce: KE + PE
    // KE = 0.5 * v^2, PE = g * (global height above reference)
    // Use fixed reference (y=0) to account for terrain height changes
    const velBeforeReflection = this.vel.clone();
    const totalEnergy = 0.5 * velBeforeReflection.lengthSq() + Math.abs(BALL_GRAVITY) * this.pos.y;

    // Post-dash landing OR an overspeed impact: reflect at 50% elasticity
    // so the segment ends with a thud, not a full-energy ricochet into
    // orbit. (Mirrors shared/ballSim.ts BALL_OVERSPEED — keep in sync.)
    const elasticity = (this.dampNextBounce || velBeforeReflection.length() > BALL_OVERSPEED) ? 0.5 : BOUNCE;
    this.dampNextBounce = false;
    this.vel.addScaledVector(n, -(1.0 + elasticity) * dot);

    // Check if reflection itself preserves energy (should be 100% with BOUNCE=1.0)
    const velAfterMag = this.vel.length();
    const velBeforeMag = velBeforeReflection.length();
    const reflectionEnergyRatio = velAfterMag / velBeforeMag;
    if (Math.abs(reflectionEnergyRatio - 1.0) > 0.01) {
      logger.debug(`Ball ${this.id} reflection lost energy: ${(reflectionEnergyRatio * 100).toFixed(1)}% (should be 100%)`);
    }

    // Compare total mechanical energy to previous bounce
    if (this.lastBounceEnergy > 0) {
      const energyRatio = totalEnergy / this.lastBounceEnergy;
      if (energyRatio < 0.95 || energyRatio > 1.05) {
        const kind = energyRatio < 0.95 ? 'LOSS' : 'GAIN';
        logger.debug(`Ball ${this.id} total energy ${kind}: ${(energyRatio * 100).toFixed(1)}% (KE: ${(0.5 * velBeforeMag * velBeforeMag).toFixed(1)}, PE: ${(Math.abs(BALL_GRAVITY) * this.pos.y).toFixed(1)})`);
      }
    }
    this.lastBounceEnergy = totalEnergy;

    // Record bounce keyframe (after velocity reflection)
    this.onBounce?.(this.pos.clone(), this.vel.clone());

    const dx = this.pos.x - playerPos.x;
    const dz = this.pos.z - playerPos.z;
    if (dx * dx + dz * dz <= BALL_MAX_DIST * BALL_MAX_DIST) return;
    if (BALL_ENRAGE_ENABLED) {
      this.setEnraged(true);
      // Spring at the player on enrage — 45° launch, same redirect physics
      // as the ground lunge. Rage stays ON (this isn't the discharging dash,
      // it's the opening move) until a real lunge lands or timeout hits.
      this.launchAt(playerPos, Math.SQRT1_2);
      this.dashFlash = 0.15;
      for (let i = 0; i < 8; i++) this.spawnDot();
      this.onBounce?.(this.pos.clone(), this.vel.clone());
    } else {
      this.teleportNearPlayer(terrain, playerPos);
    }
  }

  // Redirect velocity toward the player, preserving current speed (floored
  // at half dash speed so a dead-slow roll still produces a real launch).
  // upFrac is sin(launch angle): 0.34 ≈ flat lunge, √½ = 45° spring.
  private launchAt(playerPos: THREE.Vector3, upFrac: number): void {
    const pdx = playerPos.x - this.pos.x;
    const pdz = playerPos.z - this.pos.z;
    const pd = Math.sqrt(pdx * pdx + pdz * pdz) || 0.001;
    const speed = Math.max(this.vel.length(), BALL_ENRAGE_DASH_SPEED * 0.5);
    const h = Math.sqrt(1 - upFrac * upFrac);
    this.vel.set((pdx / pd) * speed * h, 0, (pdz / pd) * speed * h);
    // Launch angle, plus extra loft if the player is above
    this.vel.y = Math.max(speed * upFrac, (playerPos.y - this.pos.y) * 0.8);
  }

  // Ballistic lunge: horizontal speed becomes the approach speed, then vy is
  // solved so the arc lands on the player after t = dist/hspeed seconds.
  // Angles up as needed — over bumps, up at elevated players — instead of a
  // flat beeline that eats terrain or hits feet.
  private dashAt(playerPos: THREE.Vector3): void {
    const pdx = playerPos.x - this.pos.x;
    const pdz = playerPos.z - this.pos.z;
    const pd = Math.sqrt(pdx * pdx + pdz * pdz) || 0.001;
    const hSpeed = Math.max(Math.hypot(this.vel.x, this.vel.z), BALL_ENRAGE_DASH_SPEED * 0.5);
    const t = Math.max(0.15, pd / hSpeed); // flight time
    const vy = (playerPos.y - this.pos.y + 0.5 * Math.abs(BALL_GRAVITY) * t * t) / t;
    this.vel.set((pdx / pd) * hSpeed, vy, (pdz / pd) * hSpeed);
  }

  /** Director hook — enrage storms light up every ball at once. */
  enrage(): void { this.setEnraged(true); }

  private setEnraged(on: boolean): void {
    if (this.enraged === on) return;
    this.enraged = on;
    this.enrageTimer = 0;
    // Visual cue: emissive red burn while enraged
    this.emissive.setRGB(on ? 0.55 : 0, 0, 0);
  }

  // Ball drifted too far from the player — teleport it back into play range
  private teleportNearPlayer(terrain: Terrain, playerPos: THREE.Vector3): void {
    const ang = Math.random() * Math.PI * 2;
    const dist = BALL_TELE_MIN + Math.random() * (BALL_TELE_MAX - BALL_TELE_MIN);
    this.pos.x = playerPos.x + Math.cos(ang) * dist;
    this.pos.z = playerPos.z + Math.sin(ang) * dist;
    this.pos.y = terrain.getHeight(this.pos.x, this.pos.z) + BALL_TELE_HEIGHT;

    // Position jumped — cut the ribbons so they don't streak across the teleport
    for (const r of this.ribbons) r.clear();

    // Preserve absolute velocity, redirect according to terrain normal at teleport point
    const currentSpeed = this.vel.length();
    const n = terrain.getNormal(this.pos.x, this.pos.z);
    const dot = this.vel.dot(n);
    this.vel.addScaledVector(n, -2.0 * dot * BOUNCE);
    this.vel.normalize().multiplyScalar(currentSpeed);

    // Reset energy tracking on teleport (intentional energy reset)
    this.lastBounceEnergy = 0;
    // Record teleport as a bounce keyframe too (position + velocity reset)
    this.onBounce?.(this.pos.clone(), this.vel.clone());
  }

  private emitTrailDot(dt: number): void {
    this.trailTimer += dt;
    if (this.trailTimer < TRAIL_INTERVAL) return;
    this.trailTimer = 0;
    if (this.vel.lengthSq() <= 0.5) return;
    this.spawnDot();
  }

  // Two-layer sprite dot: tinted halo + near-white core. These complement
  // the clean ribbon — scattered spawn inside a small sphere around the
  // ball, random size and lifetime, so they read as chaotic sparkle.
  // Sprites come from a per-ball pool — no create/dispose churn.
  private spawnDot(): void {
    const spawn = _spawn.copy(this._rpos).addScaledVector(_scatter.set(
      Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1,
    ).normalize().multiplyScalar(Math.random() * this.radius * 0.6), 1);
    const haloSz = this.radius * (1.8 + Math.random() * 2.0);
    const coreSz = this.radius * (0.9 + Math.random() * 1.0);
    const life = 0.35 + Math.random() * 0.85;
    let d = this.dotPool.pop();
    if (d) {
      d.halo.position.copy(spawn);
      d.core.position.copy(spawn);
      this.scene.add(d.halo); this.scene.add(d.core);
    } else {
      const tex = getTrailTex();
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, color: this.color, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      const core = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, color: this.color.clone().lerp(new THREE.Color(1, 1, 1), 0.65),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      halo.position.copy(spawn); core.position.copy(spawn);
      this.scene.add(halo); this.scene.add(core);
      d = { halo, core, age: 0, life, haloSz, coreSz };
    }
    // Enraged balls bleed a red trail — the sparkle is the biggest
    // on-screen tell, so it has to carry the hostility signal
    const tint = this.enraged ? _enrageTint : this.color;
    (d.halo.material as THREE.SpriteMaterial).color.copy(tint);
    (d.core.material as THREE.SpriteMaterial).color.copy(tint).lerp(_white, 0.65);
    d.halo.scale.setScalar(haloSz);
    d.core.scale.setScalar(coreSz);
    if (this.trailDots.length >= TRAIL_COUNT) {
      this.removeDot(this.trailDots.shift()!);
    }
    d.age = 0; d.life = life; d.haloSz = haloSz; d.coreSz = coreSz;
    this.trailDots.push(d);
  }

  private dotPool: TrailDot[] = [];

  private removeDot(d: TrailDot): void {
    this.scene.remove(d.halo);
    this.scene.remove(d.core);
    this.dotPool.push(d); // pooled — materials reused, nothing disposed
  }

  private fadeTrailDots(dt: number): void {
    for (let i = this.trailDots.length - 1; i >= 0; i--) {
      const d = this.trailDots[i];
      d.age += dt;
      if (d.age >= d.life) {
        this.removeDot(d);
        this.trailDots.splice(i, 1);
      } else {
        const t = 1.0 - d.age / d.life;
        d.halo.material.opacity = t * 0.28;
        d.core.material.opacity = t * 0.7;
        // Shrink-out with per-dot base sizes
        d.core.scale.setScalar(d.coreSz * (0.4 + 0.6 * t));
        d.halo.scale.setScalar(d.haloSz * (0.7 + 0.3 * t));
      }
    }
  }

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

  /** Authoritative resync — a segment event lands mid-flight: snap the sim
   *  (and the render) to server truth, then advance it by `lead` seconds
   *  (≈half RTT) because the event is already stale when it arrives —
   *  without this every bounce visibly rewinds the ball before re-flying.
   *  The >20m trail-cut already handles teleport discontinuities. */
  applyNetSegment(
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    enraged: boolean, targetId: string | null,
    lead = 0, targetPos?: THREE.Vector3 | null,
    timers?: { et?: number; slowT?: number; damp?: boolean },
    tp?: { x: number; y: number; z: number } | null,
  ): void {
    const s = this.sim;
    if (!s) return;
    s.x = px; s.y = py; s.z = pz;
    s.vx = vx; s.vy = vy; s.vz = vz;
    s.enraged = enraged;
    // The timers ride the wire — resetting them here would restart the
    // server's 20s enrage countdown on every heartbeat and the client ball
    // would outlive enrages the authority already teleported out of.
    s.enrageTimer = timers?.et ?? 0;
    s.slowTimer = timers?.slowT ?? 0;
    s.dampNextBounce = timers?.damp ?? false;
    // Aim snapshot — the server pulled toward THIS point, so we do too.
    if (tp) { s.tx = tp.x; s.ty = tp.y; s.tz = tp.z; s.tgtValid = true; }
    else s.tgtValid = false;
    this.netTargetId = targetId;
    // Do NOT step the lead age here: a partial-width step leaves the sim
    // cursor off the server's 0.05 grid permanently — every subsequent
    // prediction step is phase-shifted, bounce contacts resolve at
    // different points, and elastic reflections compound the error into
    // the 20-100m rubberbands the logs show. Bank the age instead: the
    // update loop consumes whole cells only (sim stays exactly on-grid),
    // and the render path ballistically extrapolates the sub-step
    // remainder — which is all the lead was ever for.
    this.netAcc = Math.min(lead, 0.5);
    // Carry the visible error into renderOffset: (old rendered pos) - (new
    // truth). >6m means the prediction diverged hard — hard-snap instead of
    // smearing a long rubber slide across the screen.
    this._rpos.copy(this.pos).add(this.renderOffset);
    this._rpos.x -= s.x; this._rpos.y -= s.y; this._rpos.z -= s.z;
    if (this._rpos.lengthSq() > 36) this.renderOffset.set(0, 0, 0);
    else this.renderOffset.copy(this._rpos);
    this.pos.set(s.x, s.y, s.z);
    this.vel.set(s.vx, s.vy, s.vz);
    this.enraged = s.enraged;
    this.enrageTimer = 0;
    if (!enraged) this.emissive.setRGB(0, 0, 0);
  }

  /** Server said dead — the updateDead path fades trails as usual. */
  netKill(): void {
    this.dead = true;
  }

  dispose(): void {
    if (!this.meshRemoved) { freeSlots('ball', this); this.meshRemoved = true; }
    for (const d of this.trailDots) {
      this.removeDot(d);
    }
    this.trailDots = [];
    for (const d of this.dotPool) {
      d.halo.material.dispose();
      d.core.material.dispose();
    }
    this.dotPool = [];
    for (const r of this.ribbons) r.dispose(this.scene);
  }
}

export function pickVariant(): 0 | 1 | 2 | 3 {
  const r = Math.random();
  if (r < 0.08) return 3; // elites are rare — each one is an event
  if (r < 0.18) return 2;
  if (r < 0.38) return 1;
  return 0;
}
