#!/usr/bin/env node
// Dreadnought from analytic primitives — the siege-walker cousin of the
// juggernaut: stacked pauldrons cresting over a buried bucket helm,
// backpack with twin antennae, segmented gut plates, tall sabatons.
// Each primitive tessellates as its OWN flat-shaded plate rigidly bound
// to its bone. Skeleton, skin joints, mesh-node dequantisation and every
// baked clip are copied from class_brute.glb.
//
//   node _tools/models/build_dreadnought.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'client/public/assets/models/class_brute.glb');
const OUT = join(ROOT, 'client/public/assets/models/class_dreadnought.glb');

const ARMOR = 0, DARK = 1, ACCENT = 2;

// ---------- silhouette ----------
// Blender frame: +X left, -Y front, +Z up. Rest pose is the M2M T.
const P = [];
const cone = (a, b, r1, r2, bone, mat) => P.push({ t: 'cone', a, b, r1, r2, bone, mat });
const box = (c, h, r, bone, mat) => P.push({ t: 'box', c, h, r, bone, mat });
const ell = (c, r, bone, mat) => P.push({ t: 'ell', c, r, bone, mat });

for (const [s, sx] of [['l', 1], ['r', -1]]) {
  // legs: armored column + outer thigh plate + tall sabaton boot.
  // Analytic plates don't weld — adjacent prims must INTERPENETRATE or
  // the seam between them is real open space.
  cone([sx * 0.2, 0, 0.95], [sx * 0.21, 0, 0.52], 0.21, 0.17, `thigh_${s}`, ARMOR);
  box([sx * 0.28, -0.02, 0.72], [0.12, 0.16, 0.2], 0.04, `thigh_${s}`, ARMOR);
  ell([sx * 0.21, -0.12, 0.48], [0.15, 0.12, 0.13], `calf_${s}`, DARK);
  cone([sx * 0.2, 0, 0.44], [sx * 0.18, 0, 0.08], 0.17, 0.15, `calf_${s}`, ARMOR);
  box([sx * 0.19, -0.12, 0.11], [0.15, 0.26, 0.11], 0.05, `foot_${s}`, ARMOR);
  // THE shoulder: inner bell + outer plate + crest cap — pauldrons stack
  // OVER the helm line (the hunched siege silhouette).
  ell([sx * 0.42, 0, 1.56], [0.27, 0.27, 0.21], `clavicle_${s}`, ARMOR);
  box([sx * 0.55, -0.02, 1.52], [0.18, 0.26, 0.15], 0.05, `clavicle_${s}`, ARMOR);
  box([sx * 0.47, 0, 1.76], [0.24, 0.24, 0.07], 0.04, `clavicle_${s}`, ARMOR);
  // arms: armored column + huge forearm gauntlet + slab fist
  cone([sx * 0.46, 0, 1.5], [sx * 0.68, 0.04, 1.44], 0.17, 0.14, `upperarm_${s}`, ARMOR);
  ell([sx * 0.71, 0.04, 1.44], [0.12, 0.13, 0.12], `lowerarm_${s}`, DARK);
  cone([sx * 0.75, 0.04, 1.44], [sx * 1.0, 0.05, 1.43], 0.16, 0.13, `lowerarm_${s}`, ARMOR);
  box([sx * 1.07, 0.05, 1.42], [0.13, 0.15, 0.14], 0.05, `hand_${s}`, DARK);
  // pauldron beacon nub
  cone([sx * 0.5, 0.02, 1.86], [sx * 0.55, 0.05, 1.94], 0.05, 0.01, `clavicle_${s}`, ACCENT);
}

// pelvis + armored belt, pouches, hanging hip plates
box([0, 0, 0.98], [0.36, 0.22, 0.14], 0.08, 'pelvis', DARK);
box([0, -0.04, 0.9], [0.4, 0.24, 0.07], 0.04, 'pelvis', ARMOR);
for (const sx of [-1, 1]) {
  box([sx * 0.16, -0.27, 0.9], [0.09, 0.05, 0.09], 0.02, 'pelvis', DARK);   // belt pouch
  box([sx * 0.37, -0.04, 0.78], [0.1, 0.2, 0.16], 0.04, 'pelvis', ARMOR);   // hip skirt plate
}
// segmented abdomen — plate bands overlapping pelvis and chest
box([0, -0.02, 1.08], [0.34, 0.22, 0.09], 0.03, 'spine_01', ARMOR);
box([0, -0.03, 1.18], [0.38, 0.23, 0.09], 0.03, 'spine_01', ARMOR);
box([0, -0.03, 1.28], [0.42, 0.25, 0.08], 0.03, 'spine_01', ARMOR);
// barrel chest + pec plate + central seam
box([0, -0.02, 1.45], [0.48, 0.3, 0.26], 0.13, 'spine_03', ARMOR);
box([0, -0.3, 1.5], [0.42, 0.06, 0.18], 0.05, 'spine_03', ARMOR);
box([0, -0.35, 1.45], [0.04, 0.02, 0.2], 0.01, 'spine_03', DARK);
// backpack: reactor box + vent band + twin antennae
box([0, 0.3, 1.5], [0.38, 0.14, 0.3], 0.05, 'spine_03', DARK);
box([0, 0.36, 1.38], [0.3, 0.06, 0.1], 0.02, 'spine_03', ARMOR);
cone([-0.16, 0.34, 1.78], [-0.17, 0.36, 2.1], 0.025, 0.008, 'spine_03', DARK);
cone([0.16, 0.34, 1.78], [0.17, 0.36, 2.1], 0.025, 0.008, 'spine_03', DARK);
// upper-chest mass bridging chest to shoulders
ell([0, -0.02, 1.62], [0.38, 0.3, 0.12], 'spine_03', DARK);

// thick collar so the helm reads buried; bucket helm + brow + visor slit
cone([0, 0, 1.58], [0, 0, 1.78], 0.16, 0.14, 'neck_01', DARK);
box([0, -0.01, 1.92], [0.2, 0.19, 0.17], 0.06, 'head', ARMOR);
box([0, -0.2, 2.0], [0.2, 0.04, 0.05], 0.02, 'head', ARMOR);                // brow ridge
box([0, -0.2, 1.91], [0.16, 0.02, 0.02], 0.008, 'head', ACCENT);            // visor slit
box([0, -0.18, 1.81], [0.14, 0.05, 0.08], 0.02, 'head', DARK);              // chin grill

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
