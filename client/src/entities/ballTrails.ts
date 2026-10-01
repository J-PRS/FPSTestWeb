/**
 * ballTrails — the sparkle layer behind a bouncing ball. Two-layer dot
 * (tinted halo + near-white core) scattered inside a small sphere around
 * the ball, random size and lifetime.
 *
 * Drawn as ONE THREE.Points for the whole layer: ~40 balls × 28 sprites
 * used to cost ~1000 unbatchable draw calls, then one Points per trail
 * still cost ~57 calls (census). Now every trail owns a fixed slot range
 * inside a single shared geometry — the layer is one draw call total.
 */
import * as THREE from 'three';

const TRAIL_COUNT = 14;
const TRAIL_INTERVAL = 0.04;

interface TrailDot {
  pos: THREE.Vector3;
  age: number;
  life: number;    // per-dot random lifetime
  haloSz: number;  // per-dot random base scales
  coreSz: number;
  tint: THREE.Color;
  wIdx: number;    // vert index this dot's pos was last written to (-1 = unwritten)
}

// Dot pool — a trail cycles ~40 dots/sec and each spawn used to fresh-
// alloc a Vector3 + Color + wrapper (~1400 objects/s across the roster).
const _dotPool: TrailDot[] = [];
function takeDot(): TrailDot {
  return _dotPool.pop() ?? { pos: new THREE.Vector3(), age: 0, life: 0, haloSz: 0, coreSz: 0, tint: new THREE.Color(), wIdx: -1 };
}
function freeDot(d: TrailDot): void { _dotPool.push(d); }

const _spawn = new THREE.Vector3();
const _scatter = new THREE.Vector3();
const _white = new THREE.Color(1, 1, 1);
const _tmpC = new THREE.Color();

