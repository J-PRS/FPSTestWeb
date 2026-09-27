import * as THREE from 'three';
import type { Heightfield } from '../../../shared/heightfield.js';

import {
  TERRAIN_HEIGHT_SCALE, TERRAIN_WORLD_SCALE, TERRAIN_HEIGHTMAP_DIVISOR
} from '../core/config.js';

const HSCALE = TERRAIN_HEIGHT_SCALE;
const HM_WORLD_SCALE = TERRAIN_WORLD_SCALE;

// Step size for CPU-side normal calculation (matches finest clipmap spacing)
const CPU_STEP = 5.0;

let hmData: Uint8ClampedArray | null = null;
let hmSize = 0;

export async function loadHeightmap(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      hmSize = img.width;
      if (img.width !== img.height) {
        reject(new Error(`Heightmap must be square, got ${img.width}x${img.height}`));
        return;
      }
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      hmData = ctx.getImageData(0, 0, img.width, img.height).data; // RGBA
      resolve();
    };
    img.onerror = reject;
    img.src = url;
  });
}

function hmSample(x: number, z: number): number {
  const idx = (z * hmSize + x) * 4;
  return hmData![idx] / TERRAIN_HEIGHTMAP_DIVISOR; // R channel 0..1
}

function sampleHeightmap(wx: number, wz: number): number {
  // GPU texture2D + LinearFilter evaluates at texel CENTERS — texel i sits at
  // (i + 0.5)/N in UV space. Sample identically on CPU (u shifted by -0.5) or
  // physics height is offset half a texel from the rendered mesh, which puts
  // the player/projectiles inside hills on steep slopes.
  const u = (((wx / HM_WORLD_SCALE) % 1.0) + 1.0) % 1.0 * hmSize - 0.5;
  const v = (((wz / HM_WORLD_SCALE) % 1.0) + 1.0) % 1.0 * hmSize - 0.5;
  const x0 = ((Math.floor(u) % hmSize) + hmSize) % hmSize;
  const z0 = ((Math.floor(v) % hmSize) + hmSize) % hmSize;
  const x1 = (x0 + 1) % hmSize;
  const z1 = (z0 + 1) % hmSize;
  const fx = u - Math.floor(u);
  const fz = v - Math.floor(v);
  const h =
    hmSample(x0, z0) * (1 - fx) * (1 - fz) +
    hmSample(x1, z0) * fx * (1 - fz) +
    hmSample(x0, z1) * (1 - fx) * fz +
    hmSample(x1, z1) * fx * fz;
  return h * HSCALE;
}

export function sampleHeight(wx: number, wz: number): number {
  if (hmData) return sampleHeightmap(wx, wz);
  return 0;
}

/** The heightmap in the shared format — server-owned creatures (ballSim)
 *  replay flight against the identical field, so prediction lands on the
 *  same vertices as the server's sim. */
export function getHeightfield(): Heightfield | null {
  return hmData ? { size: hmSize, data: hmData, stride: 4 } : null;
}

const _normalTmp = new THREE.Vector3();

export function sampleNormal(wx: number, wz: number): THREE.Vector3 {
  const e = CPU_STEP * 0.5;
  const hL = sampleHeight(wx - e, wz);
  const hR = sampleHeight(wx + e, wz);
  const hD = sampleHeight(wx, wz - e);
  const hU = sampleHeight(wx, wz + e);
  return _normalTmp.set(hL - hR, 2.0 * e, hD - hU).normalize();
}

interface ClipmapLevel {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  spacing: number;
  innerHalfSize: number;
  gridOrigin: THREE.Vector2;
  innerGridOrigin: THREE.Vector2;
}

const CLIPMAP_LEVELS = [
  { spacing: 5,  divisions: 80, innerHalfSize: 0   },
  { spacing: 10, divisions: 80, innerHalfSize: 200 },
  { spacing: 20, divisions: 80, innerHalfSize: 400 },
  { spacing: 40, divisions: 80, innerHalfSize: 800 },
];

