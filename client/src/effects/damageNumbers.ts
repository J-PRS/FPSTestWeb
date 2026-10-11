import * as THREE from 'three';
import { markProbe } from '../core/fxDiag.js';

// Damage numbers — ONE batched billboard mesh for every number on screen.
// The old design was a CanvasTexture redraw + GPU upload + sprite draw call
// PER HIT; here digits come from a pre-baked glyph atlas and every number
// lives in a shared dynamic BufferGeometry — zero uploads, one draw call.
//
// Vertex layout per glyph quad: position (billboarded on CPU each frame),
// uv (fixed at spawn), color+alpha (RGBA — alpha carries the per-number fade).

// Warm the Rajdhani face early — the atlas bakes whatever's loaded at
// build time, so without this the first batch stamps in the fallback font.
document.fonts?.load('700 56px Rajdhani');

const GLYPHS = '0123456789-!';
const CELL_W = 52;   // px per glyph cell in the atlas
const ATLAS_H = 80;
const MAX_NUMBERS = 48;
const MAX_GLYPHS = 5;               // '-9999!' worst case
const MAX_QUADS = MAX_NUMBERS * MAX_GLYPHS;
const DURATION = 1;
const POP_SCALE = 0.1;
const BASE_SCALE = 2;

interface LiveNumber {
  pos: THREE.Vector3;             // drifting world position
  vel: THREE.Vector3;
  age: number;
  distScale: number;
  dmgScale: number;
  r: number; g: number; b: number;
  glyphCount: number;
  glyphUv: Float32Array;          // MAX_GLYPHS*4 — u0,v0,u1,v1 per glyph
  dead: boolean;
}

let _atlas: THREE.CanvasTexture | null = null;
const glyphUv = new Map<string, [number, number, number, number]>();

