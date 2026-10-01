import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

// BVH raycasts: the bake fires 16 hemisphere rays per vertex against the
// merged occluder — brute-force triangle scans made this an O(verts×tris)
// startup stall (~15s+ on a throttled CPU). boundsTree + firstHitOnly
// turns each ray into an O(log n) traversal; the bake drops to ms.
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/**
 * Runtime-baked vertex AO for procedural models (no UVs → no AO textures).
 * Per vertex: fire a small hemisphere of rays from a nudged surface point,
 * count how many hit nearby geometry, and darken the vertex color by the
 * occluded fraction — bore interiors and overlapping joints shade dark,
 * exposed flats stay clean. Runs once at construction; zero per-frame cost.
 */

const _ray = new THREE.Raycaster();
_ray.firstHitOnly = true;
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _bitan = new THREE.Vector3();

const RAYS = 16;             // hemisphere samples per vertex — enough for soft AO
const RAY_DIST_SCALE = 0.18; // occlusion range = bbox radius × this (crevice scale)
const EPS = 0.004;           // origin nudge off the surface to avoid self-hit
const MIN_LIGHT = 0.25;      // floor — deepest crevice never hits full black
// Curvature gain: 1-dot(n_v, n_face) on a 90° dihedral is ~0.29 — scale
// so ~45°+ edges already saturate (smooth-shaded bodies diverge little).
const WEAR_GAIN = 7.0;
const _fa = new THREE.Vector3();
const _fb = new THREE.Vector3();
const _fc = new THREE.Vector3();

/** Per-vertex convexity bake — Substance's curvature input, at vertex res.
 *  Vertex normals on a hard edge diverge from the flat face normals of
 *  their incident triangles; flat-shaded plates stay at ~0. Concave
 *  edges score too, but the shader gates wear by AO exposure, so crevices
 *  stay dark and only sun-facing edges whiten — the reverse-weighting
 *  trick (wear = convexity AND unoccluded). */
function bakeWear(geo: THREE.BufferGeometry): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  if (!pos || !nor) return;
  const count = pos.count;
  const idx = geo.index;
  const triCount = idx ? idx.count / 3 : count / 3;
  const acc = new Float32Array(count);
  const cnt = new Uint16Array(count);
  for (let t = 0; t < triCount; t++) {
    const ia = idx ? idx.getX(t * 3) : t * 3;
    const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    _fa.fromBufferAttribute(pos, ia);
    _fb.fromBufferAttribute(pos, ib);
    _fc.fromBufferAttribute(pos, ic);
    _fb.sub(_fa); _fc.sub(_fa);
    _fa.crossVectors(_fb, _fc).normalize(); // flat face normal
    for (const vi of [ia, ib, ic]) {
      _n.fromBufferAttribute(nor, vi);
      acc[vi] += Math.max(0, 1 - _n.dot(_fa));
      cnt[vi]++;
    }
  }
  const wear = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    wear[i] = cnt[i] ? Math.min(1, (acc[i]! / cnt[i]!) * WEAR_GAIN) : 0;
  }
  geo.setAttribute('wear', new THREE.BufferAttribute(wear, 1));
}

// Uniform-ish hemisphere dirs (Fibonacci sphere upper half, bent to normal)
function bakeMesh(mesh: THREE.Mesh, occluder: THREE.Mesh, rayDist: number): void {
  const geo = mesh.geometry;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  if (!pos || !nor) return;
  const count = pos.count;
  const colors = new Float32Array(count * 3).fill(1);
  const mm = mesh.matrixWorld;

  for (let i = 0; i < count; i++) {
    _p.fromBufferAttribute(pos, i).applyMatrix4(mm);
    _n.fromBufferAttribute(nor, i).transformDirection(mm).normalize();
    // tangent frame for hemisphere jitter
    _tan.set(1, 0, 0).cross(_n);
    if (_tan.lengthSq() < 1e-4) _tan.set(0, 1, 0).cross(_n);
    _tan.normalize();
    _bitan.crossVectors(_n, _tan);

    let occluded = 0;
    for (let r = 0; r < RAYS; r++) {
      // cosine-weighted-ish jitter inside the hemisphere
      const a = Math.random() * Math.PI * 2;
      const t = Math.random();
      const spread = Math.sin(t) * 0.9;
      _dir.copy(_n).multiplyScalar(Math.cos(t))
        .addScaledVector(_tan, Math.cos(a) * spread)
        .addScaledVector(_bitan, Math.sin(a) * spread)
        .normalize();
      _origin.copy(_p).addScaledVector(_n, EPS);
      _ray.set(_origin, _dir);
      _ray.far = rayDist;
      if (_ray.intersectObject(occluder, false).length > 0) occluded++;
    }
    const ao = 1 - (occluded / RAYS) * (1 - MIN_LIGHT);
    colors[i * 3] = ao;
    colors[i * 3 + 1] = ao;
    colors[i * 3 + 2] = ao;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  bakeWear(geo);
}

/** Curvature-only bake for meshes that already carry baked AO textures
 *  (the vmBaked swap path) — same wear attribute + shader, no raycast AO. */
export function bakeWearOnly(group: THREE.Group): void {
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (!m.geometry.getAttribute('wear')) bakeWear(m.geometry);
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) if (mat && mat.type !== 'MeshBasicMaterial') enhanceWeaponMaterial(mat);
  });
}

