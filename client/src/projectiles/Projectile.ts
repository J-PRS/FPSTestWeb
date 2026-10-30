import * as THREE from 'three';

import { GRAVITY } from '../core/config.js';
import { glitch } from '../core/fxDiag.js';
import { hitRadiusAt } from '../../../shared/combat.js';
import { idSeed, jitteredTtl, getWeaponStats } from '../../../shared/weapons.js';

import type { Targetable } from '../entities/balls.js';

import type { Terrain } from '../world/terrain.js';
import type { ProjectileConfig } from './types.js';

import { RibbonTrail } from '../effects/RibbonTrail.js';
import { RailSpiral } from '../effects/railSpiral.js';

import { QuarksTrail } from '../effects/vfx.js';
import { urlParams } from '../core/params.js';
import { TrailDriver } from '../effects/vfxRuntime.js';
import { buildProjectileMeshes, updateProjectileMesh, releaseProjectileInstance, syncProjectileInstance } from '../effects/projectileVisuals.js';
import { tickRemote } from './projRemote.js';
import type { ColliderIndex } from '../../../shared/solidWorld.js';
import type { StructureCollider } from '../../../shared/ballSim.js';
import { ProjCollide } from './projCollide.js';
import { ballGhostPos } from './sweep.js';
import { ProjStuck } from './projStuck.js';
const _rayDir = new THREE.Vector3();
// Rope dart: shared geo/mat + scratch — one taut rod per live dart, so a
// per-dart allocation would be churn for a 5-vert cylinder.
// Visual only: once attached the rope may shorten but never stretch; a longer
// span detaches the thrower end and reels it back toward the anchor.
const ROPE_REEL_S = 0.2;
const _ropeGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 5, 1, true);
const _ropeMat = new THREE.MeshBasicMaterial({ color: 0x1A_14_0C });
const _ropeV = new THREE.Vector3();
const _ropeUp = new THREE.Vector3(0, 1, 0);

/** Backstop fuse — see the age check in updateAlive. */
const ABSOLUTE_TTL_S = 10;


/**
 * Projectile: client-authoritative hitscan-like projectile with swept collision.
 *
 * Per-frame movement advances the projectile by `vel * dt`. After each move, a
 * swept check is performed against terrain, balls, and remote players. The
 * sweep steps from the previous position to the new position to avoid tunneling
 * through fast-moving targets.
 *
 * Hit detection uses two concentric thresholds:
 *  1. Core (direct hit): distance <= target radius + projectile body radius.
 *     This is the "real" collision and always takes precedence over a wake
 *     hit when encountered within the same sweep.
 *  2. Wake (proxy hit): distance <= target radius + expanding hit radius.
 *     The hit radius grows over the projectile's lifetime (see `hitRadius`),
 *     giving a wider, forgiving hitbox for near misses.
 *
 * Wake hit logic:
 *  - The projectile stores the minimum distance it has ever seen to each target
 *    in `wakeBallDistances` / `wakePlayerDistances`. These maps persist across
 *    frames for the life of the projectile.
 *  - A wake hit is meant to trigger when the projectile has passed the target
 *    and is moving away (distance increasing from the recorded minimum).
 *  - However, because the minimum is stored across frames, a moving target can
 *    leave a stale minimum. If the projectile re-approaches the target while
 *    still outside the core, the old check `d > prevMin` would fire a wake
 *    hit prematurely, before the projectile could reach the core.
 *  - To prevent this, `passedCenter` is recomputed each sweep. It is set when
 *    the current step is farther than the immediately previous step, meaning
 *    the projectile has passed the closest point of this sweep. Wake hits are
 *    only allowed once `d > prevMin` AND `passedCenter` is true.
 *
 * On impact, the projectile records `hitBall`, `directHit`, `hitAccuracy`, etc.,
 * marks itself `exploded`, and the visual effect is handled elsewhere.
 *
 * Trail visuals live in vfx.ts (QuarksTrail) — the batched particle path.
 * (Not a bug: `hitRadius` starts at `hitMin`=0 by design — it's the expanding
 *  WAKE threshold, not the direct-hit radius, and a fresh projectile must not
 *  whack its own shooter. Core hits use the constant `bodyRadius`.)
 */
// Anything swept-collidable that ISN'T a damageable target — currently
// turretter bolts. prevPos = start-of-frame pos so the check is
// segment-vs-segment (both objects moved this frame).
export interface SweepObstacle {
  readonly pos: THREE.Vector3;
  readonly prevPos: THREE.Vector3;
  readonly radius: number;
  /** Optional filter — shield domes let friendly shells sail through.
   *  Presence ALSO overrides the noExplosion guard (a field eats hitscan
   *  slugs too); obstacles without a predicate keep the old behavior. */
  blocks?(p: Projectile): boolean;
  /** Called when this obstacle wins the interception (dome flare). */
  onBlocked?(p: Projectile): void;
}

