// Quarks integration — the gradual-migration home for VFX. One
// BatchedRenderer batches every quarks system of the same material
// into a single draw call; per-effect particle state lives on the GPU
// side buffers it owns, so a burst costs a few attribute writes, not
// N meshes+materials.
//
// POC usage: impactBurst() replaces the old per-spark-mesh bullet
// impact puff. New effects should start here rather than growing the
// hand-rolled pools in effects.ts/explosion.ts.
import * as THREE from 'three';
import {
  BatchedRenderer, ParticleSystem, RenderMode,
  ConeEmitter, IntervalValue, ConstantValue, ConstantColor,
  GravityForce, ColorOverLife, Gradient, SizeOverLife,
  RandomColorBetweenGradient, RotationOverLife,
  // quarks.core math types are NOT three's — keep them separate.
  Vector3 as QV3, Vector4 as QV4,
} from 'three.quarks';
import type { FunctionValueGenerator, GeneratorMemory, FunctionJSON } from 'three.quarks';
import type { IParticleSystem } from 'quarks.core';
import { CircleEmitter } from 'three.quarks';
import { BLOOM_LAYER, EMIT_GAIN, GRAVITY } from '../core/config.js';
import { getGlowTexture, getPuffTexture } from './glowTexture.js';
import type { ProjectileConfig } from '../projectiles/types.js';

let batcher: BatchedRenderer | null = null;
let scene: THREE.Scene | null = null;
const live = new Set<ParticleSystem>();

export function initVfx(s: THREE.Scene): void {
  if (batcher) return;
  scene = s;
  batcher = new BatchedRenderer();
  batcher.layers.enable(BLOOM_LAYER);
  s.add(batcher);
}

/** Perf-dump visibility: live one-shots in `live`, systems the batcher
 *  still holds, particles across them. A growing `systems` count under
 *  steady fire = a leak; growth only under explosions = honest load. */
export function vfxStats(): { systems: number; tracked: number; particles: number } {
  return { systems: batcher?.systemToBatchIndex.size ?? 0, tracked: live.size, particles: _liveParticles };
}

let _liveParticles = 0;
// Quality scaler from the gpu ladder — quarks sim is pure CPU work, so
// on weak devices density trades for frame time before the pressure
// curve even engages. 1 = full detail.
let _qualityScale = 1;
export function setVfxQualityScale(q: number): void { _qualityScale = q; }

/** Particle-pressure LOD: bursts scale their count down as the global
 *  live-particle total climbs — a 155-explosion pileup was 30k particles
 *  and ~15ms of pure CPU sim. Full detail to 4k, linear to a third at 12k. */
export function vfxPressure(): number {
  let p = 1;
  if (_liveParticles > 12000) p = 0.35;
  else if (_liveParticles > 4000) p = 1 - ((_liveParticles - 4000) / 8000) * 0.65;
  return p * _qualityScale;
}

/** Live-system cap — batcher.update simulates EVERY attached system on
 *  the CPU each frame, so an unbounded count is a monolithic 10-25ms
 *  spike no job budget can slice. 320 keeps a heavy firefight below
 *  ~6ms of quarks sim; past it we cull the oldest systems (Set order =
 *  spawn order, so the front is the stalest). */
const MAX_LIVE_SYSTEMS = 320;

/** Past this distance a burst is sub-pixel — pause its CPU sim entirely.
 *  batcher.update skips paused systems, so this is the only knob that
 *  shrinks the per-frame sim cost itself (the cap only bounds count).
 *  180m: at ~15px per particle across the map, mid-field explosions
 *  still animate but cross-map firefights stop paying quarks sim. */
const VFX_SIM_RADIUS_SQ = 180 * 180;
/** Coarse age-step applied to distance-paused systems each bookkeeping
 *  pass (~15Hz) — sub-pixel at that range, so decay speed doesn't need
 *  to be frame-accurate, only fast enough that nothing hangs. */
const PAUSED_DECAY_S = 1;

// Dead-system starvation counters: trail systems live outside `live`
// (they're looping emitters owned by projectiles), so an owner that
// forgets dispose() leaves the system attached forever — batcher.update
// keeps simulating it. particleNum 0 across ~1s of frames = orphaned.
const starveFrames = new Map<IParticleSystem, number>();
const STARVE_LIMIT = 60;

// One-shot freelist: ParticleSystem construction builds ~30 behavior
// objects per burst — the burst-frame spikes. Finished systems restart
// cleanly, so pool them by config kind instead of rebuilding each hit.
const kindOf = new Map<ParticleSystem, string>();
const pools = new Map<string, ParticleSystem[]>();
const attached = new WeakSet<ParticleSystem>();
// Systems parked in a pool stay attached but dead — starve-reaping would
// otherwise dispose them each bookkeeping pass and the pool never fills.
const pooled = new WeakSet<ParticleSystem>();
const POOL_CAP = 32;
function attachSystem(ps: ParticleSystem): void {
  if (attached.has(ps)) return;
  batcher?.addSystem(ps);
  scene?.add(ps.emitter);
  attached.add(ps);
}

function takeSystem(kind: string, build: () => ParticleSystem): ParticleSystem {
  const ps = pools.get(kind)?.pop();
  const st = window.__vfxStats;
  if (ps) { if (st) st.hits++; pooled.delete(ps); return ps; }
  if (st) st.misses++;
  const n = build();
  kindOf.set(n, kind);
  return n;
}

