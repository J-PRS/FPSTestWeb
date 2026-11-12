import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import { GRAVITY, BALL_BASE_RADIUS } from '../core/config.js';

import {type Terrain, getHeightfield} from '../world/terrain.js';
import { makeSimBall, stepBall, applySimDamage, type StructureCollider, type SegmentKind } from '../../../shared/ballSim.js';
import type { ColliderIndex } from '../../../shared/solidWorld.js';
import { type Heightfield, hmFingerprint } from '../../../shared/heightfield.js';
import { type NetBag, newNetBag, type NetStatics, type NetSeg, tickNet, isStaleSeg, applySeg, netProf } from './ballNet.js';
import { Logger } from '../core/Logger.js';
import { RibbonTrail, DyingRibbons } from '../effects/RibbonTrail.js';
import type { TrailDriver } from '../effects/vfxRuntime.js';
import { BallTrailDots } from '../effects/ballTrails.js';
import { bakeWearOnly } from '../effects/vertexAO.js';
import { forceDropDebugPin, breakDropDebugPin } from '../effects/debugPins.js';
import { tickEnrage as tickRage, setEnraged as rageSet } from './ballRage.js';
import { writeBallInstance, tickBallRenderPos, tickBallTrails, updateBallDead, SPAWN_POP_S, BALL_TRAILS } from './ballVisual.js';
import { allocSlots, freeSlots, getShadows, type SwarmPart } from './swarms.js';
import { registerDiag } from '../core/fxDiag.js';
import { urlParams } from '../core/params.js';
import { inv } from '../../../shared/invariants.js';
import { drawBallSpawn, drawVariant, spawnRand } from '../../../shared/spawnDice.js';



// ?ballprof - sub-phase timing inside update() to name the seg-correction
// burst spender. Off-path cost is one branch; the timed path is a separate
// method so the normal hot path keeps zero timing overhead.
const BALL_PROF = urlParams.has('ballprof');
netProf.on = BALL_PROF;
const ballProf = { calls: 0, net: 0, render: 0, rage: 0, shadow: 0, inst: 0, trails: 0, sim: 0, dress: 0, max: 0, maxAt: '' };

const BALL_GRAVITY   = GRAVITY;
const _enrageTint = new THREE.Color(1, 0.12, 0.08);

// One shared geometry for every ball - radius baked in, per-ball scale lives
// in the instance matrix.
let _ballGeo: THREE.BufferGeometry | null = null;
function ballGeo(): THREE.BufferGeometry {
  if (!_ballGeo) {
    // Edge wear baked once through the weapon pipeline (bakeWearOnly) -
    // the same wear texture the gun viewmodels get, so edges read worn.
    // Flat per-face normals: the icosahedron's default vertex normals are
    // smooth sphere normals, which hide every edge from the wear detector.
    const flat = new THREE.IcosahedronGeometry(BALL_BASE_RADIUS, 0); // polyhedra are already non-indexed
    flat.computeVertexNormals();
    const mesh = new THREE.Mesh(flat, ballMat());
    bakeWearOnly(new THREE.Group().add(mesh));
    // A 138° icosahedron edge scores ~0.26 - under the shader's 0.6 wear
    // gate - so boost the edge wear, not the (flat, zero) faces.
    const wear = mesh.geometry.getAttribute('wear') as THREE.BufferAttribute;
    for (let i = 0; i < wear.count; i += 1) {wear.setX(i, Math.min(1, wear.getX(i) * 2.5));}
    wear.needsUpdate = true;
    _ballGeo = mesh.geometry;
  }
  return _ballGeo;
}
let _ballMat: THREE.MeshToonMaterial | null = null;
function ballMat(): THREE.MeshToonMaterial {
  // White diffuse - instanceColor carries hue + emissive-style glow.
  // Toon + 3-step ramp: shade floor ~0.4 so lit faces pop against
  // shadowed ones (Lambert's smooth falloff read as flat at range).
  if (!_ballMat) {
    // Three hard bands: very dark underside, mid, light top.
    const ramp = new THREE.DataTexture(new Uint8Array([40, 150, 255]), 3, 1, THREE.RedFormat);
    ramp.minFilter = THREE.NearestFilter;
    ramp.magFilter = THREE.NearestFilter;
    ramp.needsUpdate = true;
    _ballMat = new THREE.MeshToonMaterial({ color: 0xFF_FF_FF, gradientMap: ramp });
  }
  return _ballMat;
}

