import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { urlParams } from '../core/params.js';

// ?wearviz paints the mask channels instead of shading — R = edge-wear
// mask, G = concave grime. Verifies bake coverage at a glance when the
// effect itself is too subtle to judge.
const WEARVIZ = urlParams.has('wearviz');

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
const RAY_DIST_SCALE = 0.12; // occlusion range = bbox radius × this (crevice scale)
// Spread angle — cosine-weighted sampling is remapped into a ~125° cone
// around the normal instead of the full 180° hemisphere. These weapons
// are DENSE assemblies of intersecting parts: grazing rays (z≈0) leave
// a face and instantly hit the box sitting on it, so every vertex next
// to a wall scored "occluded" and AO went globally dark — the classic
// spread_angle bake problem (Houdini/texture-baker expose the same
// parameter). A cone keeps contact shadows but lets open faces escape.
const CONE_MIN_Z = 0.45; // cos(63°) — rays closer than this to the normal
const EPS = 0.004;           // origin nudge off the surface to avoid self-hit
const MIN_LIGHT = 0.25;      // floor — deepest crevice never hits full black
// Curvature gain: 1-dot(n_v, n_face) on a 90° dihedral is ~0.29 — scale
// so ~45°+ edges already saturate (smooth-shaded bodies diverge little).
const WEAR_GAIN = 7.0;
const _fa = new THREE.Vector3();
const _fb = new THREE.Vector3();
const _fc = new THREE.Vector3();