function reapStarved(ps: IParticleSystem): void {
  // A paused system is suspended on purpose (out of sim range), not
  // orphaned — it emits nothing so particleNum sits at 0 and the reaper
  // would delete live projectile trails ~4s after they leave 180m.
  if ((ps as ParticleSystem).paused) {
    starveFrames.delete(ps);
    return;
  }
  // Active projectile trails aren't in live/pooled, so they'd land here
  // whenever their emitter stops moving ~4s (rested bomblet, pre-launch).
  // Deleting the system while a Projectile still owns it leaves a zombie
  // that dispose() pools — every later reuse renders nothing.
  if (activeTrailPs.has(ps as ParticleSystem)) {
    const s = ps.particleNum === 0 ? (starveFrames.get(ps) ?? 0) + 1 : 0;
    if (s === STARVE_LIMIT) trailStats.reapedActive++;
    if (s) starveFrames.set(ps, s); else starveFrames.delete(ps);
    return;
  }
  const starved = ps.particleNum === 0 ? (starveFrames.get(ps) ?? 0) + 1 : 0;
  if (starved > STARVE_LIMIT) {
    batcher?.deleteSystem(ps);
    scene?.remove((ps as ParticleSystem).emitter);
    attached.delete(ps as ParticleSystem); // else attachSystem's guard makes re-attach a silent no-op
    starveFrames.delete(ps);
  } else if (starved) starveFrames.set(ps, starved);
  else starveFrames.delete(ps);
}

// Sim decimation: the whole batcher sims at 30Hz — every other frame is
// skipped and the sim frames step 2·dt, so trajectories and lifetimes
// stay exact while a spawn-burst's peak cost halves. Short-lived
// puff/blast particles absorb the 2·dt step invisibly.
let simParity = false;
// Burst construction stagger: a multi-layer explosion builds all its
// ParticleSystems in one call (~15ms measured worst-case). Cold builds
// (empty pool bucket) are queued and drain one per frame — a frame or
// two of stagger between layers reads as the effect evolving, and warm
// restarts bypass the queue entirely.
const buildQueue: (() => void)[] = [];
// A burst should only ever land in-frame when it's a warm restart —
// a cold build is ~2ms of behavior-object construction, and a fresh
// explosion stacks several. Peek at the pool: non-empty = warm, build
// now; empty (or far, where a frame of delay is invisible) = enqueue.
// The queue cap degrades to immediate builds under sustained spam.
function queueIfCold(key: string): boolean {
  if ((pools.get(key)?.length ?? 0) > 0) return false;
  return buildQueue.length < 12;
}
// Pause/prune bookkeeping runs at 15Hz — a ~66ms lag on distance-pause or
// one-shot teardown is invisible, and rescanning every system every frame
// was the last per-frame O(systems) cost in vfx.
let prunePhase = 0;

function runBookkeeping(camPos?: THREE.Vector3): void {
  // Distance-pause BEFORE the batch sim: skip offscreen systems this frame.
  // Covers every attached system (live bursts AND projectile trails).
  if (batcher) {
    for (const ps of batcher.systemToBatchIndex.keys()) {
      if (camPos) {
        const em = ps.emitter as ParticleSystem['emitter'];
        const far = em.position.distanceToSquared(camPos) > VFX_SIM_RADIUS_SQ;
        if (far) {
          // batcher.update skips paused systems entirely, so their
          // particles would hang mid-air forever. Age suspended systems
          // a coarse step here instead — the emitter is parked, so no
          // new particles spawn while the existing ones decay out.
          //
          // emitSegment keeps writing emitter.position while paused, but
          // emissionState.previousWorldPos only advances inside emit() —
          // skipped under paused. Without resyncing first, this update
          // (or the eventual unpause) reads the whole suspended drift as
          // one giant travel jump and smears a burst along it — the
          // "stretching trail" artifact at distance.
          const st = ps.emissionState as {
            travelDistance: number;
            previousWorldPos?: { set(x: number, y: number, z: number): void };
          };
          st.travelDistance = 0;
          st.previousWorldPos?.set(em.position.x, em.position.y, em.position.z);
          ps.paused = false;
          // quarks marks update() private in its typings though it's the
          // method BatchedRenderer.update calls per frame — the cast is
          // the same call, scoped to this one system.
          (ps as unknown as { update(d: number): void }).update(PAUSED_DECAY_S);
          ps.paused = true;
        } else {
          if (ps.paused) {
            // First live tick after a suspended span: the emitter drifted
            // while paused — don't let emissionOverDistance cash the jump
            // as one long deposit.
            const st = ps.emissionState as {
              travelDistance: number;
              previousWorldPos?: { set(x: number, y: number, z: number): void };
            };
            st.travelDistance = 0;
            st.previousWorldPos?.set(em.position.x, em.position.y, em.position.z);
          }
          ps.paused = false;
        }
      }
      if (live.has(ps as ParticleSystem) || pooled.has(ps as ParticleSystem)) continue;
      reapStarved(ps);
    }
  }
  // Prune finished one-shots — emission ends at `duration`; particles
  // may outlive it, but quarks keeps rendering them until they die, so
  // the system must stay attached until then. `particleNum` is the
  // truth, not the clock.
  let particles = 0;
  for (const ps of live) {
    particles += ps.particleNum;
    if (ps.time >= ps.duration && ps.particleNum === 0) {
      const kind = kindOf.get(ps);
      if (kind) {
        const pool = pools.get(kind) ?? [];
        if (pool.length < POOL_CAP) {
          // Pooled systems stay attached to the batcher — a dead system
          // sims ~0 particles, so detach+reattach would only rebuy the
          // batch slice that restart() repopulates for free.
          pool.push(ps);
          pooled.add(ps);
          live.delete(ps);
          continue;
        }
        pools.set(kind, pool);
      }
      batcher?.deleteSystem(ps);
      scene?.remove(ps.emitter);
      attached.delete(ps);
      live.delete(ps);
    }
  }
  _liveParticles = particles;
}

