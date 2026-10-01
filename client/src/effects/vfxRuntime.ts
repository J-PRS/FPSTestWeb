// Quarks system runtime — batcher ownership, the one-shot free-list,
// distance-pause / starve-reaper bookkeeping, and the dynamic pool
// shrink. Split from vfx.ts: this file is "systems live and die here";
// vfx.ts is "effects are built here". Import the runtime surface below,
// never reach into the maps directly.
import * as THREE from 'three';
import { BatchedRenderer, ParticleSystem } from 'three.quarks';
import type { IParticleSystem } from 'quarks.core';
import { markProbe } from '../core/fxDiag.js';
import { BLOOM_LAYER } from '../core/config.js';

let batcher: BatchedRenderer | null = null;
let scene: THREE.Scene | null = null;
/** One-shots still simming (attached until their last particle dies). */
export const live = new Set<ParticleSystem>();

export function initVfx(s: THREE.Scene): void {
  if (batcher) return;
  scene = s;
  batcher = new BatchedRenderer();
  batcher.layers.enable(BLOOM_LAYER);
  s.add(batcher);
}

/** Read accessors — the batcher/scene stay module-private so nothing can
 *  attach behind attachSystem's probe-tagging or re-attach a reaped one. */
export function vfxBatcher(): BatchedRenderer | null { return batcher; }
export function vfxScene(): THREE.Scene | null { return scene; }
/** initVfx hasn't run — effects no-op rather than leak an orphan system. */
export function vfxReady(): boolean { return !!batcher && !!scene; }

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

// No live-system count cap — the old 320 limit culled the OLDEST system
// under sustained fire, which ate projectile trails mid-flight. The CPU
// bound is the 180m distance-pause + vfxPressure LOD instead; a system
// count that grows past those is a leak to hunt (vfxStats/dump), not a
// number to silently truncate.

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

// Trail lifecycle counters — written by QuarksTrail (trails live in
// vfx.ts) and read by the starve reaper here. Lives in the runtime so
// the reaper and the registry share one file's worth of state.
export const trailStats = {
  built: 0, reused: 0, noBatcher: 0, noRate: 0,
  reapedActive: 0, poolZombies: 0,
};
// Trails are exempt from the distance-pause AND the starve-reaper's
// delete path — membership is what `owns this system` means here.
export const activeTrailPs = new Set<ParticleSystem>();

// One-shot freelist: ParticleSystem construction builds ~30 behavior
// objects per burst — the burst-frame spikes. Finished systems restart
// cleanly, so pool them by config kind instead of rebuilding each hit.
const kindOf = new Map<ParticleSystem, string>();
// Pooled entries carry the time they went idle — growth is unbounded
// (peak demand IS the right size) but idle entries decay back down to
// POOL_FLOOR so a burst spike doesn't pin capacity forever.
export const pools = new Map<string, { ps: ParticleSystem; idleAt: number }[]>();
const attached = new WeakSet<ParticleSystem>();
// Systems parked in a pool stay attached but dead — starve-reaping would
// otherwise dispose them each bookkeeping pass and the pool never fills.
export const pooled = new WeakSet<ParticleSystem>();
// Dynamic-pool shrink: an entry idle this long beyond the floor is pure
// cost — every pooled system stays attached and iterates in
// batcher.update each frame. The floor keeps a warm minimum per kind.
const POOL_IDLE_MS = 30_000;
const POOL_FLOOR = 4;

export function attachSystem(ps: ParticleSystem): void {
  if (attached.has(ps)) return;
  batcher?.addSystem(ps);
  scene?.add(ps.emitter);
  // Aim-probe tag — a crosshair hit on a live Points cloud resolves back
  // to the system (paused/particle count) instead of an anonymous blur.
  markProbe(ps.emitter as unknown as THREE.Object3D, { kind: 'quarks', ps });
  attached.add(ps);
}

export function takeSystem(kind: string, build: () => ParticleSystem): ParticleSystem {
  const ps = pools.get(kind)?.pop()?.ps;
  const st = window.__vfxStats;
  if (ps) {
    if (st) st.hits++; pooled.delete(ps);
    // Pooled systems can come back parked distance-paused (the flag lives
    // on the system, not in restart()) — a paused reuse emits nothing.
    ps.paused = false;
    return ps;
  }
  if (st) st.misses++;
  const n = build();
  kindOf.set(n, kind);
  return n;
}

/** Resync quarks' emit-over-distance bookkeeping to the emitter's current
 *  position. restart() only clears waitEmiting — travelDistance and
 *  previousWorldPos survive, so after any teleport (pool reuse, unpause
 *  drift) the next emit() would read the jump as one giant deposit and
 *  dump N particles at a single point: the "first particle duplicated,
 *  too bright, lingering" blob. `??=` matters — `?.set` on a missing
 *  vector no-ops and quarks re-reads the stale emitter.matrixWorld. */