export class Projectile {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  exploded = false;
  /** Body-hit blast deferred — local contact suppressed the fake blast;
   *  the wire 'gone' handler paints the authority's real one instead. */
  ghostBodyPop = false;
  /** Which replica pop path ended the shell — carried onto the self-shove
   *  stamp so a kb-pop-div row names the divergence class (painted
   *  contact where the server shell flew on). */
  popClass?: string;
  hitBolt: SweepObstacle | null = null; // mid-air interception — combat turns this into a cookoff blast
  age = 0;
  spawnedThisFrame = true; // skip first update so projectile renders at spawn pos before moving
  isRemote = false; // true for server-authoritative/demo projectiles
  hitBall: Targetable | null = null; // balls AND crawlers — any shootable target
  hitPlayerId: string | null = null;
  // remote player hit tracking. Assigning a real id reseeds the fuse
  // cache — a jittered ttl computed pre-bind used a random seed, not the
  // server's idSeed(id), and a stale random fuse can pop a replica a
  // full jitter-window off its authority.
  private _serverProjectileId: string | null = null;
  /** Replica age when the create echo bound — -1 if never bound (the
   *  echo was late/lost; traj-outlier rows read this: an unbound
   *  replica flies its own spawn arc, no re-anchor ever ran). */
  boundAtAge = -1;
  /** Spawned on the server's rewind-epoch mirror (fire.ts) — the trajDiv
   *  audit tags whether a divergent shell had the mirror state. */
  mirrored = false;
  get serverProjectileId(): string | null {return this._serverProjectileId;}
  set serverProjectileId(v: string | null) {
    if (v !== this._serverProjectileId) {this.ttl = undefined;}
    this._serverProjectileId = v;
  }
  /** Client-minted nonce sent with the spawn claim and echoed on every
   *  claim naming this shell — binds claims before/independent of the
   *  serverProjectileId round-trip. */
  shotId: string | null = null;
  /** Burst fans bind server echoes by `${pullId}#${pelletIdx}` — the key
   *  under which this pellet sits in registry.byFanSlot, so death and
   *  destroy cleanup can drop it. Single shells leave it unset. */
  fanSlot: string | null = null;
  /** Whose shell this is — kill attribution for local-authority shots
   *  (offline GameBots; null = the local player). */
  shooterId: string | null = null;
  /** Shooter's team — team-filtered solids (shield gates) let this shell
   *  through when it matches theirs. null = teamless/unresolvable. */
  shooterTeam: string | null = null;
  /** Local-player sweep override: offline bot shells include the local
   *  player as a hittable body — they're the only projectiles whose
   *  shooter ISN'T the local player, so self-hits can't happen. Returns
   *  the live local pos each frame, or null to skip. */
  sweepLocal: (() => THREE.Vector3 | null) | null = null;
  /** Local player's armor class — the body sweep needs its capsule. */
  localClass: (() => string | undefined) | null = null;
  demoProjectileId = 0; // demo recording tracking ID
  hitAccuracy = 0; // actual center-to-center dist at moment of hit
  hitAge = 0; // projectile age at hit (airtime)
  hitDistance = 0; // travel distance from shot origin
  directHit = false; // true = hit with core hitbox, false = expanding wake hitbox
  minHitDist = 0; // minimum distance during sweep (for accurate accuracy)
  // Contact bookkeeping — read/written by projCollide (the impact-policy family).
  hitX = 0; hitY = 0; hitZ = 0; hitT = 1;
  lastDt = 0; // dt of the running update — hitAge backs off to swept contact
  bouncesTaken = 0;
  readonly hitPoint = new THREE.Vector3(); // exact sweep intersection (set by sweepTerrain)
  hitPointValid = false;
  explosionProcessed = false;
  // Sticky: froze to a surface — physics off, fuse still burning. The
  // blast is what hurts people, not the glue point.
  stuck = false;
  /** Belt-sticky combo: this bomb was caught mid-flight by a same-owner
   *  shell and rides it dead-center (Painkiller: grenade on the stake).
   *  Physics + collision off; pos/vel shadow the host; when the host
   *  dies this pops at its contact point. Trails keep emitting from the
   *  same point — the "combined trail" is the two ribbons overlapping. */
  host: Projectile | null = null;
  // Embed (javelin) + sticky glue — the planted-shell family lives in
  // projStuck.ts behind the StuckHost surface.
  glue = new ProjStuck(this); // public-ish: projCollide calls stickAt

  // Ray-burst (remote railgun): at rayBurst.delay the slug discharges a
  // hitscan beam down its velocity line — implemented as one giant swept
  // step so terrain/target/obstacle collision applies to the beam itself.
  // Terminal: hit or miss, the slug is spent at the end of the segment.
  rayFired = false;
  private rayDone = false;
  private readonly rayFrom = new THREE.Vector3();
  /** Visual/sfx hook — fired once at discharge with (beam origin, end). */
  onRayBurst: ((from: THREE.Vector3, to: THREE.Vector3) => void) | null = null;
  /** One-shot death edge — fires on the first explode() call, including
   *  local fuse/terrain deaths the server never announces. */
  onExploded: (() => void) | null = null;

  readonly config: ProjectileConfig;
  /** This shot's effective fuse — config.maxLifetime spread by ttlJitter,
   *  seeded by the server id when we know it (remote replicas pop in sync
   *  with the server's detonation; local shots fall back to a random roll
   *  since their fuse is cosmetic — the destroy edge is authoritative). */
  private ttl: number | undefined;
  // Random tumble axis for 'ball' projectiles — fixed per shot
  private readonly tumbleX = Math.random() * 2 - 1;
  private readonly tumbleY = Math.random() * 2 - 1;
  private readonly tumbleZ = Math.random() * 2 - 1;

