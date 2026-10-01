/**
 * ballTrails — the sparkle layer behind a bouncing ball. Two-layer dot
 * (tinted halo + near-white core) scattered inside a small sphere around
 * the ball, random size and lifetime.
 *
 * Drawn as ONE THREE.Points per trail: ~40 balls × 28 sprites each used to
 * cost ~1000 unbatchable draw calls (the top renderer.info.calls entry in
 * every LOW-FPS dump). Points with a per-point size/color shader draws the
 * whole thing in one call; dead slots just get size 0.
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
}

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

export class BallTrailDots {
  private dots: TrailDot[] = [];
  private timer = 0;
  private opacity: number;
  private sizeMul: number;
  private interval: number;
  private maxDots: number;

  private readonly geo: THREE.BufferGeometry;
  private readonly points: THREE.Points;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;

  constructor(private scene: THREE.Scene, opts?: { opacity?: number; sizeMul?: number; interval?: number; maxDots?: number }) {
    this.opacity = opts?.opacity ?? 1;
    this.sizeMul = opts?.sizeMul ?? 1;
    this.interval = opts?.interval ?? TRAIL_INTERVAL;
    this.maxDots = opts?.maxDots ?? TRAIL_COUNT;
    const cap = this.maxDots * 2; // halo + core slot per dot
    this.geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(cap), 1);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(cap * 4), 4);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('aSize', this.sizeAttr);
    this.geo.setAttribute('aColor', this.colAttr);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.points = new THREE.Points(this.geo, trailMat());
    this.points.frustumCulled = false;
    scene.add(this.points);
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
    const spawn = _spawn.copy(pos).addScaledVector(_scatter.set(
      Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1,
    ).normalize().multiplyScalar(Math.random() * radius * 0.6), 1);
    const d: TrailDot = {
      pos: new THREE.Vector3().copy(spawn),
      age: 0,
      life: 0.35 + Math.random() * 0.85,
      haloSz: radius * (1.8 + Math.random() * 2.0) * this.sizeMul,
      coreSz: radius * (0.9 + Math.random() * 1.0) * this.sizeMul,
      tint: tint.clone(),
    };
    if (this.dots.length >= this.maxDots) this.dots.shift();
    this.dots.push(d);
  }

  fade(dt: number): void {
    trailMat().uniforms.uHeight!.value = window.innerHeight || 800;
    let w = 0; // live-dot write cursor over the attribute pair
    for (let i = this.dots.length - 1; i >= 0; i--) {
      const d = this.dots[i];
      d.age += dt;
      if (d.age >= d.life) {
        this.dots.splice(i, 1);
      }
    }
    for (const d of this.dots) {
      const t = 1.0 - d.age / d.life;
      const haloA = t * 0.28 * this.opacity;
      const coreA = t * 0.7 * this.opacity;
      const haloS = d.haloSz * (0.7 + 0.3 * t);
      const coreS = d.coreSz * (0.4 + 0.6 * t);
      const h = w * 2, c = w * 2 + 1;
      this.posAttr.setXYZ(h, d.pos.x, d.pos.y, d.pos.z);
      this.posAttr.setXYZ(c, d.pos.x, d.pos.y, d.pos.z);
      this.sizeAttr.setX(h, haloS);
      this.sizeAttr.setX(c, coreS);
      this.colAttr.setXYZW(h, d.tint.r, d.tint.g, d.tint.b, haloA);
      _tmpC.copy(d.tint).lerp(_white, 0.65);
      this.colAttr.setXYZW(c, _tmpC.r, _tmpC.g, _tmpC.b, coreA);
      w++;
    }
    // zero out the tail slots so stale points don't linger
    for (let s = w * 2; s < this.maxDots * 2; s++) this.sizeAttr.setX(s, 0);
    // Skip the buffer upload when nothing lives — an idle trail was still
    // pushing 3 attribute uploads per ball per frame (~100/frame total).
    if (w === 0 && this._lastLive === 0) return;
    this._lastLive = w;
    this.posAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }
  private _lastLive = -1;

  dispose(): void {
    this.scene.remove(this.points);
    this.geo.dispose();
    this.dots = [];
  }
}
