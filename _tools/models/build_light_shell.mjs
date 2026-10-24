#!/usr/bin/env node
// Juggernaut from analytic primitives. Each primitive (frustum, ellipsoid,
// rounded box) is tessellated as its OWN flat-shaded plate — armor plates
// don't melt into each other. An earlier SDF smooth-union version welded
// the legs into a skirt and sawtoothed every material seam; plates rigidly
// follow their bone, which is also how armor actually articulates.
// Skeleton, skin joints, mesh-node dequantisation and every baked clip are
// copied from class_scout.glb.
//
//   node _tools/models/build_juggernaut.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'client/public/assets/models/class_scout.glb');
const OUT = join(ROOT, 'client/public/assets/models/class_light_shell.glb');

const ARMOR = 0, DARK = 1, ACCENT = 2;

// ---------- silhouette ----------
// Blender frame: +X left, -Y front, +Z up. Rest pose is the M2M T.
const P = [];
const cone = (a, b, r1, r2, bone, mat) => P.push({ t: 'cone', a, b, r1, r2, bone, mat });
const box = (c, h, r, bone, mat) => P.push({ t: 'box', c, h, r, bone, mat });
const ell = (c, r, bone, mat) => P.push({ t: 'ell', c, r, bone, mat });

// LIGHT PLATE: scout-class proportions, written directly — narrow
// torso, small pauldron caps, thin limbs, small helm. Not a scaled jugg.
for (const [s, sx] of [['l', 1], ['r', -1]]) {
  cone([sx * 0.089, 0, 0.93], [sx * 0.089, 0, 0.53], 0.055, 0.05, 'thigh_' + s, DARK);
  cone([sx * 0.089, 0, 0.53], [sx * 0.089, 0, 0.12], 0.05, 0.045, 'calf_' + s, DARK);
  cone([sx * 0.089, 0, 0.9], [sx * 0.089, 0, 0.56], 0.085, 0.07, 'thigh_' + s, ARMOR);
  cone([sx * 0.089, 0, 0.5], [sx * 0.089, -0.01, 0.14], 0.07, 0.055, 'calf_' + s, ARMOR);
  cone([sx * 0.19, 0, 1.44], [sx * 0.47, 0.07, 1.44], 0.05, 0.045, 'upperarm_' + s, DARK);
  cone([sx * 0.47, 0.07, 1.44], [sx * 0.74, 0.065, 1.44], 0.045, 0.04, 'lowerarm_' + s, DARK);
  ell([sx * 0.22, 0, 1.47], [0.16, 0.17, 0.14], 'clavicle_' + s, ARMOR);
  ell([sx * 0.7, 0.065, 1.44], [0.08, 0.09, 0.09], 'hand_' + s, DARK);
}
ell([0, 0, 1.38], [0.26, 0.2, 0.22], 'spine_03', ARMOR);
ell([0, 0, 1.0], [0.2, 0.14, 0.14], 'pelvis', DARK);
ell([0, 0, 1.6], [0.12, 0.13, 0.13], 'head', ARMOR);

// joint connectors: overlapping spheres so limbs never show a gap in the aim pose
ell([0, 0, 0.93], [0.13, 0.08, 0.06], 'pelvis', DARK);
for (const [s, sx] of [['l', 1], ['r', -1]]) {
  ell([sx * 0.089, 0, 0.93], [0.075, 0.075, 0.075], 'thigh_' + s, DARK);
  ell([sx * 0.089, -0.02, 0.53], [0.07, 0.07, 0.07], 'calf_' + s, DARK);
  ell([sx * 0.19, 0, 1.44], [0.075, 0.075, 0.075], 'upperarm_' + s, DARK);
  ell([sx * 0.47, 0.07, 1.44], [0.065, 0.065, 0.065], 'lowerarm_' + s, DARK);
}

