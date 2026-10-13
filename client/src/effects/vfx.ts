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
  ParticleSystem, RenderMode,
  ConeEmitter, IntervalValue, ConstantValue, ConstantColor,
  GravityForce, ColorOverLife, Gradient, SizeOverLife,
  RandomColorBetweenGradient, RotationOverLife,
  // quarks.core math types are NOT three's — keep them separate.
  Vector3 as QV3, Vector4 as QV4,CircleEmitter
,
  type FunctionValueGenerator, type GeneratorMemory, type FunctionJSON,
} from 'three.quarks';
import { registerDiag } from '../core/fxDiag.js';

import {
  vfxPressure, vfxReady, vfxBatcher,
  live, pools, takeSystem, activateSystem, attachSystem, returnSystem, resyncEmission,
  queueIfCold, buildQueue, activeTrailPs, trailStats,
  poolDump, trailDriverCount,
} from './vfxRuntime.js';
import { EMIT_GAIN, GRAVITY } from '../core/config.js';
import { getGlowTexture, getPuffTexture } from './glowTexture.js';
import type { ProjectileConfig } from '../projectiles/types.js';
export { initVfx, vfxStats, setVfxQualityScale, vfxPressure, updateVfx, trailStats, poolDump } from './vfxRuntime.js';

const _upQ = new QV3(0, 1, 0);

// Shared materials — quarks batches by material instance, so a fresh
// material per burst would break the batch AND leak GL programs. Lazy:
// getGlowTexture() needs a 2d canvas, which node-side tests don't have.
let _impactMat: THREE.MeshBasicMaterial | null = null;
let _normalMat: THREE.MeshBasicMaterial | null = null;
function impactMat(): THREE.MeshBasicMaterial {
  _impactMat ??= new THREE.MeshBasicMaterial({
    map: getGlowTexture(), transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
    // HDR-hot tint: particle vertex colors × EMIT_GAIN push every additive
    // emitter (trails, flashes, glow layers) past the bloom threshold.
    color: new THREE.Color(EMIT_GAIN, EMIT_GAIN, EMIT_GAIN),
  });
  return _impactMat;
}
function normalMat(): THREE.MeshBasicMaterial {
  // Blotchy asymmetric puff — smoke/debris quads NEED a non-symmetric
  // silhouette or RotationOverLife spins an invisible radial sprite.
  _normalMat ??= new THREE.MeshBasicMaterial({
    map: getPuffTexture(), transparent: true, depthWrite: false,
    blending: THREE.NormalBlending,
  });
  return _normalMat;
}

/** Bullet-impact puff: a short cone of hot sparks kicked back along the
 *  shot direction + gravity. Replaces Effects.spawnImpact's per-particle
 *  meshes — one batched burst, ~0 allocation, one draw call shared with
 *  every other burst in flight. */
