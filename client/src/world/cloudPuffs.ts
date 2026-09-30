import * as THREE from 'three';
import { UNGRADE_GLSL } from '../core/gradeGlsl.js';
import { noiseHash, _smooth, sampleBase, NOISE_WORLD_SCALE } from './volumetricClouds.js';

// Cauliflower billboard sprite: overlapping gaussian blobs clipped by a
// radial window, eroded by fbm so the edge is lumpy not circular. Alpha
// lives in .a — the quad shades itself in-shader.
const _vn = (x: number, y: number): number => {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = _smooth(x - xi), yf = _smooth(y - yi);
  const a = noiseHash(xi, yi), b = noiseHash(xi + 1, yi);
  const c = noiseHash(xi, yi + 1), d = noiseHash(xi + 1, yi + 1);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
};

export function makePuffTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = x / size - 0.5, ny = y / size - 0.5;
      let a = 0;
      for (let bIdx = 0; bIdx < 12; bIdx++) {
        const bx = (noiseHash(bIdx, 7) - 0.5) * 0.52;
        const by = (noiseHash(bIdx, 91) - 0.5) * 0.42;
        const br = 0.09 + noiseHash(bIdx, 33) * 0.17;
        const d2 = ((nx - bx) * (nx - bx) + (ny - by) * (ny - by)) / (br * br);
        a = Math.max(a, Math.exp(-d2 * 2.4));
      }
      const edge = _smooth(Math.min(Math.max((0.52 - Math.hypot(nx, ny)) * 6, 0), 1));
      const detail = 0.5 + 0.8 * _vn(x / size * 7 + 3.1, y / size * 7 + 9.7);
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
// Billboard billow layer. The six dome decks alone still read flat — planes
// can never throw a billowy silhouette. This module seeds camera-facing
// quads on the SAME noise field (inside deck blobs), so each cloud mass
// gets a lumpy 3D edge. Quads billboard in the vertex shader, wrap with
// the wind inside an 8km world cell, and shade sun-side-lit / belly-dark
// per pixel. Exported: the sprite texture, the geometry builder, and the
// two shaders — the host class assembles material/mesh/uniforms.
// ---------------------------------------------------------------------------

export const puffVertex = /* glsl */`
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

export const puffFragment = /* glsl */`
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

export function buildPuffGeometry(base: Float32Array, noiseSize: number, yMin: number, yMax: number): THREE.BufferGeometry {
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
      const h1 = noiseHash(gx | 0, gz | 0), h2 = noiseHash(gx | 0, (gz | 0) + 77);
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

