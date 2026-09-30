import * as THREE from 'three';

import {
  CLOUD_WIND_SPEED, CLOUD_DENSITY,
  CLOUD_MIN_HEIGHT, CLOUD_MAX_HEIGHT,
} from '../core/config.js';
import { FOG_COLOR } from '../core/config.js';
import { UNGRADE_GLSL } from '../core/gradeGlsl.js';

// ---------------------------------------------------------------------------
// Clouds = one dome, six stacked noise DECKS, zero raymarching.
//
// First pass marched a slab with XZ-only density — every height sampled the
// same shape, so each cloud column composited into a vertical curtain and
// the sky read as aurora. The cheap fix used by stylized-cloud shaders:
// intersect the view ray with N horizontal planes inside [yMin, yMax] and
// treat each as an independent 2D noise slice. Density varies per height →
// real billow silhouettes; the decorrelated offsets mean a column can NEVER
// smear; and 6 fetches/px beats a 30-tap march outright. Extras that sell it:
// per-layer coverage (dense mid-deck, lacy crown), wind shear (upper decks
// scroll faster), a sunward-shifted sample for self-shadowing, and a dark
// belly→lit-top gradient. Composite bottom→top (camera sits under the deck).
// ---------------------------------------------------------------------------

const LAYERS = 6;
// World meters covered by one noise-tex repeat — ~500m puff features.
const NOISE_WORLD_SCALE = 3200;
// Past this the decks collapse into a horizon haze line anyway.
const MAX_DIST = 5000;
// Deliberately larger than the 4000 sky sphere: the sky doesn't write
// depth, so the transparent dome composites over it at any radius, and
// the play space stays inside the dome even at the map's far edge.
const DOME_RADIUS = 5000;

const vertexShader = /* glsl */`
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */`
  varying vec3 vWorldPos;

  uniform sampler2D noiseTex;   // R = base fbm, G = detail fbm
  uniform vec3 sunDirection;
  uniform vec3 cloudColor;
  uniform vec3 fogColor;
  uniform vec2 windScroll;      // accumulated uv scroll (world-meters / NOISE_WORLD_SCALE)
  uniform float density;        // master absorption
  uniform float coverage;       // fbm threshold — higher = more sky covered
  uniform float yMin;
  uniform float yMax;

  const float NOISE_SCALE = ${NOISE_WORLD_SCALE.toFixed(1)};
  const int LAYERS = ${LAYERS};

  float fbm(vec2 uv) {
    vec4 n = texture2D(noiseTex, uv);
    return n.r * 0.65 + n.g * 0.35;
  }

  float hash12(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  ${UNGRADE_GLSL}

  void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorldPos - ro);
    if (abs(rd.y) < 0.015) discard; // horizon sliver — decks are parallel lines there

    vec3 sunDir = normalize(sunDirection);
    float sunDot = max(dot(rd, sunDir), 0.0);
    float silver = pow(sunDot, 6.0); // forward-scatter rim toward the sun

    vec3 col = vec3(0.0);
    float alpha = 0.0;
    float nearT = 0.0;

    // Weather map — a big low-freq patch field sampled once per pixel at
    // mid-deck. It does TWO anti-artificial jobs: coverage varies in
    // ~1km patches (clear / broken / overcast regions instead of uniform
    // scatter) AND it drives per-layer height wander below, so crowns
    // billow ± hundreds of meters instead of capping at one flat yMax
    // ceiling — the "roof" artifact was all six decks sharing one top.
    float hMid = (yMin + yMax) * 0.5;
    float tMid = (hMid - ro.y) / rd.y;
    float wm = 0.5;
    if (tMid > 0.0 && tMid < ${MAX_DIST.toFixed(1)}) {
      wm = fbm((ro + rd * tMid).xz / (NOISE_SCALE * 3.1) + windScroll * 0.8);
    }
    // Bias upward — wm runs the gauntlet of fbm's ~0.5 mean, so a flat
    // linear map would halve effective coverage everywhere.
    float covLocal = coverage * (0.75 + 0.9 * wm);
    // Crown wander: signed wobble, strongest in dense weather patches.
    float topWobble = (wm - 0.5) * (yMax - yMin) * 0.9;

    // Bottom→top = front-to-back for a camera under the deck. Each layer
    // gets its own uv offset so a vertical column CANNOT line up — the
    // anti-aurora guarantee.
    for (int i = 0; i < LAYERS; i++) {
      float fi = float(i) / float(LAYERS - 1); // 0 = base, 1 = crown
      // Upper decks ride the weather wobble — bases stay glued.
      float h = yMin + (yMax - yMin) * fi + topWobble * max(fi - 0.3, 0.0);
      float t = (h - ro.y) / rd.y;
      if (t <= 0.0 || t > ${MAX_DIST.toFixed(1)}) continue;
      if (nearT == 0.0) nearT = t;

      // Wind shear: upper decks drift faster. Decorrelate per layer —
      // offset AND scale, else grazing views streak every deck along the
      // same stretched texel footprint into one comb pattern.
      vec2 uv = (ro + rd * t).xz / (NOISE_SCALE * (1.0 - fi * 0.3))
              + windScroll * (1.0 + fi * 0.4)
              + fi * vec2(0.37, 0.19);
      float f = fbm(uv);

      // Lens profile: dense mid-deck, sparse base and crown.
      float cov = covLocal * (1.0 - abs(fi - 0.45) * 0.6);
      float d = max(0.0, f - (1.0 - cov)) / max(cov, 0.001);
      d = d * d * (3.0 - 2.0 * d);
      // Crown erosion — the detail octave eats the tops, not the bases.
      float ero = texture2D(noiseTex, uv * 3.7 - windScroll * 0.6).g;
      d = clamp(d - ero * 0.55 * fi * fi, 0.0, 1.0);
      if (d <= 0.0) continue;

      // Self-shadow approx: resample the same field sunward-shifted.
      // Cheap 2D Beer — shadowed cores read warm-grey, rims stay lit.
      float shade = fbm(uv + sunDir.xz * (0.04 + fi * 0.04));
      float beer = exp(-shade * density * 3.5);

      float a = clamp(d * density * 1.6, 0.0, 0.95);
      vec3 amb = mix(cloudColor * 0.42, fogColor, 0.35);
      vec3 lit = cloudColor * (1.0 + silver * 0.9);
      vec3 sc = mix(amb, lit, beer) * mix(0.6, 1.05, fi); // dark belly → lit crown
      col += (1.0 - alpha) * a * sc;
      alpha += (1.0 - alpha) * a;
      if (alpha > 0.97) break;
    }
    if (alpha <= 0.001) discard;

    // Distance fade into horizon haze — far clouds ARE fog.
    float fade = 1.0 - smoothstep(2500.0, ${MAX_DIST.toFixed(1)}, nearT);
    alpha *= fade;
    col = mix(fogColor, col, fade);
    gl_FragColor = vec4(ungradeColor(col), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// Tileable value-noise FBM baked once into a DataTexture. Wrapping the
// lattice by each octave's period keeps the tile seamless — the shader can
// scroll UV forever without a seam sweeping through the sky.
const _noiseHash = (x: number, y: number): number => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >> 13)) * 1274126177 | 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
};
const _smooth = (t: number) => t * t * (3 - 2 * t);