  // Wake hit tracking: only trigger when distance increases (projectile passed target)
  // (public: the sweep functions in sweep.ts read/write them)
  readonly wakeBallDistances = new Map<Targetable, number>(); // target -> min distance seen
  readonly wakePlayerDistances = new Map<string, number>(); // playerId -> min distance seen

  // Wake-proxy radius — shared/combat.ts so the server's hit-claim
  // validation computes the exact same number from the reported airtime.
  get hitRadius(): number {
    return hitRadiusAt(this.config.weaponType, this.age);
  }

  /** Map-structure colliders — set once per map load alongside
   *  Ball.colliders so shells and balls bounce off the same geometry. */
  static solidColliders: readonly StructureCollider[] = [];
  static solidIndex: ColliderIndex | null = null;
  /** Planted deployable hulls — the Deployables array by reference, so
   *  shells detonate on contact instead of phasing through a generator
   *  and popping on the wall behind it (server sweeps the same set). */
  static dynColliders: readonly StructureCollider[] = [];

  get explosionRadius(): number { return this.config.explosionRadius; }
  get force(): number { return this.config.force; }
  get forceMode(): 'push' | 'pull' { return this.config.forceMode; }

  /** Effective fuse for THIS shell: config.maxLifetime spread by
   *  ttlJitter, seeded from serverProjectileId when the server link has
   *  landed (remote replicas assign it right after construction) so both
   *  ends pop at the same age; pending local shots seed randomly — their
   *  fuse is cosmetic, the server's destroy edge is authoritative anyway. */
  fuseTtl(): number | undefined {
    if (this.ttl !== undefined) {return this.ttl || undefined;}
    const ml = this.config.maxLifetime;
    if (!ml) {return undefined;}
    const j = this.config.ttlJitter ?? 0;
    if (!j) { this.ttl = ml; return ml; }
    const seed = this.serverProjectileId ? idSeed(this.serverProjectileId) : Math.trunc(Math.random() * 4_294_967_296);
    this.ttl = jitteredTtl({ maxLifetime: ml, ttlJitter: j }, seed);
    return this.ttl;
  }

  scene: THREE.Scene;  // public — collide/stuck families remove planted meshes
  mesh: THREE.Mesh;
  glowMesh: THREE.Mesh | null = null;
  readonly prevPos: THREE.Vector3; // start-of-frame pos — sweeps step prevPos→pos
  readonly shotOrigin: THREE.Vector3;
  /** What the renderer draws: pos + renderOffset. Netcode can seed
   *  renderOffset so a remote shell visibly leaves the shooter's rendered
   *  muzzle, then blends onto the true simmed path (~100ms decay) — sim
   *  truth stays in pos, so trails, sweeps and hit points never lie. */
  readonly rendered: THREE.Vector3 = new THREE.Vector3();
  readonly renderOffset: THREE.Vector3 = new THREE.Vector3();
  /** Velocity at spawn — the server's claim validator checks claimed
   *  reach against origin velocity, and gravity/drag mutate `vel`, so
   *  the launch vector lives separately for the client-side re-check. */
  readonly launchVel: THREE.Vector3;
  /** Construction wall-time — mirrors the server's spawnAt for the
   *  shared claim legality check's age-vs-airtime gate. */
  readonly spawnedAtMs: number;

  // Particle trail — quarks-batched.
  private trail: QuarksTrail;
  // Rope dart: a unit cylinder stretched thrower→dart every frame —
  // taut by construction; sag would be a lie.
  private ropeMesh: THREE.Mesh | null = null;
  // F1 debug: hitbox (config.radius, red) + wake proxy (hitRadius, orange —
  // grows with age, rescaled every updateMesh). Scene-level, not mesh
  // children — the shell mesh is instanced and can't carry them.
  private dbgCore: THREE.Mesh | null = null;
  private dbgWake: THREE.Mesh | null = null;
  private projectileRemoved = false;
  private disposed = false;
  private ribbons: (RibbonTrail | RailSpiral)[] = [];
  // Runtime-owned emit/jump decisions for every trail layer (P1) —
  // pos discontinuities need no caller teleport(): the driver cuts all
  // layers when its own last-sample says the host jumped.
  private readonly driver: TrailDriver;