function createFlatGridGeometry(divisions: number, borderCells = 1): THREE.BufferGeometry {
  const total = divisions + 2 * borderCells;
  const n = total + 1;
  const positions = new Float32Array(n * n * 3);
  const indices = new Uint16Array(total * total * 6);

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const vi = iz * n + ix;
      // Interior [-0.5, 0.5] plus border overhang on each side
      positions[vi * 3 + 0] = (ix - borderCells) / divisions - 0.5;
      positions[vi * 3 + 1] = 0;
      positions[vi * 3 + 2] = (iz - borderCells) / divisions - 0.5;
    }
  }

  for (let iz = 0; iz < total; iz++) {
    for (let ix = 0; ix < total; ix++) {
      const i = iz * n + ix;
      const ti = (iz * total + ix) * 6;
      indices[ti]     = i;
      indices[ti + 1] = i + n;
      indices[ti + 2] = i + 1;
      indices[ti + 3] = i + 1;
      indices[ti + 4] = i + n;
      indices[ti + 5] = i + n + 1;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

const terrainVert = /* glsl */`
  uniform sampler2D heightMap;
  uniform float hmWorldScale;
  uniform float hScale;
  uniform vec2 gridOrigin;
  uniform float levelScale;
  uniform float gridSpacing;
  uniform float innerHalfSize;
  uniform float innerSpacing;
  uniform vec2 innerGridOrigin;

  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vCameraPos;

  #include <shadowmap_pars_vertex>

  float sampleHeightGPU(vec2 worldXZ) {
    vec2 uv = fract(worldXZ / hmWorldScale);
    return texture2D(heightMap, uv).r * hScale;
  }

  // Bilinear interpolation of the next-finer level's grid heights
  // The inner level's grid corner is at innerGridOrigin - innerHalfSize
  // (innerGridOrigin is the grid CENTER, not the corner)
  float sampleInnerHeight(vec2 worldXZ) {
    if (innerHalfSize <= 0.0) return sampleHeightGPU(worldXZ);
    vec2 corner = innerGridOrigin - innerHalfSize;
    vec2 local = worldXZ - corner;
    vec2 cell = floor(local / innerSpacing);
    vec2 f = fract(local / innerSpacing);
    vec2 p00 = corner + cell * innerSpacing;
    float h00 = sampleHeightGPU(p00);
    float h10 = sampleHeightGPU(p00 + vec2(innerSpacing, 0.0));
    float h01 = sampleHeightGPU(p00 + vec2(0.0, innerSpacing));
    float h11 = sampleHeightGPU(p00 + vec2(innerSpacing, innerSpacing));
    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
  }

  // Morph heights near the inner boundary to match the finer level,
  // using circular distance for rounder, less noticeable transitions
  float getMorphHeight(vec2 worldXZ) {
    float outerH = sampleHeightGPU(worldXZ);
    if (innerHalfSize <= 0.0) return outerH;
    vec2 d = worldXZ - innerGridOrigin;
    float dist = length(d);
    // 100% inner-height region extends BEYOND the discard boundary by 3 inner spacings.
    // This ensures all vertices of triangles spanning the discard boundary are at full inner
    // height, so the per-fragment interpolated height at the boundary exactly matches the
    // inner level. Without this, per-vertex morphing creates a height step at the seam.
    float morphStart = innerHalfSize + innerSpacing * 3.0;
    float morphEnd = innerHalfSize + innerSpacing * 9.0;
    if (dist <= morphStart) return sampleInnerHeight(worldXZ);
    if (dist >= morphEnd) return outerH;
    float blend = smoothstep(morphStart, morphEnd, dist);
    float innerH = sampleInnerHeight(worldXZ);
    return mix(innerH, outerH, blend);
  }

  void main() {
    vec2 worldXZ = gridOrigin + position.xz * levelScale;

    float eps = gridSpacing * 0.5;
    float h = getMorphHeight(worldXZ);

    // For normals, use raw GPU height if far from morph boundary (saves 4× sampleInnerHeight)
    vec2 d = worldXZ - innerGridOrigin;
    float dist = length(d);
    float morphStart = innerHalfSize + innerSpacing * 3.0;
    float morphEnd = innerHalfSize + innerSpacing * 9.0;
    bool nearBoundary = innerHalfSize > 0.0 && dist > morphStart - eps && dist < morphEnd + eps;

    float hL, hR, hD, hU;
    if (nearBoundary) {
      hL = getMorphHeight(worldXZ - vec2(eps, 0.0));
      hR = getMorphHeight(worldXZ + vec2(eps, 0.0));
      hD = getMorphHeight(worldXZ - vec2(0.0, eps));
      hU = getMorphHeight(worldXZ + vec2(0.0, eps));
    } else {
      hL = sampleHeightGPU(worldXZ - vec2(eps, 0.0));
      hR = sampleHeightGPU(worldXZ + vec2(eps, 0.0));
      hD = sampleHeightGPU(worldXZ - vec2(0.0, eps));
      hU = sampleHeightGPU(worldXZ + vec2(0.0, eps));
    }
    vNormal = normalize(vec3(hL - hR, 2.0 * eps, hD - hU));

    vec3 worldPos = vec3(worldXZ.x, h, worldXZ.y);
    vWorldPos = worldPos;
    vCameraPos = cameraPosition;

    // Shadow-receive coords — computed manually so vNormal (already
    // world-space) provides the bias offset; the mesh transform is identity.
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
        vec4 shadowWorldPosition = vec4(worldPos, 1.0) + vec4(vNormal * directionalLightShadows[ i ].shadowNormalBias, 0.0);
        vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * shadowWorldPosition;
      }
    #endif

    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
  }
`;

const terrainFrag = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vCameraPos;

  #include <common>
  #include <packing>
  uniform bool receiveShadow; // bound by the renderer (mesh.receiveShadow)
  #include <shadowmap_pars_fragment>
  #include <shadowmask_pars_fragment>

  uniform vec3 sunDir;
  uniform vec3 sunColor;
  uniform vec3 ambientColor;
  uniform float hscale;
  uniform int terrainPreset; // 0=mixed, 1=desert
  uniform vec3 fogColor;
  uniform float fogStart;
  uniform float fogEnd;
  uniform float innerHalfSize;
  uniform vec2 innerGridOrigin;

  // --- hash + value noise with analytic derivatives ---
  float hash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
  }
  vec3 noised(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f*f*(3.0-2.0*f);
    vec2 du = 6.0*f*(1.0-f);
    float a = hash(i+vec2(0,0));
    float b = hash(i+vec2(1,0));
    float c = hash(i+vec2(0,1));
    float d = hash(i+vec2(1,1));
    float v = a + (b-a)*u.x + (c-a)*u.y + (a-b-c+d)*u.x*u.y;
    vec2  g = du * (vec2(b-a, c-a) + (a-b-c+d)*u.yx);
    return vec3(v, g);
  }
  float noise(vec2 p) { return noised(p).x; }

  // --- Derivative erosion FBM (suppresses detail on steep slopes) ---
  const mat2 m2 = mat2(0.8, -0.6, 0.6, 0.8);
  float fbmErosion(vec2 p, int octaves) {
    float v=0.0, a=0.5;
    vec2 d = vec2(0.0);
    for(int i=0;i<16;i++){
      if(i >= octaves) break;
      vec3 n = noised(p);
      d += n.yz;
      v += a * n.x / (1.0 + dot(d,d));
      a *= 0.5;
      p = m2 * p * 2.0;
    }
    return v;
  }
  float fbm(vec2 p) { return fbmErosion(p, 6); }

  uniform vec4 scorchData[16]; // x, z, radius, intensity (w<=0 = unused slot)
  uniform float scorchEmber[16]; // per-slot ember rim glow (0 = none)

  // Projected explosion-scorch decals: darken albedo inside each scorch
  // circle with a noise-jittered edge. Applied in the fragment shader so it
  // conforms to the displaced surface exactly — no z-fighting, no decals
  // bridging dips or floating over slopes.
  float scorchMask(vec2 p) {
    float m = 0.0;
    for (int i = 0; i < 16; i++) {
      vec4 s = scorchData[i];
      if (s.w <= 0.0) continue;
      // Mostly circular blast ring with slight edge irregularity
      float edge = s.z * (0.9 + 0.15 * noise(p * 0.8 + float(i) * 7.31));
      float d = distance(p, s.xy);
      m = max(m, s.w * (1.0 - smoothstep(edge * 0.4, edge, d)));
    }
    return m;
  }

  // Ember rim: additive orange ring at the blast edge, fades in ~1s.
  // Projected in-shader so it always sits ON the terrain — a mesh ring
  // gets eaten by surface bumps at grazing angles.
  vec3 scorchEmberGlow(vec2 p) {
    float g = 0.0;
    for (int i = 0; i < 16; i++) {
      vec4 s = scorchData[i];
      float eb = scorchEmber[i];
      if (eb <= 0.0) continue;
      float d = distance(p, s.xy);
      float ring = 1.0 - smoothstep(0.0, s.z * 0.3, abs(d - s.z * 0.7));
      g += eb * max(ring, 0.0);
    }
    return vec3(1.0, 0.45, 0.1) * min(g, 1.2);
  }

  // --- Worley / cell noise for rocky variation ---
  float worley(vec2 p) {
    vec2 i = floor(p);
    float minD = 1e9;
    for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++){
      vec2 cell = i + vec2(x,y);
      vec2 pt = cell + vec2(hash(cell), hash(cell+vec2(31.41,27.18)));
      minD = min(minD, length(p - pt));
    }
    return clamp(minD, 0.0, 1.0);
  }

  // --- Second Worley layer at different scale for rock complexity ---
  float worley2(vec2 p) {
    vec2 i = floor(p);
    float minD = 1e9;
    for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++){
      vec2 cell = i + vec2(x,y);
      vec2 pt = cell + vec2(hash(cell+vec2(57.3,91.7)), hash(cell+vec2(13.4,87.2)));
      minD = min(minD, length(p - pt));
    }
    return clamp(minD, 0.0, 1.0);
  }

  // --- Triplanar noise sampling (prevents stretching on cliffs) ---
  float triplanarNoise(vec3 p, float scale) {
    vec3 w = abs(vNormal);
    w = w / (w.x + w.y + w.z);
    float nx = noise(p.zy * scale);
    float ny = noise(p.xz * scale);
    float nz = noise(p.xy * scale);
    return nx * w.x + ny * w.y + nz * w.z;
  }

  // --- Stochastic texture bombing (random detail patches) ---
  float stochastic(vec3 p, float scale, float density) {
    vec3 i = floor(p * scale);
    float sum = 0.0;
    for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) for(int z=-1;z<=1;z++){
      vec3 cell = i + vec3(x,y,z);
      vec3 rnd = vec3(hash(cell.xy), hash(cell.yz), hash(cell.zx));
      vec3 center = (cell + rnd) / scale;
      float d = length(p - center);
      if(d < 0.5) sum += 1.0 - d * 2.0;
    }
    return clamp(sum * density, 0.0, 1.0);
  }

  // --- Directional erosion noise (creates river/drainage patterns) ---
  vec3 erosionNoise(vec2 p, vec2 dir) {
    vec2 ip = floor(p);
    vec2 fp = fract(p) - 0.5;
    float va = 0.0, wt = 0.0;
    for(int i=-2;i<=1;i++) for(int j=-2;j<=1;j++){
      vec2 o = vec2(float(i), float(j));
      vec2 h = vec2(hash(ip-o), hash(ip-o+vec2(37.0,17.0))) * 0.5;
      vec2 pp = fp + o + h;
      float d = dot(pp, pp);
      float w = exp(-d * 2.0);
      float mag = dot(pp, dir);
      va += cos(mag * 6.283) * w;
      wt += w;
    }
    return vec3(va / wt, 0.0, 0.0);
  }

  float terrainErosion(vec2 p, vec2 baseSlope) {
    float e = 0.0, a = 0.5;
    vec2 dir = normalize(baseSlope + vec2(0.001));
    for(int i=0;i<5;i++){
      vec3 n = erosionNoise(p * 4.0, dir);
      e += a * n.x;
      a *= 0.5;
      p *= 2.0;
    }
    return e;
  }

  void main() {
    if (innerHalfSize > 0.0) {
      vec2 _d = vWorldPos.xz - innerGridOrigin;
      if (length(_d) < innerHalfSize) discard;
    }
    float slope  = 1.0 - clamp(vNormal.y, 0.0, 1.0);
    float height = clamp(vWorldPos.y / hscale, 0.0, 1.0);
    // Real cast shadows: 1 = lit, <1 = occluded by balls/crawlers/players
    float shadowMask = getShadowMask();

    // --- multi-scale UVs ---
    vec2 uv    = vWorldPos.xz * 0.032;
    vec2 uvMed = vWorldPos.xz * 0.14;
    vec2 uvFin = vWorldPos.xz * 0.72;

    // --- desert preset (sand + dirt + rock only) ---
    if(terrainPreset == 1) {
      // Desert only needs: micro, cell, triRock, macro, medium, triDetail
      vec2 warp = vec2(fbm(uv), fbm(uv + vec2(5.2, 1.3)));
      float macro  = fbm(uv + 0.8 * warp);
      // Warp medium + micro too — unwarped fixed-frequency noise reads as
      // tiling at ground level even though nothing literally repeats
      float medium = fbm(uvMed + vec2(3.1, 7.4) + 0.35 * warp);
      float micro  = noise(uvFin + warp * 2.0) * 0.5 + noise(uvFin * 2.8 + warp * 3.5 + 1.7) * 0.5;
      float cell   = worley(uvMed * 1.4 + warp * 0.6);
      float triRock = triplanarNoise(vWorldPos, 0.22);
      float triDetail = triplanarNoise(vWorldPos, 0.85);
      // Patchiness: low-freq mask varies detail amplitude across the map so
      // every square meter doesn't share identical noise statistics
      float patchMask = smoothstep(0.25, 0.75, fbm(vWorldPos.xz * 0.008));
      float detail = (macro*0.40 + medium*0.30 + micro*0.15 + triDetail*0.10)
                   * (0.55 + 0.9 * patchMask);

      vec3 cDesertSand = vec3(0.78, 0.66, 0.28) + micro * vec3(0.10, 0.08, 0.02);
      vec3 cDesertRock = vec3(0.28, 0.24, 0.18) + cell * vec3(0.12, 0.10, 0.08) + triRock * vec3(0.08, 0.07, 0.05);
      vec3 cDesertCliff = vec3(0.18, 0.16, 0.12) + cell * vec3(0.10, 0.09, 0.07);
      vec3 cDirt = vec3(0.52, 0.30, 0.12) + medium * vec3(0.10, 0.06, 0.02) + cell * vec3(0.06, 0.04, 0.01);

      vec3 col = cDesertSand;
      col = mix(col, cDirt, smoothstep(0.05, 0.25, height));
      col = mix(col, cDesertRock, smoothstep(0.30, 0.60, height));
      float slopeBlend = smoothstep(0.18, 0.45, slope);
      vec3 slopeCol = mix(cDirt, cDesertCliff, smoothstep(0.30, 0.65, slope));
      col = mix(col, slopeCol, slopeBlend);
      col *= 0.86 + 0.28 * detail;
      col *= 1.0 - scorchMask(vWorldPos.xz);
      float diff = max(dot(vNormal, sunDir), 0.0);
      float shadow = diff * diff;
      float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
      vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
      col *= lit;
      col += scorchEmberGlow(vWorldPos.xz);
      // Fog distance: dampen the DOWNWARD vertical component so terrain
      // below an airborne camera isn't over-fogged (looking down a valley,
      // ground 200m below shouldn't haze like it's 200m across the map).
      vec3 fogDelta = vWorldPos - vCameraPos;
      float fogDist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
      float fogFactor = smoothstep(fogStart, fogEnd, fogDist);
      float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, fogDist) * smoothstep(0.3, 0.8, height);
      fogFactor = clamp(fogFactor + heightFog, 0.0, 1.0);
      col = mix(col, fogColor, fogFactor);
      gl_FragColor = vec4(col, 1.0);
      return;
    }

    // --- mixed preset: full noise suite ---
    vec2 warp = vec2(fbm(uv), fbm(uv + vec2(5.2, 1.3)));
    float macro  = fbm(uv  + 0.8 * warp);
    float medium = fbm(uvMed + vec2(3.1, 7.4));
    float micro  = noise(uvFin) * 0.5 + noise(uvFin*2.8+1.7)*0.5;
    float cell   = worley(uvMed * 1.4);
    float cell2  = worley2(uvMed * 2.1);

    float triRock = triplanarNoise(vWorldPos, 0.22);
    float triDetail = triplanarNoise(vWorldPos, 0.85);

    float grassPatch = stochastic(vWorldPos, 0.18, 0.35);
    float rockPatch  = stochastic(vWorldPos, 0.12, 0.25);

    vec2 slopeDir = normalize(vec2(vNormal.x, vNormal.z) + vec2(0.001));
    float drainage = terrainErosion(uvMed, slopeDir);

    float detail = macro*0.40 + medium*0.30 + micro*0.15 + triDetail*0.10 + drainage*0.05;

    // --- rich saturated palette ---
    vec3 cSand  = vec3(0.68, 0.58, 0.32) + micro * vec3(0.08, 0.06, 0.02);
    vec3 cGrass = vec3(0.18, 0.52, 0.06) + medium * vec3(0.08, 0.12, 0.02) + micro * vec3(0.05, 0.07, 0.01) + grassPatch * vec3(0.04, 0.08, 0.0);
    vec3 cDry   = vec3(0.62, 0.50, 0.16) + macro * vec3(0.12, 0.10, 0.04);
    vec3 cDirt  = vec3(0.52, 0.30, 0.12) + medium * vec3(0.10, 0.06, 0.02) + cell * vec3(0.06, 0.04, 0.01);
    vec3 cRock  = vec3(0.36, 0.32, 0.26) + cell * vec3(0.14, 0.12, 0.10) + cell2 * vec3(0.08, 0.07, 0.06) + triRock * vec3(0.06, 0.05, 0.04) + rockPatch * vec3(0.08, 0.07, 0.05);
    vec3 cMoss  = vec3(0.28, 0.42, 0.14) + cell2 * vec3(0.06, 0.08, 0.02);
    vec3 cCliff = vec3(0.22, 0.20, 0.16) + cell * vec3(0.10, 0.09, 0.07) + triRock * vec3(0.08, 0.07, 0.05);
    vec3 cWet   = vec3(0.38, 0.40, 0.34);

    // --- height blend (mixed preset) ---
    vec3 col = cSand;
    col = mix(col,   cDry,   smoothstep(0.05, 0.15, height));
    col = mix(col,   cGrass, smoothstep(0.12, 0.35, height));
    col = mix(col,   cDirt,  smoothstep(0.38, 0.56, height));
    col = mix(col,   cRock,  smoothstep(0.52, 0.78, height));

    // --- slope blend ---
    float slopeBlend = smoothstep(0.18, 0.45, slope);
    vec3 slopeCol = mix(cDirt, cCliff, smoothstep(0.30, 0.65, slope));
    col = mix(col, slopeCol, slopeBlend);

    // --- moss on rocks in mid-height damp areas ---
    float mossMask = smoothstep(0.25, 0.55, height) * (1.0 - smoothstep(0.60, 0.75, height));
    float mossSlope = smoothstep(0.25, 0.50, slope);
    col = mix(col, cMoss, mossMask * mossSlope * cell2 * 0.6);

    // --- wet patches in low valleys ---
    float wetMask = smoothstep(0.0, 0.12, height) * (1.0 - smoothstep(0.18, 0.25, height));
    col = mix(col, cWet, wetMask * macro * 0.4);

    // --- drainage channels (darker, follow slope direction) ---
    float drainageMask = smoothstep(0.0, 0.6, drainage) * smoothstep(0.1, 0.8, slope);
    vec3 cDrain = vec3(0.25, 0.28, 0.22);
    col = mix(col, cDrain, drainageMask * 0.35);

    // --- micro darkening in concavities via detail ---
    col *= 0.86 + 0.28 * detail;
    col *= 1.0 - scorchMask(vWorldPos.xz);

    // --- lighting ---
    float diff   = max(dot(vNormal, sunDir), 0.0);
    float shadow = diff * diff;
    // subtle fresnel-like rim on slopes facing away
    float rim = pow(1.0 - max(dot(vNormal, vec3(0,1,0)), 0.0), 2.5) * 0.15;
    vec3 lit = ambientColor + sunColor * shadow * shadowMask + vec3(rim);
    col *= lit;
    col += scorchEmberGlow(vWorldPos.xz);
    // Same dampened-downward-distance fog as the desert branch — see above
    vec3 fogDelta = vWorldPos - vCameraPos;
    float dist = length(vec3(fogDelta.x, min(fogDelta.y, 0.0) * 0.3, fogDelta.z));
    float fogFactor = smoothstep(fogStart, fogEnd, dist);
    // Height-augmented fog: tall terrain at distance gets extra fog
    float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, dist)
                     * smoothstep(0.3, 0.8, height);
    fogFactor = clamp(fogFactor + heightFog, 0.0, 1.0);
    col = mix(col, fogColor, fogFactor);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class Terrain {
  private scene: THREE.Scene;
  private levels: ClipmapLevel[] = [];
  private heightTexture: THREE.DataTexture;
  private gridGeo: THREE.BufferGeometry;
  // Shader-projected scorch decals: x, z, radius, intensity (16 slots)
  private scorchList: { x: number; z: number; r: number; intensity: number; ember: number }[] = [];
  private scorchArr = new Float32Array(16 * 4);
  private scorchEmberArr = new Float32Array(16);

  constructor(scene: THREE.Scene, sunDir: THREE.Vector3) {
    this.scene = scene;

    if (!hmData || hmSize === 0) {
      throw new Error('Terrain constructor called before loadHeightmap() completed');
    }

    // Upload heightmap as a GPU texture for vertex shader displacement
    this.heightTexture = new THREE.DataTexture(
      hmData, hmSize, hmSize, THREE.RGBAFormat, THREE.UnsignedByteType
    );
    this.heightTexture.wrapS = THREE.RepeatWrapping;
    this.heightTexture.wrapT = THREE.RepeatWrapping;
    this.heightTexture.magFilter = THREE.LinearFilter;
    this.heightTexture.minFilter = THREE.LinearFilter;
    this.heightTexture.needsUpdate = true;

    // Shared flat grid geometry (normalised [-0.5, 0.5] plus one-cell overlap border)
    const divisions = CLIPMAP_LEVELS[0].divisions;
    this.gridGeo = createFlatGridGeometry(divisions, 1);
    const gridGeo = this.gridGeo;

    for (let i = 0; i < CLIPMAP_LEVELS.length; i++) {
      const cfg = CLIPMAP_LEVELS[i];
      const levelScale = cfg.spacing * cfg.divisions;

      const material = new THREE.ShaderMaterial({
        vertexShader: terrainVert,
        fragmentShader: terrainFrag,
        lights: true, // binds sun shadow map/matrices — enables USE_SHADOWMAP
        polygonOffset: i > 0,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        uniforms: {
          // Required with lights:true — renderer writes light/shadow state here
          ...THREE.UniformsLib.lights,
          heightMap:       { value: this.heightTexture },
          hmWorldScale:    { value: HM_WORLD_SCALE },
          hScale:          { value: HSCALE },
          gridOrigin:      { value: new THREE.Vector2(0, 0) },
          levelScale:      { value: levelScale },
          gridSpacing:     { value: cfg.spacing },
          innerHalfSize:   { value: cfg.innerHalfSize },
          innerSpacing:    { value: i > 0 ? CLIPMAP_LEVELS[i - 1].spacing : 0.0 },
          innerGridOrigin: { value: new THREE.Vector2(0, 0) },
          sunDir:          { value: sunDir.clone().normalize() },
          sunColor:        { value: new THREE.Color(1.0, 0.94, 0.8) },
          ambientColor:    { value: new THREE.Color(0.38, 0.45, 0.55) },
          hscale:          { value: HSCALE },
          terrainPreset:   { value: 1 },
          fogColor:        { value: new THREE.Color(0xbbd0e8) },
          fogStart:        { value: 80.0 },
          fogEnd:          { value: 400.0 },
          scorchData:      { value: this.scorchArr },
          scorchEmber:     { value: this.scorchEmberArr },
        },
      });

      const mesh = new THREE.Mesh(gridGeo, material);
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // world-space extent is set via uniforms, not mesh transform
      scene.add(mesh);

      this.levels.push({
        mesh,
        material,
        spacing: cfg.spacing,
        innerHalfSize: cfg.innerHalfSize,
        gridOrigin: new THREE.Vector2(0, 0),
        innerGridOrigin: new THREE.Vector2(0, 0),
      });
    }
  }

  update(px: number, pz: number): void {
    for (let i = 0; i < this.levels.length; i++) {
      const level = this.levels[i];
      // Snap grid origin to this level's spacing to prevent vertex swimming
      const ox = Math.round(px / level.spacing) * level.spacing;
      const oz = Math.round(pz / level.spacing) * level.spacing;
      level.gridOrigin.set(ox, oz);
      level.material.uniforms.gridOrigin.value.set(ox, oz);

      // Outer levels use the inner level's snapped origin for discard boundary
      if (i > 0) {
        const inner = this.levels[i - 1];
        level.innerGridOrigin.copy(inner.gridOrigin);
        level.material.uniforms.innerGridOrigin.value.copy(inner.gridOrigin);
      }
    }

    // Upload scorch decal slots (shared Float32Array across all level materials)
    this.scorchArr.fill(0);
    this.scorchEmberArr.fill(0);
    for (let i = 0; i < this.scorchList.length; i++) {
      const s = this.scorchList[i];
      const o = i * 4;
      this.scorchArr[o] = s.x;
      this.scorchArr[o + 1] = s.z;
      this.scorchArr[o + 2] = s.r;
      this.scorchArr[o + 3] = s.intensity;
      this.scorchEmberArr[i] = s.ember;
    }
  }

  // Register a projected scorch decal. Returns a handle whose `intensity`
  // and `ember` the caller animates; pass it back to removeScorch when done.
  addScorch(x: number, z: number, r: number) {
    const entry = { x, z, r, intensity: 0.5, ember: 0 };
    if (this.scorchList.length >= 16) this.scorchList.shift();
    this.scorchList.push(entry);
    return entry;
  }

  removeScorch(entry: { x: number; z: number; r: number; intensity: number; ember: number }): void {
    const i = this.scorchList.indexOf(entry);
    if (i >= 0) this.scorchList.splice(i, 1);
  }

  updateFog(color: THREE.Color, start: number, end: number): void {
    for (const level of this.levels) {
      level.material.uniforms.fogColor.value.copy(color);
      level.material.uniforms.fogStart.value = start;
      level.material.uniforms.fogEnd.value = end;
    }
  }

  dispose(): void {
    for (const level of this.levels) {
      this.scene.remove(level.mesh);
      level.material.dispose();
    }
    this.levels = [];
    this.gridGeo.dispose();
    this.heightTexture.dispose();
  }

  getHeight(wx: number, wz: number): number {
    return sampleHeight(wx, wz);
  }

  getNormal(wx: number, wz: number): THREE.Vector3 {
    return sampleNormal(wx, wz);
  }
}