// Dihedral sharpness for the line-edge mask: 1 - cos(50°). Steep enough
// to keep box corners and hex-ridge breaks (~60-90°) while skipping
// cylinder segment seams — an 8-seg tube's 45° facets are curvature
// approximation, not a designed edge, and lining them read as random
// scratches across flat tube walls.
const SHARP_DIHEDRAL = 0.357;

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
  // 0.1mm weld tolerance — enough for GLB round-trip jitter and
  // toNonIndexed dupes, but at 1mm (toFixed(3)) verts in these small
  // parts (0.015–0.035 walls/floors) collapse into each other: distinct
  // edges merge into one list and a sharp pair's flag lands on a
  // coplanar seam — the "slanted line on a flat face" bug.
  const pk = (i: number) => `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
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
    // c = the corner SLOT (0/1/2) opposite this edge — the barycentric
    // channel the shader reads. Passing the vertex index (3t+2) instead
    // was the phantom-line bug: only tri 0's slots coincided, every
    // other tri scattered its flag into a DIFFERENT tri's channels.
    const add = (a: number, b: number, c: number) => {
      const key = pk(a) < pk(b) ? `${pk(a)}|${pk(b)}` : `${pk(b)}|${pk(a)}`;
      let l = edges.get(key);
      if (!l) edges.set(key, l = []);
      l.push({ t, c, a, b });
    };
    add(v0, v1, 2); // edge 0-1, opposite corner 2
    add(v1, v2, 0); // edge 1-2, opposite corner 0
    add(v2, v0, 1); // edge 2-0, opposite corner 1
  }
  const aedge = new Float32Array(count * 3); // vec3 — flag lives in the corner's own component
  const flaggedKeys = new Set<string>(); // debug: gunlab draws these as red overlay
  for (const [key, list] of edges) {
    // Boundary edges (unmatched halves — T-junctions, triangulation
    // seams, cross-mesh contacts) are NOT auto-sharp: they sit ON flat
    // faces and paint phantom wear diagonals. All our primitives are
    // closed solids, so a shared-edge dihedral is the only signal that
    // counts.
    if (list.length < 2) continue;
    // Test ALL pairs, not just [0],[1]: the 1mm weld can merge two
    // DISTINCT geometric edges into one list (dense small geometry —
    // chamfers, ring steps), and picking one pair decided for every
    // ref — sharp edges were flagged onto coplanar seams and real
    // edges skipped when their first two refs were flat. Flag only the
    // tris of a genuinely sharp pair; !(>t) keeps NaN normals failing.
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i]!, y = list[j]!;
        const dn = faceN[x.t * 3]! * faceN[y.t * 3]! + faceN[x.t * 3 + 1]! * faceN[y.t * 3 + 1]! + faceN[x.t * 3 + 2]! * faceN[y.t * 3 + 2]!;
        if (!(1 - dn > SHARP_DIHEDRAL)) continue;
        // Flag in ALL THREE corners of channel c — storing it only at the
        // opposite corner interpolates the flag to zero exactly at the edge
        // it marks (vAedge.c ≈ bary.c → 0), so the line could never draw.
        // Constant flags across the tri give a real distance-to-edge field.
        // Flag EVERY ref on this edge, not just the sharp pair: duplicated
        // verts / T-junctions put a coplanar third tri on the same key —
        // unflagged, its side of the seam has no distance field and the
        // wear line visibly cuts where triangles switch on a flat face.
        for (const e of list) for (let v = 0; v < 3; v++) aedge[(e.t * 3 + v) * 3 + e.c] = 1;
        flaggedKeys.add(key);
      }
    }
  }
  // Continuation pass — a crease crossing a coplanar triangulation seam is
  // ONE geometric edge, but the seam vertex splits it per-tri: X owns
  // A→C, the sibling tri owns C→D. When the continuation fails its own
  // pair test (boundary/T-junction there), the wear line dies exactly at
  // the seam. Propagate flags to unflagged COLLINEAR edges that share an
  // endpoint and live in a tri coplanar with the flagged face —
  // transitively, so polylines heal end-to-end.
  const vmap = new Map<string, string[]>(); // welded vert key → edge keys
  for (const [key, list] of edges) {
    const e = list[0]!;
    for (const ep of [e.a, e.b]) {
      const vk = pk(ep);
      let l = vmap.get(vk);
      if (!l) vmap.set(vk, l = []);
      l.push(key);
    }
  }
  const _d = new THREE.Vector3(), _d2 = new THREE.Vector3();
  const dirOf = (e: { a: number; b: number }, out: THREE.Vector3) =>
    out.set(pos.getX(e.b) - pos.getX(e.a), pos.getY(e.b) - pos.getY(e.a), pos.getZ(e.b) - pos.getZ(e.a)).normalize();
  const queue = [...flaggedKeys];
  while (queue.length) {
    const key = queue.pop()!;
    const list = edges.get(key)!;
    dirOf(list[0]!, _d);
    for (const ep of [list[0]!.a, list[0]!.b]) {
      for (const k2 of vmap.get(pk(ep)) ?? []) {
        if (k2 === key || flaggedKeys.has(k2)) continue;
        const l2 = edges.get(k2)!;
        dirOf(l2[0]!, _d2);
        if (Math.abs(_d.dot(_d2)) < 0.995) continue; // not a straight continuation
        // Continuation must sit in a tri coplanar with one of the
        // flagged edge's incident faces — else it's a different crease.
        let coplanar = false;
        for (const r2 of l2) {
          for (const r of list) {
            const dn = faceN[r2.t * 3]! * faceN[r.t * 3]! + faceN[r2.t * 3 + 1]! * faceN[r.t * 3 + 1]! + faceN[r2.t * 3 + 2]! * faceN[r.t * 3 + 2]!;
            if (1 - dn < 0.02) { coplanar = true; break; }
          }
          if (coplanar) break;
        }
        if (!coplanar) continue;
        for (const r of l2) for (let v = 0; v < 3; v++) aedge[(r.t * 3 + v) * 3 + r.c] = 1;
        flaggedKeys.add(k2);
        queue.push(k2);
      }
    }
  }
  // T-junction heal — the split is one-sided: face A keeps edge A→D while
  // face B cuts it at a mid vertex V, so B's halves land on DIFFERENT
  // keys and never pair (skipped as boundary). The halves share no
  // endpoint with A→D either, so vmap can't reach them. Match by
  // geometry instead: a lone edge whose midpoint lies on a flagged
  // segment is the same physical crease — flag it, transitively.
  const _m = new THREE.Vector3(), _pa = new THREE.Vector3(), _pb = new THREE.Vector3(), _cp = new THREE.Vector3();
  const segOf = (e: { a: number; b: number }) => {
    _pa.set(pos.getX(e.a), pos.getY(e.a), pos.getZ(e.a));
    _pb.set(pos.getX(e.b), pos.getY(e.b), pos.getZ(e.b));
  };
  const pointOnSeg = (p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) => {
    _d2.subVectors(b, a);
    const len = _d2.length();
    if (len < 1e-9) return false;
    _d2.divideScalar(len);
    const t = _d.subVectors(p, a).dot(_d2);
    if (t < -1e-4 || t > len + 1e-4) return false;
    _cp.copy(a).addScaledVector(_d2, t);
    return _cp.distanceToSquared(p) < 1e-6;
  };
  let healed = true;
  while (healed) {
    healed = false;
    for (const [key, list] of edges) {
      if (flaggedKeys.has(key)) continue;
      segOf(list[0]!);
      _m.addVectors(_pa, _pb).multiplyScalar(0.5);
      let onCrease = false;
      for (const fk of flaggedKeys) {
        const fe = edges.get(fk)![0]!;
        _pa.set(pos.getX(fe.a), pos.getY(fe.a), pos.getZ(fe.a));
        _pb.set(pos.getX(fe.b), pos.getY(fe.b), pos.getZ(fe.b));
        if (pointOnSeg(_m, _pa, _pb)) { onCrease = true; break; }
      }
      if (!onCrease) continue;
      for (const r of list) for (let v = 0; v < 3; v++) aedge[(r.t * 3 + v) * 3 + r.c] = 1;
      flaggedKeys.add(key);
      healed = true;
    }
  }
  // Debug breadcrumb for the gunlab wire view: the actual segment list the
  // flagger produced — gaps here mean detection, gaps ONLY in the shader
  // wear line mean interpolation.
  if (flaggedKeys.size) {
    const segs = new Float32Array(flaggedKeys.size * 6);
    const refs: { t: number; a: number; b: number }[] = [];
    let w = 0;
    for (const key of flaggedKeys) {
      const list = edges.get(key)!;
      const e = list[0]!;
      segs[w++] = pos.getX(e.a); segs[w++] = pos.getY(e.a); segs[w++] = pos.getZ(e.a);
      segs[w++] = pos.getX(e.b); segs[w++] = pos.getY(e.b); segs[w++] = pos.getZ(e.b);
      for (const r of list) refs.push({ t: r.t, a: r.a, b: r.b });
    }
    geo.userData.__sharpEdges = segs;
    geo.userData.__sharpEdgeRefs = refs;
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
  const aalt = new Float32Array(count * 3);
  const _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vc = new THREE.Vector3(), _ab = new THREE.Vector3(), _ac = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    abary[(t * 3) * 3] = 1;
    abary[(t * 3 + 1) * 3 + 1] = 1;
    abary[(t * 3 + 2) * 3 + 2] = 1;
    // Per-channel altitude (corner → opposite edge, object units):
    // bary.c × altitude = the fragment's TRUE distance to that edge, so
    // the shader can size wear lines in world units instead of constant
    // screen pixels — wear is a physical feature, it should zoom.
    const v = [t * 3, t * 3 + 1, t * 3 + 2];
    _va.fromBufferAttribute(pos, v[0]!);
    _vb.fromBufferAttribute(pos, v[1]!);
    _vc.fromBufferAttribute(pos, v[2]!);
    for (let c = 0; c < 3; c++) {
      const a = (c + 1) % 3, b = (c + 2) % 3;
      const pa = [_va, _vb, _vc][a]!, pb = [_va, _vb, _vc][b]!, pc = [_va, _vb, _vc][c]!;
      _ab.subVectors(pb, pa);
      _ac.subVectors(pc, pa);
      const len = _ab.length();
      const alt = len < 1e-9 ? 0 : _ac.cross(_ab).length() / len;
      for (let k = 0; k < 3; k++) aalt[(t * 3 + k) * 3 + c] = alt;
    }
  }
  geo.setAttribute('aedge', new THREE.BufferAttribute(aedge, 3));
  geo.setAttribute('abary', new THREE.BufferAttribute(abary, 3));
  geo.setAttribute('aalt', new THREE.BufferAttribute(aalt, 3));
}

// ——— Edge-strip overlay ——————————————————————————————————————————
// Wear mask atlas — the real fix for "the line cuts where triangles
// switch": instead of a per-triangle barycentric field (which can only
// exist inside whichever tri owns the edge), every triangle gets its own
// small UV cell and the flagged edge segments are RASTERIZED into that
// UV space at bake time. Coplanar and T-junction neighbors paint their
// own half of the line, so triangulation can't cut it — and it's a
// texture lookup, zero extra geometry, no z-fighting. The dirt/noise
// breakup is baked in at raster time, glued to the metal forever.
const WEAR_CELL = 32;   // px per triangle cell
const WEAR_MARGIN = 7;  // bleed room for the soft edge + mips
const WEAR_LINE = 0.004; // world-space half-width of the wear line

const _wA = new THREE.Vector3(), _wB = new THREE.Vector3(), _wC = new THREE.Vector3();
const _wE1 = new THREE.Vector3(), _wE2 = new THREE.Vector3(), _wN = new THREE.Vector3();

// JS port of the shader's value-noise — identical constants so the
// baked texture matches the surface mask (see whash/wnoise below).
function wHash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
function wNoise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const c = (dx: number, dy: number, dz: number) => wHash3(ix + dx, iy + dy, iz + dz);
  return c(0, 0, 0) * (1 - fx) * (1 - fy) * (1 - fz)
    + c(1, 0, 0) * fx * (1 - fy) * (1 - fz)
    + c(0, 1, 0) * (1 - fx) * fy * (1 - fz)
    + c(1, 1, 0) * fx * fy * (1 - fz)
    + c(0, 0, 1) * (1 - fx) * (1 - fy) * fz
    + c(1, 0, 1) * fx * (1 - fy) * fz
    + c(0, 1, 1) * (1 - fx) * fy * fz
    + c(1, 1, 1) * fx * fy * fz;
}
const wFbm3 = (x: number, y: number, z: number) =>
  0.5 * wNoise3(x, y, z) + 0.25 * wNoise3(x * 2.17, y * 2.17, z * 2.17) + 0.125 * wNoise3(x * 4.31, y * 4.31, z * 4.31);
const sstep = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

let _blankWearTex: THREE.Texture | null = null;
let _whiteTex: THREE.Texture | null = null;
function blankWearTex(): THREE.Texture {
  if (!_blankWearTex) {
    _blankWearTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    _blankWearTex.needsUpdate = true;
  }
  return _blankWearTex;
}
// Grime masks multiply the albedo — the no-file default must be WHITE
// (no dirt), not the wear map's black.
function whiteTex(): THREE.Texture {
  if (!_whiteTex) {
    _whiteTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    _whiteTex.needsUpdate = true;
  }
  return _whiteTex;
}

/** Rasterize the flagged edge segments into a per-triangle UV atlas and
 *  write the matching `uv` attribute. Texture goes on userData.__wearTex;
 *  the weapon shader picks it up via material.userData.__wearTex. */
function bakeWearTexture(geo: THREE.BufferGeometry): void {
  // Baked GLBs carry a real unwrap shared with their ao.png + the
  // blend's exported edge bake — the atlas would clobber that uv.
  if (geo.userData.__keepUv) return;
  const refs = geo.userData.__sharpEdgeRefs as { t: number; a: number; b: number }[] | undefined;
  if (!refs || !refs.length) return;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const triCount = pos.count / 3;
  const cols = Math.ceil(Math.sqrt(triCount));
  const size = Math.min(2048, cols * WEAR_CELL);
  const cpr = Math.floor(size / WEAR_CELL);
  const uvs = new Float32Array(pos.count * 2);
  // Per-tri: local 2D frame (u = first edge, v = in-plane perpendicular)
  // scaled so the tri fits its cell; uv per corner = cell-space coords.
  const triScale = new Float32Array(triCount);
  const triOrg = new Float32Array(triCount * 2);
  const triE1: [number, number, number][] = [], triE2: [number, number, number][] = [];
  for (let t = 0; t < triCount; t++) {
    _wA.fromBufferAttribute(pos, t * 3);
    _wB.fromBufferAttribute(pos, t * 3 + 1);
    _wC.fromBufferAttribute(pos, t * 3 + 2);
    _wE1.subVectors(_wB, _wA);
    const d = _wE1.length() || 1e-9;
    _wE1.divideScalar(d);
    _wE2.subVectors(_wC, _wA);
    _wN.crossVectors(_wE1, _wE2).normalize();
    _wE2.crossVectors(_wN, _wE1);
    const dxC = _wC.x - _wA.x, dyC = _wC.y - _wA.y, dzC = _wC.z - _wA.z;
    const px = dxC * _wE1.x + dyC * _wE1.y + dzC * _wE1.z;
    const py = dxC * _wE2.x + dyC * _wE2.y + dzC * _wE2.z;
    const ext = Math.max(d, px, Math.abs(py)) || 1e-9;
    const scale = (WEAR_CELL - 2 * WEAR_MARGIN) / ext;
    triScale[t] = scale;
    const cx0 = (t % cpr) * WEAR_CELL, cy0 = Math.floor(t / cpr) * WEAR_CELL;
    triOrg[t * 2] = cx0 + WEAR_MARGIN;
    triOrg[t * 2 + 1] = cy0 + WEAR_MARGIN;
    triE1[t] = [_wE1.x, _wE1.y, _wE1.z];
    triE2[t] = [_wE2.x, _wE2.y, _wE2.z];
    for (let v = 0; v < 3; v++) {
      const i = t * 3 + v;
      _wB.fromBufferAttribute(pos, i).sub(_wA);
      const lx = _wB.x * triE1[t][0] + _wB.y * triE1[t][1] + _wB.z * triE1[t][2];
      const ly = _wB.x * triE2[t][0] + _wB.y * triE2[t][1] + _wB.z * triE2[t][2];
      uvs[i * 2] = (triOrg[t * 2] + lx * scale) / size;
      uvs[i * 2 + 1] = (triOrg[t * 2 + 1] + ly * scale) / size;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.lineCap = 'round';
  // Rasterize each flagged segment inside every tri that owns it —
  // subdivided so the noise can fade individual pieces out. Two passes:
  // a wide faint bleed (the smear) then the core line.
  const toUV = (t: number, i: number): [number, number] => {
    _wB.fromBufferAttribute(pos, i);
    const pa = pos;
    _wA.fromBufferAttribute(pa, t * 3);
    _wB.sub(_wA);
    const lx = _wB.x * triE1[t][0] + _wB.y * triE1[t][1] + _wB.z * triE1[t][2];
    const ly = _wB.x * triE2[t][0] + _wB.y * triE2[t][1] + _wB.z * triE2[t][2];
    return [triOrg[t * 2] + lx * triScale[t], triOrg[t * 2 + 1] + ly * triScale[t]];
  };
  for (const r of refs) {
    const [ax, ay] = toUV(r.t, r.a);
    const [bx, by] = toUV(r.t, r.b);
    const wlen = _wA.fromBufferAttribute(pos, r.a).distanceTo(_wB.fromBufferAttribute(pos, r.b));
    const pieces = Math.max(2, Math.ceil(wlen / 0.004));
    const lwCore = Math.max(1, WEAR_LINE * 2 * triScale[r.t]);
    for (let k = 0; k < pieces; k++) {
      const t0 = k / pieces, t1 = (k + 1) / pieces;
      const mx = ax + (bx - ax) * (t0 + t1) / 2, my = ay + (by - ay) * (t0 + t1) / 2;
      // Object-space midpoint for the noise — same coords the surface
      // wear samples, so chips land where the face wear does.
      _wA.fromBufferAttribute(pos, r.a); _wB.fromBufferAttribute(pos, r.b);
      const ox = _wA.x + (_wB.x - _wA.x) * (t0 + t1) / 2;
      const oy = _wA.y + (_wB.y - _wA.y) * (t0 + t1) / 2;
      const oz = _wA.z + (_wB.z - _wA.z) * (t0 + t1) / 2;
      const n = wFbm3(ox * 90, oy * 90, oz * 90);
      const amp = 0.35 + 0.65 * sstep(0.35, 0.75, n); // mostly solid, noisy bite
      if (amp < 0.42) continue; // rare worn-through pinhole
      const x0 = ax + (bx - ax) * t0, y0 = ay + (by - ay) * t0;
      const x1 = ax + (bx - ax) * t1, y1 = ay + (by - ay) * t1;
      ctx.globalAlpha = amp * 0.4;
      ctx.lineWidth = lwCore * 2.4;
      ctx.strokeStyle = '#fff';
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.globalAlpha = amp;
      ctx.lineWidth = lwCore;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  geo.userData.__wearTex = tex;
}

/** Backwards-compat shim: kept name so existing call sites stay — now
 *  rasterizes the wear atlas instead of attaching strip geometry. */
export function attachEdgeWear(mesh: THREE.Mesh): void {
  bakeWearTexture(mesh.geometry);
}

/** Per-vertex convexity bake — Substance's curvature input, at vertex res.
 *  Vertex normals on a hard edge diverge from the flat face normals of
 *  their incident triangles; flat-shaded plates stay at ~0. Concave
 *  edges score too, but the shader gates wear by AO exposure, so crevices
 *  stay dark and only sun-facing edges whiten — the reverse-weighting
 *  trick (wear = convexity AND unoccluded). */
function bakeWear(geo: THREE.BufferGeometry, grime = false, wearBoost = 0): void {
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
  if (wearBoost) geo.setAttribute('awear', new THREE.BufferAttribute(new Float32Array(count).fill(wearBoost), 1));
  if (grime) bakeGrime(geo, pos, count, triCount, idx);
}

/** Signed-curvature split — the half of Blender-style edge wear the
 *  vertex-vs-face divergence can't express: it scores magnitude only,
 *  so a convex ridge and a concave groove look identical. Walk welded
 *  edges instead: an edge is CONVEX when the neighbouring tri's
 *  centroid sits below this tri's plane (the two faces bend away like a
 *  roof), CONCAVE when it sits above (valley). Convex feeds the bright
 *  wear line; concave feeds `grime` — a soft dark mask for crevices,
 *  thresholded shallower (~15°) than the wear line so panel seams,
 *  collar roots and lip junctions all collect dirt. */
function bakeGrime(geo: THREE.BufferGeometry, pos: THREE.BufferAttribute, count: number, triCount: number, idx: THREE.BufferAttribute | null): void {
  const pk = (i: number) => `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
  interface EdgeRef { t: number; c: number; a: number; b: number }
  const edges = new Map<string, EdgeRef[]>();
  const faceN = new Float32Array(triCount * 3);
  const faceC = new Float32Array(triCount * 3);
  const _n = new THREE.Vector3(), _ca = new THREE.Vector3(), _cb = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    const v = [idx ? idx.getX(t * 3) : t * 3, idx ? idx.getX(t * 3 + 1) : t * 3 + 1, idx ? idx.getX(t * 3 + 2) : t * 3 + 2];
    _fa.fromBufferAttribute(pos, v[0]!);
    _fb.fromBufferAttribute(pos, v[1]!);
    _fc.fromBufferAttribute(pos, v[2]!);
    _ca.copy(_fa).add(_fb).add(_fc).multiplyScalar(1 / 3);
    faceC[t * 3] = _ca.x; faceC[t * 3 + 1] = _ca.y; faceC[t * 3 + 2] = _ca.z;
    _fb.sub(_fa); _fc.sub(_fa);
    _n.crossVectors(_fb, _fc).normalize();
    faceN[t * 3] = _n.x; faceN[t * 3 + 1] = _n.y; faceN[t * 3 + 2] = _n.z;
    for (const [a, b, c] of [[0, 1, 2], [1, 2, 0], [2, 0, 1]] as const) {
      const ka = pk(v[a]!), kb = pk(v[b]!);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      let l = edges.get(key);
      if (!l) edges.set(key, l = []);
      l.push({ t, c, a: v[a]!, b: v[b]! });
    }
  }
  const grime = new Float32Array(count);
  const CONCAVE_DIHEDRAL = 0.034; // 1 - cos(15°)
  for (const list of edges.values()) {
    if (list.length !== 2) continue; // boundary rims: no valley either side
    const [x, y] = [list[0]!, list[1]!];
    const dn = faceN[x.t * 3]! * faceN[y.t * 3]! + faceN[x.t * 3 + 1]! * faceN[y.t * 3 + 1]! + faceN[x.t * 3 + 2]! * faceN[y.t * 3 + 2]!;
    if (1 - dn < CONCAVE_DIHEDRAL) continue;
    // Concavity test: y's centroid vs x's plane. A point on the shared
    // edge anchors the plane; sign of n·(c_y - edgePoint) tells which
    // side of x's face y bends toward. Negative = bends under = valley.
    _ca.fromBufferAttribute(pos, x.a); // edge endpoint = plane point
    _cb.set(faceC[y.t * 3]!, faceC[y.t * 3 + 1]!, faceC[y.t * 3 + 2]!).sub(_ca);
    const side = _cb.x * faceN[x.t * 3]! + _cb.y * faceN[x.t * 3 + 1]! + _cb.z * faceN[x.t * 3 + 2]!;
    if (side >= 0) continue; // convex — wear line already claims it
    const g = Math.min(1, (1 - dn) * 3); // steeper groove → deeper grime
    for (const e of list) { grime[e.a] = Math.max(grime[e.a]!, g); grime[e.b] = Math.max(grime[e.b]!, g); }
  }
  geo.setAttribute('grime', new THREE.BufferAttribute(grime, 1));
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