  constructor(scene: THREE.Scene, origin: THREE.Vector3, dir: THREE.Vector3, playerVel: THREE.Vector3, config: ProjectileConfig) {
    this.scene = scene;
    this.config = config;
    this.pos = origin.clone();
    this.prevPos = origin.clone();
    this.shotOrigin = origin.clone();
    this.rendered.copy(origin);
    // Player-velocity inheritance (Tribes Ascend style) — per-weapon via
    // config.inherit (0 on RemoteRailgun: the rail fires down this line)
    this.vel = dir.clone().normalize().multiplyScalar(config.speed).addScaledVector(playerVel, config.inherit ?? 0.5);
    this.launchVel = this.vel.clone();
    this.spawnedAtMs = performance.now();

    const v = buildProjectileMeshes(scene, config, this.pos);
    this.mesh = v.mesh;
    this.glowMesh = v.glowMesh;

    this.trail = new QuarksTrail({
      config,
      pos: this.rendered, vel: this.vel,
      // Emission lead measures travel from sim truth, never the drawn
      // (renderOffset-blended) anchor — see effects/trailLead.ts.
      travelPos: this.pos,
      age: (): number => this.age,
    });

    this.ribbons = v.ribbons;
    // Q2 coil rides the same ribbons list: the driver push()es it the
    // frame travel once, and it internally re-samples onto its helix.
    if (config.railSpiral) {this.ribbons.push(new RailSpiral(scene, config));}
    this.driver = new TrailDriver(
      { pos: this.rendered, vel: this.vel, emitting: (): boolean => !this.exploded },
      [this.trail],
      this.ribbons,
    );
  }

  /** Impact policy (bounce/fuse/intercept/target record) — projCollide.ts. */
  collide = new ProjCollide(this);
  solids(): readonly StructureCollider[] { return Projectile.solidColliders; }
  solidIdx(): ColliderIndex | null { return Projectile.solidIndex; }
  dynSolids(): readonly StructureCollider[] { return Projectile.dynColliders; }

  // Swept collision math lives in sweep.ts (SweepHost) — the checks are
  // free functions so they're testable without a scene-bound projectile.

  update(dt: number, terrain: Terrain, balls?: Targetable[], remotePlayers?: Map<string, THREE.Vector3>, obstacles?: SweepObstacle[], playerClasses?: Map<string, string>): void {
    if (this.dead) {return;}

    // Converge the splice at ≤10% of flight speed: lateral correction
    // beyond that visibly bends the path (~6° deflection is perceptible);
    // slower is invisible. tau = offset/rate self-scales — a big
    // reanchor stretches the blend, a small one snaps in a frame or two.
    const offsetLen = this.renderOffset.length();
    if (offsetLen > 0) {
      const tau = offsetLen / Math.max(this.vel.length() * 0.1, 1);
      this.renderOffset.multiplyScalar(Math.exp(-dt / tau));
      if (this.renderOffset.lengthSq() < 1e-8) {this.renderOffset.set(0, 0, 0);}
    }

    // First frame: just render at spawn position, don't apply physics yet
    if (this.spawnedThisFrame) {
      this.spawnedThisFrame = false;
      this.updateMesh();
      return;
    }

    if (!this.exploded) {this.updateAlive(dt, terrain, balls, remotePlayers, obstacles, playerClasses);}

    // Cell-stepped shells render the sub-cell remainder ballistically
    // (ballNet's rem pattern) — pos sits on the last 50ms grid boundary;
    // the fraction between it and the next step draws the arc, not a
    // 20Hz staircase. cellAcc stays 0 for replicas — same formula.
    this.computeRendered();

    this.tickRayBurst();

    if (this.glue.embedded && !this.glue.tickEmbedded(dt)) {this.removeProjectileMesh();}
    else if (this.exploded && !this.projectileRemoved) {this.removeProjectileMesh();}
    for (const r of this.ribbons) {r.update(dt);}
    this.trail.update(dt);
    this.tickRope(dt);

    if (this.settled()) {this.dead = true;}
  }

  // Teleport the projectile forward along its velocity without physics steps —
  // used to compensate remote-spawn latency so it appears where it really is
  advanceBy(seconds: number): void {
    this.prevPos.copy(this.pos);
    this.pos.addScaledVector(this.vel, seconds);
    this.age += seconds;
    // The jump reads as a discontinuity to the trail driver — it cuts
    // every layer on its next tick, no caller declaration needed.
    this.rendered.copy(this.pos).add(this.renderOffset);
    if (this.mesh) { this.mesh.position.copy(this.rendered); syncProjectileInstance(this.mesh); }
  }

  /** Ray-burst discharge: the rest of this frame's travel is the beam —
   *  prevPos stays at the discharge point so the swept segment covers the
   *  whole ray. Applies to remote replicas too: delay/direction/range are
   *  all deterministic from spawn state, like bounces. The jump reads as
   *  a discontinuity to the trail driver, which cuts every layer itself. */
  private tickRayDischarge(): void {
    if (this.config.rayBurst && !this.rayFired && this.age >= this.config.rayBurst.delay) {
      this.rayFired = true;
      this.rayFrom.copy(this.pos);
      _rayDir.copy(this.vel).normalize();
      this.prevPos.copy(this.pos);
      this.pos.addScaledVector(_rayDir, this.config.rayBurst.range);
    }
  }

