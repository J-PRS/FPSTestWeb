import * as THREE from 'three';

import { GRAVITY } from '../core/config.js';
import { glitch } from '../core/fxDiag.js';
import { hitRadiusAt } from '../../../shared/combat.js';
import { idSeed, jitteredTtl } from '../../../shared/weapons.js';

import type { Targetable } from '../entities/balls.js';

import type { Terrain } from '../world/terrain.js';
import type { ProjectileConfig } from './types.js';

import { RibbonTrail } from '../effects/RibbonTrail.js';
import { RailSpiral } from '../effects/railSpiral.js';

import { QuarksTrail } from '../effects/vfx.js';
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
  hitBolt: SweepObstacle | null = null; // mid-air interception — combat turns this into a cookoff blast
  age = 0;
  spawnedThisFrame = true; // skip first update so projectile renders at spawn pos before moving
  isRemote = false; // true for server-authoritative/demo projectiles
  hitBall: Targetable | null = null; // balls AND crawlers — any shootable target
  hitPlayerId: string | null = null;
  serverProjectileId: string | null = null; // remote player hit tracking
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

    this.renderOffset.multiplyScalar(Math.exp(-dt / 0.05));
    if (this.renderOffset.lengthSq() < 1e-8) {this.renderOffset.set(0, 0, 0);}

    // First frame: just render at spawn position, don't apply physics yet
    if (this.spawnedThisFrame) {
      this.spawnedThisFrame = false;
      this.updateMesh();
      return;
    }

    if (!this.exploded) {this.updateAlive(dt, terrain, balls, remotePlayers, obstacles, playerClasses);}

    this.rendered.copy(this.pos).add(this.renderOffset);

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
    this.prevPos.copy(this.pos);
    this.lastDt = dt;
    this.age += dt;
    this.tickArmedFx();

    // Absolute backstop: fuseless configs (bolt/disc/chaingun fly-until-
    // contact) or a remote replica whose destroy edge never arrived used
    // to leave immortal shells drifting — simming 10k-particle trails
    // 90km below the world at 2300m/s. Any reasonable shot is long dead
    // by 10s (a 250m/s chaingun slug covers ~2.5km).
    if (this.age >= ABSOLUTE_TTL_S) {
      this.explode();
      return;
    }

    // Stuck bomb: planted on a surface, ticking down to fuse.
    if (this.stuck && this.glue.tickStuck()) {return;}
    // hitPoint is per-frame: a stale value from a previous bounce would
    // teleport the explosion back to the last terrain contact (the
    // "explosion in the wrong spot" bug on fuse/ball/player kills)
    this.hitPointValid = false;
    if (this.config.gravity) {this.vel.y += GRAVITY * dt;}
    this.pos.addScaledVector(this.vel, dt);

    // Fuse: auto-explode once the ARMED fuse burns out. Sticky ordnance
    // is inert in flight (fuseAge -1) — a bomb that never attaches gets
    // a failsafe triple-fuse so it can't drift forever.
    const ttl = this.fuseTtl();
    const fa = this.fuseAge();
    if (ttl && ((fa >= 0 && fa >= ttl) || (fa < 0 && this.age >= ttl * 3))) {
      this.explode();
      return;
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

    this.tickRayDischarge();

    // Remote (server-authoritative/demo) replicas skip all collision —
    // terrain-only behavior lives in tickRemote.
    if (this.isRemote) {
      if (this.tickRemote(terrain, remotePlayers, playerClasses)) {return;}
    } else if (this.checkCollisions(terrain, balls, remotePlayers, obstacles, playerClasses)) {
      return; // exploded inside checkCollisions
    }

    this.updateMesh();
    // Trail emission is driver-owned: updateVfx samples this.pos once the
    // frame settles and decides emit-vs-jump for every layer.
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
    Projectile._renderPos.copy(this.pos).add(this.renderOffset);
    updateProjectileMesh(this.mesh, this.glowMesh, Projectile._renderPos, this.vel,
      this.config, this.age, this.hitRadius,
      { x: this.tumbleX, y: this.tumbleY, z: this.tumbleZ }, this.lastDt, this.fuseAge());
  }

  private static readonly _renderPos = new THREE.Vector3();

  removeProjectileMesh(): void {
    if (this.projectileRemoved) {return;}
    releaseProjectileInstance(this.mesh);
    // mat/glowMat are cache-shared — never dispose
    if (this.glowMesh) {
      releaseProjectileInstance(this.glowMesh);
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
  /** True while the rope should draw: live flight OR inside the reel. */
  get ropeActive(): boolean { return !this.exploded || this.ropeT > 0; }

  /** Rope dart: caller passes the thrower's CURRENT chest pos each frame
   *  (local player for own darts, replica pos for remote throws). The
   *  line is drawn taut — slack in flight would read as a disconnect. */
  setRope(from: THREE.Vector3): void {
    if (!this.ropeMesh) {
      this.ropeMesh = new THREE.Mesh(_ropeGeo, _ropeMat);
      this.scene.add(this.ropeMesh);
    }
    _ropeV.subVectors(this.ropeTo ?? this.rendered, from);
    const len = _ropeV.length();
    if (len < 0.01) { this.ropeMesh.visible = false; return; }
    this.ropeMesh.visible = true;
    this.ropeMesh.position.copy(from).addScaledVector(_ropeV, 0.5);
    this.ropeMesh.quaternion.setFromUnitVectors(_ropeUp, _ropeV.normalize());
    this.ropeMesh.scale.set(1, len, 1);
  }

  hideRope(): void { if (this.ropeMesh) {this.ropeMesh.visible = false;} }

  /** Embedded shells outlive their trails — the planted corpse IS the
   *  effect, so death waits on the mesh removal too. A hooked rope holds
   *  the shell alive through its reel window the same way. */
  private settled(): boolean {
    return this.exploded && this.trail.empty && this.ribbons.every((r): boolean => r.done)
      && this.ropeT <= 0 && (!this.glue.embedded || this.projectileRemoved);
  }

  /** Reel window countdown — the rope outlives the dart by design. */
  private tickRope(dt: number): void {
    if (this.ropeT <= 0) {return;}
    this.ropeT -= dt;
    if (this.ropeT <= 0) { this.ropeTo = null; this.hideRope(); }
  }

  explode(): void {
    if (this.exploded) {return;}
    this.exploded = true;
    // A real connect keeps the rope up through the reel — the moving end
    // sliding along the line IS the pull animation. Whiffs snap dead.
    if (this.config.hook && (this.hitPlayerId || this.hitPointValid)) {
      this.ropeTo = (this.hitPlayerId ? this.pos : this.hitPoint).clone();
      this.ropeT = 0.55;
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