const _vnoise = (x: number, y: number, period: number): number => {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = _smooth(x - xi), yf = _smooth(y - yi);
  const w = (v: number) => ((v % period) + period) % period;
  const a = _noiseHash(w(xi), w(yi)), b = _noiseHash(w(xi + 1), w(yi));
  const c = _noiseHash(w(xi), w(yi + 1)), d = _noiseHash(w(xi + 1), w(yi + 1));
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
};
const _fbm = (u: number, v: number, basePeriod: number, octaves: number): number => {
  let sum = 0, amp = 0.5, per = basePeriod, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += _vnoise(u * per, v * per, per) * amp;
    norm += amp;
    amp *= 0.5;
    per *= 2;
  }
  return sum / norm;
};

function makeNoiseTexture(size = 256): { tex: THREE.DataTexture; base: Float32Array } {
  // Two passes: bake raw fbm, then histogram-stretch to the full 0-255.
  // Value-noise fbm bunches hard around its mean (~0.23 here, max ~0.44)
  // — unmapped, a 0.5 coverage threshold clips EVERYTHING and the sky
  // renders empty. Normalized, coverage is a real coverage fraction.
  const rawR = new Float32Array(size * size);
  const rawG = new Float32Array(size * size);
  let rMin = 9, rMax = -9, gMin = 9, gMax = -9;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const i = y * size + x;
      const r = _fbm(u, v, 6, 4), g = _fbm(u, v, 18, 4);
      rawR[i] = r; rawG[i] = g;
      if (r < rMin) rMin = r; if (r > rMax) rMax = r;
      if (g < gMin) gMin = g; if (g > gMax) gMax = g;
    }
  }
  const data = packNoiseTex(size, { rawR, rawG, rMin, rMax, gMin, gMax });
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  // `base` = normalized R channel on the CPU — the billboard billow layer
  // seeds its puffs where this field is dense so sprites land inside the
  // shader's deck blobs instead of free-floating in clear sky.
  const base = new Float32Array(size * size);
  const rSpan = rMax - rMin;
  for (let i = 0; i < size * size; i++) base[i] = (rawR[i]! - rMin) / rSpan;
  return { tex, base };
}