export function updateVfx(dt: number, camPos?: THREE.Vector3): void {
  if (buildQueue.length) buildQueue.shift()!();
  if (++prunePhase >= 4) {
    prunePhase = 0;
    runBookkeeping(camPos);
  }
  simParity = !simParity;
  if (simParity) batcher?.update(dt * 2);
  // Hard cap: cull oldest systems until under the ceiling. A killed
  // system vanishes mid-effect — only reached under sustained overload
  // where the alternative is a slideshow.
  while (live.size > MAX_LIVE_SYSTEMS) {
    const oldest = live.values().next().value;
    if (!oldest) break;
    batcher?.deleteSystem(oldest);
    scene?.remove(oldest.emitter);
    attached.delete(oldest);
    live.delete(oldest);
  }
}

const _upQ = new QV3(0, 1, 0);

// Shared materials — quarks batches by material instance, so a fresh
// material per burst would break the batch AND leak GL programs. Lazy:
// getGlowTexture() needs a 2d canvas, which node-side tests don't have.
let _impactMat: THREE.MeshBasicMaterial | null = null;
let _normalMat: THREE.MeshBasicMaterial | null = null;
function impactMat(): THREE.MeshBasicMaterial {
  return _impactMat ??= new THREE.MeshBasicMaterial({
    map: getGlowTexture(), transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
    // HDR-hot tint: particle vertex colors × EMIT_GAIN push every additive
    // emitter (trails, flashes, glow layers) past the bloom threshold.
    color: new THREE.Color(EMIT_GAIN, EMIT_GAIN, EMIT_GAIN),
  });
}
function normalMat(): THREE.MeshBasicMaterial {
  // Blotchy asymmetric puff — smoke/debris quads NEED a non-symmetric
  // silhouette or RotationOverLife spins an invisible radial sprite.
  return _normalMat ??= new THREE.MeshBasicMaterial({
    map: getPuffTexture(), transparent: true, depthWrite: false,
    blending: THREE.NormalBlending,
  });
}

/** Bullet-impact puff: a short cone of hot sparks kicked back along the
 *  shot direction + gravity. Replaces Effects.spawnImpact's per-particle
 *  meshes — one batched burst, ~0 allocation, one draw call shared with
 *  every other burst in flight. */
export function impactBurst(pos: THREE.Vector3, vel: THREE.Vector3): void {
  if (!batcher || !scene || live.size >= MAX_LIVE_SYSTEMS) return;
  const ps = takeSystem('impact', () => new ParticleSystem({
    duration: 0.35,
    looping: false,
    startLife: new IntervalValue(0.12, 0.27),
    startSpeed: new IntervalValue(4, 12),
    startSize: new IntervalValue(0.08, 0.2),
    startColor: new ConstantColor(new QV4(1.0, 0.9, 0.45, 0.9)),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [{ time: 0, count: new ConstantValue(8), cycle: 0, interval: 0.01, probability: 1 }],
    shape: new ConeEmitter({ radius: 0.02, angle: 0.7 }),
    material: impactMat(),
    renderMode: RenderMode.BillBoard,
    worldSpace: true,
    behaviors: [
      new GravityForce(_upQ, -9.8),
      new ColorOverLife(new Gradient(
        [[new QV3(1, 0.9, 0.45), 0], [new QV3(1, 0.5, 0.15), 1]],
        [[0.9, 0], [0, 1]],
      )),
    ],
  }));
  ps.emitter.position.copy(pos);
  // Cone emits along local +Z — aim it back along the incoming shot.
  if (vel.lengthSq() > 0) {
    _back.copy(vel).normalize().negate();
    ps.emitter.quaternion.setFromUnitVectors(_forward, _back);
  }
  attachSystem(ps);
  live.add(ps);
  ps.restart();

  // Directional streak fan — stretched sparks flung back along the shot
  // line. This is what separates a bullet hit from a puff: the eye reads
  // velocity-aligned slivers as fragments. Skipped under particle
  // pressure (the puff above is the minimum readable hit).
  if (vfxPressure() > 0.6) {
    const streaks = takeSystem('impactStreak', () => new ParticleSystem({
      duration: 0.25,
      looping: false,
      startLife: new IntervalValue(0.1, 0.2),
      startSpeed: new IntervalValue(18, 45),
      startSize: new IntervalValue(0.05, 0.09),
      startColor: new ConstantColor(new QV4(1.0, 0.85, 0.4, 0.9)),
      emissionOverTime: new ConstantValue(0),
      emissionBursts: [{ time: 0, count: new ConstantValue(5), cycle: 0, interval: 0.01, probability: 1 }],
      shape: new ConeEmitter({ radius: 0.02, angle: 0.5 }),
      material: impactMat(),
      renderMode: RenderMode.StretchedBillBoard,
      speedFactor: 0.15,
      startLength: new ConstantValue(6),
      worldSpace: true,
      behaviors: [
        new GravityForce(_upQ, -14),
        new ColorOverLife(new Gradient(
          [[new QV3(1, 0.9, 0.5), 0], [new QV3(0.9, 0.4, 0.1), 1]],
          [[0.9, 0], [0, 1]],
        )),
      ],
    }));
    streaks.emitter.position.copy(pos);
    streaks.emitter.quaternion.copy(ps.emitter.quaternion);
    attachSystem(streaks);
    live.add(streaks);
    streaks.restart();
  }
}