  // Physics + collision + visuals for a live (non-exploded) projectile
  private updateAlive(dt: number, terrain: Terrain, balls?: Targetable[], remotePlayers?: Map<string, THREE.Vector3>, obstacles?: SweepObstacle[], playerClasses?: Map<string, string>): void {
    // Riding a host shell: dead-center on its path, no own physics or
    // collision. Host death pops us at ITS contact point — the rider is
    // the payload the shell was carrying.
    if (this.host) {
      const h = this.host;
      if (h.dead || h.exploded) {
        this.host = null;
        this.pos.copy(h.hitPointValid ? h.hitPoint : h.pos);
        this.prevPos.copy(this.pos);
        this.popClass = 'host-pop';
        this.explode();
        return;
      }
      this.prevPos.copy(h.prevPos);
      this.pos.copy(h.pos);
      this.vel.copy(h.vel);
      this.lastDt = dt;
      this.age += dt;
      this.updateMesh();
      return;
    }
    this.tickArmedFx();

    // Stuck bomb: planted on a surface, ticking down to fuse. Age is the
    // fuse clock (fuseAge = age − armAge) — it advances wall-clock here,
    // the cell grid only owns physics+collision while the shell flies.
    if (this.stuck) {
      this.age += dt; this.lastDt = dt;
      if (this.glue.tickStuck()) {return;}
    }

    // Remote (server-authoritative/demo) replicas skip predicted
    // collision (tickRemote instead) — but they still step on the 50ms
    // grid: frame-sized sub-segments resolve bounces/contacts at a
    // different phase than the authority's tick, which was the remote
    // half of the trajDiv tail (self:0 outliers).
    if (this.isRemote) {
      // Catch-up ceiling: replicas get WALL dt (the server shell doesn't
      // starve when our frames loaf) — cap at 2s so a single jank frame
      // fully closes the gap instead of dripping it over seconds.
      this.cellAcc = Math.min(this.cellAcc + dt, 2);
      while (this.cellAcc >= 0.05) {
        this.cellAcc -= 0.05;
        if (this.stepFrame(0.05, terrain, undefined, remotePlayers, obstacles, playerClasses)) {return;}
      }
      this.computeRendered();
      return;
    }

    // Predicted shells step physics+collision on the SERVER's fixed 50ms
    // cell grid — frame-sized sub-segments were the trajDiv tail: every
    // bounce/contacts resolved at a different phase point than the tick
    // grid the authority sweeps. The sub-cell remainder renders
    // ballistically (the ballNet rem pattern) so motion stays smooth.
    // Wall-dt feed: the server shell doesn't starve under our jank —
    // catch up through the grid (cap 2s covers a full loafed frame).
    this.cellAcc = Math.min(this.cellAcc + dt, 2);
    while (this.cellAcc >= 0.05) {
      this.cellAcc -= 0.05;
      if (this.stepFrame(0.05, terrain, balls, remotePlayers, obstacles, playerClasses)) {return;}
    }
    this.computeRendered();
    this.updateMesh();
    // Trail emission is driver-owned: updateVfx samples this.pos once the
    // frame settles and decides emit-vs-jump for every layer.
  }

  /** Remainder of the current 50ms cell — rendered pos = pos + vel*rem. */
  private cellAcc = 0;