// Histogram-stretch both baked channels into RGBA8 (B unused, A opaque).
function packNoiseTex(size: number, ch: {
    rawR: Float32Array; rawG: Float32Array;
    rMin: number; rMax: number; gMin: number; gMax: number;
  }): Uint8Array {
  const { rawR, rawG } = ch;
  const data = new Uint8Array(size * size * 4);
  const rSpan = ch.rMax - ch.rMin, gSpan = ch.gMax - ch.gMin;
  for (let i = 0; i < size * size; i++) {
    const j = i * 4;
    data[j] = Math.round((rawR[i]! - ch.rMin) / rSpan * 255);
    data[j + 1] = Math.round((rawG[i]! - ch.gMin) / gSpan * 255);
    data[j + 2] = 0;
    data[j + 3] = 255;
  }
  return data;
}

// Sample the normalized CPU field with repeat-wrapping, bilinear.
function sampleBase(base: Float32Array, size: number, u: number, v: number): number {
  const x = ((u % 1) + 1) % 1 * size, y = ((v % 1) + 1) % 1 * size;
  const xi = Math.floor(x) % size, yi = Math.floor(y) % size;
  const xf = x - Math.floor(x), yf = y - Math.floor(y);
  const a = base[yi * size + xi]!, b = base[yi * size + (xi + 1) % size]!;
  const c = base[((yi + 1) % size) * size + xi]!, d = base[((yi + 1) % size) * size + (xi + 1) % size]!;
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}