// Inverted hull: same sphere pushed to ~107% drawn back-side white - the
// classic cel outline. Second swarm part, matrix written in
// writeBallInstance; two parts still stays under the gib-burst floor.
let _outlineMat: THREE.MeshBasicMaterial | null = null;
function outlineMat(): THREE.MeshBasicMaterial {
  if (!_outlineMat) {_outlineMat = new THREE.MeshBasicMaterial({ color: 0xFF_FF_FF, side: THREE.BackSide });}
  return _outlineMat;
}

export function ballParts(): SwarmPart[] {
  return [
    { geometry: ballGeo(), material: ballMat(), castShadow: true },
    { geometry: ballGeo(), material: outlineMat() },
  ];
}

const BALL_COLORS = [
  new THREE.Color(1, 0.25, 0.25),
  new THREE.Color(0.25, 0.85, 0.25),
  new THREE.Color(0.25, 0.55, 1),
  new THREE.Color(1, 0.85, 0.1),
  new THREE.Color(0.9, 0.25, 0.9),
  new THREE.Color(0.15, 0.9, 0.9),
  new THREE.Color(1, 0.5, 0.1),
];

// Anything a projectile can hit / an explosion can push: balls, crawlers.
// combat.ts works against this surface - position, radius, damage, knockback.
export interface Targetable {
  readonly id: number;
  variant: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead: boolean;
  health: number;
  maxHealth?: number;
  radius: number;
  /** Collision radius override - render and physics radius diverge on
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
  /** serverPaid: the authority's sim already settles this damage (shell
   *  contact / shell splash) - skip the hit claim or it pays twice. */
  takeDamage(damage: number, opts?: { serverPaid?: boolean }): boolean;
  /** claim=true only for directed-hit shoves (melee, lightning pin) whose
   *  impulse must ride the next creatureHit claim; AoE blasts are
   *  predict-only - the server's blast knock() already shoves authority. */
  applyKnockback(from: THREE.Vector3, force: number, claim?: boolean): void;
  applyPull(to: THREE.Vector3, force: number, claim?: boolean): void;
  /** Wire identity for net-driven targets - kill/damage records must key
   *  on netId, not the client 0x40xx id, or replay never sees the edge. */
  netDriven?: boolean;
  netId?: number;
  /** Props (Tumbleweed) die visually but shouldn't credit frags. */
  scoreless?: boolean;
  /** Suppress nugget drops - wildlife and pure props. */
  lootless?: boolean;
  /** Suppress floating health bars - set for props, not hostile wildlife. */
  hideHealthBar?: boolean;
  /** 'brush' = fluttering twigs/feathers; 'goo' = sticky splat blobs. */
  debrisKind?: 'rock' | 'brush' | 'goo';
  /** Ichor hex - creatures bleed tinted goo: hit spray droplets and
   *  projected ground stains. Absent = mechanical/prop (no spray). */
  ichor?: number;
  /** Real fragment geometries for the death burst (tumbleweed twigs) -
   *  debris shards use these instead of generated chunks. */
  debrisGeos?: THREE.BufferGeometry[];
  /** Death-cue override - crawlers splat, weeds rustle, most use default. */
  dieCue?: 'die' | 'splat' | 'rustle' | 'squawk';
  /** Swarm-rendered entities carry instancing handles so the death path can
   *  shatter the body into gibs; absent on plain-mesh targets. */
  swarmSlot?: number;
  swarmSpecies?: string;
  shadowSlot?: number;
  /** Fires once when destroyed - elites split, everything else ignores it. */
  onDeath?: (t: Targetable) => void;
}

export class Ball {
  // Live-ball registry - feeds the Alt+Q trail census (ribbon/dot gate
  // state per ball, no plumbing through entities.ts needed).
  static readonly live = new Set<Ball>();
  // Camera position synced by the main loop once per frame - feeds the
  // billboarded ribbon trails (avoids threading camPos through every
  // update() call site including demo playback fast-forward).
  static readonly viewPos = new THREE.Vector3();
  readonly id: number;
  readonly variant: 0 | 1 | 2 | 3;
  /** Elite split hook - wired by entities.ts for variant 3. */
  onDeath?: (t: Targetable) => void;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  color: THREE.Color;