const _back = new THREE.Vector3();
const _forward = new THREE.Vector3(0, 0, 1);

// ---- Projectile trails ----

/** Same host contract as ProjectileTrail — nothing else needed. */
export interface QuarksTrailHost {
  config: ProjectileConfig;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age(): number;
}

const _tDir = new THREE.Vector3();
// Trails pool like bursts: weapon configs are a bounded set, and a shot's
// trail construction is ~20 behavior objects — restarting beats rebuilding.
const circleOf = new WeakMap<ParticleSystem, CircleEmitter>();

function trailKey(config: ProjectileConfig): string {
  return ['trail', config.trailParticlesPerUnit, config.trailLifeMin,
    config.trailLifeMax, config.trailBaseSize, config.trailSizeRange,
    config.trailScaleMin, config.trailScaleMax, config.trailSpread,
    config.trailOpacity, config.trailParticleGravity, config.trailRampIn,
    config.trailColors.map(c => `${c.r},${c.g},${c.b}`).join(';')].join(',');
}

/** Trail as ONE batched quarks system per projectile: the old pool-per-
 *  host trail meant ~1 mesh+material+draw call per emitted particle; here
 *  the emitter just tracks the projectile and `emissionOverDistance`
 *  reproduces the exact same world-space spacing (slow shell vs fast
 *  slug get equal density). Emission stops by itself once the emitter
 *  stops moving — explode() simply stops calling emitSegment.
 *
 *  Trade vs the hand-rolled version: ring/disc mesh types collapse to
 *  billboards (only 'billboard' was ever configured anyway) and wakeVisual
 *  keeps the old path — no config enables it. */
// Debug surface — a live-trail registry + lifecycle counters so a silent
// trail can be told apart from (a) never built, (b) reaped while a
// projectile still owns it, (c) parked paused, (d) zombie from the pool.
export const trailStats = {
  built: 0, reused: 0, noBatcher: 0, noRate: 0,
  reapedActive: 0, poolZombies: 0,
};
const activeTrailPs = new Set<ParticleSystem>();
const liveQuarks = new Set<QuarksTrail>();

export function trailDump(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const t of liveQuarks) out.push(t.diag());
  return out;
}

export class QuarksTrail {
  private ps: ParticleSystem | null = null;
  private circle: CircleEmitter | null = null;
  private key = '';

  constructor(private host: QuarksTrailHost) {
    const config = host.config;
    if (!batcher || !scene) { trailStats.noBatcher++; return; }
    if (config.trailParticlesPerUnit <= 0) { trailStats.noRate++; return; }
    this.key = trailKey(config);
    if ((pools.get(this.key)?.length ?? 0) > 0) trailStats.reused++; else trailStats.built++;
    this.ps = takeSystem(this.key, () => {
      // Gradient + alpha fade built from the config's arbitrary-length
      // trailColors — same lerp the per-particle loop used to do by hand.
      const cols = config.trailColors;
      const colorStops: [QV3, number][] = cols.map((c, i) =>
        [new QV3(c.r, c.g, c.b), cols.length > 1 ? i / (cols.length - 1) : 0]);
      const alphaStops: [number, number][] = [[config.trailOpacity, 0], [0, 1]];
      const smin = config.trailScaleMin, smax = config.trailScaleMax;

      const behaviors: ConstructorParameters<typeof ParticleSystem>[0]['behaviors'] = [
        new ColorOverLife(new Gradient(colorStops, alphaStops)),
        new SizeOverLife(new FnValue(t => smin + (smax - smin) * t)),
      ];
      // Old loop did vel.y += gravity*dt (positive lifts — sprinkler droplets)
      if (config.trailParticleGravity) {
        behaviors.push(new GravityForce(_upQ, config.trailParticleGravity));
      }

      const circle = new CircleEmitter({ radius: config.trailSpread * 0.5, thickness: 1 });
      const sys = new ParticleSystem({
        duration: 1, looping: true,
        startLife: new IntervalValue(config.trailLifeMin, config.trailLifeMax),
        // slight outward drift — CircleEmitter pushes velocity radially
        startSpeed: new IntervalValue(0, 0.2),
        // The pooled-mesh trail scaled a radius-1 sphere by `size`, so the
        // visual diameter was 2·size; BillBoard startSize IS the full quad
        // side — without the ×2 every trail particle renders at half the
        // old linear size and reads as "no trail".
        startSize: new IntervalValue(config.trailBaseSize * 2,
          (config.trailBaseSize + config.trailSizeRange) * 2),
        startColor: new ConstantColor(new QV4(1, 1, 1, 1)),
        emissionOverTime: new ConstantValue(0),
        emissionOverDistance: new ConstantValue(config.trailParticlesPerUnit),
        shape: circle,
        material: impactMat(),
        renderMode: RenderMode.BillBoard,
        worldSpace: true,
        behaviors,
      });
      circleOf.set(sys, circle);
      return sys;
    });
    this.circle = circleOf.get(this.ps) ?? null;
    this.ps.emitter.position.copy(host.pos);
    attachSystem(this.ps);
    this.ps.restart();
    // restart() doesn't clear emissionState.travelDistance/previousWorldPos
    // — a pooled system still remembers the PREVIOUS projectile's last
    // position, so the distance-based emitter reads the teleport to the new
    // muzzle as travel and dumps its entire budget as one stationary burst
    // (the visible "streak from the old spot" + dead trail after).
    const st = this.ps.emissionState as {
      travelDistance: number;
      previousWorldPos?: THREE.Vector3;
    };
    st.travelDistance = 0;
    st.previousWorldPos = undefined;
    activeTrailPs.add(this.ps);
    liveQuarks.add(this);
    // A system reaped out from under a previous owner comes back dead —
    // the batcher no longer knows it, so attach+restart renders nothing.
    if (batcher && !batcher.systemToBatchIndex.has(this.ps)) trailStats.poolZombies++;
  }