// Shared radial-gradient texture: hot center -> colored mid -> soft rim.
let _trailTex: THREE.Texture | null = null;
export function getTrailTex(): THREE.Texture {
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

let _mat: THREE.ShaderMaterial | null = null;
function trailMat(): THREE.ShaderMaterial {
  if (!_mat) {
    _mat = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: getTrailTex() },
        // viewport height in px — world size -> gl_PointSize needs it and
        // projectionMatrix[1][1]; updated per frame in fade()
        uHeight: { value: 800 },
      },
      vertexShader: /* glsl */`
        attribute float aSize;
        attribute vec4 aColor;
        varying vec4 vColor;
        uniform float uHeight;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (uHeight * projectionMatrix[1][1] * 0.5) / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying vec4 vColor;
        uniform sampler2D uTex;
        void main() {
          float a = texture2D(uTex, gl_PointCoord).a;
          gl_FragColor = vec4(vColor.rgb, vColor.a * a);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }
  return _mat;
}

// One shared Points mesh per batch — each trail owns a contiguous
// slot range (TRAIL_COUNT*2 verts) inside the shared geometry.
const SLOT_VERTS = TRAIL_COUNT * 2;   // halo + core per dot
const BATCH_TRAILS = 128;

class DotBatch {
  readonly geo = new THREE.BufferGeometry();
  readonly posAttr = new THREE.BufferAttribute(new Float32Array(BATCH_TRAILS * SLOT_VERTS * 3), 3);
  readonly sizeAttr = new THREE.BufferAttribute(new Float32Array(BATCH_TRAILS * SLOT_VERTS), 1);
  readonly colAttr = new THREE.BufferAttribute(new Float32Array(BATCH_TRAILS * SLOT_VERTS * 4), 4);
  free: number[] = [];
  readonly points: THREE.Points;
  private dirtyLo = Infinity;
  private dirtyHi = 0;

  constructor(private scene: THREE.Scene) {
    for (const a of [this.posAttr, this.sizeAttr, this.colAttr]) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('aSize', this.sizeAttr);
    this.geo.setAttribute('aColor', this.colAttr);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.points = new THREE.Points(this.geo, trailMat());
    this.points.frustumCulled = false;
    scene.add(this.points);
    for (let s = BATCH_TRAILS - 1; s >= 0; s--) this.free.push(s);
  }

  dispose(): void {
    this.scene.remove(this.points);
    this.geo.dispose();
  }

  /** Accumulate a dirty vert range — flush() uploads just the touched
   *  span instead of the whole ~90KB buffer every frame. */
  mark(lo: number, hi: number): void {
    if (lo < this.dirtyLo) this.dirtyLo = lo;
    if (hi > this.dirtyHi) this.dirtyHi = hi;
  }

  flush(): void {
    const lo = this.dirtyLo, n = this.dirtyHi - lo;
    this.dirtyLo = Infinity; this.dirtyHi = 0;
    if (n <= 0) return;
    this.posAttr.clearUpdateRanges();
    this.posAttr.addUpdateRange(lo * 3, n * 3);
    this.posAttr.needsUpdate = true;
    this.sizeAttr.clearUpdateRanges();
    this.sizeAttr.addUpdateRange(lo, n);
    this.sizeAttr.needsUpdate = true;
    this.colAttr.clearUpdateRanges();
    this.colAttr.addUpdateRange(lo * 4, n * 4);
    this.colAttr.needsUpdate = true;
  }
}

// Dynamic batching, same contract as the trail batches: spawn a sibling
// batch when every existing slot is taken (one extra draw call), retire
// an overflow batch the moment it empties — batch[0] is the floor. The
// old code silently rendered nothing once 128 trails were live.
const dotBatches = new Map<THREE.Scene, DotBatch[]>();

/** Take a slot from any non-full batch for the scene; grow on demand. */
function acquireDotSlot(scene: THREE.Scene): { batch: DotBatch; slot: number } {
  let list = dotBatches.get(scene);
  if (!list) { list = [new DotBatch(scene)]; dotBatches.set(scene, list); }
  for (const b of list) {
    const slot = b.free.pop();
    if (slot !== undefined) return { batch: b, slot };
  }
  const b = new DotBatch(scene);
  list.push(b);
  return { batch: b, slot: b.free.pop()! };
}

/** Return the slot; an emptied overflow batch retires (batch[0] stays). */
function releaseDotSlot(scene: THREE.Scene, batch: DotBatch, slot: number): void {
  batch.free.push(slot);
  const list = dotBatches.get(scene);
  if (!list || batch === list[0]) return;
  if (batch.free.length < BATCH_TRAILS) return;
  list.splice(list.indexOf(batch), 1);
  batch.dispose();
}

export class BallTrailDots {
  private dots: TrailDot[] = [];
  private timer = 0;
  private opacity: number;
  private sizeMul: number;
  private interval: number;
  private maxDots = TRAIL_COUNT;
  private readonly batch: DotBatch;
  private slot: number;
  private base: number; // vertex index of this trail's slot range

  constructor(private scene: THREE.Scene, opts?: { opacity?: number; sizeMul?: number; interval?: number; maxDots?: number }) {
    this.opacity = opts?.opacity ?? 1;
    this.sizeMul = opts?.sizeMul ?? 1;
    this.interval = opts?.interval ?? TRAIL_INTERVAL;
    const a = acquireDotSlot(scene);
    this.batch = a.batch;
    this.slot = a.slot;
    this.base = this.slot * SLOT_VERTS;
  }

  /** Emit a sparkle when the cadence fires — caller passes the ball's
   *  render pos, radius, and tint (enraged tint swaps handled upstream). */
  emit(dt: number, pos: THREE.Vector3, vel: THREE.Vector3, radius: number, tint: THREE.Color): void {
    this.timer += dt;
    if (this.timer < this.interval) return;
    this.timer = 0;
    if (vel.lengthSq() <= 0.5) return;
    this.spawn(pos, radius, tint);
  }

  /** Dust-burst at takeoff/land — count dots now, timer not involved. */
  burst(count: number, pos: THREE.Vector3, radius: number, tint: THREE.Color): void {
    for (let i = 0; i < count; i++) this.spawn(pos, radius, tint);
  }

  get size(): number { return this.dots.length; }

  private spawn(pos: THREE.Vector3, radius: number, tint: THREE.Color): void {
    if (this.slot < 0) return;
    const spawn = _spawn.copy(pos).addScaledVector(_scatter.set(
      Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1,
    ).normalize().multiplyScalar(Math.random() * radius * 0.6), 1);
    const d = takeDot();
    d.pos.copy(spawn);
    d.age = 0;
    d.wIdx = -1; // fresh position — force a pos write on next fade
    d.life = 0.35 + Math.random() * 0.85;
    d.haloSz = radius * (1.8 + Math.random() * 2.0) * this.sizeMul;
    d.coreSz = radius * (0.9 + Math.random() * 1.0) * this.sizeMul;
    d.tint.copy(tint);
    if (this.dots.length >= this.maxDots) freeDot(this.dots.shift()!);
    this.dots.push(d);
  }

  fade(dt: number): void {
    if (this.slot < 0) return;
    for (let i = this.dots.length - 1; i >= 0; i--) {
      const d = this.dots[i];
      d.age += dt;
      if (d.age >= d.life) {
        freeDot(d);
        this.dots.splice(i, 1);
      }
    }
    // Attribute rewrite at ~30Hz — dots live ~1s, so a frame of stale
    // alpha/size is invisible; aging/pruning above still runs full rate.
    this._half = !this._half;
    if (this._half && this.dots.length > 0) return;
    trailMat().uniforms.uHeight!.value = window.innerHeight || 800;
    let w = 0; // live-dot write cursor over the attribute pair
    for (const d of this.dots) {
      const t = 1.0 - d.age / d.life;
      const haloA = t * 0.28 * this.opacity;
      const coreA = t * 0.7 * this.opacity;
      const haloS = d.haloSz * (0.7 + 0.3 * t);
      const coreS = d.coreSz * (0.4 + 0.6 * t);
      const h = this.base + w * 2, c = h + 1;
      // Dot positions are static — only re-upload when the dot is new or
      // an earlier death slid it into a different vert index.
      if (d.wIdx !== w) {
        this.batch.posAttr.setXYZ(h, d.pos.x, d.pos.y, d.pos.z);
        this.batch.posAttr.setXYZ(c, d.pos.x, d.pos.y, d.pos.z);
        d.wIdx = w;
      }
      this.batch.sizeAttr.setX(h, haloS);
      this.batch.sizeAttr.setX(c, coreS);
      this.batch.colAttr.setXYZW(h, d.tint.r, d.tint.g, d.tint.b, haloA);
      _tmpC.copy(d.tint).lerp(_white, 0.65);
      this.batch.colAttr.setXYZW(c, _tmpC.r, _tmpC.g, _tmpC.b, coreA);
      w++;
    }
    // Zero freed tail slots only when the live count shrank — a stable
    // roster re-zeroes nothing (the tail was already zeroed last shrink).
    if (w < this._lastLive) {
      for (let s = this.base + w * 2; s < this.base + this.maxDots * 2; s++) this.batch.sizeAttr.setX(s, 0);
    }
    // Skip the buffer upload when nothing lives — an idle trail was still
    // pushing 3 attribute uploads per ball per frame (~100/frame total).
    if (w === 0 && this._lastLive === 0) return;
    this._lastLive = w;
    this.batch.mark(this.base, this.base + this.maxDots * 2);
    this.batch.flush();
  }
  private _lastLive = -1;
  private _half = false;

  dispose(): void {
    if (this.slot >= 0) {
      // bury the slot's points before handing it back
      for (let s = this.base; s < this.base + SLOT_VERTS; s++) this.batch.sizeAttr.setX(s, 0);
      this.batch.mark(this.base, this.base + SLOT_VERTS);
      this.batch.flush();
      releaseDotSlot(this.scene, this.batch, this.slot);
      this.slot = -1;
    }
    for (const d of this.dots) freeDot(d);
    this.dots = [];
  }
}