function buildAtlas(): THREE.CanvasTexture {
  if (_atlas) {return _atlas;}
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W * GLYPHS.length;
  canvas.height = ATLAS_H;
  const ctx = canvas.getContext('2d')!;
  // Rajdhani Bold — condensed squared sci-fi digits, the shooter FCT font.
  ctx.font = `700 56px "Rajdhani", "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 7;
  ctx.lineJoin = 'round';
  for (let i = 0; i < GLYPHS.length; i += 1) {
    const cx = i * CELL_W + CELL_W / 2;
    ctx.strokeText(GLYPHS[i]!, cx, ATLAS_H / 2);
    ctx.fillText(GLYPHS[i]!, cx, ATLAS_H / 2);
    // Inset the UV a half-px so neighbors don't bleed at minification.
    const u0 = (i * CELL_W + 1) / canvas.width, u1 = ((i + 1) * CELL_W - 1) / canvas.width;
    glyphUv.set(GLYPHS[i]!, [u0, 0.02, u1, 0.98]);
  }
  _atlas = new THREE.CanvasTexture(canvas);
  _atlas.generateMipmaps = true;
  _atlas.minFilter = THREE.LinearMipmapLinearFilter;
  return _atlas;
}

const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _c = new THREE.Color();

export class DamageNumberManager {
  private mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private geo: THREE.BufferGeometry;
  private posAttr: THREE.BufferAttribute;
  private uvAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private numbers: LiveNumber[] = [];
  private pool: LiveNumber[] = [];

  constructor(scene: THREE.Scene) {
    this.geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(MAX_QUADS * 4 * 3), 3);
    this.uvAttr = new THREE.BufferAttribute(new Float32Array(MAX_QUADS * 4 * 2), 2);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(MAX_QUADS * 4 * 4), 4);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.uvAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('uv', this.uvAttr);
    this.geo.setAttribute('aColor', this.colAttr);
    const idx = new Uint16Array(MAX_QUADS * 6);
    for (let i = 0; i < MAX_QUADS; i += 1) {
      const v = i * 4, k = i * 6;
      idx[k] = v; idx[k + 1] = v + 1; idx[k + 2] = v + 2;
      idx[k + 3] = v; idx[k + 4] = v + 2; idx[k + 5] = v + 3;
    }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setDrawRange(0, 0);

    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: buildAtlas() } },
      vertexShader: /* glsl */`
        attribute vec4 aColor;
        varying vec2 vUv;
        varying vec4 vCol;
        void main() {
          vUv = uv;
          vCol = aColor;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D map;
        varying vec2 vUv;
        varying vec4 vCol;
        void main() {
          vec4 t = texture2D(map, vUv);
          gl_FragColor = vec4(t.rgb * vCol.rgb, t.a * vCol.a);
          if (gl_FragColor.a < 0.01) discard;
        }`,
      transparent: true,
      depthTest: false,   // hit feedback must never be occluded
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false; // verts move every frame
    this.mesh.renderOrder = 950;
    scene.add(this.mesh);
    markProbe(this.mesh, { kind: 'fxMesh', label: 'damageNumbers' });
  }

  spawn(pos: THREE.Vector3, damage: number, color = '#ffffff', camera?: THREE.Camera): void {
    let distScale = 1;
    if (camera) {
      const dist = camera.position.distanceTo(pos);
      // sqrt distance scaling — constant-screen-size makes far numbers
      // comically huge; 1.0 at the ~15m reference range.
      distScale = Math.max(0.45, Math.min(3, Math.sqrt(dist / 15)));
    }
    const n = this.pool.pop() ?? {
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      age: 0, distScale: 1, dmgScale: 1, r: 1, g: 1, b: 1,
      glyphCount: 0, glyphUv: new Float32Array(MAX_GLYPHS * 4), dead: false,
    };
    // Every hit gets its own number — no merging; a summed pop can show
    // a value no shot deals.
    const text = Math.round(damage).toString().slice(0, MAX_GLYPHS);
    n.glyphCount = text.length;
    for (let i = 0; i < text.length; i += 1) {
      const uvr = glyphUv.get(text[i]!) ?? glyphUv.get('0')!;
      n.glyphUv.set(uvr, i * 4);
    }
    _c.set(color);
    n.r = _c.r; n.g = _c.g; n.b = _c.b;
    n.distScale = distScale;
    n.dmgScale = Math.min(1.6, 1 + Math.sqrt(Math.max(0, damage)) * 0.05);
    n.pos.set(pos.x + (Math.random() - 0.5) * 0.4, pos.y + 1, pos.z + (Math.random() - 0.5) * 0.4);
    n.vel.set((Math.random() - 0.5) * 1.6, 3.2 + Math.random() * 0.8, (Math.random() - 0.5) * 1.6);
    n.age = 0;
    n.dead = false;
    if (this.numbers.length < MAX_NUMBERS) {this.numbers.push(n);}
    else { this.numbers.shift(); this.numbers.push(n); } // oldest drops early under flood
  }

  update(dt: number, camera: THREE.Camera): void {
    // Camera basis for the CPU billboard — one quat read per frame.
    camera.matrixWorld.extractBasis(_right, _up, _fwd);
    let quad = 0;

    for (let i = this.numbers.length - 1; i >= 0; i -= 1) {
      const n = this.numbers[i]!;
      n.age += dt;
      if (n.age >= DURATION || n.dead) {
        this.pool.push(n);
        this.numbers.splice(i, 1);
        continue;
      }
      // Ballistic drift — up fast, gravity eases it to a hover
      n.vel.y -= 5.5 * dt;
      if (n.vel.y < 0) {n.vel.y *= 0.9;}
      n.pos.addScaledVector(n.vel, dt);
      quad = this.writeQuads(n, n.age / DURATION, quad);
    }
    // Only the written quad span needs uploading — idle frames skip
    // the buffer transfer entirely (was a full-array upload every frame).
    if (quad > 0) {
      this.posAttr.addUpdateRange(0, quad * 4 * 3);
      this.posAttr.needsUpdate = true;
      this.uvAttr.addUpdateRange(0, quad * 4 * 2);
      this.uvAttr.needsUpdate = true;
      this.colAttr.addUpdateRange(0, quad * 4 * 4);
      this.colAttr.needsUpdate = true;
    }
    this.geo.setDrawRange(0, quad * 6);
  }

  /** Stamp one number's glyph quads at the next free slot — returns the
   *  updated quad cursor. */
  private writeQuads(n: LiveNumber, t: number, quad: number): number {
    const posA = this.posAttr.array as Float32Array;
    const uvA = this.uvAttr.array as Float32Array;
    const colA = this.colAttr.array as Float32Array;
    // Pop: fast scale-in over the first 12.5%
    const popT = t < 0.125 ? t / 0.125 : 1;
    const s = BASE_SCALE * n.distScale * n.dmgScale * (POP_SCALE + (1 - POP_SCALE) * popT);
    const alpha = t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1;
    // Half-extents keep the atlas cell aspect (56px digit in an 80×52
    // cell) at sprite scale s.
    const hh = s * 0.3;
    const hw = hh * (CELL_W / ATLAS_H);
    const step = hw * 1.7;
    const x0 = -(n.glyphCount - 1) * step * 0.5;
    let q = quad;
    for (let gIdx = 0; gIdx < n.glyphCount && q < MAX_QUADS; ((gIdx += 1) - 1), ((q += 1) - 1)) {
      const ox = x0 + gIdx * step;
      const v = quad * 4;
      for (let k = 0; k < 4; k += 1) {
        const sx = k === 0 || k === 3 ? -1 : 1;
        const sy = k < 2 ? -1 : 1;
        const p = v * 3 + k * 3;
        posA[p] = n.pos.x + _right.x * (ox + sx * hw) + _up.x * sy * hh;
        posA[p + 1] = n.pos.y + _right.y * (ox + sx * hw) + _up.y * sy * hh;
        posA[p + 2] = n.pos.z + _right.z * (ox + sx * hw) + _up.z * sy * hh;
        const uvi = v * 2 + k * 2;
        const uv = n.glyphUv;
        uvA[uvi] = k === 0 || k === 3 ? uv[gIdx * 4] : uv[gIdx * 4 + 2];
        uvA[uvi + 1] = k < 2 ? uv[gIdx * 4 + 1] : uv[gIdx * 4 + 3];
        const ci = v * 4 + k * 4;
        colA[ci] = n.r; colA[ci + 1] = n.g; colA[ci + 2] = n.b; colA[ci + 3] = alpha;
      }
    }
    return quad;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
    this.numbers = [];
    this.pool = [];
  }
}