export function resyncEmission(ps: IParticleSystem, em: THREE.Object3D): void {
  const st = (ps as ParticleSystem).emissionState as {
    travelDistance: number;
    waitEmiting: number;
    previousWorldPos?: THREE.Vector3;
  };
  st.travelDistance = 0;
  st.waitEmiting = 0;
  (st.previousWorldPos ??= new THREE.Vector3()).copy(em.position);
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
export const buildQueue: (() => void)[] = [];
// A burst should only ever land in-frame when it's a warm restart —
// a cold build is ~2ms of behavior-object construction, and a fresh
// explosion stacks several. Peek at the pool: non-empty = warm, build
// now; empty (or far, where a frame of delay is invisible) = enqueue.
// The queue cap degrades to immediate builds under sustained spam.
export function queueIfCold(key: string): boolean {
  if ((pools.get(key)?.length ?? 0) > 0) return false;
  return buildQueue.length < 12;
}
// Pause/prune bookkeeping runs at 15Hz — a ~66ms lag on distance-pause or
// one-shot teardown is invisible, and rescanning every system every frame
// was the last per-frame O(systems) cost in vfx.
let prunePhase = 0;

/** Distance-pause / suspend-decay for one system. Far systems get a coarse
 *  manual age step (batcher.update skips paused ones, so their particles
 *  would hang mid-air forever); near systems just unpause. Both resync the
 *  emission state first — emitSegment keeps writing emitter.position while
 *  paused, but previousWorldPos only advances inside emit(), so without
 *  the resync the suspended drift cashes as one giant travel jump. */
function tickSuspended(ps: IParticleSystem, em: THREE.Object3D, camPos: THREE.Vector3): void {
  const far = em.position.distanceToSquared(camPos) > VFX_SIM_RADIUS_SQ;
  if (!far) {
    if ((ps as ParticleSystem).paused) resyncEmission(ps, em);
    (ps as ParticleSystem).paused = false;
    return;
  }
  resyncEmission(ps, em);
  (ps as ParticleSystem).paused = false;
  // quarks marks update() private in its typings though it's the method
  // BatchedRenderer.update calls per frame — the cast is the same call,
  // scoped to this one system.
  (ps as unknown as { update(d: number): void }).update(PAUSED_DECAY_S);
  (ps as ParticleSystem).paused = true;
}

function runBookkeeping(camPos?: THREE.Vector3): void {
  // Distance-pause BEFORE the batch sim: skip offscreen systems this frame.
  // Covers every attached system (live bursts AND projectile trails).
  if (batcher) {
    for (const ps of batcher.systemToBatchIndex.keys()) {
      // Trails are exempt from the 180m distance-pause: a suspended system
      // emits nothing, so the particle trail would freeze mid-flight even
      // while the projectile keeps going — and trails are cheap continuous
      // emitters compared to the multi-layer bursts this pause exists for.
      if (camPos && !activeTrailPs.has(ps as ParticleSystem))
        tickSuspended(ps, ps.emitter as unknown as THREE.Object3D, camPos);
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
        // Pooled systems stay attached to the batcher — a dead system
        // sims ~0 particles, so detach+reattach would only rebuy the
        // batch slice that restart() repopulates for free.
        pool.push({ ps, idleAt: performance.now() });
        pooled.add(ps);
        pools.set(kind, pool);
        live.delete(ps);
        continue;
      }
      batcher?.deleteSystem(ps);
      scene?.remove(ps.emitter);
      attached.delete(ps);
      live.delete(ps);
    }
  }
  _liveParticles = particles;
  shrinkPools(performance.now());
}

// The contract half of the dynamic pool: entries idle past the keep-alive
// window are retired back toward POOL_FLOOR — capacity tracks demand
// instead of staying pinned at the all-time peak.
function shrinkPools(now: number): void {
  for (const [kind, pool] of pools) {
    for (let i = pool.length - 1; i >= POOL_FLOOR; i--) {
      if (now - pool[i]!.idleAt <= POOL_IDLE_MS) continue;
      const ps = pool[i]!.ps;
      pool[i] = pool[pool.length - 1]!;
      pool.pop();
      batcher?.deleteSystem(ps);
      scene?.remove(ps.emitter);
      attached.delete(ps);
      pooled.delete(ps);
      ps.dispose();
    }
    if (!pool.length) pools.delete(kind);
  }
}

export function updateVfx(dt: number, camPos?: THREE.Vector3): void {
  if (buildQueue.length) buildQueue.shift()!();
  if (++prunePhase >= 4) {
    prunePhase = 0;
    runBookkeeping(camPos);
  }
  simParity = !simParity;
  if (simParity) batcher?.update(dt * 2);
}

/** Pool inventory + batcher census — a trailKind whose pool keeps a dead
 *  system shows as depth with broken renders. paused/pooled/starved/
 *  buildQueue expose the suspended-work surface the plain counts hide. */
export function poolDump(): Record<string, unknown> {
  const keys: Record<string, number> = {};
  for (const [k, v] of pools) keys[k] = v.length;
  let paused = 0, pooledN = 0;
  if (batcher) {
    for (const ps of batcher.systemToBatchIndex.keys()) {
      if ((ps as ParticleSystem).paused) paused++;
    }
  }
  for (const v of pools.values()) pooledN += v.length;
  return {
    batcherSystems: batcher ? batcher.systemToBatchIndex.size : 0,
    live: live.size,
    liveParticles: _liveParticles,
    paused, pooled: pooledN,
    starveWatch: starveFrames.size,
    buildQueue: buildQueue.length,
    activeTrails: activeTrailPs.size,
    poolDepth: keys,
  };
}