export function impactBurst(pos: THREE.Vector3, vel: THREE.Vector3): void {
  if (!vfxReady()) {return;}
  const ps = takeSystem('impact', (): ParticleSystem => new ParticleSystem({
    duration: 0.35,
    looping: false,
    startLife: new IntervalValue(0.12, 0.27),
    startSpeed: new IntervalValue(4, 12),
    startSize: new IntervalValue(0.08, 0.2),
    startColor: new ConstantColor(new QV4(1, 0.9, 0.45, 0.9)),
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
  // Cone emits along local +Z — aim it back along the incoming shot.
  if (vel.lengthSq() > 0) {
    _back.copy(vel).normalize().negate();
    _aimQ.setFromUnitVectors(_forward, _back);
  } else {_aimQ.identity();}
  activateSystem(ps, pos, _aimQ);
  live.add(ps);

  // Directional streak fan — stretched sparks flung back along the shot
  // line. This is what separates a bullet hit from a puff: the eye reads
  // velocity-aligned slivers as fragments. Skipped under particle
  // pressure (the puff above is the minimum readable hit).
  if (vfxPressure() > 0.6) {
    const streaks = takeSystem('impactStreak', (): ParticleSystem => new ParticleSystem({
      duration: 0.25,
      looping: false,
      startLife: new IntervalValue(0.1, 0.2),
      startSpeed: new IntervalValue(18, 45),
      startSize: new IntervalValue(0.05, 0.09),
      startColor: new ConstantColor(new QV4(1, 0.85, 0.4, 0.9)),
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
    activateSystem(streaks, pos, ps.emitter.quaternion);
    live.add(streaks);
  }
}

const _back = new THREE.Vector3();
const _aimQ = new THREE.Quaternion();
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
    config.trailColors.map((c): string => `${c.r},${c.g},${c.b}`).join(';')].join(',');
}

/** Trail as ONE batched quarks system per projectile: the old pool-per-
 *  host trail meant ~1 mesh+material+draw call per emitted particle; here
 *  the emitter just tracks the projectile and `emissionOverDistance`
 *  reproduces the exact same world-space spacing (slow shell vs fast
 *  slug get equal density). Emission stops by itself once the emitter
 *  stops moving — explode() simply stops calling emitSegment.
 *
 *  Trade vs the hand-rolled version: ring/disc mesh types collapse to
 *  billboards (only 'billboard' was ever configured anyway). */
// Debug surface — a live-trail registry + lifecycle counters so a silent
// trail can be told apart from (a) never built, (b) reaped while a
// projectile still owns it, (c) parked paused, (d) zombie from the pool.
const liveQuarks = new Set<QuarksTrail>();

export function trailDump(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const t of liveQuarks) {out.push(t.diag());}
  return out;
}

/** Pool inventory + batcher census — a trailKind whose pool keeps a dead
 *  system shows as depth with broken renders. paused/pooled/starved/
 *  buildQueue expose the suspended-work surface the plain counts hide. */
export class QuarksTrail {
  private ps: ParticleSystem | null = null;
  private circle: CircleEmitter | null = null;
  private key = '';
  private segCount = 0;
  // Last emitter anchor the sim deposited from — NaN until the first
  // emitSegment. Used to measure REAL per-frame travel; vel assumes
  // pos += vel*dt, which interp-driven/shadowed hosts don't honor, and a
  // stale vel left the lead short — the head-gap on remote shells.
  private _sx = Number.NaN; private _sy = 0; private _sz = 0;

  constructor(private host: QuarksTrailHost) {
    const {config} = host;
    if (!vfxReady()) {trailStats.noBatcher += 1; return; }
    if (config.trailParticlesPerUnit <= 0) {trailStats.noRate += 1; return; }
    this.key = trailKey(config);
    if ((pools.get(this.key)?.length ?? 0) > 0) {trailStats.reused += 1;} else {trailStats.built += 1;}
    this.ps = takeSystem(this.key, (): ParticleSystem => {
      // Gradient + alpha fade built from the config's arbitrary-length
      // trailColors — same lerp the per-particle loop used to do by hand.
      const cols = config.trailColors;
      const colorStops: [QV3, number][] = cols.map((c, i): [QV3, number] =>
        [new QV3(c.r, c.g, c.b), cols.length > 1 ? i / (cols.length - 1) : 0]);
      const alphaStops: [number, number][] = [[config.trailOpacity, 0], [0, 1]];
      const smin = config.trailScaleMin, smax = config.trailScaleMax;

      const behaviors: ConstructorParameters<typeof ParticleSystem>[0]['behaviors'] = [
        new ColorOverLife(new Gradient(colorStops, alphaStops)),
        // oxlint-disable-next-line no-use-before-define -- class declared below; constructed lazily
        new SizeOverLife(new FnValue((t): number => smin + (smax - smin) * t)),
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
    // activateSystem owns the whole pooled-checkout reset — position,
    // attach, restart, and the emission resync that stops a pooled
    // teleport cashing as one giant distance deposit at the muzzle.
    activateSystem(this.ps, host.pos);
    activeTrailPs.add(this.ps);
    liveQuarks.add(this);
    // A system reaped out from under a previous owner comes back dead —
    // the batcher no longer knows it, so attach+restart renders nothing.
    if (!vfxBatcher()!.systemToBatchIndex.has(this.ps)) {trailStats.poolZombies += 1;}
  }

  diag(): Record<string, unknown> {
    const {ps} = this;
    const { pos, vel, config } = this.host;
    return {
      n: config.name,
      age: Number(this.host.age().toFixed(2)),
      pos: `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`,
      spd: Number(vel.length().toFixed(1)),
      ppu: config.trailParticlesPerUnit,
      hasPs: Boolean(ps),
      segs: this.segCount,
      particles: ps?.particleNum ?? -1,
      attached: ps ? Boolean(vfxBatcher()?.systemToBatchIndex.has(ps)) : false,
      paused: ps?.paused ?? false,
      waiting: Number(((ps?.emissionState as { waitEmiting?: number } | undefined)?.waitEmiting ?? 0).toFixed(2)),
      // Silent-emission discriminators: emitEnded pauses emit() forever,
      // looping gates the time-wrap, travelDistance/prevWorldPos say whether
      // emit-over-distance ever deposits, emVis/emRoot catch an emitter
      // culled out of getVisibleSystems (frozen matrixWorld) or detached
      // from the scene root (update() self-disposes on !Scene).
      ended: (ps as unknown as { emitEnded?: boolean } | undefined)?.emitEnded ?? null,
      loop: ps?.looping ?? null,
      emT: ps ? Number(ps.time.toFixed(2)) : null,
      travel: Number(((ps?.emissionState as { travelDistance?: number } | undefined)?.travelDistance ?? -1).toFixed(2)),
      emVis: ps?.emitter.visible ?? null,
      emRoot: ps ? ((): string => {
        let o: THREE.Object3D = ps.emitter;
        while (o.parent) {o = o.parent;}
        return o.type;
      })() : null,
      emScale: ps ? Number(ps.emitter.scale.x.toFixed(3)) : null,
      // Double-checkout detector: a trail ps that also sits in a pool means
      // two owners share one system — emit bookkeeping is then torn between
      // them (the classic "sometimes no trail" split-brain).
      inPool: ps ? [...(pools.get(this.key) ?? [])].some((e): boolean => e.ps === ps) : null,
      // Emitter WORLD position vs the first live particle's spawn point —
      // particles drifting far from the emitter mean the distance deposit
      // landed at a stale matrixWorld (parked-teleport burst elsewhere),
      // not at the muzzle.
      emW: ps ? ((): string => {
        const e = ps.emitter.matrixWorld.elements;
        return `${e[12]!.toFixed(1)},${e[13]!.toFixed(1)},${e[14]!.toFixed(1)}`;
      })() : '-',
      p0: ps && ps.particleNum > 0 ? ((): string => {
        const p = (ps as unknown as { particles: { position: THREE.Vector3 }[] }).particles[0]!;
        return `${p.position.x.toFixed(1)},${p.position.y.toFixed(1)},${p.position.z.toFixed(1)}`;
      })() : '-',
    };
  }

  /** The host projectile teleported (latency advance, ray-burst discharge)
   *  — resync the emitter or the next emit() reads the jump as traveled
   *  distance and dumps a straight line of particles across the gap. */
  teleport(): void {
    if (!this.ps) {return;}
    this.ps.emitter.position.copy(this.host.pos);
    this._sx = Number.NaN; // re-arm measured travel at the new anchor
    resyncEmission(this.ps, this.ps.emitter);
  }

  // Move + aim the emitter; quarks emits floor(dist*ppu) particles itself.
  emitSegment(dt = 0): void {
    if (!this.ps) {return;}
    // Starve-reaped while parked (owner stalled >4s without disposing):
    // re-attach so this emit actually lands — an orphan's detach is
    // self-healing here, not a permanent "no trail" state.
    if (!vfxBatcher()!.systemToBatchIndex.has(this.ps)) {
      this.ps.paused = false;
      attachSystem(this.ps);
      resyncEmission(this.ps, this.ps.emitter);
      activeTrailPs.add(this.ps);
    }
this.segCount += 1;
    const { pos, vel, config } = this.host;
    // Emit-time jump cut — the deposit is the segment the emitter
    // traveled, so ANY discontinuity (teleport, resync sweep, correction
    // glide) has to be refused HERE, inside emit, not left to every
    // caller remembering teleport(). Same budget RibbonTrail.push uses:
    // ~80ms of travel + slack — deposits span ≤2 render frames between
    // sim ticks, so legit motion never reaches it; the old quarter-second
    // budget let 30-80m jumps cash as one sky-crossing dotted line.
    const em = this.ps.emitter;
    const spd = vel.length();
    const jump = spd * 0.08 + 3;
    // Measure against what emit() actually deposits from —
    // previousWorldPos, not the emitter's last position write.
    const pwp = (this.ps.emissionState as { previousWorldPos?: THREE.Vector3 }).previousWorldPos;
    const ax = pwp?.x ?? em.position.x, ay = pwp?.y ?? em.position.y, az = pwp?.z ?? em.position.z;
    const jx = pos.x - ax, jy = pos.y - ay, jz = pos.z - az;
    const jumped = jx * jx + jy * jy + jz * jz > jump * jump;
    // Real per-frame travel — pos-driven hosts (interp remotes, shadow
    // shells, renderOffset decay) don't move by vel*dt, so a vel-based
    // lead undershoots and the deposit head lags the mesh. Measure the
    // anchor's actual displacement instead; identical to vel*dt when
    // the host is vel-driven. Capped: a resume/jump frame's giant delta
    // would push the lead past the jump cut the resync just cleared.
    const mdx = pos.x - this._sx, mdy = pos.y - this._sy, mdz = pos.z - this._sz;
    this._sx = pos.x; this._sy = pos.y; this._sz = pos.z;
    em.position.copy(pos);
    // Sim-decimation lead: the batcher only sims every other frame, and
    // quarks spawns distance particles AT the emitter's matrixWorld —
    // so the freshest particle is always ~2 render frames behind the
    // mesh (the head gap, ~7m at 200m/s). Lead the emitter by the sim
    // interval so deposits land at the head's drawn position instead.
    // Travel math is unaffected — previousWorldPos carries the same
    // lead, so only the deposit's endpoint shifts forward.
    if (dt > 0) {
      const cap = spd * dt * 4 + 3;
      const mLen = mdx * mdx + mdy * mdy + mdz * mdz;
      if (Number.isFinite(mLen) && mLen > 1e-12) {
        // Scale the measured lead down to the cap on overshoot — a vel
        // fallback undershoots pos-driven hosts (interp remotes,
        // renderOffset decay) and the trail snaps behind on hitchy frames.
        const k = Math.min(1, cap / Math.sqrt(mLen)) * 2;
        em.position.x += mdx * k; em.position.y += mdy * k; em.position.z += mdz * k;
      } else {
        em.position.addScaledVector(vel, dt * 2);
      }
    }
    // emit() deposits previousWorldPos→matrixWorld — judge THAT span, not
    // pos alone: a dt-scaled fallback lead can park the emitter far ahead
    // on a hitch frame while pos never jumped (hidden-tab resume dumps
    // vel*dt*2 ≈ kilometers of lead), and emit() then paints the whole
    // gap as one sky streak. On overshoot re-seat at pos, no lead.
    em.updateMatrixWorld(true);
    const lx = em.position.x - ax, ly = em.position.y - ay, lz = em.position.z - az;
    if (jumped || lx * lx + ly * ly + lz * lz > jump * jump) {
trailStats.emitCuts += 1;
      em.position.copy(pos);
      em.updateMatrixWorld(true);
      resyncEmission(this.ps, em);
    }
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
    if (!this.ps) {return;}
    const {ps} = this;
    this.ps = null;
    activeTrailPs.delete(ps);
    liveQuarks.delete(this);
    ps.stop(); // kill particles immediately — old dispose() pooled them away just as fast
    returnSystem(ps, this.key);
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
  // spec is re-seeded on every pooled checkout — pos/velMin/velMax/shed
  // are velocity-coupled per call, so they must NOT live in the pool key.
  constructor(private spec: PuffSpec) { }
  setSpec(s: PuffSpec): void { this.spec = s; }
  update(): void { return; }
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

// Pooled puff systems keep their constructed emitter — like BlastEmitter's
// liveDir, the velocity-coupled spec fields are re-seeded on checkout.
const puffOf = new WeakMap<ParticleSystem, PuffEmitter>();

/** One small effect call → one batched burst. Replicates the pooled
 *  particle lifecycle: alpha always faded t·0.6 (the old update loop
 *  overwrote spawn opacity), size ran (0.3+t·1.4)·sizeScale shrinking
 *  over life, gravity applied unless noGravity. */
const _qc = (c?: number[]): string => c === undefined ? '' : c.map((v): number => Math.round(v * 20) / 20).join('-');
const _q = (v?: number, step = 0.05): number | "" => v === undefined ? '' : Math.round(v / step) * step;
export function fxPuff(pos: THREE.Vector3, spec: PuffSpec): void {
  if (!vfxReady() || document.hidden) {return;} // off-screen bursts only pile up
  const pressure = vfxPressure();
  // Ambient emitters fire every frame — under pressure each call still
  // costs a ParticleSystem even at count 1, so skip emissions outright.
  // Squaring keeps low-pressure drops rare: 0.35 → ~12% emit rate.
  if (Math.random() > pressure * pressure) {return;}
  const ss = spec.sizeScale ?? 1;
  const count = Math.max(1, Math.round(spec.count * pressure));
  // The key covers only what the build bakes into generators/behaviors
  // (life range, size, colors, material, gravity) — quantized so near-equal
  // specs share a bucket. pos/velMin/velMax/shed/count are velocity-coupled
  // per call: they're re-seeded via PuffEmitter.setSpec / emissionBursts on
  // checkout. Keying on them fragmented the freelist into 8.4k one-entry
  // buckets (~30k parked systems) — the 13ms vfx frame.
  const kind = `puff:${_q(spec.lifeMin, 0.1)}:${_q(spec.lifeMax, 0.1)}:${_q(ss, 0.1)}` +
    `:${spec.additive ? 1 : 0}:${spec.gravity === false ? 0 : 1}:${_qc(spec.colA)}:${_qc(spec.colB)}`;
  const ps = takeSystem(kind, (): ParticleSystem => {
    const em = new PuffEmitter(spec);
    const sys = new ParticleSystem({
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
    shape: em,
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
      // oxlint-disable-next-line no-use-before-define -- class declared below; constructed lazily
      new SizeOverLife(new FnValue((t): number => 0.3 + (1 - t) * 1.4)),
      new RotationOverLife(new IntervalValue(-2, 2)),
    ],
    });
    puffOf.set(sys, em);
    return sys;
  });
  // Re-seed the runtime spec — the pooled system's emitter was built with
  // a different call's pos/velMin/velMax/shed.
  puffOf.get(ps)?.setSpec(spec);
  // count is baked at build but pressure-scaled per call — a pooled
  // reuse would replay the first build's crowd size.
  ps.emissionBursts[0]!.count = new ConstantValue(count);
  activateSystem(ps, pos); // tags the emitter for the aim probe too
  live.add(ps);
}

// ---- Explosion blast layers ----

/** quarks expects classes for value/emitter plugins, but all it checks
 *  is the structural interface — a tiny function-valued generator lets
 *  us hand in real curves instead of bezier control points. */
class FnValue implements FunctionValueGenerator {
  type = 'function' as const;
  constructor(private fn: (t: number) => number) { }
  startGen(): void { return; }
  genValue(_m: GeneratorMemory, t: number): number { return this.fn(t); }
  toJSON(): FunctionJSON { return { type: 'function' } as FunctionJSON; }
  clone(): FnValue { return new FnValue(this.fn); }
}

// Grow-in over the first 12% then linear shrink — the shape the old
// pooled particles used (t<0.12 ? t/0.12 : 1-t).
const GROW_SHRINK = new FnValue((t): number => (t < 0.12 ? t / 0.12 : 1 - t));

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
    if (dir) {this.liveDir.copy(dir);}
  }
  update(): void { return; }
  // Pooled systems keep their constructed emitter — the launch dir is the
  // only per-shot value a forward-cone burst needs swapped on reuse.
  private liveDir = new THREE.Vector3();
  setDir(d?: THREE.Vector3): void { if (d) {this.liveDir.copy(d);} }
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
    Boolean(s.dir), q(s.spread), q(s.rMin), q(s.rMax), q(s.swirl)].join(',');
}

/** Inward shell emitter for implosions: spawn on a sphere shell at
 *  rMin..rMax, velocity aimed at the emitter origin plus a tangential
 *  swirl term (the old spiral read). Speed still rolls via startSpeed. */
class ImplodeEmitter {
  readonly type = 'implode';
  constructor(private rMin: number, private rMax: number, private swirl: number) { }
  update(): void { return; }
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

function spawnImplodeBurst(pos: THREE.Vector3, spec: ImplodeSpec, additive: boolean): void {
  if (!vfxReady()) {return;}
  const w = spec.stagger ?? 0;
  const ps = takeSystem(burstKey('implode', spec, additive), (): ParticleSystem => new ParticleSystem({
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
  activateSystem(ps, pos);
  live.add(ps);
}



/** Lifesteal — the melee-heal payoff: blood-red wisps converging into
 *  the killer's chest. Additive so it glows; reads the same imploding
 *  "life pulled in" on a remote body and in the local player's own face. */
export function lifestealBurst(pos: THREE.Vector3): void {
  implodeBurst(pos, {
    count: 22, rMin: 0.4, rMax: 2.6,
    spdMin: 9, spdMax: 15, swirl: 2.5,
    lifeMin: 0.22, lifeMax: 0.42,
    sizeMin: 0.22, sizeMax: 0.45,
    c1: [1, 0.18, 0.12], c2: [0.45, 0.02, 0.06],
    opacity: 0.9, stagger: 0.05,
  }, true);
}

/** Inward variant of blastBurst — same batching, shell → center. */
export function implodeBurst(pos: THREE.Vector3, spec: ImplodeSpec, additive: boolean): void {
  if (queueIfCold(burstKey('implode', spec, additive))) {
    const p = pos.clone();
    buildQueue.push((): void => spawnImplodeBurst(p, spec, additive));
    return;
  }
  spawnImplodeBurst(pos, spec, additive);
}

/** Staggered emission: 60% at t=0 (the hit still snaps), 25%/15% trailing
 *  across the window so a layer breathes instead of popping in one frame. */
function blastBursts(count: number, w: number) {
  if (w <= 0) {return [{ time: 0, count: new ConstantValue(count), cycle: 0, interval: 0.01, probability: 1 }];}
  return [[0, Math.ceil(count * 0.6)], [w * 0.45, Math.ceil(count * 0.25)], [w, Math.floor(count * 0.15)]]
    .filter((b): boolean => b[1] > 0)
    .map(([time, c]) => ({ time, count: new ConstantValue(c), cycle: 0, interval: 0.01, probability: 1 }));
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
function blastColorGen(spec: BlastSpec): Gradient | RandomColorBetweenGradient {
  const g1 = new Gradient([[new QV3(...spec.c1), 0], [new QV3(...spec.c2), 1]],
    [[spec.opacity, 0], [0, 1]]);
  return spec.gVar
    ? new RandomColorBetweenGradient(g1, new Gradient(
        [[new QV3(spec.c1[0], spec.c1[1] + spec.gVar, spec.c1[2]), 0],
         [new QV3(...spec.c2), 1]], [[spec.opacity, 0], [0, 1]]))
    : g1;
}

function spawnBlastBurst(pos: THREE.Vector3, spec: BlastSpec,
    additive: boolean): void {
  if (!vfxReady()) {return;}
  const colorGen = blastColorGen(spec);
  const {lifeMax} = spec;
  const w = spec.stagger ?? 0;
  // Particle-pressure LOD: counts thin as global live particles climb,
  // so a mass-explosion pileup doesn't turn into 30k CPU-simmed quads.
  const bursts = blastBursts(Math.max(1, Math.round(spec.count * vfxPressure())), w);
  const em = new BlastEmitter(spec.elvBase ?? 0.5, spec.elvSpan ?? Math.PI, Boolean(spec.planar), spec.vy, spec.dir, spec.spread);
  const ps = takeSystem(burstKey('blast', spec, additive), (): ParticleSystem => {
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
  activateSystem(ps, pos);
  live.add(ps);
}



export function blastBurst(pos: THREE.Vector3, spec: BlastSpec,
    additive: boolean): void {
  if (queueIfCold(burstKey('blast', spec, additive))) {
    const p = pos.clone();
    buildQueue.push((): void => spawnBlastBurst(p, spec, additive));
    return;
  }
  spawnBlastBurst(pos, spec, additive);
}

// Alt+Q census section — registered here so the dump grows without
// another gameLoop/stateDebug plumbing pass. This IS the P4 unified
// census: pools (takeSystem), host drivers (P1), ribbons (P2 gens),
// and lit/orphan audits in one row.
registerDiag('vfx', () => ({
  stats: trailStats,
  pools: poolDump(),
  drivers: trailDriverCount(),
  // No 'ribbons' key here — the ribbons section emits the row array and
  // Object.assign merge would let this shadow it with the litAudit
  // OBJECT (diagDump then crashes on .slice).
  trails: trailDump(),
}));