  // Renders through the 'ball' swarm - instanceColor carries hue plus the
  // enrage/dash/flash glow (values >1 fake emissive).
  swarmSlot = -1;
  shadowSlot = -1;

  scene: THREE.Scene;
  scale: number;
  emissive = new THREE.Color(0, 0, 0); // additive glow - folded into instanceColor; public so ballNet can mirror enrage state onto it
  // Public flat fields - ballRage's BallRageHost mutates them (the same
  // state-bag pattern as the *Visual splits).
  trails: BallTrailDots;
  ribbons: RibbonTrail[];
  /** Driver-owned emit path - tickBallTrails only refreshes _trailNear. */
  trailDriver?: TrailDriver;
  _trailNear = true;
  _trailDt = 0;
  _blendCut = false; // true while a large renderOffset blend suppressed ribbons
  flashTimer = 0;
  /** Spring-in timer - instance scale eases 0→1 over SPAWN_POP_S. Reset by
   *  ballRage's teleport; visual-only, never recorded. */
  spawnPopT = SPAWN_POP_S;
  meshRemoved = false; // swarm slot freed; name kept - it gates dead-ball cleanup
  _disposed = false;

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
  /** Minimap reads this - enraged balls are threats, not ambient cyan. */
  get isEnraged(): boolean { return this.enraged; }
  enrageTimer = 0;
  slowTimer = 0; // seconds under BALL_MIN_SPEED - fires the stall breaker
  dampNextBounce = false; // set by the enrage dash - next ground bounce reflects at 50%
  dashFlash = 0; // brief white-hot pop right after a lunge

  // ---- Server-driven mode (shared PvE) ---------------------------------
  // A netDriven ball replays shared/ballSim.ts NON-authoritatively: server
  // `ballSegment` events snap pos/vel/target, and between events the local
  // stepper predicts the same arc against the same heightfield - bounce-for
  // -bounce identical, so corrections are invisible unless latency spikes.
  netDriven = false;
  /** Demo playback: pos/vel come from recorded edges (reseeded via
   *  seedSim), the sim only fills physics between them — pass
   *  authoritative=false + target=null to stepBall or its enrage pull /
   *  stall-breaker / leash teleport fire on the sim's own clock toward
   *  the local player, not the recorded one (phantom fly-aways). */
  edgeDriven = false;
  netId = 0;
  get netTargetId(): string | null { return this.netS.netTargetId; }
  readonly netS: NetBag = newNetBag();
  private static field: Heightfield | null = null;
  /** Read-only for desync forensics (netBalls logs its fingerprint on
   *  rubberbands). Mutate via initNetMode only. */
  static get netField(): Heightfield | null { return Ball.field; }
  /** True while a terrain swap is loading - prediction still runs on the
   *  previous field until initNetMode(true) rebinds it, so rubberband
   *  warns in this window are expected, not desync signal. */
  static terrainSwapping = false;

  /** Prediction-state snapshot for the rubberband warn - answers "which
   *  regime diverged" in one line: simT≫simNow = free-ran past the clock
   *  gate; inert legAge pinned at ~8 = stale anchor extrapolating blind. */
  get netDiag(): { simT: number; simNow: number | null; legT0: number; legAge: number; enraged: boolean; tgtValid: boolean; parked: boolean; anchor: { x: number; y: number; z: number; vx: number; vy: number; vz: number } } | null {
    const {sim} = this.netS;
    if (!sim) {return null;}
    const simNow = Ball.netSimNow?.() ?? null;
    const legAge = simNow !== null && Number.isFinite(simNow) && this.netS.legT0 >= 0
      ? simNow - this.netS.legT0 : -1;
    return {
      simT: this.netS.simT, simNow, legT0: this.netS.legT0, legAge,
      enraged: sim.enraged, tgtValid: sim.tgtValid, parked: this.netS.parked,
      anchor: { x: sim.x, y: sim.y, z: sim.z, vx: sim.vx, vy: sim.vy, vz: sim.vz },
    };
  }
  /** Map-structure colliders from gameState - prediction ricochets off
   *  walls/pillars identically to the server. Set by netHandlers. */
  static colliders: readonly StructureCollider[] = [];
  static colliderIndex: ColliderIndex | null = null;
  /** Sim-time the ball's pos is evaluated at - server grid multiples of
   *  0.05. Steps fire only while the next cell is behind the server clock
   *  estimate: free-running ahead is what bounced early and snapped back. */
  private simT = 0;
  /** Server-sim "now" estimate - wired by netBalls from stamped events. */
  static netSimNow: (() => number) | null = null;
  /** entities.ts wires this once - hit claims go to the server, not local health. */
  static hitClaim: ((netId: number, damage: number, ix: number, iy: number, iz: number) => void) | null = null;
  private _netImp = new THREE.Vector3(); // pending knockback impulse → next claim
  /** ballNet reads Ball's statics through closures - no circular import. */
  private static readonly NET_S: NetStatics = {
    field: (): Heightfield | null => Ball.field,
    simNow: (): number | undefined => Ball.netSimNow?.(),
    colliders: (): readonly StructureCollider[] => Ball.colliders,
    colliderIndex: (): ColliderIndex | null => Ball.colliderIndex,
  };
  readonly renderOffset = new THREE.Vector3(); // public: ballNet blends segment corrections into it
  readonly _rpos = new THREE.Vector3(); // pos + renderOffset, scratch

