// structSurface — procedural surface treatment for structure materials.
// One onBeforeCompile patch, applied per material: cast-pour mottle,
// world-space panel seams, downward grime streaks, ledge dust, and a
// roughness wobble. No UVs — everything keys off world pos + normal,
// so it works on lofts, merged spec boxes, anything with a standard
// or lambert material.
//
// Modular by construction: applyStructSurface(material, recipe) is
// idempotent and chains — it calls the previous onBeforeCompile first
// and re-emits `#include <normal_fragment_begin>` so terrainBlend's
// patch (same marker) composes unchanged. Weapons and glow meshes
// never touch this — it only binds the materials you pass it.

import * as THREE from 'three';

export interface SurfaceRecipe {
  /** Panel seam cell size in meters — 0 disables. */
  panel?: number;
  /** Cast-pour mottle amplitude (0-0.4). */
  mottle?: number;
  /** Downward grime streak strength (0-1). */
  grime?: number;
  /** Ledge-dust strength on up-facing surfaces (0-1). */
  dust?: number;
}

const patched = new WeakMap<THREE.Material, THREE.Material['onBeforeCompile'] | undefined>();

const VERT = /* glsl */ `
  vSsW = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vSsN = normalize(mat3(modelMatrix) * objectNormal);
`;

const HEAD = /* glsl */ `
  varying vec3 vSsW;
  varying vec3 vSsN;
  float ssHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float ssNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(ssHash(i), ssHash(i + vec2(1, 0)), f.x),
               mix(ssHash(i + vec2(0, 1)), ssHash(i + vec2(1, 1)), f.x), f.y);
  }
  float ssFbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int k = 0; k < 3; k += 1) { v += a * ssNoise(p); p = p * 2.07 + vec2(7.7, 3.1); a *= 0.5; }
    return v * 1.14;
  }
`;

/** Bind the recipe to a material — returns the same material so
 *  `const m = applyStructSurface(new MeshStandardMaterial(...))` reads
 *  like a normal declaration. `un` restores the previous patch. */
export function applyStructSurface<T extends THREE.Material>(m: T, r: SurfaceRecipe = {}): T {
  if (patched.has(m)) {return m;}
  const prev = m.onBeforeCompile;
  patched.set(m, prev);
  const panel = r.panel ?? 2.6;
  const mottle = r.mottle ?? 0.1;
  const grime = r.grime ?? 0.35;
  const dust = r.dust ?? 0.4;

  // Inject at normal_fragment_begin — roughnessFactor doesn't exist until
  // roughnessmap_fragment (which runs AFTER color_fragment), and Lambert
  // never declares it at all (gate). color_fragment was the wrong site:
  // every patched standard material compiled an undeclared-identifier
  // variant — the 'program not valid' burst at boot.
  const isStd = m instanceof THREE.MeshStandardMaterial;

  const BODY = /* glsl */ `
  {
    // Dominant-axis projection — walls get wall grids, floors get tile grids.
    vec3 san = abs(vSsN);
    vec2 suv = san.y > max(san.x, san.z) ? vSsW.xz : (san.x > san.z ? vSsW.zy : vSsW.xy);
    float ssMot = ssFbm(suv * 0.62 + vSsW.y * 0.31);
    diffuseColor.rgb *= 1.0 + (ssMot - 0.5) * ${(mottle * 2).toFixed(3)};
    ${isStd ? 'roughnessFactor = clamp(roughnessFactor + (ssMot - 0.5) * 0.16, 0.05, 1.0);' : ''}
    ${panel > 0 ? /* glsl */ `
    {
      // Panel seams — noise-broken thin grooves; the jitter keeps the
      // grid from reading as a ruler.
      vec2 cell = suv / ${panel.toFixed(2)};
      vec2 e = min(fract(cell), 1.0 - fract(cell));
      float seam = 1.0 - smoothstep(0.0, 0.022, min(e.x, e.y));
      seam *= 0.5 + 0.5 * ssNoise(suv * 2.7);
      diffuseColor.rgb *= 1.0 - seam * 0.32;
    }` : ''}
    ${grime > 0 ? /* glsl */ `
    {
      // Rain grime — streaks stretched 4:1 down the vertical axis, on
      // wall-facing fragments only.
      float wall = 1.0 - abs(vSsN.y);
      float st = ssFbm(vec2(suv.x * 2.4 + suv.y * 0.3, vSsW.y * 0.26));
      diffuseColor.rgb *= 1.0 - wall * smoothstep(0.52, 0.82, st) * ${grime.toFixed(2)} * 0.34;
    }` : ''}
    ${dust > 0 ? /* glsl */ `
    {
      // Ledge dust — pale deposit on up-facing surfaces, blotched.
      float upf = clamp(vSsN.y, 0.0, 1.0);
      diffuseColor.rgb += vec3(0.82, 0.78, 0.68) * upf * smoothstep(0.5, 0.85, ssFbm(suv * 1.6)) * ${dust.toFixed(2)} * 0.10;
    }` : ''}
  }
  `;

  m.onBeforeCompile = (shader, renderer): void => {
    prev?.(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec3 vSsW;\nvarying vec3 vSsN;\nvoid main() {')
      .replace('#include <fog_vertex>', `#include <fog_vertex>\n${VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${HEAD}\nvoid main() {`)
      // Re-emit the include inside the body so later patches (terrainBlend
      // targets the same marker) compose — both bodies run in order.
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\n${BODY}`);
  };
  m.needsUpdate = true;
  return m;
}

/** Unbind — restores the onBeforeCompile captured before our patch. */
export function unbindStructSurface(m: THREE.Material): void {
  const prev = patched.get(m);
  if (prev !== undefined || patched.has(m)) {
    m.onBeforeCompile = prev!;
    m.needsUpdate = true;
    patched.delete(m);
  }
}
