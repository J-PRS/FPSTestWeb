// Gameplay-water surface — one translucent, wave-animated plane at the
// map's sea level. The lit seafloor (coast terrain preset) shows through it,
// so shallow/deep reads come from the terrain below while this layer adds
// ripple normals, a grazing-angle haze mirror, and a sun glint. Fog is
// blended with three's own chunks so the water dissolves into the horizon
// seams identically to the terrain. Absent `water` removes the plane.
//
// A map with no `water` block never builds this, so every dry map renders
// exactly as before.

import * as THREE from 'three';
import type { WaterSpec } from '../../../shared/mapSpec.js';
import { getWorldScale, getHeightmapData, getHeightScale } from './heightmap.js';
import { TERRAIN_HEIGHT_SCALE } from '../core/config.js';
import { noiseHash, _smooth } from './cloudNoise.js';

// --- Tileable value noise (same wrap-the-lattice trick the clouds use) ---
function vnoise(x: number, y: number, period: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = _smooth(x - xi), yf = _smooth(y - yi);
  const w = (v: number): number => ((v % period) + period) % period;
  const a = noiseHash(w(xi), w(yi)), b = noiseHash(w(xi + 1), w(yi));
  const c = noiseHash(w(xi), w(yi + 1)), d = noiseHash(w(xi + 1), w(yi + 1));
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
let noiseTex: THREE.DataTexture | null = null;
/** R = coarse chop octave, G = fine — both tile at the texture edge so
 *  any uv scale the shader scrolls wraps seamlessly. */
function getNoiseTex(): THREE.DataTexture {
  if (noiseTex) {return noiseTex;}
  const S = 256;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const i = (y * S + x) * 4;
      data[i] = Math.round(255 * vnoise(x / 32, y / 32, 8));
      data[i + 1] = Math.round(255 * vnoise(x / 16, y / 16, 16));
      data[i + 2] = 0; data[i + 3] = 255;
    }
  }
  noiseTex = new THREE.DataTexture(data, S, S);
  noiseTex.wrapS = THREE.RepeatWrapping;
  noiseTex.wrapT = THREE.RepeatWrapping;
  noiseTex.magFilter = THREE.LinearFilter;
  noiseTex.minFilter = THREE.LinearFilter;
  noiseTex.needsUpdate = true;
  return noiseTex;
}

// --- Water depth straight from the resident heightmap — the SAME bytes
// the terrain vertex shader displaces by, sampled per-pixel so the
// shoreline follows the real coast instead of a coarse bake's texel
// staircase. Bound lazily: the heightmap lands after the water plane on
// first load, and a map swap replaces the bytes (pointer compare). ---
let hmTex: THREE.DataTexture | null = null;
let hmBound: Uint8ClampedArray | null = null;

function bindHeightmap(): void {
  if (!material) {return;}
  const hm = getHeightmapData();
  if (!hm || hm.data === hmBound) {return;}
  hmTex?.dispose();
  hmTex = new THREE.DataTexture(hm.data, hm.size, hm.size, THREE.RGBAFormat, THREE.UnsignedByteType);
  hmTex.wrapS = THREE.RepeatWrapping;
  hmTex.wrapT = THREE.RepeatWrapping;
  hmTex.magFilter = THREE.LinearFilter;
  hmTex.minFilter = THREE.LinearFilter;
  hmTex.needsUpdate = true;
  material.uniforms.uHm.value = hmTex;
  material.uniforms.uHmScale.value = getWorldScale();
  material.uniforms.uHScale.value = TERRAIN_HEIGHT_SCALE * getHeightScale();
  material.uniforms.uHasHm.value = 1;
  hmBound = hm.data;
}

/** Authored defaults — used when the spec gives only a level. */
const DEFAULT_SHALLOW: [number, number, number] = [0.1, 0.34, 0.4];
const DEFAULT_DEEP: [number, number, number] = [0.02, 0.1, 0.2];