  private static lastBoundFp = '';
  /** Teleported balls' old tails - stopped, fading where they were left. */
  private static dyingRibbons = new DyingRibbons();
  static updateDyingRibbons(dt: number): void { Ball.dyingRibbons.update(dt, Ball.viewPos); }

  /** One-time init: the heightfield the shared sim needs for bounce prediction. */
  static initNetMode(force = false): void {
    if (force || !Ball.field) {
      Ball.field = getHeightfield();
      if (Ball.field) {
        const fp = hmFingerprint(Ball.field);
        if (fp !== Ball.lastBoundFp) {
          Ball.lastBoundFp = fp;
          Logger.info(`[Ball] netmode field bound fp=${fp}`);
        }
      }
    }
  }

  constructor(scene: THREE.Scene, terrain: Terrain, variant: 0 | 1 | 2 | 3 = 0,
    netSpawn?: { id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; colorIdx: number },
    center?: THREE.Vector3) {
    this.scene = scene;
    this.id = nextTargetId();
    this.variant = variant;
    // The whole ambient spawn's dice in one shared draw - verifier
    // replays this exact sequence against the run's seed. Net-driven
    // spawns consume nothing (wire is truth).
    const spawn = netSpawn ? null : drawBallSpawn(spawnRand, variant, BALL_COLORS.length);

    if (variant === 3) {
      // Elite - big violet splitter; death spawns two children
      this.scale = 2.4; this.health = 350;
      this.color = new THREE.Color(0.45, 0.2, 0.85);
    } else if (variant === 2) {
      this.scale = 3; this.health = 200;
      this.color = new THREE.Color(1, 0.25, 0.25);
    } else if (variant === 1) {
      this.scale = 2; this.health = 125;
      this.color = new THREE.Color(0.25, 0.85, 0.25);
    } else {
      this.scale = 1; this.health = 75;
      // Ambient pick only for an offline spawn - a net-driven ball's color
      // is the wire's colorIdx (set below); drawing here would be an
      // ambient draw in a replicated entity's construction (§5 inv 3).
      this.color = netSpawn
        ? BALL_COLORS[netSpawn.colorIdx % BALL_COLORS.length]!.clone()
        : BALL_COLORS[spawn!.colorIdx % BALL_COLORS.length]!.clone();
    }
    this.maxHealth = this.health;
    this.radius = BALL_BASE_RADIUS * this.scale;

    // Two-lane billboarded ribbon: wide tinted halo + thin near-white core,
    // same structure as the disc trails but the strip always faces the camera.
    const coreColor = this.color.clone().lerp(new THREE.Color(1, 1, 1), 0.7);
    // Scale color energy down - additive stacking made full-strength colors
    // eye-searing; these are emission intensities, not hues
    this.trails = new BallTrailDots(scene);
    this.ribbons = this.acquireRibbons(coreColor);


    if (netSpawn) {
      // Server-owned spawn - pos/vel/color come off the wire, nothing rolled
      this.netDriven = true;
      this.netId = netSpawn.id;
      this.id = 0x40_00_00_00 + netSpawn.id; // net namespace - can't collide with local targetIds
      this.pos = new THREE.Vector3(netSpawn.x, netSpawn.y, netSpawn.z);
      this.vel = new THREE.Vector3(netSpawn.vx, netSpawn.vy, netSpawn.vz);
      this.netS.sim = makeSimBall(netSpawn.id, variant, netSpawn.colorIdx,
        { x: netSpawn.x, y: netSpawn.y, z: netSpawn.z },
        { x: netSpawn.vx, y: netSpawn.vy, z: netSpawn.vz });
    } else {
      // OG RadialSpawner parity: a point on the 100-400m ring around the
      // player, dropped ~5m over the surface, tossed UP at 32-64 m/s with
      // a two-die triangular horizontal scatter (peak 0, tail ±32), the
      // whole impulse scaled by 1/scale so big variants launch slower.
      const cx = center?.x ?? 0, cz = center?.z ?? 0;
      const rx = cx + spawn!.offX, rz = cz + spawn!.offZ;
      const gy = terrain.getHeight(rx, rz);
      this.pos = new THREE.Vector3(rx, (Number.isFinite(gy) ? gy : 0) + this.radius + 5, rz);

      this.vel = new THREE.Vector3(spawn!.vel.x, spawn!.vel.y, spawn!.vel.z);
      // Local authority: the same shared sim the wire replays - bounce,
      // enrage pull, stall breaker, leash teleport all live there; this
      // ball's update() only adds dressing to the events it returns.
      this.netS.sim = makeSimBall(this.id, variant, spawn!.colorIdx,
        { x: this.pos.x, y: this.pos.y, z: this.pos.z },
        { x: this.vel.x, y: this.vel.y, z: this.vel.z });
      this.netS.sim.health = this.health;
    }

    if (!allocSlots('ball', this)) { this.dead = true; this._disposed = true; }
    writeBallInstance(this);
    Ball.live.add(this);
  }

