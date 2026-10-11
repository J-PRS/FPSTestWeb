import * as THREE from 'three';

import {
  CLOUD_WIND_SPEED, CLOUD_DENSITY,
  CLOUD_MIN_HEIGHT, CLOUD_MAX_HEIGHT,FOG_COLOR
} from '../core/config.js';

import { UNGRADE_GLSL } from '../core/gradeGlsl.js';
import { puffVertex, puffFragment, makePuffTexture, buildPuffGeometry } from './cloudPuffs.js';
import { NOISE_WORLD_SCALE, noiseHash, _smooth } from './cloudNoise.js';

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
const _vnoise = (x: number, y: number, period: number): number => {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = _smooth(x - xi), yf = _smooth(y - yi);
  const w = (v: number) => ((v % period) + period) % period;
  const a = noiseHash(w(xi), w(yi)), b = noiseHash(w(xi + 1), w(yi));
  const c = noiseHash(w(xi), w(yi + 1)), d = noiseHash(w(xi + 1), w(yi + 1));
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
      if (r < rMin) {rMin = r;} if (r > rMax) {rMax = r;}
      if (g < gMin) {gMin = g;} if (g > gMax) {gMax = g;}
    }
  }
  const data = packNoiseTex(size, { rawR, rawG, rMin, rMax, gMin, gMax });
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapS = tex.wrapT;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  // `base` = normalized R channel on the CPU — the billboard billow layer
  // seeds its puffs where this field is dense so sprites land inside the
  // shader's deck blobs instead of free-floating in clear sky.
  const base = new Float32Array(size * size);
  const rSpan = rMax - rMin;
  for (let i = 0; i < size * size; i++) {base[i] = (rawR[i]! - rMin) / rSpan;}
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
        cloudColor: { value: params.cloudColor ?? new THREE.Color(0xFF_FF_FF) },
        fogColor: { value: new THREE.Color(FOG_COLOR) },
        sunDirection: { value: this.sunDirection },
        windScroll: { value: this.scroll },
        density: { value: (params.cloudDensity ?? CLOUD_DENSITY) * 2 },
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

  /** Both cloud meshes cost full-sky fragment work — the auto-quality
   *  ladder sheds them before touching pixel scale again. */
  setEnabled(on: boolean): void {
    this.mesh.visible = on;
    this.puffMesh.visible = on;
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