// Deterministic hemisphere dirs (cosine-weighted Fibonacci) — random
// jitter made every vertex sample a different sky, so occlusion halos
// came out lopsided and speckled. One shared dir set gives smooth AO
// gradients; the shader's fbm supplies the surface mottle instead.
const HEMI_DIRS: [number, number, number][] = (() => {
  const dirs: [number, number, number][] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < RAYS; i++) {
    const t = (i + 0.5) / RAYS;
    const z = CONE_MIN_Z + (1 - CONE_MIN_Z) * Math.sqrt(1 - t * t);
    const a = i * golden;
    const r = Math.sqrt(1 - z * z);
    dirs.push([Math.cos(a) * r, Math.sin(a) * r, z]);
  }
  return dirs;
})();
function bakeMesh(mesh: THREE.Mesh, occluder: THREE.Mesh, rayDist: number, grime = false, wearBoost = 0): void {
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
      const [tx, ty, tz] = HEMI_DIRS[r]!;
      _dir.copy(_n).multiplyScalar(tz)
        .addScaledVector(_tan, tx)
        .addScaledVector(_bitan, ty)
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
  // Weld coincident corners that agree on position AND normal direction:
  // per-corner raycasts jitter occlusion a few rays either way, and the
  // interpolated AO then steps at coplanar tri seams — wear/grime masks
  // visibly cut where triangles switch on a flat face. Same surface
  // point + same shading normal must get the same light; split-normal
  // verts on hard edges keep their own values.
  const weld = new Map<string, number[]>();
  for (let i = 0; i < count; i++) {
    const k = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}|${nor.getX(i).toFixed(2)},${nor.getY(i).toFixed(2)},${nor.getZ(i).toFixed(2)}`;
    let l = weld.get(k);
    if (!l) weld.set(k, l = []);
    l.push(i);
  }
  for (const l of weld.values()) {
    if (l.length < 2) continue;
    let s = 0;
    for (const i of l) s += colors[i * 3]!;
    const a = s / l.length;
    for (const i of l) colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = a;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  bakeWear(geo, grime, wearBoost);
  bakeEdgeLines(geo);
  attachEdgeWear(mesh);
}

/** Curvature-only bake for meshes that already carry baked AO textures
 *  (the vmBaked swap path) — same wear attribute + shader, no raycast AO. */
export function bakeWearOnly(group: THREE.Group, opts: { grime?: boolean; wearBoost?: number } = {}): void {
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    ensureNonIndexed(m);
    // Always rebake — GLBs can carry a STALE wear attribute round-tripped
    // through the dump pipeline (baked before the hard-edge pass existed).
    bakeWear(m.geometry, opts.grime, opts.wearBoost);
    bakeEdgeLines(m.geometry);
    attachEdgeWear(m);
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) if (mat && mat.type !== 'MeshBasicMaterial') {
      mat.userData.__wearTex = m.geometry.userData.__wearTex ?? null;
      mat.userData.__grimeTex = m.geometry.userData.__grimeTex ?? null;
      enhanceWeaponMaterial(mat);
    }
  });
}

/** Bake vertex AO into every mesh of a group. Call after the group's local
 *  transforms are final (add to a parent first or updateWorldMatrix). */
export function bakeVertexAO(group: THREE.Group, opts: { grime?: boolean; wearBoost?: number } = {}): void {
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
    bakeMesh(m, occluder, rayDist, opts.grime, opts.wearBoost);
    const mat = m.material as THREE.Material & { vertexColors?: boolean };
    if (mat) {
      mat.vertexColors = true;
      mat.userData.__wearTex = m.geometry.userData.__wearTex ?? null;
      mat.userData.__grimeTex = m.geometry.userData.__grimeTex ?? null;
      mat.needsUpdate = true;
      enhanceWeaponMaterial(mat);
    }
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
    if (WEARVIZ) sh.defines = { ...(sh.defines ?? {}), WEARVIZ: 1 };
    sh.uniforms.uWearMap = { value: (mat.userData.__wearTex as THREE.Texture) ?? blankWearTex() };
    sh.uniforms.uGrimeMap = { value: (mat.userData.__grimeTex as THREE.Texture) ?? whiteTex() };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
varying vec2 vUvW;
varying vec3 vWpos;
attribute float wear; varying float vWear;
attribute float grime; varying float vGrime;
attribute float awear; varying float vAw;
attribute vec3 abary; varying vec3 vBary;
attribute vec3 aedge; varying vec3 vAedge;
attribute vec3 aalt; varying vec3 vAlt;`)
      // OBJECT space, not world: the viewmodel rides the camera, so a
      // world-space field swims across the gun as you move — read as
      // "moving blobs". Local position glues the grunge to the metal.
      .replace('#include <fog_vertex>', `#include <fog_vertex>
vWpos = position; vWear = wear; vBary = abary; vAedge = aedge; vAlt = aalt; vGrime = grime; vAw = awear;
vUvW = uv;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uWearMap;
uniform sampler2D uGrimeMap;
varying vec2 vUvW;
varying vec3 vWpos;
varying float vWear;
varying float vGrime;
varying float vAw;
varying vec3 vBary;
varying vec3 vAedge;
varying vec3 vAlt;
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
  // corner's weight → 0 only at triangle edges flagged sharp (>~50°
  // dihedral) at bake time, and smoothstep on the screen-space width
  // draws a ~2px line that hugs the real edge on ANY topology. The old
  // fwidth(vNormal) fallback is GONE: it measured screen-space normal
  // sweep, so smooth-shaded surfaces (tube walls, octagonal slabs) lit
  // up wherever normals interpolated fast — phantom wear on flat faces.
  // The crisp wear LINE comes from the baked UV atlas — the edge
  // segments were rasterized per-triangle at bake time, so coplanar
  // and T-junction neighbors paint their own half and no triangulation
  // seam can cut it. The vertex-level accent stays: hot corner verts
  // read as chipped paint, but the 0.6 floor keeps smooth-normal
  // divergence on curved walls (≈0.5 baked) from painting whole faces.
  // World-space width: bary weight × the corner's baked altitude is the
  // distance-to-edge in METERS — the line is a fixed ~9mm wear band that
  // scales with zoom like the metal, not a constant-pixel overlay.
  vec3 ew = (vBary + (1.0 - vAedge) * 4.0) * vAlt;
  float eDist = min(ew.x, min(ew.y, ew.z));
  float eline = 1.0 - smoothstep(0.002, 0.009, eDist);
  float edge = max(eline, max(texture2D(uWearMap, vUvW).r * 0.5, smoothstep(0.6, 0.95, vWear) * 0.4));

  // Patchy mask so wear clumps in zones like real abrasion, gated to
  // well-lit (unoccluded) faces — crevices don't wear bright. The floor is
  // 0.5 (not 0.35): stacked under exposure × 0.7 mix, a low floor crushed
  // real edges below the visibility threshold — "no edge wear".
  float patches = 0.5 + 0.5 * smoothstep(0.55, 0.8, wnoise(vWpos * 90.0));
  #ifdef USE_COLOR
    // AO owns the mask — occluded crevices get NO bright wear. The band
    // is anchored at the bake's MIN_LIGHT floor (0.25): a fixed 0.45
    // cutoff was above most of this weapon's actual AO, so exposure
    // went ~0 everywhere and nothing wore.
    float exposure = smoothstep(0.28, 0.75, vColor.g);
  #else
    // Baked-GLB path: AO lives in the texture, no vertex colors — edge
    // wear stays unmasked by exposure (concave hits are rare here).
    float exposure = 1.0;
  #endif
    // awear: per-weapon boost attr (unbaked/absent → 0 → ×1 unchanged).
    float wear = min(1.0, edge * patches * exposure * (1.0 + vAw));

    // Worn metal: desaturate and brighten edges; slight micro-scratch noise.
    float scratch = wnoise(vWpos * 700.0) * 0.12;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.86, 0.84), wear * 0.95);
    diffuseColor.rgb *= 1.0 - wear * scratch;

    // Baked grime map (the bakery's full-material branch): a mostly-white
    // mask whose dark response is broad dirt — multiplies the albedo where
    // a weapon has the file, blank everywhere else.
    float grimeB = texture2D(uGrimeMap, vUvW).r;
    diffuseColor.rgb *= mix(1.0, grimeB, 0.45);

    // Concave grime — the signed-curvature complement of edge wear:
    // baked per-vertex on valley edges, darkened + dirtied with the same
    // patchy clumping so seams read as collected crud, not a uniform
    // shade ramp.
    float dirt = vGrime * (0.6 + 0.4 * wnoise(vWpos * 110.0 + 31.7));
    diffuseColor.rgb *= 1.0 - dirt * 0.38;
  #ifdef WEARVIZ
    // R=final wear, G=baked AO (the exposure gate input), B=edge flag.
    // AO replaced grime here — when wear reads wrong, the AO values are
    // almost always the thing that needs eyeballing.
    #ifdef USE_COLOR
      diffuseColor.rgb = vec3(wear, vColor.g, edge);
    #else
      diffuseColor.rgb = vec3(wear, 0.0, edge);
    #endif
  #endif

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