  /** KEEP-IN-SYNC: updateProf below duplicates this body with per-phase
   *  lap() timers for ?ballprof - edit both or the profiler reports on
   *  stale code. */
  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) {
      updateBallDead(this, dt, Ball.viewPos);
      return;
    }
    if (BALL_PROF) {this.updateProf(dt, terrain, playerPos); return;}

    if (this.spawnPopT > 0) {this.spawnPopT -= dt;}
    this.prevVelY = this.vel.y;
    if (this.netDriven && this.netS.sim && Ball.field) {
      tickNet(Ball.NET_S, this.netS, this, dt);
    } else {
      this.tickLocal(dt, playerPos);
    }

    tickBallRenderPos(this, dt);

    // Peak detection: vel.y crossed from positive to negative (apex of arc)
    if (this.prevVelY > 0 && this.vel.y <= 0 && this.onPeak) {
      this.onPeak(this.pos.clone(), this.vel.clone());
    }

    tickRage(this, dt, terrain, playerPos);
    getShadows()?.set(this, this._rpos, this.radius, 0.3);
    writeBallInstance(this);

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) {this.emissive.setRGB(0, 0, 0);}
    }

    tickBallTrails(this, dt, Ball.viewPos);
  }

  /** ?ballprof twin of update() - identical work, each phase timed and
   *  folded into the module accumulator the 'balls' diag section dumps. */
  private updateProf(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    const t0 = performance.now();
    let t = t0;
    const lap = (acc: 'net' | 'render' | 'rage' | 'shadow' | 'inst' | 'trails', parts: string[]): void => {
      const n = performance.now();
      const ms = n - t;
      ballProf[acc] += ms;
      if (ms > 0.5) {parts.push(`${acc}=${ms.toFixed(1)}`);}
      t = n;
    };
    const parts: string[] = [];

    if (this.spawnPopT > 0) {this.spawnPopT -= dt;}
    this.prevVelY = this.vel.y;
    if (this.netDriven && this.netS.sim && Ball.field) {
      tickNet(Ball.NET_S, this.netS, this, dt);
    } else {
      this.tickLocal(dt, playerPos);
    }
    lap('net', parts);

    tickBallRenderPos(this, dt);
    lap('render', parts);

    if (this.prevVelY > 0 && this.vel.y <= 0 && this.onPeak) {
      this.onPeak(this.pos.clone(), this.vel.clone());
    }

    tickRage(this, dt, terrain, playerPos);
    lap('rage', parts);

    getShadows()?.set(this, this._rpos, this.radius, 0.3);
    lap('shadow', parts);

    writeBallInstance(this);
    lap('inst', parts);

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) {this.emissive.setRGB(0, 0, 0);}
    }

    tickBallTrails(this, dt, Ball.viewPos);
    lap('trails', parts);
    ballProf.calls += 1;
    const callMs = performance.now() - t0;
    if (callMs > ballProf.max) {
      ballProf.max = callMs;
      ballProf.maxAt = `id${this.id} ${this.netDriven ? 'net' : 'loc'}${this.netS.sim?.enraged ? ' rage' : ''} ${parts.join(' ')}`;
    }
  }

  /** Director hook - enrage storms light up every ball at once. Writes
   *  the sim (its own pull does the chasing); rageSet is just the tint. */
  enrage(): void {
    const s = this.netS.sim;
    if (s) {s.enraged = true;}
    rageSet(this, true);
  }

  /** Local-authority leg - the same stepBall the wire replays, stepped at
   *  frame dt against the same heightfield. Segment kinds land as dressing
   *  (burst/teleport fade/keyframe) instead of wire broadcasts. */
  private tickLocal(dt: number, playerPos: THREE.Vector3): void {
    const s = this.netS.sim;
    const field = Ball.field ?? getHeightfield();
    if (!s || !field) {
      this.vel.y += BALL_GRAVITY * dt;
      this.pos.addScaledVector(this.vel, dt);
      return;
    }
    // The committed target is the live player - offline has no link lag.
    const _pt = BALL_PROF ? performance.now() : 0;
    const ev = stepBall(s, dt, field, this.edgeDriven ? null : playerPos, !this.edgeDriven,
      { colliders: Ball.colliders, colliderIndex: Ball.colliderIndex ?? undefined });
    if (BALL_PROF) {ballProf.sim += performance.now() - _pt;}
    this.pos.set(s.x, s.y, s.z);
    this.vel.set(s.vx, s.vy, s.vz);
    this.enraged = s.enraged;
    this.enrageTimer = s.enrageTimer;
    this.slowTimer = s.slowTimer;
    this.dampNextBounce = s.dampNextBounce;
    this.health = s.health;
    if (s.dead) {this.dead = true;}
    const _pd = BALL_PROF ? performance.now() : 0;
    this.dressSegment(ev);
    if (BALL_PROF) {ballProf.dress += performance.now() - _pd;}
  }

  /** Event → dressing. onBounce is the demo keyframe - every velocity
   *  discontinuity records one, same as the pre-sim path did. */
  private dressSegment(ev: SegmentKind | null): void {
    if (ev === null) {return;}
    if (ev === 'teleport') {
      // Position jumped - retire the tails so they fade where they were,
      // then spring-in at the new perch.
      this.retireRibbons();
      this.spawnPopT = SPAWN_POP_S;
      this.trails.burst(12, this.pos, this.radius, this.color);
      // Pin at the NEW pos, not _rpos (which still holds the pre-jump
      // spot until writeBallInstance runs) - the conn old→new is what
      // gets marked bad; a stale pin would mark the wrong conn.
      breakDropDebugPin(this, this.pos);
      this.onBounce?.(this.pos.clone(), this.vel.clone());
      return;
    }
    if (ev === 'lunge' || ev === 'enrage' || ev === 'stall') {
      this.dashFlash = 0.15;
      this.trails.burst(8, this._rpos, this.radius, this.enraged ? _enrageTint : this.color);
    }
    if (ev === 'bounce' || ev === 'lunge' || ev === 'enrage' || ev === 'stall' || ev === 'knockback' || ev === 'hit') {
      this.onBounce?.(this.pos.clone(), this.vel.clone());
      // Debug pin at every direction-change - the trail-vs-body
      // comparison needs a marker exactly where the path turns.
      forceDropDebugPin(this, this._rpos);
    }
  }

  hitTest(px: number, py: number, pz: number, extraRadius = 0): boolean {
    const dx = px - this.pos.x;
    const dy = py - this.pos.y;
    const dz = pz - this.pos.z;
    const r = this.radius + extraRadius;
    return dx * dx + dy * dy + dz * dz <= r * r;
  }

  takeDamage(damage: number, opts?: { serverPaid?: boolean }): boolean {
    // NaN damage: clamped Math.max(0, NaN) = NaN, and health <= 0 fails
    // forever - a poisoned bar or an unkillable ball either way.
    if (!Number.isFinite(damage)) { inv('ball-damage-finite', false, { damage, net: this.netDriven }); return false; }
    if (this.netDriven) {
      // Server-authoritative: claim the hit (with any knockback the caller
      // already staged), flash locally, and let ballDie decide death.
      // Shell contact/splash callers pass serverPaid - the sim's
      // creatureSweep/splashDamage pays those, a claim would double-pay.
      if (!opts?.serverPaid) {Ball.hitClaim?.(this.netId, damage, this._netImp.x, this._netImp.y, this._netImp.z);}
      this._netImp.set(0, 0, 0);
      this.flashTimer = 0.15;
      // Predicted health - the claim carries exactly this damage, so the
      // floating bar can tick down NOW instead of one RTT late. Death is
      // still the server's call; clamp at 0, never set `dead`.
      this.health = Math.max(0, this.health - damage);
      return false;
    }
    this.flashTimer = 0.15;
    const s = this.netS.sim;
    if (s) {
      if (applySimDamage(s, damage, 0, 0, 0)) { this.dead = true; return true; }
      this.health = s.health;
      return false;
    }
    this.health -= damage;
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number, claim = false): void {
    const dir = this.pos.clone().sub(from).normalize();
    if (this.netDriven) {
      // Predicted shove on the replay sim - the server's knock()/hit impulse
      // is the identical math, so the next segment confirms instead of
      // yanking 20-50m (the render-blend/follow-jump storm).
      const s = this.netS.sim;
      if (s) { s.vx += dir.x * force; s.vy += dir.y * force; s.vz += dir.z * force; s.gt = 0; }
      this.netS.lastPredImpulseMs = performance.now(); // seg-div suppresses the designed divergence
      if (claim) { this._netImp.addScaledVector(dir, force); }
      return;
    }
    // Same write as the net path - the impulse lands in the sim, the next
    // stepBall just flies the new arc (gt=0: the cached probe is stale).
    const s = this.netS.sim;
    if (s) { s.vx += dir.x * force; s.vy += dir.y * force; s.vz += dir.z * force; s.gt = 0; return; }
    this.vel.addScaledVector(dir, force);
  }

  applyPull(to: THREE.Vector3, force: number, claim = false): void {
    const dir = to.clone().sub(this.pos).normalize();
    if (this.netDriven) {
      const s = this.netS.sim;
      if (s) { s.vx += dir.x * force; s.vy += dir.y * force; s.vz += dir.z * force; s.gt = 0; }
      this.netS.lastPredImpulseMs = performance.now();
      if (claim) { this._netImp.addScaledVector(dir, force); }
      return;
    }
    const s = this.netS.sim;
    if (s) { s.vx += dir.x * force; s.vy += dir.y * force; s.vz += dir.z * force; s.gt = 0; return; }
    this.vel.addScaledVector(dir, force);
  }

  isStaleSegment(t: number | undefined): boolean { return isStaleSeg(this.netS, t); }

  applyNetSegment(seg: NetSeg): void { applySeg(Ball.NET_S, this.netS, this, seg); }

  /** Server said dead - the updateDead path fades trails as usual. */
  private acquireRibbons(coreColor?: THREE.Color): RibbonTrail[] {
    const core = coreColor ?? this.color.clone().lerp(new THREE.Color(1, 1, 1), 0.7);
    const out = BALL_TRAILS ? [
      RibbonTrail.acquire(this.scene, { color: this.color.clone().multiplyScalar(0.55).getHex(), width: this.radius * 1.2, life: 0.5, billboard: true, tag: 'ball' }),
      RibbonTrail.acquire(this.scene, { color: core.multiplyScalar(0.7).getHex(), width: this.radius * 0.45, life: 0.4, billboard: true, tag: 'ball', farCull: true }),
    ] : []; // BALL_TRAILS off: no ribbons - WPOS carries the line trail
    // TrailDriver sets follow only on the ribbons it was built with -
    // retired replacements must inherit the tail anchor themselves. The
    // anchor is _rpos (pos + renderOffset): raw pos snaps on every segment
    // correction while mesh+deposits blend - the follow-jump stream.
    for (const r of out) {
      r.follow = this._rpos;
      r.followManaged = true;
      r.jumpHint = (): Record<string, unknown> => ({ off: Math.round(this.renderOffset.length() * 10) / 10, v: Math.round(this.vel.length()), acc: Math.round(this.netS.netAcc * 1000) });
    }
    return out;
  }

  /** Position jump (leash teleport, playback snap): the old tails stop
   *  emitting and FADE OUT where they were - never a one-frame vanish -
   *  while fresh ribbons take over at the new spot. Swap is IN PLACE:
   *  TrailDriver captured this array at construction - a fresh array
   *  would leave it pushing into the retired ribbons forever. */
  retireRibbons(): void {
    // Drop follow BEFORE handing over - else each fading tail's head
    // sample re-pins to the teleported pos and drags the streak along.
    for (const r of this.ribbons) {r.follow = null;}
    Ball.dyingRibbons.fadeAll(this.ribbons);
    this.ribbons.length = 0;
    this.ribbons.push(...this.acquireRibbons());
  }

  netKill(): void {
    this.dead = true;
  }

  dispose(): void {
    // Always leave the census - the drained-dead path (updateBallDead)
    // frees FX itself and splices without dispose(), so without this a
    // corpse stays in Ball.live forever and the dump fills with dead rows.
    if (this._disposed) { Ball.live.delete(this); return; }
    Ball.live.delete(this);
    if (!this.meshRemoved) { freeSlots('ball', this); this.meshRemoved = true; }
    this.trailDriver?.release();
    this.trails.dispose();
    for (const r of this.ribbons) {r.dispose();}
  }
}

