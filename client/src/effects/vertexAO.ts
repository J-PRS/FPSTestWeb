import * as THREE from 'three';

/**
 * Runtime-baked vertex AO for procedural models (no UVs → no AO textures).
 * Per vertex: fire a small hemisphere of rays from a nudged surface point,
 * count how many hit nearby geometry, and darken the vertex color by the
 * occluded fraction — bore interiors and overlapping joints shade dark,
 * exposed flats stay clean. Runs once at construction; zero per-frame cost.
 */

const _ray = new THREE.Raycaster();
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
      .replace('#include <common>', '#include <common>\nvarying vec3 vWpos;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvWpos = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWpos;
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

  // Screen-space curvature: fwidth of the normal spikes on hard edges and
  // plate rims — the true "edge wear" signal, vs noise which is uniform.
  float curv = length(fwidth(normalize(vNormal)));
  float edge = smoothstep(0.35, 1.2, curv);

  // Patchy mask so wear clumps in zones like real abrasion, gated to
  // well-lit (unoccluded) faces — crevices don't wear bright.
  float patches = smoothstep(0.55, 0.8, wnoise(vWpos * 90.0));
  #ifdef USE_COLOR
    float exposure = smoothstep(0.55, 0.9, vColor.g);
    float wear = edge * (0.35 + 0.65 * patches) * exposure;

    // Worn metal: desaturate and brighten edges; slight micro-scratch noise.
    float scratch = wnoise(vWpos * 700.0) * 0.12;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72, 0.70, 0.68), wear * 0.55);
    diffuseColor.rgb *= 1.0 - wear * scratch;

    // Extra cavity depth beyond vertex AO — cheap contrast ramp on the bake.
    diffuseColor.rgb *= 0.75 + 0.25 * smoothstep(0.25, 0.7, vColor.g);
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