  /** Wire-echo re-anchor: the server spawned this shell at its rewind
   *  origin with shadow-velocity inherit — the claim's live pos/vel
   *  differ by ~a transit of motion (and drift further on flat flyers).
   *  Take the authority's spawn state projected forward by this shell's
   *  own age — spawn clocks agree within a transit — and fold the
   *  positional splice into renderOffset so the mesh doesn't pop. */
  reanchorTo(pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }, srvAge: number): void {
    Projectile._reanchorOld.copy(this.rendered);
    this.pos.set(pos.x, pos.y, pos.z).addScaledVector(Projectile._reanchorV.set(vel.x, vel.y, vel.z), srvAge);
    if (this.config.gravity) {this.pos.y += 0.5 * GRAVITY * srvAge * srvAge;}
    this.prevPos.copy(this.pos);
    this.vel.copy(Projectile._reanchorV);
    // Clock sync: the splice trusts the authority's spawn state verbatim —
    // the age rides with it or the two timelines diverge ~transit every bind.
    this.age = srvAge;
    this.computeRendered();
    this.renderOffset.add(Projectile._reanchorOld).sub(this.rendered);
    this.computeRendered();
  }
  private static readonly _reanchorOld = new THREE.Vector3();
  private static readonly _reanchorV = new THREE.Vector3();

  private computeRendered(): void {
    this.rendered.copy(this.pos).addScaledVector(this.vel, this.cellAcc);
    if (this.cellAcc > 0 && this.config.gravity) {this.rendered.y += 0.5 * GRAVITY * this.cellAcc * this.cellAcc;}
    this.rendered.add(this.renderOffset);
  }

  /** One sim step (one server cell for predicted shells, one frame for
   *  replicas): integrate, fuse, discharge, sweep. True on explode/dead. */
  private stepFrame(dt: number, terrain: Terrain, balls?: Targetable[], remotePlayers?: Map<string, THREE.Vector3>, obstacles?: SweepObstacle[], playerClasses?: Map<string, string>): boolean {
    this.prevPos.copy(this.pos);
    this.lastDt = dt;
    this.age += dt;

    // Absolute backstop: fuseless configs (bolt/disc/chaingun fly-until-
    // contact) or a remote replica whose destroy edge never arrived used
    // to leave immortal shells drifting — simming 10k-particle trails
    // 90km below the world at 2300m/s. Any reasonable shot is long dead
    // by 10s (a 250m/s chaingun slug covers ~2.5km).
    if (this.age >= ABSOLUTE_TTL_S) {
      this.popClass = 'ttl';
      this.explode();
      return true;
    }

    // hitPoint is per-step: a stale value from a previous bounce would
    // teleport the explosion back to the last terrain contact (the
    // "explosion in the wrong spot" bug on fuse/ball/player kills)
    this.hitPointValid = false;
    if (this.config.gravity) {this.vel.y += GRAVITY * dt;}
    this.pos.addScaledVector(this.vel, dt);
    if (this.fuseExpired()) {return true;}

    this.tickRayDischarge();

    if (this.isRemote) {
      return this.tickRemote(terrain, remotePlayers, playerClasses);
    }
    return this.checkCollisions(terrain, balls, remotePlayers, obstacles, playerClasses);
  }

  /** Fuse burn + overdue/fuseless diagnostics — true when the cell ends
   *  the shell. Sticky ordnance is inert in flight (fuseAge -1) — a bomb
   *  that never attaches gets a failsafe triple-fuse so it can't drift
   *  forever. */
  private fuseExpired(): boolean {
    const ttl = this.fuseTtl();
    const fa = this.fuseAge();
    if (ttl && ((fa >= 0 && fa >= ttl) || (fa < 0 && this.age >= ttl * 3))) {
      this.popClass = 'fuse';
      this.explode();
      return true;
    }
    // A live shell this far past its fuse means the pop path itself failed
    // (stale ttl, armed gate, stuck early-return) — name it in the dump.
    if (ttl && !this.overdueFlagged && this.age > ttl * 2) {
      this.overdueFlagged = true;
      glitch('proj-overdue', { cfg: this.config.name, age: Number(this.age.toFixed(2)), ttl, fa, remote: this.isRemote, stuck: this.stuck, wt: this.config.weaponType });
    }
    // Fuseless shells (missing maxLifetime — the BOLT_CONFIG fallback on an
    // unknown weaponType is exactly this) fly to the 10s backstop; flag
    // them early so an immortal replica names itself instead of streaking.
    if (!ttl && !this.overdueFlagged && this.age > 4) {
      this.overdueFlagged = true;
      glitch('proj-fuseless', { cfg: this.config.name, age: Number(this.age.toFixed(2)), remote: this.isRemote, wt: this.config.weaponType });
    }
    return false;
  }

  // Discharge aftermath: beam visual fires once with the resolved
  // endpoint (swept hitPoint on a hit, range cap on a miss), then the
  // slug detonates there. Called from update() so early returns inside
  // updateAlive can't skip it.
  private tickRayBurst(): void {
    if (!this.rayFired || this.rayDone) {return;}
    this.rayDone = true;
    this.onRayBurst?.(this.rayFrom, this.hitPointValid ? this.hitPoint : this.pos);
    if (!this.exploded) {this.explode();}
  }

  // Remote replicas skip claim collisions — terrain + the cosmetic body
  // pop live in tickRemote (server owns damage on every hit).
  private tickRemote(terrain: Terrain, remotePlayers?: Map<string, THREE.Vector3>, playerClasses?: Map<string, string>): boolean { return tickRemote(this, terrain, remotePlayers, playerClasses); }

  // Runs all swept collision checks; returns true if the projectile hit
  // something and exploded (records hit target + accuracy data).
  private checkCollisions(terrain: Terrain, balls?: Targetable[], remotePlayers?: Map<string, THREE.Vector3>, obstacles?: SweepObstacle[], playerClasses?: Map<string, string>): boolean {
    return this.collide.checkCollisions(terrain, balls, remotePlayers, obstacles, playerClasses, ballGhostPos);
  }

  /** Plant the bomb at a contact point — the glue family owns the state. */
  stickAt(p: THREE.Vector3, ball?: Targetable, playerId?: string,
          remotePlayers?: Map<string, THREE.Vector3>): void {
    this.glue.stickAt(p, ball, playerId, remotePlayers);
  }

  get armed(): boolean {
    return this.config.armTime === undefined || this.age >= this.config.armTime;
  }

  /** Body-contact gate — separate from the terrain/bounce arming: the GL
   *  skips off dirt for a second yet pops on a body at any age. */
  get bodiesLive(): boolean {
    const ba = this.config.bodyArmTime ?? this.config.armTime;
    return ba === undefined || this.age >= ba;
  }

  /** First dirt contact starts a short cook-off: clamp this shell's fuse
   *  to now+sec. Min-clamped so later skips don't extend the deadline;
   *  mirrors the server's projContact ttl clamp. */
  clampFuse(sec: number): void {
    this.ttl = Math.min(this.fuseTtl() ?? Infinity, this.fuseAge() + sec);
  }

  /** Fuse clock — for sticky ordnance the fuse starts at ATTACH, not
   *  spawn: a lobbed bomb midair is inert (no fuse burn, no armed-light
   *  ramp). -1 = not armed yet; everything else just reads `age`. */
  fuseAge(): number {
    if (!this.config.sticks) {return this.age;}
    return this.glue.armAge === undefined ? -1 : this.age - this.glue.armAge;
  }

  // Arming tell — the moment a fused shell cooks off it picks up a hot
  // streak, so "this one can hurt you" reads at a glance instead of
  // requiring fuse math. Lives in `ribbons` so trail push/stop/pooling
  // treat it exactly like a launcher-attached ribbon.
  private armedFxDone = false;
  private overdueFlagged = false;
  private tickArmedFx(): void {
    if (this.armedFxDone || !this.armed || this.config.armTime === undefined) {return;}
    this.armedFxDone = true;
    const armed = RibbonTrail.acquire(this.scene, {
      color: 0xFF_BB_33, width: 0.22, life: 0.5, billboard: true, tag: `arm:${this.config.name}`,
    });
    // Late-join ribbons miss the driver's ctor follow-bind — without this
    // the armed streak's tip trails the shell by a frame of travel.
    armed.follow = this.rendered;
    armed.followManaged = true;
    this.ribbons.push(armed);
  }

  // GL/flak shells always bounce; a mortar only bounces while unarmed —
  // once armed it's impact-fused like any other shell.
  get canBounce(): boolean {
    return Boolean(this.config.bounces) && (this.config.armTime === undefined || !this.armed);
  }

  // Contact point along this frame's sweep + its parametric position
  // (0=prevPos, 1=pos). Hit distance/airtime come from here, not the
  // already-integrated end-of-frame pos — a fast shell could overshoot the
  // target by meters inside one frame and inflate the hit score/claim.
  hitAt(x: number, y: number, z: number, t: number): void {
    this.hitX = x; this.hitY = y; this.hitZ = z; this.hitT = t;
    // Also the detonation point — combat renders the blast at hitPoint when
    // valid, so target hits (not just terrain) explode at contact, not at
    // the overshot end-of-frame position.
    this.hitPoint.set(x, y, z);
    this.hitPointValid = true;
  }

  // Mesh ramp-in: every projectile pops in small and grows to full size —
  // a 1.6m cannonball spawning at your face shouldn't fill half the screen
  // for a frame. Config overrides via meshStartScale/meshRampInDuration;
  // meshRampIn === false opts out. Duration capped at 40% of maxLifetime
  // so a 0.4s shotgun pellet still snaps to size fast.


  updateMesh(): void {
    Projectile._renderPos.copy(this.rendered);
    updateProjectileMesh(this.mesh, this.glowMesh, Projectile._renderPos, this.vel,
      this.config, this.age, this.hitRadius,
      { x: this.tumbleX, y: this.tumbleY, z: this.tumbleZ }, this.lastDt, this.fuseAge());
    // F1 is a runtime toggle — create lazily (shells predating the key
    // still show), hide when it's off, spawn nothing in normal play.
    if (urlParams.debug) {
      if (!this.dbgCore) {
        const mk = (color: number): THREE.Mesh => {
          const m = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshBasicMaterial({ color, wireframe: true }));
          this.scene.add(m);
          return m;
        };
        this.dbgCore = mk(0xFF_44_44);
        this.dbgWake = mk(0xFF_AA_22);
        this.dbgCore.scale.setScalar(getWeaponStats(this.config.weaponType).bodyRadius);
      }
      this.dbgCore.visible = true;
      this.dbgCore.position.copy(Projectile._renderPos);
      this.dbgWake!.visible = true;
      this.dbgWake!.position.copy(Projectile._renderPos);
      this.dbgWake!.scale.setScalar(this.hitRadius);
    } else if (this.dbgCore) {
      this.dbgCore.visible = false;
      this.dbgWake!.visible = false;
    }
  }

  private static readonly _renderPos = new THREE.Vector3();

  removeProjectileMesh(): void {
    if (this.projectileRemoved) {return;}
    releaseProjectileInstance(this.mesh);
    // mat/glowMat are cache-shared — never dispose
    if (this.glowMesh) {
      releaseProjectileInstance(this.glowMesh);
    }
    for (const m of [this.dbgCore, this.dbgWake]) {
      if (m) {this.scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose();}
    }
    this.projectileRemoved = true;
  }

  /** Diagnostics row — trail + ribbon state for the Alt+Q dump. */
  dbg(): { trail: Record<string, unknown> | null; ribbons: ReturnType<RibbonTrail['dbg']>[] } {
    return {
      trail: this.trail instanceof QuarksTrail ? this.trail.diag() : null,
      ribbons: this.ribbons.map(r => r.dbg()),
    };
  }

  /** Rope dart's far end after connect — the terrain anchor point, or
   *  the reeled victim's live position (the caller repoints it per frame
   *  on body hits). null = in flight, rope end is `rendered`. */
  ropeTo: THREE.Vector3 | null = null;
  /** Remaining reel window — the rope stays drawn through the pull. */
  ropeT = 0;
  /** Attached rope's shrink-only visual length (-1 = not yet measured). */
  private ropeLen = -1;
  /** Connect hold: the line stays attached to its anchor for the yank window. */
  private ropeHold = false;
  /** Finish reel: the free end walks from ropeFree back to the thrower. */
  private ropeRecall = false;
  private readonly ropeFree = new THREE.Vector3();
  private readonly ropeReelFrom = new THREE.Vector3();
  private readonly ropeFromPos = new THREE.Vector3();
  private ropeMax = 0;
  private ropeReelT = 0;
  /** True while the rope should draw: live flight OR inside the reel. */
  get ropeActive(): boolean { return !this.exploded || this.ropeHold || this.ropeRecall; }

  /** Rope dart: caller passes the thrower's CURRENT chest pos each frame
   *  (local player for own darts, replica pos for remote throws). The
   *  line is drawn taut — slack in flight would read as a disconnect. */
  setRope(from: THREE.Vector3): void {
    if (!this.ropeMesh) {
      this.ropeMesh = new THREE.Mesh(_ropeGeo, _ropeMat);
      this.scene.add(this.ropeMesh);
    }
    this.ropeFromPos.copy(from);
    let a: THREE.Vector3 = from;
    let b: THREE.Vector3 = this.rendered;
    if (this.ropeRecall) {
      b = this.ropeFree;
    } else if (this.ropeHold) {
      a = this.ropeTo!;
      b = from;
      _ropeV.subVectors(from, a);
      const len = _ropeV.length();
      this.ropeMax = Math.max(this.ropeMax, len);
      if (this.ropeLen < 0 || len <= this.ropeLen + 0.02) {this.ropeLen = len;}
      else {
        // Span grew past the taut length (the reeled body overshot the
        // anchor): the line lets go and reels back from the anchor —
        // extending the free end to ropeMax here whipped the tip outward.
        this.startRecall();
        a = from; b = this.ropeFree;
      }
    }
    _ropeV.subVectors(b, a);
    const len = _ropeV.length();
    if (len < 0.01) { this.ropeMesh.visible = false; return; }
    this.ropeMesh.visible = true;
    _ropeV.divideScalar(len);
    this.ropeMesh.position.copy(a).addScaledVector(_ropeV, len * 0.5);
    this.ropeMesh.quaternion.setFromUnitVectors(_ropeUp, _ropeV);
    this.ropeMesh.scale.set(1, len, 1);
  }

  hideRope(): void { if (this.ropeMesh) {this.ropeMesh.visible = false;} }

  /** Embedded shells outlive their trails — the planted corpse IS the
   *  effect, so death waits on the mesh removal too. A hooked rope holds
   *  the shell alive through its reel window the same way. */
  private settled(): boolean {
    return this.exploded && this.trail.empty && this.ribbons.every((r): boolean => r.done)
      && !this.ropeHold && !this.ropeRecall && (!this.glue.embedded || this.projectileRemoved);
  }

  /** Reel window countdown — the rope outlives the dart by design. */
  private tickRope(dt: number): void {
    if (this.ropeHold) {
      this.ropeT -= dt;
      if (this.ropeT <= 0) {this.startRecall();}
    } else if (this.ropeRecall) {
      // Constant-time reel: the free end lerps anchor→thrower over
      // ROPE_REEL_S regardless of span — a 400m miss retracts as fast
      // as a 20m one, so the line never lingers behind a moving thrower.
      this.ropeReelT += dt;
      const k = Math.min(1, this.ropeReelT / ROPE_REEL_S);
      this.ropeFree.lerpVectors(this.ropeReelFrom, this.ropeFromPos, k);
      if (k >= 1) {this.ropeRecall = false; this.ropeTo = null; this.hideRope();}
    }
  }

  private startRecall(): void {
    this.ropeHold = false; this.ropeRecall = true; this.ropeReelT = 0;
    this.ropeReelFrom.copy(this.ropeTo ?? this.pos);
    this.ropeFree.copy(this.ropeReelFrom);
  }

  explode(): void {
    if (this.exploded) {return;}
    this.exploded = true;
    // Remote replicas name their pop path for the kb-pop-div census —
    // untagged explode sites collapse to 'other' so the count is honest.
    if (this.isRemote && !this.popClass) {this.popClass = 'other';}
    // A connect holds the line on its anchor for the yank window, then every
    // hook finishes the same way: the free end reels back to the thrower.
    if (this.config.hook) {
      const hit = this.hitPlayerId || this.hitPointValid;
      this.ropeTo = (this.hitPlayerId ? this.pos : this.hitPoint).clone();
      this.ropeLen = -1; this.ropeMax = 0;
      if (hit) {this.ropeHold = true; this.ropeT = 0.55;}
      else {this.startRecall();}
    } else {this.hideRope();}
    const hook = this.onExploded;
    this.onExploded = null;
    hook?.();
    for (const r of this.ribbons) {r.stop();}
    // Embed-capable shells plant on world hits — no target, a swept
    // contact point to sit at. Fuse pops in mid-air still vanish normally.
    if (this.glue.tryEmbed()) {return;}
    this.removeProjectileMesh();
  }

  dispose(): void {
    if (this.disposed) {return;}
    if (this.ropeMesh) { this.scene.remove(this.ropeMesh); this.ropeMesh = null; }
    this.removeProjectileMesh();
    this.driver.release();
    for (const r of this.ribbons) {r.dispose();}
    this.trail.dispose();
    this.disposed = true;
    // Mark dead so a mass-dispose (demo teardown) can't leave a live object
    // updating — update loops key off `dead`, not `disposed`.
    this.dead = true;
  }
}