// waist + chest spine: overlapping ellipsoids so the torso is one column
ell([0, 0, 0.98], [0.15, 0.12, 0.09], 'pelvis', DARK);
ell([0, 0, 1.12], [0.15, 0.13, 0.1], 'spine_01', DARK);
ell([0, 0, 1.28], [0.16, 0.14, 0.11], 'spine_03', DARK);

// shell legs: thick plated thighs over slim shins — the thigh carries the mass
for (const [s, sx] of [['l', 1], ['r', -1]]) {
  cone([sx * 0.089, 0, 0.95], [sx * 0.089, 0, 0.53], 0.12, 0.08, 'thigh_' + s, DARK);
  cone([sx * 0.089, 0, 0.53], [sx * 0.089, 0, 0.12], 0.075, 0.045, 'calf_' + s, ARMOR);
  box([sx * 0.089, -0.11, 0.75], [0.07, 0.025, 0.2], 0.015, 'thigh_' + s, ARMOR);
  ell([sx * 0.089, -0.03, 0.55], [0.07, 0.06, 0.06], 'calf_' + s, DARK);
}
// shell boot: one smooth dark-suit ellipsoid foot under a big shell cap
for (const [s, sx] of [['l', 1], ['r', -1]]) {
  ell([sx * 0.089, -0.05, 0.08], [0.1, 0.17, 0.08], 'foot_' + s, DARK);
  ell([sx * 0.089, -0.04, 0.12], [0.11, 0.13, 0.09], 'foot_' + s, ARMOR);
}

// ---------- analytic tessellation ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

// Triangle soup per material — each entry {p:[x,y,z], n:[x,y,z], bone, mat}
// positions/normals in Blender frame; converted at GLB write.
const groups = [[], [], []];
const TAU = Math.PI * 2;

function tri(a, b, c, bone, mat) {
  const n = unit(cross(sub(b, a), sub(c, a)));
  for (const p of [a, b, c]) {groups[mat].push({ p, n, bone });}
}

// Any orthonormal basis around dir.
function basis(dir) {
  const d = unit(dir);
  const ref = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const u = unit(cross(d, ref));
  const v = cross(d, u);
  return [d, u, v];
}

// Tapered capsule (frustum), N sides + end caps.
function meshCone(a, b, r1, r2, bone, mat, N = 10) {
  const [d, u, v] = basis(sub(b, a));
  const ring = (c, r) => Array.from({ length: N }, (_, i) => {
    const t = (i / N) * TAU;
    return add3(c, add3(mul3(u, Math.cos(t) * r), mul3(v, Math.sin(t) * r)));
  });
  const ra = ring(a, r1), rb = ring(b, r2);
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    tri(ra[i], ra[j], rb[j], bone, mat);
    tri(ra[i], rb[j], rb[i], bone, mat);
  }
  // caps — fan around centre, skipped when the end tapers to a point
  if (r1 > 0.01) {for (let i = 0; i < N; i++) {tri(a, ra[(i + 1) % N], ra[i], bone, mat);}}
  if (r2 > 0.01) {for (let i = 0; i < N; i++) {tri(b, rb[i], rb[(i + 1) % N], bone, mat);}}
}