const VERT = /* glsl */`
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
uniform float uTime;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform sampler2D uNoise;  // tileable value noise: R coarse, G fine
uniform sampler2D uHm;     // terrain heightmap — same texture the ground displaces by
uniform float uHmScale;    // heightmap world span (m)
uniform float uHScale;     // heightmap value → world height
uniform float uLevel;      // sea level (m)
uniform float uHasHm;
varying vec3 vWorld;
#include <fog_pars_fragment>

// Broad swell — the only directional content left. Everything finer comes
// from the noise texture: sine chop stripes visibly, noise just sparkles.
vec2 ripple(vec2 p, float t) {
  vec2 g = vec2(0.0);
  vec2 d1 = normalize(vec2(0.85, 0.53));
  g += d1 * (0.05 * 0.16 * cos(dot(p, d1) * 0.16 + t * 1.1));
  vec2 d2 = normalize(vec2(-0.42, 0.91));
  g += d2 * (0.035 * 0.27 * cos(dot(p, d2) * 0.27 + t * 1.6));
  vec2 d3 = normalize(vec2(0.31, -0.95));
  g += d3 * (0.02 * 0.55 * cos(dot(p, d3) * 0.55 + t * 2.3));
  return g;
}

float nR(vec2 uv) { return texture2D(uNoise, uv).r; }
float nG(vec2 uv) { return texture2D(uNoise, uv).g; }
// Finite-difference gradient of one noise channel — the micro normal
// jitter that breaks a flat specular sheet into glitter.
vec2 chopGrad(vec2 uv, float e, float amp, float sel) {
  float a = mix(nR(uv), nG(uv), sel);
  return vec2(mix(nR(uv + vec2(e, 0.0)), nG(uv + vec2(e, 0.0)), sel) - a,
              mix(nR(uv + vec2(0.0, e)), nG(uv + vec2(0.0, e)), sel) - a) * amp;
}

void main() {
  vec2 g = ripple(vWorld.xz, uTime);
  vec3 view = normalize(cameraPosition - vWorld);
  float dist = length(cameraPosition - vWorld);
  // Two noise octaves drifted on different vectors at different scales —
  // incommensurate so the tile period never surfaces. Fades with distance
  // (~250m) where it's sub-pixel shimmer anyway.
  vec2 chop =
      chopGrad(vWorld.xz * 0.045 + vec2(uTime * 0.013, uTime * 0.007), 0.004, 9.0, 0.0)
    + chopGrad(vWorld.xz * 0.11 + vec2(-uTime * 0.019, uTime * 0.011), 0.008, 6.0, 1.0);
  g += chop * exp(-dist * 0.004);
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  float ndv = clamp(dot(n, view), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 4.0);
  // Per-pixel water depth — identical sample to the terrain's vertex
  // displacement, so the waterline lands exactly on the drawn coast.
  float depth = uHasHm > 0.5
    ? max(0.0, uLevel - texture2D(uHm, fract(vWorld.xz / uHmScale)).r * uHScale)
    : 99.0;
  // Real depth drives shallow→deep where the heightmap exists; fall back
  // to the old view-angle tint until it lands (map load frame).
  vec3 col = uHasHm > 0.5
    ? mix(uDeep, uShallow, exp(-depth * 0.35))
    : mix(uDeep, uShallow, ndv * 0.6 + 0.25);
  // Shoreline foam — two layers, both fed by the baked depth:
  //  1) a crisp line right at the waterline (the drawn shore edge)
  //  2) broken clusters in the ~2m band behind it — two noise channels
  //     thresholded into clumps, marched shoreward by a wave phase so it
  //     reads as swash, not a static haze stripe.
  float nCl = nG(vWorld.xz * 0.07 + vec2(uTime * 0.006, -uTime * 0.004));
  float nCl2 = nR(vWorld.xz * 0.17 - vec2(uTime * 0.011, uTime * 0.008));
  float line = smoothstep(0.3, 0.02, depth) * uHasHm
    * (0.75 + 0.25 * nCl2); // slight breakup so the edge isn't vector-clean
  float wave = 0.6 + 0.4 * sin(uTime * 1.4 - depth * 5.0);
  float clump = smoothstep(0.55, 0.85, nCl * 0.65 + nCl2 * 0.45) * wave;
  float band = smoothstep(3.0, 0.4, depth) * uHasHm;
  float foam = max(line, band * clump);
  col += vec3(0.92, 0.96, 1.0) * foam * 0.7;
  // Open-water flecks — sparse high-threshold noise riding the chop so
  // the far field isn't a uniform sheet. Deliberately faint.
  float cap = smoothstep(0.86, 1.05, nG(vWorld.xz * 0.05 + vec2(uTime * 0.008, -uTime * 0.005))
    + nR(vWorld.xz * 0.13 - vec2(uTime * 0.012, uTime * 0.009)) * 0.35);
  col += vec3(0.9, 0.95, 1.0) * cap * 0.10;
  // Grazing fake-sky: reflect the view off the plane and grade it
  // horizon→sun. Reads as a mirror at eye level instead of flat haze.
  vec3 rdir = reflect(-view, vec3(0.0, 1.0, 0.0));
  float sunAmt = pow(max(dot(rdir, normalize(uSunDir)), 0.0), 4.0);
  vec3 sky = mix(fogColor, uSunColor * 1.15, sunAmt);
  col = mix(col, sky, fres * 0.75);
  vec3 h = normalize(view + normalize(uSunDir));
  // Tighter lobe + chop-jittered normals = glitter, not a plastic streak.
  float spec = pow(max(dot(n, h), 0.0), 320.0);
  col += uSunColor * spec * 1.1;
  float alpha = mix(0.5, 0.88, fres);
  alpha *= mix(1.0, smoothstep(0.0, 0.45, depth), uHasHm); // waterline thins out
  alpha = max(alpha, max(foam * 0.9, cap * 0.15 * exp(-dist * 0.002)));
  if (!gl_FrontFacing) {
    // Seen from below — murk not mirror, plus the Snell window: the
    // bright disc overhead where the surface still passes sky. Total
    // internal reflection kills the rest, so it reads as a lit porthole.
    col = mix(uDeep * 0.55, col, 0.3);
    float up = smoothstep(0.6, 0.84, view.y);
    col += (uSunColor * 1.3 + fogColor * 0.5) * up * up;
    alpha = max(alpha, 0.8);
  }
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

let mesh: THREE.Mesh | null = null;
let material: THREE.ShaderMaterial | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let builtSize = 0;
let level: number | undefined;

/** The map's sea level in world meters — undefined on a dry map. FX
 *  (water splashes) read this without needing the spec plumbed down. */
export function getWaterLevel(): number | undefined { return level; }

// --- Underwater camera grade — a DOM overlay, not renderer fog: the
// terrain shader owns its fog uniforms so a scene.fog swap can't reach
// it. Depth drives opacity: a splash entry flashes teal, a dive goes to
// murk. Hysteresis keeps bobbing at the waterline from strobing it.
let uwEl: HTMLDivElement | null = null;
let uwOn = false;
let uwShown = false;

export function tickUnderwaterGrade(camY: number): void {
  const depth = level === undefined ? -1 : level - camY;
  uwOn = depth > (uwOn ? -0.1 : 0.02);
  const target = uwOn ? Math.min(0.85, 0.45 + depth * 0.05) : 0;
  if (!uwOn && !uwShown) {return;} // dry world + dormant overlay — no DOM churn
  if (!uwEl) {
    uwEl = document.createElement('div');
    uwEl.id = 'water-grade';
    uwEl.innerHTML = '<div class="uw-top"></div><div class="uw-motes"></div>';
    document.body.append(uwEl);
  }
  uwEl.style.opacity = target.toFixed(3);
  if (uwShown !== uwOn) {document.body.classList.toggle('underwater', uwOn);}
  uwShown = uwOn;
}

// Impact rings — a splash isn't real until the surface itself answers.
// One shared geometry, small live pool, ticked from the water mesh's
// onBeforeRender so there's no per-frame plumbing. Ring = expanding
// foam circle that decays in ~1s; scale grows into maxRadius.
const RING_POOL = 12;
const RING_LIFE = 1.1;
const RING_GEO = new THREE.RingGeometry(0.75, 1, 40);
const ringPool: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; t: number; maxR: number }[] = [];
let ringClock = -1;

/** Expanding foam ripple at (x, level, z) — the blast/splash's answer on
 *  the surface itself. No-op while dry. */
export function addWaterRipple(x: number, z: number, maxRadius: number): void {
  if (level === undefined || !mesh) {return;}
  let r = ringPool.find((p): boolean => p.t >= RING_LIFE);
  if (!r && ringPool.length < RING_POOL) {
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
      color: new THREE.Color(0.9, 0.96, 1), side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(RING_GEO, mat);
    m.rotation.x = -Math.PI / 2;
    r = { mesh: m, mat, t: RING_LIFE, maxR: 0 };
    ringPool.push(r);
  }
  if (!r) {return;} // pool saturated — oldest keeps running
  r.t = 0;
  r.maxR = maxRadius;
  r.mat.opacity = 0.55;
  r.mesh.position.set(x, level + 0.06, z);
  r.mesh.scale.setScalar(0.2);
  mesh.parent?.add(r.mesh);
}

function tickRings(now: number): void {
  if (ringClock < 0) {ringClock = now; return;}
  const dt = Math.min(now - ringClock, 0.1);
  ringClock = now;
  for (const r of ringPool) {
    if (r.t >= RING_LIFE) {continue;}
    r.t += dt;
    const t = Math.min(r.t / RING_LIFE, 1);
    // Ease-out expansion — ring accelerates off the impact then dies wide.
    r.mesh.scale.setScalar(0.2 + r.maxR * (1 - (1 - t) * (1 - t)));
    r.mat.opacity = 0.55 * (1 - t);
    if (t >= 1) {r.mesh.parent?.remove(r.mesh);}
  }
}

function removeWaterSurface(scene: THREE.Scene): void {
  if (mesh) {scene.remove(mesh);}
  material?.dispose();
  geometry?.dispose();
  mesh = null; material = null; geometry = null; builtSize = 0;
  level = undefined;
  hmTex?.dispose(); hmTex = null; hmBound = null;
  for (const r of ringPool) { r.t = RING_LIFE; r.mesh.parent?.remove(r.mesh); }
  // Map swap while submerged — the grade must not outlive its water.
  uwOn = false;
  if (uwEl) { uwEl.style.opacity = '0'; }
  uwShown = false;
  document.body?.classList?.remove('underwater');
}

/** Create, update, or remove the sea surface for `water` (undefined = dry). */
export function applyWaterSurface(scene: THREE.Scene, water?: WaterSpec): void {
  if (!water) {
    removeWaterSurface(scene);
    return;
  }

  const size = Math.max(getWorldScale() * 2.5, 2000);
  if (!mesh || !material || !geometry || builtSize !== size) {
    removeWaterSurface(scene);
    geometry = new THREE.PlaneGeometry(size, size, 1, 1);
    material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uShallow: { value: new THREE.Color() },
          uDeep: { value: new THREE.Color() },
          uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.2) },
          uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
          uNoise: { value: null },
          uHm: { value: null },
          uHmScale: { value: 1 },
          uHScale: { value: 1 },
          uLevel: { value: 0 },
          uHasHm: { value: 0 },
        },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
    });
    material.uniforms.uNoise.value = getNoiseTex();
    material.uniforms.uHm.value = getNoiseTex(); // placeholder until bindHeightmap swaps it — keeps the sampler bound
    mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 1;
    mesh.frustumCulled = false;
    // Advance the ripple clock each frame it renders — wall time is fine for
    // a purely visual layer (never feeds the sim).
    mesh.onBeforeRender = (): void => {
      const now = performance.now() * 0.001;
      material!.uniforms.uTime.value = now;
      bindHeightmap();
      tickRings(now);
    };
    scene.add(mesh);
    builtSize = size;
  }

  const shallow = water.color ?? DEFAULT_SHALLOW;
  const deep = water.deep ?? DEFAULT_DEEP;
  (material.uniforms.uShallow.value as THREE.Color).setRGB(shallow[0], shallow[1], shallow[2], THREE.SRGBColorSpace);
  (material.uniforms.uDeep.value as THREE.Color).setRGB(deep[0], deep[1], deep[2], THREE.SRGBColorSpace);
  // Sun rides the sky dome (a dusk atmosphere has already re-aimed it).
  const sky = scene.getObjectByName('__sky')?.userData.sky as { getSunDirection(): THREE.Vector3 } | undefined;
  const dir = sky?.getSunDirection();
  if (dir) {(material.uniforms.uSunDir.value as THREE.Vector3).copy(dir);}
  mesh!.position.y = water.level;
  material.uniforms.uLevel.value = water.level;
  ({ level } = water); // publish last — teardown above must not clear it
}
