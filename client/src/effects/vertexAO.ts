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

// Dihedral sharpness for the line-edge mask: 1 - cos(30°). Edges steeper
// than ~30° (every box corner, rail lips, tube rims) get a crisp shader
// line; cylinder segment seams (~15-20°) stay smooth.
const SHARP_DIHEDRAL = 0.134;

/** Per-corner attributes need unique verts — an indexed vertex is shared
 *  across triangles, so a barycentric/edge-mask value written for one tri
 *  would leak into every tri touching it. Must run BEFORE vertex colors
 *  are baked (they're sized to the vertex count). */
function ensureNonIndexed(mesh: THREE.Mesh): void {
  if (mesh.geometry.index) mesh.geometry = mesh.geometry.toNonIndexed();
}

/** Build the barycentric edge-line attributes (the real crisp-edge signal):
 *  `abary` = canonical corner weights (1,0,0)/(0,1,0)/(0,0,1); `aedge` =
 *  per-corner flag "the triangle edge OPPOSITE me is sharp". In the
 *  fragment, the interpolated weight → 0 only near edges flagged sharp, so
 *  a smoothstep on fwidth gives a pixel-width wear line hugging actual
 *  geometry edges — the thing vertex-level wear can't do on a 24-vert box.
 *  Non-sharp corners contribute a large constant instead so flat seams and
 *  coplanar triangulation never draw. */
function bakeEdgeLines(geo: THREE.BufferGeometry): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const count = pos.count;
  const triCount = count / 3; // caller guarantees non-indexed
  const faceN = new Float32Array(triCount * 3);
  // 1mm weld tolerance — baked GLBs split verts at UV/seam boundaries, and
  // toFixed(4) keys would still match identical coords, but exporting
  // pipelines (and toNonIndexed) can nudge them. At coarser precision a
  // split-vert soup degenerates to "every edge is boundary → all sharp".
  const pk = (i: number) => `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
  const edges = new Map<string, { t: number; c: number; a: number; b: number }[]>();
  const _e = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    const v0 = t * 3, v1 = t * 3 + 1, v2 = t * 3 + 2;
    _fa.fromBufferAttribute(pos, v0);
    _fb.fromBufferAttribute(pos, v1);
    _fc.fromBufferAttribute(pos, v2);
    _fb.sub(_fa); _fc.sub(_fa);
    _e.crossVectors(_fb, _fc).normalize();
    faceN[t * 3] = _e.x; faceN[t * 3 + 1] = _e.y; faceN[t * 3 + 2] = _e.z;
    const add = (a: number, b: number, c: number) => {
      const key = pk(a) < pk(b) ? `${pk(a)}|${pk(b)}` : `${pk(b)}|${pk(a)}`;
      let l = edges.get(key);
      if (!l) edges.set(key, l = []);
      l.push({ t, c, a, b });
    };
    add(v0, v1, v2); // edge 0-1, opposite corner 2
    add(v1, v2, v0); // edge 1-2, opposite corner 0
    add(v2, v0, v1); // edge 2-0, opposite corner 1
  }
  const aedge = new Float32Array(count * 3); // vec3 — flag lives in the corner's own component
  for (const list of edges.values()) {
    let sharp = list.length === 1; // boundary edges (open rims) are real edges
    if (!sharp) {
      const [x, y] = [list[0]!, list[1]!];
      const dn = faceN[x.t * 3]! * faceN[y.t * 3]! + faceN[x.t * 3 + 1]! * faceN[y.t * 3 + 1]! + faceN[x.t * 3 + 2]! * faceN[y.t * 3 + 2]!;
      sharp = 1 - dn > SHARP_DIHEDRAL;
    }
    if (!sharp) continue;
    for (const e of list) aedge[(e.t * 3 + e.c) * 3 + e.c] = 1;
  }
  if ((geo.userData.__dbgEdge as boolean | undefined) !== true) {
    geo.userData.__dbgEdge = true;
    let shared = 0, bnd = 0, sharpN = 0, flagged = 0;
    for (const l of edges.values()) { if (l.length > 1) shared++; else bnd++; }
    for (const l of edges.values()) {
      if (l.length === 1) { sharpN++; flagged += l.length; continue; }
      const [x, y] = [l[0]!, l[1]!];
      const dn = faceN[x.t * 3]! * faceN[y.t * 3]! + faceN[x.t * 3 + 1]! * faceN[y.t * 3 + 1]! + faceN[x.t * 3 + 2]! * faceN[y.t * 3 + 2]!;
      if (1 - dn > SHARP_DIHEDRAL) { sharpN++; flagged += l.length; }
    }
    let set = 0; for (let i = 0; i < count * 3; i++) if (aedge[i]! > 0) set++;
    console.log(`[edgebake] tris=${triCount} edges=${edges.size} shared=${shared} bnd=${bnd} sharp=${sharpN} flagverts=${set}/${count}`);
  }
  const abary = new Float32Array(count * 3);
  for (let t = 0; t < triCount; t++) {
    abary[(t * 3) * 3] = 1;
    abary[(t * 3 + 1) * 3 + 1] = 1;
    abary[(t * 3 + 2) * 3 + 2] = 1;
  }
  geo.setAttribute('aedge', new THREE.BufferAttribute(aedge, 3));
  geo.setAttribute('abary', new THREE.BufferAttribute(abary, 3));
}

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
  // Hard-edge pass: flat-shaded geometry (every BoxGeometry part — most of
  // the viewmodel family) duplicates verts per face, so the vertex-vs-face
  // divergence above reads ~0 and blocks get NO edge wear. Comparing
  // normals across coincident POSITIONS catches the real edge signal: a
  // 90° cube corner has three verts at one spot with orthogonal normals.
  const hard = hardEdgeDivergence(pos, nor, count);

  const wear = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const soft = cnt[i] ? (acc[i]! / cnt[i]!) * WEAR_GAIN : 0;
    wear[i] = Math.min(1, Math.max(soft, hard[i]!));
  }
  geo.setAttribute('wear', new THREE.BufferAttribute(wear, 1));
}

/** Max (1 - dot) between each vertex's normal and the normals of every
 *  vertex sharing its position — 0 on flat faces, ~1 at 90° corners. */
function hardEdgeDivergence(pos: THREE.BufferAttribute, nor: THREE.BufferAttribute, count: number): Float32Array {
  const byPos = new Map<string, number[]>();
  for (let i = 0; i < count; i++) {
    const key = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    let list = byPos.get(key);
    if (!list) byPos.set(key, list = []);
    list.push(i);
  }
  const hard = new Float32Array(count);
  const _ni = new THREE.Vector3(), _nj = new THREE.Vector3();
  for (const list of byPos.values()) {
    if (list.length < 2) continue;
    for (const i of list) {
      _ni.fromBufferAttribute(nor, i);
      for (const j of list) {
        if (i === j) continue;
        _nj.fromBufferAttribute(nor, j);
        const d = 1 - _ni.dot(_nj);
        if (d > hard[i]!) hard[i] = d;
      }
    }
  }
  return hard;
}

// Uniform-ish hemisphere dirs (Fibonacci sphere upper half, bent to normal)
function bakeMesh(mesh: THREE.Mesh, occluder: THREE.Mesh, rayDist: number): void {
  ensureNonIndexed(mesh); // before colors: attribute size must match
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
  bakeEdgeLines(geo);
}

/** Curvature-only bake for meshes that already carry baked AO textures
 *  (the vmBaked swap path) — same wear attribute + shader, no raycast AO. */
export function bakeWearOnly(group: THREE.Group): void {
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    ensureNonIndexed(m);
    // Always rebake — GLBs can carry a STALE wear attribute round-tripped
    // through the dump pipeline (baked before the hard-edge pass existed).
    bakeWear(m.geometry);
    bakeEdgeLines(m.geometry);
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

  // Sibling meshes can share one BufferGeometry (disc rails, mag discs) —
  // baking instance A then instance B overwrites A's vertex colors, so both
  // siblings wear the LAST-baked occlusion. Detach on repeat bake.
  const baked = new Set<THREE.BufferGeometry>();
  for (const m of meshes) {
    // Emissive/glow parts (MeshBasicMaterial: glow rings, muzzle glows) must
    // stay lit — AO would dim them. Only lit materials get vertex colors.
    if ((m.material as THREE.Material).type === 'MeshBasicMaterial') continue;
    if (baked.has(m.geometry)) m.geometry = m.geometry.clone();
    baked.add(m.geometry);
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
      .replace('#include <common>', `#include <common>