  diag(): Record<string, unknown> {
    const ps = this.ps;
    const { pos, vel, config } = this.host;
    return {
      pos: `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`,
      spd: +vel.length().toFixed(1),
      ppu: config.trailParticlesPerUnit,
      hasPs: !!ps,
      particles: ps?.particleNum ?? -1,
      attached: ps ? !!batcher && batcher.systemToBatchIndex.has(ps) : false,
      paused: ps?.paused ?? false,
      waiting: +((ps?.emissionState as { waitEmiting?: number } | undefined)?.waitEmiting ?? 0).toFixed(2),
    };
  }

  // Move + aim the emitter; quarks emits floor(dist*ppu) particles itself.
  emitSegment(): void {
    if (!this.ps) return;
    const { pos, vel, config } = this.host;
    this.ps.emitter.position.copy(pos);
    if (vel.lengthSq() > 1e-4) {
      this.ps.emitter.quaternion.setFromUnitVectors(
        _forward, _tDir.copy(vel).normalize());
    }
    // Ramp-in: shrink the scatter disc during the trailRampIn window
    if (this.circle && config.trailRampIn > 0) {
      this.circle.radius = config.trailSpread * 0.5
        * Math.min(this.host.age() / config.trailRampIn, 1);
    }
  }

  /** True once exploded AND every emitted particle has died — the emitter
   *  simply stops moving, so no new particles spawn after the last
   *  emitSegment. */
  get empty(): boolean { return !this.ps || this.ps.particleNum === 0; }

  update(_dt: number): void { /* batcher.update drives everything */ }

  dispose(): void {
    if (!this.ps) return;
    const ps = this.ps;
    this.ps = null;
    activeTrailPs.delete(ps);
    liveQuarks.delete(this);
    ps.stop(); // kill particles immediately — old dispose() pooled them away just as fast
    const pool = pools.get(this.key) ?? [];
    if (pool.length < POOL_CAP) {
      pool.push(ps);
      pooled.add(ps);
      pools.set(this.key, pool);
      return;
    }
    batcher?.deleteSystem(ps);
    scene?.remove(ps.emitter);
    attached.delete(ps);
    ps.dispose();
  }
}

// ---- Continuous/small puffs (jetpack, dust, slipstreams) ----

export interface PuffSpec {
  count: number;
  /** spawn scatter box, half-extents added to the emit position */
  pos?: [number, number, number];
  /** per-axis uniform velocity range */
  velMin: [number, number, number];
  velMax: [number, number, number];
  /** flat velocity added to every particle — carries a fraction of the
   *  emitter's motion (ski dust sheds -0.05·vel, fly trails -0.1·vel) */
  shed?: [number, number, number];
  lifeMin: number; lifeMax: number;
  /** multiplies the old update-loop scale curve (0.15-radius sphere base) */
  sizeScale?: number;
  /** per-particle color endpoints — component-wise random lerp */
  colA: [number, number, number];
  colB: [number, number, number];
  additive?: boolean;
  gravity?: boolean; // default true — matches the old update loop
}

interface PuffParticle extends BlastParticle { startSpeed: number; }

/** Emits the old per-call particle semantics: box-scattered spawn,
 *  per-axis velocity range + a shared "shed" term. Direction/color/life
 *  all ride the system's generators so a call is a handful of small
 *  objects, not N meshes+materials+draw calls. */
class PuffEmitter {
  readonly type = 'puff';
  constructor(private spec: PuffSpec) { }
  update(): void { }
  initialize(p: PuffParticle): void {
    const s = this.spec, h = s.pos;
    p.position.set(
      h ? (Math.random() - 0.5) * 2 * h[0] : 0,
      h ? (Math.random() - 0.5) * 2 * h[1] : 0,
      h ? (Math.random() - 0.5) * 2 * h[2] : 0);
    p.velocity.set(
      s.velMin[0] + Math.random() * (s.velMax[0] - s.velMin[0]),
      s.velMin[1] + Math.random() * (s.velMax[1] - s.velMin[1]),
      s.velMin[2] + Math.random() * (s.velMax[2] - s.velMin[2]));
    if (s.shed) {
      p.velocity.x += s.shed[0]; p.velocity.y += s.shed[1]; p.velocity.z += s.shed[2];
    }
    p.startSpeed = 0; // velocity fully owned — don't let the shape scale it
  }
  toJSON(): { type: string } { return { type: this.type }; }
  clone(): PuffEmitter { return new PuffEmitter(this.spec); }
}

/** One small effect call → one batched burst. Replicates the pooled
 *  particle lifecycle: alpha always faded t·0.6 (the old update loop
 *  overwrote spawn opacity), size ran (0.3+t·1.4)·sizeScale shrinking
 *  over life, gravity applied unless noGravity. */