// Cauliflower billboard sprite: overlapping gaussian blobs clipped by a
// radial window, eroded by fbm so the edge is lumpy not circular. Alpha
// lives in .a — the quad shades itself in-shader.
function makePuffTexture(size = 256): THREE.DataTexture {
  const vn = (x: number, y: number): number => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = _smooth(x - xi), yf = _smooth(y - yi);
    const a = _noiseHash(xi, yi), b = _noiseHash(xi + 1, yi);
    const c = _noiseHash(xi, yi + 1), d = _noiseHash(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = x / size - 0.5, ny = y / size - 0.5;
      let a = 0;
      for (let bIdx = 0; bIdx < 12; bIdx++) {
        const bx = (_noiseHash(bIdx, 7) - 0.5) * 0.52;
        const by = (_noiseHash(bIdx, 91) - 0.5) * 0.42;
        const br = 0.09 + _noiseHash(bIdx, 33) * 0.17;
        const d2 = ((nx - bx) * (nx - bx) + (ny - by) * (ny - by)) / (br * br);
        a = Math.max(a, Math.exp(-d2 * 2.4));
      }
      const edge = _smooth(Math.min(Math.max((0.52 - Math.hypot(nx, ny)) * 6, 0), 1));
      const detail = 0.5 + 0.8 * vn(x / size * 7 + 3.1, y / size * 7 + 9.7);
      const alpha = Math.round(Math.min(Math.max(a * edge * detail, 0), 1) * 255);
      const j = (y * size + x) * 4;
      data[j] = data[j + 1] = data[j + 2] = 255;
      data[j + 3] = alpha;
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Billboard billow layer. The six decks alone still read flat — planes can
// never throw a billowy silhouette. This layer seeds camera-facing quads on
// the SAME noise field (inside deck blobs), so each cloud mass gets a lumpy
// 3D edge. Quads billboard in the vertex shader, wrap with the wind inside
// an 8km world cell, and shade sun-side-lit / belly-dark per pixel.
// ---------------------------------------------------------------------------

const puffVertex = /* glsl */`
  attribute vec3 center;
  attribute float radius;
  attribute float seed;
  uniform vec2 windOffset;      // world meters
  uniform vec3 sunDirection;
  varying vec2 vUv;
  varying vec2 vSun;
  varying float vFade;
  varying float vSeed;
  void main() {
    vec3 c = center;
    // Wind wraps inside an 8km cell — puffs drift through like weather
    // instead of sailing off the map. Per-puff phase staggers the loop.
    c.xz = mod(c.xz + windOffset * (0.85 + seed * 0.3) + 4000.0, 8000.0) - 4000.0;
    vec4 mv = viewMatrix * vec4(c, 1.0);
    mv.xy += position.xy * radius;
    float dist = length(mv.xyz);
    // Near fade stops a giant sprite jumping the camera; far fade melts
    // into the deck haze. Squash vertical fade too — horizon quads are
    // already covered by the decks.
    vFade = smoothstep(220.0, 650.0, dist)
          * (1.0 - smoothstep(3200.0, 4600.0, dist));
    vSun = normalize((viewMatrix * vec4(sunDirection, 0.0)).xy + vec2(1e-5, 0.0));
    vUv = uv;
    vSeed = seed;
    gl_Position = projectionMatrix * mv;
  }
`;

const puffFragment = /* glsl */`
  uniform sampler2D puffTex;
  uniform vec3 cloudColor;
  uniform vec3 fogColor;
  varying vec2 vUv;
  varying vec2 vSun;
  varying float vFade;
  varying float vSeed;
  ${UNGRADE_GLSL}
  void main() {
    float a = texture2D(puffTex, vUv).a;
    if (a <= 0.004 || vFade <= 0.002) discard;
    vec2 d = (vUv - 0.5) * 2.0;
    // Two light cues: sun-side gradient across the billboard face, and a
    // darker bottom belly. Blend both — tops read lit even with a low sun.
    float sunA = 0.5 + 0.5 * dot(normalize(d + vec2(1e-4)), vSun);
    float l = clamp(sunA * 0.55 + vUv.y * 0.55 + 0.08, 0.0, 1.0);
    vec3 belly = mix(cloudColor * 0.42, fogColor, 0.35);
    vec3 col = mix(belly, cloudColor * 1.06, l);
    col = mix(fogColor, col, vFade);
    gl_FragColor = vec4(ungradeColor(col), a * vFade * 0.9);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// Puffs spawn where the base field is dense — a grid walk keeps them
// spread out instead of clustering into one mega-blob. Each dense cell
// gets a main puff plus, sometimes, a smaller satellite. Positions are
// pre-wind; the shader wraps them inside the 8km drift cell.
const PUFF_CELL = 520;
const PUFF_RADIUS = 3400;
const MAX_PUFFS = 96;

function buildPuffGeometry(base: Float32Array, noiseSize: number, yMin: number, yMax: number): THREE.BufferGeometry {
  const centers: number[] = [], radii: number[] = [], seeds: number[] = [];
  const push = (x: number, y: number, z: number, r: number, s: number) => {
    centers.push(x, y, z);
    radii.push(r);
    seeds.push(s);
  };
  for (let gz = -PUFF_RADIUS; gz <= PUFF_RADIUS && seeds.length < MAX_PUFFS; gz += PUFF_CELL) {
    for (let gx = -PUFF_RADIUS; gx <= PUFF_RADIUS && seeds.length < MAX_PUFFS; gx += PUFF_CELL) {
      // Same field the shader samples at windScroll=0 — uv = xz / scale.
      const f = sampleBase(base, noiseSize, gx / NOISE_WORLD_SCALE, gz / NOISE_WORLD_SCALE);
      if (f < 0.48) continue;
      const h1 = _noiseHash(gx | 0, gz | 0), h2 = _noiseHash(gx | 0, (gz | 0) + 77);
      const x = gx + (h1 - 0.5) * PUFF_CELL * 0.8;
      const z = gz + (h2 - 0.5) * PUFF_CELL * 0.8;
      const y = yMin + (0.25 + h1 * 0.5) * (yMax - yMin);
      push(x, y, z, 150 + h2 * 240, h1);
      if (h2 > 0.45) {
        // Satellite puff — the lump next to the main mass that makes the
        // silhouette read cauliflower instead of single blob.
        push(x + (h1 - 0.5) * 320, y + (h2 - 0.5) * 160, z + (h2 - 0.5) * 320,
             90 + h1 * 150, h2);
      }
    }
  }
  const n = seeds.length;
  const pos = new Float32Array(n * 4 * 3);
  const ctr = new Float32Array(n * 4 * 3);
  const rad = new Float32Array(n * 4);
  const sed = new Float32Array(n * 4);
  const uv = new Float32Array(n * 4 * 2);
  const idx = new Uint16Array(n * 6);
  const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  for (let i = 0; i < n; i++) {
    for (let v = 0; v < 4; v++) {
      const vi = i * 4 + v;
      pos[vi * 3] = corners[v]![0]!;
      pos[vi * 3 + 1] = corners[v]![1]!;
      pos[vi * 3 + 2] = 0;
      ctr[vi * 3] = centers[i * 3]!;
      ctr[vi * 3 + 1] = centers[i * 3 + 1]!;
      ctr[vi * 3 + 2] = centers[i * 3 + 2]!;
      rad[vi] = radii[i]!;
      sed[vi] = seeds[i]!;
      uv[vi * 2] = corners[v]![0]! + 0.5;
      uv[vi * 2 + 1] = corners[v]![1]! + 0.5;
    }
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('center', new THREE.BufferAttribute(ctr, 3));
  g.setAttribute('radius', new THREE.BufferAttribute(rad, 1));
  g.setAttribute('seed', new THREE.BufferAttribute(sed, 1));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

export interface CloudParams {
  count?: number;          // legacy — sphere-era param, unused by the dome
  cloudColor?: THREE.Color;
  cloudDensity?: number;
  windSpeed?: number;
  windDirection?: THREE.Vector3;
  minHeight?: number;
  maxHeight?: number;
  spreadRadius?: number;   // legacy — unused, the slab is unbounded
}

export class VolumetricClouds {
  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private noiseTex: THREE.DataTexture;
  private puffMesh: THREE.Mesh;
  private puffMat: THREE.ShaderMaterial;
  private puffTex: THREE.DataTexture;
  private windDirection: THREE.Vector3;
  private windSpeed: number;
  private sunDirection: THREE.Vector3;
  private scroll = new THREE.Vector2();
  private windOffset = new THREE.Vector2(); // world-meter drift for puffs

  constructor(scene: THREE.Scene, params: CloudParams = {}) {
    this.windDirection = (params.windDirection ?? new THREE.Vector3(1, 0, 0.1)).clone();
    this.windSpeed = params.windSpeed ?? CLOUD_WIND_SPEED;
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    const { tex: noiseTex, base } = makeNoiseTexture();
    this.noiseTex = noiseTex;

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        noiseTex: { value: this.noiseTex },
        cloudColor: { value: params.cloudColor ?? new THREE.Color(0xffffff) },
        fogColor: { value: new THREE.Color(FOG_COLOR) },
        sunDirection: { value: this.sunDirection },
        windScroll: { value: this.scroll },
        density: { value: (params.cloudDensity ?? CLOUD_DENSITY) * 2.0 },
        coverage: { value: 0.55 },
        yMin: { value: params.minHeight ?? CLOUD_MIN_HEIGHT },
        yMax: { value: params.maxHeight ?? CLOUD_MAX_HEIGHT },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 48, 24), this.material);
    this.mesh.frustumCulled = false; // dome surrounds the camera — culling it per-tri is a lie
    this.mesh.renderOrder = 1;       // after the opaque sky sphere
    scene.add(this.mesh);

    this.puffTex = makePuffTexture();
    const yMin = params.minHeight ?? CLOUD_MIN_HEIGHT;
    const yMax = params.maxHeight ?? CLOUD_MAX_HEIGHT;
    this.puffMat = new THREE.ShaderMaterial({
      vertexShader: puffVertex,
      fragmentShader: puffFragment,
      uniforms: {
        puffTex: { value: this.puffTex },
        cloudColor: { value: this.material.uniforms.cloudColor.value as THREE.Color },
        fogColor: { value: new THREE.Color(FOG_COLOR) },
        sunDirection: { value: this.sunDirection },
        windOffset: { value: this.windOffset },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.puffMesh = new THREE.Mesh(buildPuffGeometry(base, 256, yMin, yMax), this.puffMat);
    this.puffMesh.frustumCulled = false; // positions wrap in-shader — bounds are fiction
    this.puffMesh.renderOrder = 2;       // after the deck dome
    scene.add(this.puffMesh);
  }

  setSunDirection(direction: THREE.Vector3): void {
    this.sunDirection.copy(direction);
  }

  setCloudColor(color: THREE.Color): void {
    (this.material.uniforms.cloudColor.value as THREE.Color).copy(color);
  }

  update(dt: number): void {
    // Wind = UV scroll. Sample positions are world XZ, so moving the map
    // moves the weather instead of dragging a fleet of spheres around.
    this.scroll.x += this.windDirection.x * this.windSpeed * dt / NOISE_WORLD_SCALE;
    this.scroll.y += this.windDirection.z * this.windSpeed * dt / NOISE_WORLD_SCALE;
    this.windOffset.x += this.windDirection.x * this.windSpeed * dt;
    this.windOffset.y += this.windDirection.z * this.windSpeed * dt;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.puffMesh.geometry.dispose();
    this.noiseTex.dispose();
    this.puffTex.dispose();
    this.material.dispose();
    this.puffMat.dispose();
  }
}