// Corner-chamfered box: faces stay flat but every corner is truncated
// into a triangle, so plates stop reading as literal cubes. `ch` is the
// chamfer depth — larger on the carapace, small on sabatons.
function meshBox(c, h, ch, bone, mat) {
  const [cx, cy, cz] = c, [hx, hy, hz] = h;
  const k = Math.min(ch, Math.min(hx, hy, hz) * 0.9);
  if (k <= 0.001) {
    const v = [
      [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz], [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz],
      [cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz], [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz],
    ];
    const F = [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1],
               [2, 6, 7], [2, 7, 3], [0, 3, 7], [0, 7, 4], [1, 5, 6], [1, 6, 2]];
    for (const [i, j, l] of F) {tri(v[i], v[j], v[l], bone, mat);}
    return;
  }
  // Winding fix: flip any tri whose normal doesn't point away from centre.
  const triO = (a, b, d) => {
    const n = cross(sub(b, a), sub(d, a));
    const m = [a[0] + b[0] + d[0] - 3 * cx, a[1] + b[1] + d[1] - 3 * cy, a[2] + b[2] + d[2] - 3 * cz];
    if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < 0) {tri(a, d, b, bone, mat);} else {tri(a, b, d, bone, mat);}
  };
  // 8 corners → 3 edge-pullback verts each + a chamfer triangle.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const vx = [cx + sx * (hx - k), cy + sy * hy, cz + sz * hz];
        const vy = [cx + sx * hx, cy + sy * (hy - k), cz + sz * hz];
        const vz = [cx + sx * hx, cy + sy * hy, cz + sz * (hz - k)];
        triO(vx, vy, vz);
      }
    }
  }
  // 6 octagonal faces (corners cut), fanned from the first vert.
  const oct = (axis, s) => {
    const [u, w] = [0, 1, 2].filter(i => i !== axis);
    const U = h[u], W = h[w];
    const pt = (pu, pw) => {
      const p = [0, 0, 0];
      p[u] = c[u] + pu; p[w] = c[w] + pw; p[axis] = c[axis] + s * h[axis];
      return p;
    };
    const ring = [
      pt(-U, -(W - k)), pt(-(U - k), -W), pt(U - k, -W), pt(U, -(W - k)),
      pt(U, W - k), pt(U - k, W), pt(-(U - k), W), pt(-U, W - k),
    ];
    for (let i = 1; i < ring.length - 1; i++) {triO(ring[0], ring[i], ring[i + 1]);}
  };
  for (const axis of [0, 1, 2]) {for (const s of [-1, 1]) {oct(axis, s);}}
}

// Lat-long ellipsoid.
function meshEll(c, r, bone, mat, SEG = 8, RINGS = 5) {
  const pt = (phi, th) => [
    c[0] + r[0] * Math.sin(th) * Math.cos(phi),
    c[1] + r[1] * Math.sin(th) * Math.sin(phi),
    c[2] + r[2] * Math.cos(th),
  ];
  for (let ri = 0; ri < RINGS; ri++) {
    const t0 = (ri / RINGS) * Math.PI, t1 = ((ri + 1) / RINGS) * Math.PI;
    for (let si = 0; si < SEG; si++) {
      const p0 = (si / SEG) * TAU, p1 = ((si + 1) / SEG) * TAU;
      const a = pt(p0, t0), b = pt(p1, t0), d = pt(p1, t1), e = pt(p0, t1);
      if (ri > 0) {tri(a, b, d, bone, mat);}
      if (ri < RINGS - 1) {tri(a, d, e, bone, mat);}
    }
  }
}

for (const q of P) {
  if (q.t === 'cone') {meshCone(q.a, q.b, q.r1, q.r2, q.bone, q.mat);}
  else if (q.t === 'box') {meshBox(q.c, q.h, q.r, q.bone, q.mat);}
  else {meshEll(q.c, q.r, q.bone, q.mat);}
}

// ---------- GLB writer: brute's skeleton, skin, clips and mesh nodes ----------
const toGltf = ([x, y, z]) => [x, z, -y];
const jointOf = Object.fromEntries(readGltfJoints().map((name, i) => [name, i]));

function readGltfJoints() {
  const src = readFileSync(SRC);
  const jl = src.readUInt32LE(12);
  const g = JSON.parse(src.subarray(20, 20 + jl).toString('utf8'));
  return g.skins[0].joints.map(n => g.nodes[n].name);
}

const src = readFileSync(SRC);
const jsonLen = src.readUInt32LE(12);
const gltf = JSON.parse(src.subarray(20, 20 + jsonLen).toString('utf8'));
const binLen = src.readUInt32LE(20 + jsonLen);
const bin = src.subarray(28 + jsonLen, 28 + jsonLen + binLen);
if (binLen !== gltf.buffers[0].byteLength) {throw new Error('BIN chunk / buffer 0 mismatch');}