export function fxPuff(pos: THREE.Vector3, spec: PuffSpec): void {
  if (!batcher || !scene || live.size > 1200) return;
  const pressure = vfxPressure();
  // Ambient emitters fire every frame — under pressure each call still
  // costs a ParticleSystem even at count 1, so skip emissions outright.
  // Squaring keeps low-pressure drops rare: 0.35 → ~12% emit rate.
  if (Math.random() > pressure * pressure) return;
  const ss = spec.sizeScale ?? 1;
  const count = Math.max(1, Math.round(spec.count * pressure));
  const ps = new ParticleSystem({
    duration: spec.lifeMax + 0.05,
    looping: false,
    startLife: new IntervalValue(spec.lifeMin, spec.lifeMax),
    startSpeed: new ConstantValue(0),
    // base quad size ≈ old 0.15-radius sphere × 2 → diameter
    startSize: new ConstantValue(0.3 * ss),
    startColor: new ConstantColor(new QV4(1, 1, 1, 1)),
    startRotation: new IntervalValue(0, Math.PI * 2),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [{ time: 0, count: new ConstantValue(count), cycle: 0, interval: 0.01, probability: 1 }],
    shape: new PuffEmitter(spec),
    material: spec.additive ? impactMat() : normalMat(),
    renderMode: RenderMode.BillBoard,
    worldSpace: true,
    behaviors: [
      ...(spec.gravity === false ? [] : [new GravityForce(_upQ, GRAVITY)]),
      new ColorOverLife(new RandomColorBetweenGradient(
        new Gradient([[new QV3(...spec.colA), 0], [new QV3(...spec.colA), 1]],
          [[0.6, 0], [0, 1]]),
        new Gradient([[new QV3(...spec.colB), 0], [new QV3(...spec.colB), 1]],
          [[0.6, 0], [0, 1]]))),
      // shrink 1.7→0.3 over life — the old s=(0.3+t·1.4) formula
      new SizeOverLife(new FnValue(t => 0.3 + (1 - t) * 1.4)),
      new RotationOverLife(new IntervalValue(-2, 2)),
    ],
  });
  ps.emitter.position.copy(pos);
  batcher.addSystem(ps);
  scene.add(ps.emitter);
  live.add(ps);
  ps.play();
}

// ---- Explosion blast layers ----

/** quarks expects classes for value/emitter plugins, but all it checks
 *  is the structural interface — a tiny function-valued generator lets
 *  us hand in real curves instead of bezier control points. */
class FnValue implements FunctionValueGenerator {
  type = 'function' as const;
  constructor(private fn: (t: number) => number) { }
  startGen(): void { }
  genValue(_m: GeneratorMemory, t: number): number { return this.fn(t); }
  toJSON(): FunctionJSON { return { type: 'function' } as FunctionJSON; }
  clone(): FnValue { return new FnValue(this.fn); }
}

// Grow-in over the first 12% then linear shrink — the shape the old
// pooled particles used (t<0.12 ? t/0.12 : 1-t).
const GROW_SHRINK = new FnValue(t => (t < 0.12 ? t / 0.12 : 1 - t));

interface QVec {
  x: number; y: number; z: number;
  set(x: number, y: number, z: number): QVec;
  multiplyScalar(s: number): QVec;
}
interface BlastParticle {
  position: QVec;
  velocity: QVec;
  startSpeed: number;
}

/** Direction distribution the old spawnBurst loop used: elv drawn from
 *  [rand-elvBase)*elvSpan, uniform azimuth, plus a flat vy lift — or a
 *  flat horizontal disc for `planar` layers. Owns velocity fully, so
 *  the system-level startSpeed is just the speed roll. */
