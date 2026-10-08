import * as THREE from 'three';
import type { Terrain } from '../world/terrain.js';

// Terrain↔structure seam blend — sand creeping up the foot of every kit
// piece and spec box instead of a hard intersection line. Implemented as
// a shared onBeforeCompile patch: the fragment computes height-above-
// terrain from the SAME heightfield texture the terrain displaces by,
// and fades a noisy sand tint in over the first ~1.3m of contact.
// Up-facing surfaces bury deep; walls only dust near the contact line.

type HeightU = Terrain['heightU'];

const SAND = new THREE.Color(0.78, 0.66, 0.28); // desert palette's cDesertSand base
const patched = new WeakSet<THREE.Material>();

const VERT_TAIL = /* glsl */ `
  #ifdef USE_INSTANCING
    vTbW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  #else
    vTbW = (modelMatrix * vec4(transformed, 1.0)).xyz;
  #endif
`;

const FRAG_HEAD = /* glsl */ `
  varying vec3 vTbW;
  uniform sampler2D uTbHmap;
  uniform float uTbWorldScale;
  uniform float uTbHScale;
  uniform vec3 uTbSand;
  float tbHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float tbNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(tbHash(i), tbHash(i + vec2(1, 0)), f.x),
               mix(tbHash(i + vec2(0, 1)), tbHash(i + vec2(1, 1)), f.x), f.y);
  }
`;

// Runs after normal_fragment_begin so `normal` (view space) exists.
const FRAG_BODY = /* glsl */ `
  #include <normal_fragment_begin>
  {
    float tbGround = texture2D(uTbHmap, fract(vTbW.xz / uTbWorldScale)).r * uTbHScale;
    float tbRel = vTbW.y - tbGround;
    // Noise-broken top edge — a straight sand line reads as painted-on.
    float tbBand = 1.0 - smoothstep(0.0, 1.3, tbRel - (tbNoise(vTbW.xz * 0.9) - 0.5) * 0.8);
    // Up-facing surfaces catch full sand; walls get a low dusting only.
    vec3 tbWN = transpose(mat3(viewMatrix)) * normal;
    float tbCov = tbBand * mix(0.22, 1.0, clamp(tbWN.y, 0.0, 1.0));
    vec3 tbSand = uTbSand * (0.85 + 0.3 * tbNoise(vTbW.xz * 2.3));
    diffuseColor.rgb = mix(diffuseColor.rgb, tbSand, clamp(tbCov, 0.0, 1.0));
  }
`;

/** Bind a material into the terrain blend — idempotent, safe to call per
 *  build. The uniform objects are terrain.heightU's own, so heightmap
 *  reloads and per-map scale swaps propagate without repatching. */
export function applyTerrainBlend(m: THREE.Material, heightU: HeightU): void {
  if (patched.has(m)) {return;}
  patched.add(m);
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer): void => {
    prev?.(shader, renderer);
    shader.uniforms.uTbHmap = heightU.heightMap;
    shader.uniforms.uTbWorldScale = heightU.hmWorldScale;
    shader.uniforms.uTbHScale = heightU.hScale;
    shader.uniforms.uTbSand = { value: SAND };
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec3 vTbW;\nvoid main() {')
      .replace('#include <fog_vertex>', `#include <fog_vertex>\n${VERT_TAIL}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${FRAG_HEAD}\nvoid main() {`)
      .replace('#include <normal_fragment_begin>', FRAG_BODY);
  };
  m.needsUpdate = true;
}

/** Per-map sand tint — non-desert presets can recolor the creep. */
export function setTerrainBlendSand(hex: number): void {
  SAND.setHex(hex);
}
