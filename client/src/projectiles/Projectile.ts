import * as THREE from 'three';

import { GRAVITY } from '../core/config.js';
import { hitRadiusAt } from '../../../shared/combat.js';
import { idSeed, jitteredTtl } from '../../../shared/weapons.js';

import type { Targetable } from '../entities/balls.js';

import { Terrain } from '../world/terrain.js';
import type { ProjectileConfig } from './types.js';

import { RibbonTrail } from './RibbonTrail.js';
import { ProjectileTrail } from './trailParticles.js';
import { QuarksTrail } from '../effects/vfx.js';
import { buildProjectileMeshes, updateProjectileMesh, releaseProjectileInstance, syncProjectileInstance } from './visuals.js';
import { tickRemote } from './projRemote.js';
import { ColliderIndex } from '../../../shared/solidWorld.js';
import type { StructureCollider } from '../../../shared/ballSim.js';
import { ProjCollide } from './projCollide.js';
import { ProjStuck } from './projStuck.js';
const _rayDir = new THREE.Vector3();

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
 * Trail/wake particle visuals live in trailParticles.ts (TrailHost interface).
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
  age = 0.0;
  spawnedThisFrame = true; // skip first update so projectile renders at spawn pos before moving
  isRemote = false; // true for server-authoritative/demo projectiles
  hitBall: Targetable | null = null; // balls AND crawlers — any shootable target
  hitPlayerId: string | null = null;
  serverProjectileId: string | null = null; // remote player hit tracking
  /** Client-minted nonce sent with the spawn claim and echoed on every
   *  claim naming this shell — binds claims before/independent of the
   *  serverProjectileId round-trip. */
  shotId: string | null = null;
  /** Whose shell this is — kill attribution for local-authority shots
   *  (offline GameBots; null = the local player). */
  shooterId: string | null = null;
  /** Local-player sweep override: offline bot shells include the local
   *  player as a hittable body — they're the only projectiles whose
   *  shooter ISN'T the local player, so self-hits can't happen. Returns
   *  the live local pos each frame, or null to skip. */
  sweepLocal: (() => THREE.Vector3 | null) | null = null;
  /** Local player's armor class — the body sweep needs its capsule. */
  localClass: (() => string | undefined) | null = null;
  demoProjectileId = 0; // demo recording tracking ID
  hitAccuracy = 0.0; // actual center-to-center dist at moment of hit
  hitAge = 0.0; // projectile age at hit (airtime)
  hitDistance = 0.0; // travel distance from shot origin
  directHit = false; // true = hit with core hitbox, false = expanding wake hitbox
  minHitDist = 0.0; // minimum distance during sweep (for accurate accuracy)
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

  get explosionRadius(): number { return this.config.explosionRadius; }
  get force(): number { return this.config.force; }
  get forceMode(): 'push' | 'pull' { return this.config.forceMode; }

  /** Effective fuse for THIS shell: config.maxLifetime spread by
   *  ttlJitter, seeded from serverProjectileId when the server link has
   *  landed (remote replicas assign it right after construction) so both
   *  ends pop at the same age; pending local shots seed randomly — their
   *  fuse is cosmetic, the server's destroy edge is authoritative anyway. */
  fuseTtl(): number | undefined {
    if (this.ttl !== undefined) return this.ttl || undefined;
    const ml = this.config.maxLifetime;
    if (!ml) return undefined;
    const j = this.config.ttlJitter ?? 0;
    if (!j) { this.ttl = ml; return ml; }
    const seed = this.serverProjectileId ? idSeed(this.serverProjectileId) : (Math.random() * 4294967296) >>> 0;
    this.ttl = jitteredTtl({ maxLifetime: ml, ttlJitter: j }, seed);
    return this.ttl;
  }

  scene: THREE.Scene;  // public — collide/stuck families remove planted meshes
  mesh: THREE.Mesh;
  glowMesh: THREE.Mesh | null = null;
  readonly prevPos: THREE.Vector3; // start-of-frame pos — sweeps step prevPos→pos
  readonly shotOrigin: THREE.Vector3;

  // Particle trail — quarks-batched by default; the pooled-mesh path
  // survives only for wakeVisual hosts (no config enables it today).
  private trail: ProjectileTrail | QuarksTrail;
  private projectileRemoved = false;
  private disposed = false;
  private ribbons: RibbonTrail[] = [];

  constructor(scene: THREE.Scene, origin: THREE.Vector3, dir: THREE.Vector3, playerVel: THREE.Vector3, config: ProjectileConfig) {
    this.scene = scene;
    this.config = config;
    this.pos = origin.clone();
    this.prevPos = origin.clone();
    this.shotOrigin = origin.clone();
    // 50% player velocity inheritance (Tribes Ascend style)
    this.vel = dir.clone().normalize().multiplyScalar(config.speed).addScaledVector(playerVel, 0.5);

    const v = buildProjectileMeshes(scene, config, this.pos);
    this.mesh = v.mesh;
    this.glowMesh = v.glowMesh;

    this.trail = config.wakeVisual
      ? new ProjectileTrail({
          scene, config,
          pos: this.pos, prevPos: this.prevPos, vel: this.vel,
          age: () => this.age,
          hitRadius: () => this.hitRadius,
        })
      : new QuarksTrail({
          config,
          pos: this.pos, vel: this.vel,
          age: () => this.age,
        });

    this.ribbons = v.ribbons;
  }

  /** Impact policy (bounce/fuse/intercept/target record) — projCollide.ts. */
  collide = new ProjCollide(this);
  solids(): readonly StructureCollider[] { return Projectile.solidColliders; }
  solidIdx(): ColliderIndex | null { return Projectile.solidIndex; }

  // Swept collision math lives in sweep.ts (SweepHost) — the checks are
  // free functions so they're testable without a scene-bound projectile.

  update(dt: number, terrain: Terrain, balls?: Targetable[], remotePlayers?: Map<string, THREE.Vector3>, obstacles?: SweepObstacle[], playerClasses?: Map<string, string>): void {
    if (this.dead) return;

    // First frame: just render at spawn position, don't apply physics yet
    if (this.spawnedThisFrame) {
      this.spawnedThisFrame = false;
      this.updateMesh();
      return;
    }

    if (!this.exploded) this.updateAlive(dt, terrain, balls, remotePlayers, obstacles, playerClasses);

    this.tickRayBurst();

    if (this.glue.embedded && !this.glue.tickEmbedded(dt)) this.removeProjectileMesh();
    else if (this.exploded && !this.projectileRemoved) this.removeProjectileMesh();
    for (const r of this.ribbons) r.update(dt);
    this.trail.update(dt);

    // Embedded shells outlive their trails — the planted corpse IS the
    // effect, so death waits on the mesh removal too.
    if (this.exploded && this.trail.empty && this.ribbons.every(r => r.done)
        && (!this.glue.embedded || this.projectileRemoved)) {
      this.dead = true;
    }
  }

  // Teleport the projectile forward along its velocity without physics steps —
  // used to compensate remote-spawn latency so it appears where it really is
  advanceBy(seconds: number): void {
    this.prevPos.copy(this.pos);
    this.pos.addScaledVector(this.vel, seconds);
    this.age += seconds;
    // The jump is a discontinuity — ribbons must not bridge it with a
    // quad between the spawn point and here (streak across the map).
    for (const r of this.ribbons) r.clear();
    if (this.mesh) { this.mesh.position.copy(this.pos); syncProjectileInstance(this.mesh); }
  }

  // Physics + collision + visuals for a live (non-exploded) projectile
  private updateAlive(dt: number, terrain: Terrain, balls?: Targetable[], remotePlayers?: Map<string, THREE.Vector3>, obstacles?: SweepObstacle[], playerClasses?: Map<string, string>): void {
    this.prevPos.copy(this.pos);
    this.lastDt = dt;
    this.age += dt;

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
    if (this.stuck && this.glue.tickStuck()) return;
    // hitPoint is per-frame: a stale value from a previous bounce would
    // teleport the explosion back to the last terrain contact (the
    // "explosion in the wrong spot" bug on fuse/ball/player kills)
    this.hitPointValid = false;
    if (this.config.gravity) this.vel.y += GRAVITY * dt;
    this.pos.addScaledVector(this.vel, dt);

    // Fuse: auto-explode if max lifetime is reached
    if (this.fuseTtl() && this.age >= this.fuseTtl()!) {
      this.explode();
      return;
    }

    // Ray-burst discharge: the rest of this frame's travel is the beam —
    // prevPos stays at the discharge point so the swept segment covers the
    // whole ray. Applies to remote replicas too: delay/direction/range are
    // all deterministic from spawn state, like bounces.
    if (this.config.rayBurst && !this.rayFired && this.age >= this.config.rayBurst.delay) {
      this.rayFired = true;
      this.rayFrom.copy(this.pos);
      _rayDir.copy(this.vel).normalize();
      this.prevPos.copy(this.pos);
      this.pos.addScaledVector(_rayDir, this.config.rayBurst.range);
      // The discharge is a teleport — the ribbon would bridge it with a
      // streak across the whole beam range (same hazard advanceBy covers).
      for (const r of this.ribbons) r.clear();
    }

    // Remote (server-authoritative/demo) replicas skip all collision —
    // terrain-only behavior lives in tickRemote.
    if (this.isRemote) {
      if (this.tickRemote(terrain)) return;
    } else if (this.checkCollisions(terrain, balls, remotePlayers, obstacles, playerClasses)) {
      return; // exploded inside checkCollisions
    }

    this.updateMesh();
    this.trail.emitSegment();
    for (const r of this.ribbons) r.push(this.pos, this.vel);
  }

  // Discharge aftermath: beam visual fires once with the resolved
  // endpoint (swept hitPoint on a hit, range cap on a miss), then the
  // slug detonates there. Called from update() so early returns inside
  // updateAlive can't skip it.
  private tickRayBurst(): void {
    if (!this.rayFired || this.rayDone) return;
    this.rayDone = true;
    this.onRayBurst?.(this.rayFrom, this.hitPointValid ? this.hitPoint : this.pos);
    if (!this.exploded) this.explode();
  }

  // Remote replicas skip all collision — terrain-only behavior lives
  // in tickRemote (server owns damage on every hit).
  private tickRemote(terrain: Terrain): boolean { return tickRemote(this, terrain); }

  // Runs all swept collision checks; returns true if the projectile hit
  // something and exploded (records hit target + accuracy data).
  private checkCollisions(terrain: Terrain, balls?: Targetable[], remotePlayers?: Map<string, THREE.Vector3>, obstacles?: SweepObstacle[], playerClasses?: Map<string, string>): boolean {
    return this.collide.checkCollisions(terrain, balls, remotePlayers, obstacles, playerClasses);
  }

  /** Plant the bomb at a contact point — the glue family owns the state. */
  stickAt(p: THREE.Vector3, ball?: Targetable, playerId?: string,
          remotePlayers?: Map<string, THREE.Vector3>): void {
    this.glue.stickAt(p, ball, playerId, remotePlayers);
  }

  get armed(): boolean {
    return this.config.armTime === undefined || this.age >= this.config.armTime;
  }

  // GL/flak shells always bounce; a mortar only bounces while unarmed —
  // once armed it's impact-fused like any other shell.
  get canBounce(): boolean {
    return !!this.config.bounces && (this.config.armTime === undefined || !this.armed);
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
    updateProjectileMesh(this.mesh, this.glowMesh, this.pos, this.vel,
      this.config, this.age, this.hitRadius,
      { x: this.tumbleX, y: this.tumbleY, z: this.tumbleZ }, this.lastDt);
  }

  removeProjectileMesh(): void {
    if (this.projectileRemoved) return;
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

  explode(): void {
    if (this.exploded) return;
    this.exploded = true;
    for (const r of this.ribbons) r.stop();
    // Embed-capable shells plant on world hits — no target, a swept
    // contact point to sit at. Fuse pops in mid-air still vanish normally.
    if (this.glue.tryEmbed()) return;
    this.removeProjectileMesh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.removeProjectileMesh();
    for (const r of this.ribbons) r.dispose();
    this.trail.dispose();
    this.disposed = true;
    // Mark dead so a mass-dispose (demo teardown) can't leave a live object
    // updating — update loops key off `dead`, not `disposed`.
    this.dead = true;
  }
}