class BlastEmitter {
  readonly type = 'blast';
  constructor(private elvBase: number, private elvSpan: number,
              private planar: boolean, private vy: number,
              private dir?: THREE.Vector3, private spread?: number) {
    if (dir) this.liveDir.copy(dir);
  }
  update(): void { }
  // Pooled systems keep their constructed emitter — the launch dir is the
  // only per-shot value a forward-cone burst needs swapped on reuse.
  private liveDir = new THREE.Vector3();
  setDir(d?: THREE.Vector3): void { if (d) this.liveDir.copy(d); }
  initialize(p: BlastParticle): void {
    const ang = Math.random() * Math.PI * 2;
    p.position.set((Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5);
    if (this.dir) {
      // Forward cone: dir jittered by `spread` — reads as streaks along a
      // launch direction rather than an omnidirectional puff.
      _eVel.copy(this.liveDir)
        .addScaledVector(_eRand.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(), this.spread!)
        .normalize()
        .multiplyScalar(p.startSpeed);
      p.velocity.set(_eVel.x, _eVel.y, _eVel.z);
      return;
    }
    if (this.planar) {
      p.velocity.set(Math.sin(ang) + (Math.random() - 0.5), 0, Math.cos(ang) + (Math.random() - 0.5))
        .multiplyScalar(p.startSpeed);
      p.velocity.y += this.vy + Math.random() * 4;
    } else {
      const elv = (Math.random() - this.elvBase) * this.elvSpan;
      const c = Math.cos(elv);
      p.velocity.set(c * Math.sin(ang), Math.sin(elv), c * Math.cos(ang))
        .multiplyScalar(p.startSpeed);
      p.velocity.y += this.vy;
    }
  }
  toJSON(): { type: string } { return { type: this.type }; }
  clone(): BlastEmitter { return new BlastEmitter(this.elvBase, this.elvSpan, this.planar, this.vy, this.dir, this.spread); }
}
const _eRand = new THREE.Vector3();
const _eVel = new THREE.Vector3();

// Spec-keyed burst pool: explosions repeat the same few layer configs,
// so systems restart instead of rebuilding ~30 behavior objects per hit.
// The dir vector can't go in the key — it varies per shot — so the
// emitter is stored alongside and its liveDir re-seeded on take.
const shapeOf = new WeakMap<ParticleSystem, BlastEmitter>();

// Spec-quantizers hoisted out of burstKey — they're recreated per call otherwise.
const _q = (v?: number, step = 0.05) => v === undefined ? '' : Math.round(v / step) * step;
const _qc = (c?: number[]) => c === undefined ? '' : c.map(v => Math.round(v * 20) / 20).join('-');

function burstKey(kind: string, spec: BlastSpec | ImplodeSpec, additive: boolean): string {
  const s = spec as BlastSpec & ImplodeSpec;
  // Specs arrive with per-shot micro-variance (counts scaled by blast
  // radius, tints recomputed per weapon energy) — unquantized floats would
  // give every call a distinct key and the pool would never hit. Rounding
  // buckets specs whose visual difference is below perception anyway.
  const q = _q, qc = _qc;
  // count/gVar excluded: they scale per-shot (blast radius, heat value) and
  // a reused system's baked emission count is already pressure-scaled —
  // the drift is invisible, and keying on them empties the pool.
  return [kind, additive, q(s.spdMin), q(s.spdMax), q(s.vy),
    q(s.lifeMin), q(s.lifeMax), q(s.sizeMin), q(s.sizeMax), q(s.gravity),
    qc(s.c1), qc(s.c2), q(s.opacity), q(s.elvBase), q(s.elvSpan), s.planar,
    s.stretched, q(s.stretchLen), q(s.spin), q(s.stagger, 0.1),
    !!s.dir, q(s.spread), q(s.rMin), q(s.rMax), q(s.swirl)].join(',');
}

/** Inward shell emitter for implosions: spawn on a sphere shell at
 *  rMin..rMax, velocity aimed at the emitter origin plus a tangential
 *  swirl term (the old spiral read). Speed still rolls via startSpeed. */
class ImplodeEmitter {
  readonly type = 'implode';
  constructor(private rMin: number, private rMax: number, private swirl: number) { }
  update(): void { }
  initialize(p: BlastParticle): void {
    const elv = (Math.random() - 0.5) * Math.PI;
    const ang = Math.random() * Math.PI * 2;
    const c = Math.cos(elv);
    const dx = c * Math.sin(ang), dy = Math.sin(elv), dz = c * Math.cos(ang);
    const r = this.rMin + Math.random() * (this.rMax - this.rMin);
    p.position.set(dx * r, dy * r, dz * r);
    // Inward at startSpeed; swirl = fixed tangential add (not scaled by
    // startSpeed or it spins proportionally faster).
    p.velocity.set(-dx * p.startSpeed, -dy * p.startSpeed, -dz * p.startSpeed);
    // tangent ⟂ radius: rotate dir 90° about Y for an azimuthal swirl
    const tx = -dz, tz = dx;
    p.velocity.set(
      p.velocity.x + tx * this.swirl,
      p.velocity.y,
      p.velocity.z + tz * this.swirl);
  }
  toJSON(): { type: string } { return { type: this.type }; }
  clone(): ImplodeEmitter { return new ImplodeEmitter(this.rMin, this.rMax, this.swirl); }
}

export interface ImplodeSpec {
  count: number;
  rMin: number; rMax: number;    // spawn shell radii
  spdMin: number; spdMax: number;
  swirl?: number;                // tangential speed add (spiral read)
  lifeMin: number; lifeMax: number;
  sizeMin: number; sizeMax: number;
  c1: [number, number, number]; c2: [number, number, number];
  opacity: number;
  gravity?: number;
  spin?: number;
  stagger?: number;
}

/** Inward variant of blastBurst — same batching, shell → center. */
export function implodeBurst(pos: THREE.Vector3, spec: ImplodeSpec, additive: boolean): void {
  if (queueIfCold(burstKey('implode', spec, additive))) {
    const p = pos.clone();
    buildQueue.push(() => spawnImplodeBurst(p, spec, additive));
    return;
  }
  spawnImplodeBurst(pos, spec, additive);
}

function spawnImplodeBurst(pos: THREE.Vector3, spec: ImplodeSpec, additive: boolean): void {
  if (!batcher || !scene || live.size >= MAX_LIVE_SYSTEMS) return;
  const w = spec.stagger ?? 0;
  const ps = takeSystem(burstKey('implode', spec, additive), () => new ParticleSystem({
    duration: spec.lifeMax + w + 0.05,
    looping: false,
    startLife: new IntervalValue(spec.lifeMin, spec.lifeMax),
    startSpeed: new IntervalValue(spec.spdMin, spec.spdMax),
    startSize: new IntervalValue(spec.sizeMin, spec.sizeMax),
    startColor: new ConstantColor(new QV4(1, 1, 1, 1)),
    startRotation: new IntervalValue(0, Math.PI * 2),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: blastBursts(Math.max(1, Math.round(spec.count * vfxPressure())), w),
    shape: new ImplodeEmitter(spec.rMin, spec.rMax, spec.swirl ?? 0),
    material: additive ? impactMat() : normalMat(),
    renderMode: RenderMode.BillBoard,
    worldSpace: true,
    behaviors: [
      ...(spec.gravity ? [new GravityForce(_upQ, spec.gravity)] : []),
      new ColorOverLife(new Gradient(
        [[new QV3(...spec.c1), 0], [new QV3(...spec.c2), 1]],
        [[spec.opacity, 0], [0, 1]])),
      new SizeOverLife(GROW_SHRINK),
      new RotationOverLife(new IntervalValue(-(spec.spin ?? 1), spec.spin ?? 1)),
    ],
  }));
  ps.emitter.position.copy(pos);
  attachSystem(ps);
  live.add(ps);
  ps.restart();
}

export interface BlastSpec {
  count: number;
  elvBase?: number; elvSpan?: number;   // non-planar elevation distribution
  planar?: boolean;                     // flat horizontal sheet
  dir?: THREE.Vector3;                  // forward-cone mode (launch streaks)
  spread?: number;                      // cone jitter magnitude for dir mode
  spdMin: number; spdMax: number; vy: number;
  lifeMin: number; lifeMax: number;
  sizeMin: number; sizeMax: number;
  gravity: number;
  c1: [number, number, number]; c2: [number, number, number];
  opacity: number;
  gVar?: number;                        // per-particle green-channel spread
  stretched?: boolean;                  // velocity-stretched quads (spike rays)
  stretchLen?: number;                  // startLength multiplier for stretched
  /** Emission stagger window (s): splits `count` across 3 bursts over the
   *  window so a layer breathes instead of popping in one frame — the
   *  "low-FPS flipbook" tell is everything spawning at t=0. */
  stagger?: number;
  /** Billboard spin ±rad/s — rotating smoke/debris is the modern read;
   *  irrelevant on stretched quads (velocity-aligned) and symmetric glow. */
  spin?: number;
}

/** One explosion particle layer as a single batched quarks burst — the
 *  replacement for spawnBurst's per-particle pooled meshes/sprites.
 *  `kind: 'glow'` = additive, 'smoke'/'solid' = normal blend. */
/** gVar spreads the green channel per-particle — organic fire variance. */
function blastColorGen(spec: BlastSpec) {
  const g1 = new Gradient([[new QV3(...spec.c1), 0], [new QV3(...spec.c2), 1]],
    [[spec.opacity, 0], [0, 1]]);
  return spec.gVar
    ? new RandomColorBetweenGradient(g1, new Gradient(
        [[new QV3(spec.c1[0], spec.c1[1] + spec.gVar, spec.c1[2]), 0],
         [new QV3(...spec.c2), 1]], [[spec.opacity, 0], [0, 1]]))
    : g1;
}

/** Staggered emission: 60% at t=0 (the hit still snaps), 25%/15% trailing
 *  across the window so a layer breathes instead of popping in one frame. */
function blastBursts(count: number, w: number) {
  if (w <= 0) return [{ time: 0, count: new ConstantValue(count), cycle: 0, interval: 0.01, probability: 1 }];
  return [[0, Math.ceil(count * 0.6)], [w * 0.45, Math.ceil(count * 0.25)], [w, Math.floor(count * 0.15)]]
    .filter(b => b[1] > 0)
    .map(([time, c]) => ({ time, count: new ConstantValue(c), cycle: 0, interval: 0.01, probability: 1 }));
}

export function blastBurst(pos: THREE.Vector3, spec: BlastSpec,
    additive: boolean): void {
  if (queueIfCold(burstKey('blast', spec, additive))) {
    const p = pos.clone();
    buildQueue.push(() => spawnBlastBurst(p, spec, additive));
    return;
  }
  spawnBlastBurst(pos, spec, additive);
}

function spawnBlastBurst(pos: THREE.Vector3, spec: BlastSpec,
    additive: boolean): void {
  if (!batcher || !scene || live.size >= MAX_LIVE_SYSTEMS) return;
  const colorGen = blastColorGen(spec);
  const lifeMax = spec.lifeMax;
  const w = spec.stagger ?? 0;
  // Particle-pressure LOD: counts thin as global live particles climb,
  // so a mass-explosion pileup doesn't turn into 30k CPU-simmed quads.
  const bursts = blastBursts(Math.max(1, Math.round(spec.count * vfxPressure())), w);
  const em = new BlastEmitter(spec.elvBase ?? 0.5, spec.elvSpan ?? Math.PI, !!spec.planar, spec.vy, spec.dir, spec.spread);
  const ps = takeSystem(burstKey('blast', spec, additive), () => {
    const sys = new ParticleSystem({
    duration: lifeMax + w + 0.05,
    looping: false,
    startLife: new IntervalValue(spec.lifeMin, lifeMax),
    startSpeed: new IntervalValue(spec.spdMin, spec.spdMax),
    startSize: new IntervalValue(spec.sizeMin, spec.sizeMax),
    startColor: new ConstantColor(new QV4(1, 1, 1, 1)),
    startRotation: new IntervalValue(0, Math.PI * 2),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: bursts,
    shape: em,
    material: additive ? impactMat() : normalMat(),
    renderMode: spec.stretched ? RenderMode.StretchedBillBoard : RenderMode.BillBoard,
    speedFactor: spec.stretched ? 0.12 : undefined,
    startLength: spec.stretched ? new ConstantValue(spec.stretchLen ?? 8) : undefined,
    worldSpace: true,
    behaviors: [
      new GravityForce(_upQ, spec.gravity),
      new ColorOverLife(colorGen),
      new SizeOverLife(GROW_SHRINK),
      ...(spec.stretched ? [] : [new RotationOverLife(new IntervalValue(-(spec.spin ?? 1.2), spec.spin ?? 1.2))]),
    ],
    });
    shapeOf.set(sys, em);
    return sys;
  });
  shapeOf.get(ps)?.setDir(spec.dir);
  ps.emitter.position.copy(pos);
  attachSystem(ps);
  live.add(ps);
  ps.restart();
}