// Mesh nodes dequantise uint16 positions: world = q * scale + translation.
// Storing (world - translation) / scale reproduces the brute placement exactly.
const meshNode = gltf.nodes.find(n => n.mesh !== undefined);
const T = meshNode.translation;
const S = meshNode.scale[0];
const local = ([x, y, z]) => [(x - T[0]) / S, (y - T[1]) / S, (z - T[2]) / S];

const chunks = [bin];
let cursor = bin.length;
function view(typed, target) {
  const pad = (4 - (cursor % 4)) % 4;
  if (pad) {chunks.push(Buffer.alloc(pad)); cursor += pad;}
  const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  chunks.push(bytes);
  gltf.bufferViews.push({ buffer: 0, byteOffset: cursor, byteLength: bytes.length, target });
  cursor += bytes.length;
  return gltf.bufferViews.length - 1;
}
function accessor(typed, componentType, type, count, extra = {}) {
  gltf.accessors.push({ bufferView: view(typed, 34962), byteOffset: 0, componentType, count, type, ...extra });
  return gltf.accessors.length - 1;
}

// Rigid plates interpenetrate at joints — looking into an overlap shows
// a plate's BACK face, which single-sided culling drops. DoubleSide.
for (const m of gltf.materials ?? []) {m.doubleSided = true;}

gltf.meshes = groups.map((g, m) => {
  const n = g.length;
  const pos = new Float32Array(g.flatMap(v => local(toGltf(v.p))));
  const min = [0, 1, 2].map(a => Math.min(...pos.filter((_, i) => i % 3 === a)));
  const max = [0, 1, 2].map(a => Math.max(...pos.filter((_, i) => i % 3 === a)));
  const nrm = new Float32Array(g.flatMap(v => toGltf(v.n)));
  const jnt = new Uint8Array(g.flatMap(v => {
    const j = jointOf[v.bone];
    return [j, j, 0, 0];                               // rigid: one bone, w=1
  }));
  const wgt = new Float32Array(g.flatMap(() => [1, 0, 0, 0]));
  const idx = new Uint32Array(g.map((_, i) => i));
  const attributes = {
    POSITION: accessor(pos, 5126, 'VEC3', n, { min, max }),
    NORMAL: accessor(nrm, 5126, 'VEC3', n),
    JOINTS_0: accessor(jnt, 5121, 'VEC4', n),
    WEIGHTS_0: accessor(wgt, 5126, 'VEC4', n),
  };
  const indices = gltf.accessors.length;
  gltf.accessors.push({ bufferView: view(idx, 34963), byteOffset: 0, componentType: 5125, count: idx.length, type: 'SCALAR' });
  return { primitives: [{ attributes, indices, material: m }] };
});

gltf.buffers[0].byteLength = cursor;
const binOut = Buffer.concat(chunks, cursor);
const binPadded = Buffer.concat([binOut, Buffer.alloc((4 - (binOut.length % 4)) % 4)]);
let jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);

const header = Buffer.alloc(12);
header.write('glTF', 0, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binPadded.length, 8);
const jsonHead = Buffer.alloc(8);
jsonHead.writeUInt32LE(jsonBuf.length, 0);
jsonHead.writeUInt32LE(0x4e4f534a, 4);
const binHead = Buffer.alloc(8);
binHead.writeUInt32LE(binPadded.length, 0);
binHead.writeUInt32LE(0x004e4942, 4);
writeFileSync(OUT, Buffer.concat([header, jsonHead, jsonBuf, binHead, binPadded]));

const tris = groups.reduce((t, g) => t + g.length / 3, 0);
console.log(`juggernaut: ${P.length} primitives, ${tris} tris -> ${OUT}`);