/** Bake vertex AO into every mesh of a group. Call after the group's local
 *  transforms are final (add to a parent first or updateWorldMatrix). */
export function bakeVertexAO(group: THREE.Group): void {
  group.updateWorldMatrix(true, true);

  // One merged occluder mesh so rays hit every part of the weapon
  const meshes: THREE.Mesh[] = [];
  group.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  if (!meshes.length) return;

  const occluderGeo = mergeGeometries(meshes);
  occluderGeo.boundsTree = new MeshBVH(occluderGeo);
  // DoubleSide is required: hemisphere rays point outward and mostly hit the
  // back faces of surrounding geometry — FrontSide culling would miss them all.
  const occluder = new THREE.Mesh(occluderGeo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  occluder.updateMatrixWorld(true);
  // Range must stay below model scale or every ray hits something and the
  // bake flattens to the floor value everywhere.
  const rayDist = occluderGeo.boundingSphere!.radius * RAY_DIST_SCALE;

  for (const m of meshes) {
    // Emissive/glow parts (MeshBasicMaterial: glow rings, muzzle glows) must
    // stay lit — AO would dim them. Only lit materials get vertex colors.
    if ((m.material as THREE.Material).type === 'MeshBasicMaterial') continue;
    bakeMesh(m, occluder, rayDist);
    const mat = m.material as THREE.Material & { vertexColors?: boolean };
    if (mat) { mat.vertexColors = true; mat.needsUpdate = true; enhanceWeaponMaterial(mat); }
  }
  occluderGeo.dispose();
}

/**
 * Per-pixel procedural surface detail, no UVs needed: world-space value-noise
 * fbm breaks the flat albedo, and a high-freq ridged noise masked by the baked
 * vertex AO (vColor) adds wear on exposed surfaces — creases stay dark while
 * plate tops get scuffed-brighter streaks. The baked-Blender look, faked.
 */
function enhanceWeaponMaterial(mat: THREE.Material): void {
  if (mat.userData.__grunge) return;
  mat.userData.__grunge = true;
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWpos;\nattribute float wear;\nvarying float vWear;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvWpos = (modelMatrix * vec4(position, 1.0)).xyz;\nvWear = wear;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWpos;
varying float vWear;
float whash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float wnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(whash(i), whash(i + vec3(1,0,0)), f.x), mix(whash(i + vec3(0,1,0)), whash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(whash(i + vec3(0,0,1)), whash(i + vec3(1,0,1)), f.x), mix(whash(i + vec3(0,1,1)), whash(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}
float wfbm(vec3 p) { return 0.5 * wnoise(p) + 0.25 * wnoise(p * 2.17) + 0.125 * wnoise(p * 4.31); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  // Large-scale mottled variation — reads as paint/finish, not speckle.
  float g = wfbm(vWpos * 35.0);
  diffuseColor.rgb *= 0.92 + 0.14 * g;

  // Edge wear = baked vertex convexity (the curvature map) refined by
  // screen-space normal gradient — the bake catches flat-shaded plates
  // where fwidth(vNormal) reads ~0, fwidth catches intra-triangle detail.
  float curv = length(fwidth(normalize(vNormal)));
  float edge = max(smoothstep(0.35, 1.2, curv), smoothstep(0.12, 0.5, vWear));

  // Patchy mask so wear clumps in zones like real abrasion, gated to
  // well-lit (unoccluded) faces — crevices don't wear bright.
  float patches = smoothstep(0.55, 0.8, wnoise(vWpos * 90.0));
  #ifdef USE_COLOR
    float exposure = smoothstep(0.55, 0.9, vColor.g);
  #else
    // Baked-GLB path: AO lives in the texture, no vertex colors — edge
    // wear stays unmasked by exposure (concave hits are rare here).
    float exposure = 1.0;
  #endif
    float wear = edge * (0.35 + 0.65 * patches) * exposure;

    // Worn metal: desaturate and brighten edges; slight micro-scratch noise.
    float scratch = wnoise(vWpos * 700.0) * 0.12;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72, 0.70, 0.68), wear * 0.7);
    diffuseColor.rgb *= 1.0 - wear * scratch;

  #ifdef USE_COLOR
    // Extra cavity depth beyond vertex AO — cheap contrast ramp on the bake.
    diffuseColor.rgb *= 0.6 + 0.4 * smoothstep(0.2, 0.75, vColor.g);
  #endif
}`);
    mat.needsUpdate = true;
  };
}

// Minimal merge: concatenate world-space triangles of all meshes (indexed
// or not) into one non-indexed position buffer — raycasts only need that.
function mergeGeometries(meshes: THREE.Mesh[]): THREE.BufferGeometry {
  const parts: Float32Array[] = [];
  for (const m of meshes) {
    const g = m.geometry;
    const p = g.attributes.position as THREE.BufferAttribute;
    const idx = g.index;
    const tris = idx ? idx.count : p.count;
    const out = new Float32Array(tris * 3);
    const v = new THREE.Vector3();
    let w = 0;
    for (let t = 0; t < tris; t++) {
      const i = idx ? idx.getX(t) : t;
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      out[w++] = v.x; out[w++] = v.y; out[w++] = v.z;
    }
    parts.push(out);
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const merged = new Float32Array(total);
  let off = 0;
  for (const p of parts) { merged.set(p, off); off += p.length; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(merged, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}