varying vec3 vWpos;
attribute float wear; varying float vWear;
attribute vec3 abary; varying vec3 vBary;
attribute vec3 aedge; varying vec3 vAedge;`)
      // OBJECT space, not world: the viewmodel rides the camera, so a
      // world-space field swims across the gun as you move — read as
      // "moving blobs". Local position glues the grunge to the metal.
      .replace('#include <fog_vertex>', `#include <fog_vertex>
vWpos = position; vWear = wear; vBary = abary; vAedge = aedge;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWpos;
varying float vWear;
varying vec3 vBary;
varying vec3 vAedge;
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

  // Edge wear: the DOMINANT term is the baked barycentric line — each
  // corner's weight → 0 only at triangle edges flagged sharp (>~30°
  // dihedral) at bake time, and smoothstep on the screen-space width
  // draws a ~1.5px line that hugs the real edge on ANY topology. This is
  // the wireframe-shader trick repurposed — fwidth(vNormal) can't see
  // flat-shaded boxes (constant normal → zero derivative), and vertex
  // wear can only paint whole corner verts, not lines.
  vec3 ew = vBary + (1.0 - vAedge) * 4.0;
  float eDist = min(ew.x, min(ew.y, ew.z));
  float ePx = fwidth(vBary.x) + fwidth(vBary.y) + fwidth(vBary.z);
  // Width in barycentric-derivative units: 1.5 was sub-pixel on these
  // small meshes — needs ~2.5+ to read at game distance.
  float eline = 1.0 - smoothstep(0.0, ePx * 2.5, eDist);
  float curv = length(fwidth(normalize(vNormal)));
  float edge = max(eline,
    max(smoothstep(0.22, 0.7, curv), smoothstep(0.45, 0.95, vWear) * 0.4));

  // Patchy mask so wear clumps in zones like real abrasion, gated to
  // well-lit (unoccluded) faces — crevices don't wear bright. The floor is
  // 0.5 (not 0.35): stacked under exposure × 0.7 mix, a low floor crushed
  // real edges below the visibility threshold — "no edge wear".
  float patches = 0.5 + 0.5 * smoothstep(0.55, 0.8, wnoise(vWpos * 90.0));
  #ifdef USE_COLOR
    float exposure = smoothstep(0.45, 0.85, vColor.g);
  #else
    // Baked-GLB path: AO lives in the texture, no vertex colors — edge
    // wear stays unmasked by exposure (concave hits are rare here).
    float exposure = 1.0;
  #endif
    float wear = edge * patches * exposure;

    // Worn metal: desaturate and brighten edges; slight micro-scratch noise.
    float scratch = wnoise(vWpos * 700.0) * 0.12;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72, 0.70, 0.68), wear * 0.85);
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