// Alt+Q census - one row per live ball pairing the emit-gate inputs
// (speed, cam distance vs the 200m particle cutoff) with the outputs
// (live dots, ribbon samples). A ball with velSq>0.5 and nearCam but
// dots=0/count<2 is emitting-into-the-void; velSq≈0 everywhere is the
// net-velocity starvation case.
registerDiag('balls', () => ({
  balls: Object.assign(
    {
      viewPos: `${Ball.viewPos.x.toFixed(0)},${Ball.viewPos.y.toFixed(0)},${Ball.viewPos.z.toFixed(0)}`,
    },
    BALL_PROF ? {
      prof: {
        calls: ballProf.calls,
        avgMs: ballProf.calls ? Number(((ballProf.net + ballProf.render + ballProf.rage + ballProf.shadow + ballProf.inst + ballProf.trails) / ballProf.calls).toFixed(3)) : 0,
        net: Number(ballProf.net.toFixed(1)), render: Number(ballProf.render.toFixed(1)),
        rage: Number(ballProf.rage.toFixed(1)), shadow: Number(ballProf.shadow.toFixed(1)),
        inst: Number(ballProf.inst.toFixed(1)), trails: Number(ballProf.trails.toFixed(1)),
        sim: Number(ballProf.sim.toFixed(1)), dress: Number(ballProf.dress.toFixed(1)),
        tickNet: { calls: netProf.calls, cells: netProf.cells, ms: Number(netProf.stepMs.toFixed(1)), max: Number(netProf.max.toFixed(1)), maxAt: netProf.maxAt },
        applySeg: { n: netProf.applyN, ms: Number(netProf.applyMs.toFixed(1)) },
        max: Number(ballProf.max.toFixed(1)), maxAt: ballProf.maxAt,
      },
    } : {},
    {
    rows: [...Ball.live].map(b => ({
      id: b.id, v: b.variant, net: b.netDriven || undefined, dead: b.dead || undefined,
      pos: `${b._rpos.x.toFixed(0)},${b._rpos.y.toFixed(0)},${b._rpos.z.toFixed(0)}`,
      spd: Number(Math.sqrt(b.vel.lengthSq()).toFixed(1)),
      camD: Number(Math.sqrt(b._rpos.distanceToSquared(Ball.viewPos)).toFixed(0)),
      dots: b.trails.dbg(),
      rib: b.ribbons.map(r => r.dbg()),
    })),
    },
  ),
}));

export type { NetSeg } from './ballNet.js';

export function pickVariant(): 0 | 1 | 2 | 3 {
  return drawVariant(spawnRand); // elites are rare - each one is an event
}
