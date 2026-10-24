#!/usr/bin/env node
// OG Juggernaut — the SDF smooth-union version, kept for gunlab A/B
// comparison against the plate builder (build_juggernaut.mjs). Primitives
// are smooth-unioned into one body, polygonised with naive surface nets,
// and flat-shaded. Each triangle takes the material and skin joint of its
// nearest primitive. Legs weld to the torso (smin) but crease against
// each other (hard min between leg groups).
// Skeleton, skin joints, mesh-node dequantisation and every baked clip
// are copied from class_brute.glb.
//
//   node _tools/models/build_juggernaut_OG.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'client/public/assets/models/class_brute.glb');
const OUT = join(ROOT, 'client/public/assets/models/class_juggernaut_og.glb');

const ARMOR = 0, DARK = 1, ACCENT = 2;
const H = 0.055;                                 // voxel size, metres
const BLEND = 0.05;                              // smooth-union radius
const ORIGIN = [-1.25, -0.7, -0.05];             // grid corner, Blender frame

// ---------- silhouette ----------
// Blender frame: +X left, -Y front, +Z up. Rest pose is the M2M T.
const P = [];
// Fuse groups: smin welds only inside a group; different groups meet
// with a hard crease. Each leg is its own group — a shared weld between
// the legs is what fused the crotch into a skirt. Torso/arms/pelvis
// share group 0 and still weld to the thigh tops normally.
const cone = (a, b, r1, r2, bone, mat, g = 0) => P.push({ t: 'cone', a, b, r1, r2, bone, mat, g });
const box = (c, h, r, bone, mat, g = 0) => P.push({ t: 'box', c, h, r, bone, mat, g });
const ell = (c, r, bone, mat, g = 0) => P.push({ t: 'ell', c, r, bone, mat, g });

for (const [s, sx] of [['l', 1], ['r', -1]]) {
  const lg = s === 'l' ? 1 : 2;                      // one leg per weld group
  // legs: column thighs, knee bulge, blocky sabatons (original spacing)
  cone([sx * 0.17, 0, 0.92], [sx * 0.18, 0, 0.52], 0.2, 0.165, `thigh_${s}`, ARMOR, lg);
  ell([sx * 0.18, -0.1, 0.5], [0.15, 0.14, 0.13], `calf_${s}`, DARK, lg);
  cone([sx * 0.18, 0, 0.46], [sx * 0.16, 0, 0.12], 0.155, 0.13, `calf_${s}`, ARMOR, lg);
  box([sx * 0.17, -0.1, 0.1], [0.14, 0.23, 0.1], 0.05, `foot_${s}`, DARK, lg);
  // shoulder bells, T-rest arms, gauntlets
  ell([sx * 0.42, 0, 1.56], [0.24, 0.25, 0.2], `clavicle_${s}`, ARMOR);
  cone([sx * 0.44, 0, 1.52], [sx * 0.66, 0.04, 1.46], 0.15, 0.13, `upperarm_${s}`, ARMOR);
  ell([sx * 0.7, 0.04, 1.45], [0.11, 0.12, 0.12], `lowerarm_${s}`, DARK);
  cone([sx * 0.74, 0.04, 1.45], [sx * 0.94, 0.04, 1.45], 0.13, 0.11, `lowerarm_${s}`, ARMOR);
  ell([sx * 1.0, 0.04, 1.44], [0.13, 0.15, 0.14], `hand_${s}`, DARK);
  cone([sx * 0.44, 0.02, 1.74], [sx * 0.5, 0.05, 1.9], 0.07, 0.01, `clavicle_${s}`, ACCENT);
}

// pelvis, carapace, back plate
box([0, 0, 0.98], [0.34, 0.2, 0.13], 0.08, 'pelvis', DARK);
box([0, -0.04, 0.9], [0.36, 0.22, 0.06], 0.04, 'pelvis', ARMOR);
cone([0, 0, 1.06], [0, 0, 1.12], 0.27, 0.3, 'spine_01', DARK);
box([0, -0.02, 1.4], [0.46, 0.3, 0.24], 0.14, 'spine_03', ARMOR);
box([0, 0.26, 1.4], [0.42, 0.1, 0.32], 0.08, 'spine_03', DARK);
box([0, -0.33, 1.42], [0.1, 0.05, 0.2], 0.04, 'spine_03', DARK);
ell([0, -0.02, 1.6], [0.36, 0.3, 0.1], 'spine_03', DARK);
cone([0, 0.32, 1.6], [0, 0.4, 1.9], 0.05, 0.01, 'spine_03', ACCENT);

// neck, square helm, T-visor, crest
cone([0, 0, 1.6], [0, 0, 1.74], 0.12, 0.1, 'neck_01', DARK);
// knight-style helm: rounded shell tapering to a forward point
cone([0, 0, 1.76], [0, -0.18, 1.88], 0.26, 0.06, 'head', ARMOR);
box([0, -0.2, 1.9], [0.24, 0.05, 0.03], 0.02, 'head', DARK);
box([0, -0.22, 1.86], [0.16, 0.02, 0.02], 0.01, 'head', ACCENT);
cone([0, 0.06, 2.02], [0, 0.12, 2.1], 0.05, 0.01, 'head', ACCENT);

// ---------- signed distance ----------
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const len3 = (x, y, z) => Math.hypot(x, y, z);

function sdCone(px, py, pz, a, b, r1, r2) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  const pax = px - a[0], pay = py - a[1], paz = pz - a[2];
  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;
  const xx = pax * l2 - bax * y, xy = pay * l2 - bay * y, xz = paz * l2 - baz * y;
  const x2 = xx * xx + xy * xy + xz * xz;
  const y2 = y * y * l2, z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) {return Math.sqrt(x2 + z2) * il2 - r2;}
  if (Math.sign(y) * a2 * y2 < k) {return Math.sqrt(x2 + y2) * il2 - r1;}
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

function sdBox(px, py, pz, c, h, r) {
  const qx = Math.abs(px - c[0]) - (h[0] - r);
  const qy = Math.abs(py - c[1]) - (h[1] - r);
  const qz = Math.abs(pz - c[2]) - (h[2] - r);
  const outside = len3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  return outside + Math.min(Math.max(qx, qy, qz), 0) - r;
}

function sdEll(px, py, pz, c, r) {
  const x = (px - c[0]), y = (py - c[1]), z = (pz - c[2]);
  const k0 = len3(x / r[0], y / r[1], z / r[2]);
  const k1 = len3(x / (r[0] * r[0]), y / (r[1] * r[1]), z / (r[2] * r[2]));
  return k1 === 0 ? -Math.min(...r) : k0 * (k0 - 1) / k1;
}

function primDist(q, px, py, pz) {
  if (q.t === 'cone') {return sdCone(px, py, pz, q.a, q.b, q.r1, q.r2);}
  if (q.t === 'box') {return sdBox(px, py, pz, q.c, q.h, q.r);}
  return sdEll(px, py, pz, q.c, q.r);
}

function smin(a, b) {
  const h = clamp01(0.5 + (0.5 * (b - a)) / BLEND);
  return b + (a - b) * h - BLEND * h * (1 - h);
}

function field(px, py, pz) {
  // Legs weld to the torso smoothly (smin) but to EACH OTHER with a hard
  // min() crease — the shared weld is what fused the crotch into a skirt,
  // and the all-groups crease was what read as mangled seams.
  let body = Infinity;
  const perLeg = [Infinity, Infinity];
  for (const q of P) {
    const p = primDist(q, px, py, pz);
    if (q.g === 0) {body = body === Infinity ? p : smin(body, p);}
    else {const i = q.g - 1; perLeg[i] = perLeg[i] === Infinity ? p : smin(perLeg[i], p);}
  }
  const legs = Math.min(perLeg[0], perLeg[1]);
  // Legs hard-union against the body too: a smin weld fillets the crotch
  // gap shut AND gives shared verts blended thigh_l/thigh_r weights —
  // the sheet tears the moment the legs stride apart in anim.
  return Math.min(body, legs);
}
function gradient(px, py, pz) {
  const e = H * 0.5;
  return [
    field(px + e, py, pz) - field(px - e, py, pz),
    field(px, py + e, pz) - field(px, py - e, pz),
    field(px, py, pz + e) - field(px, py, pz - e),
  ];
}

function nearest(px, py, pz) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < P.length; i++) {
    const d = primDist(P[i], px, py, pz);
    if (d < bestD) {bestD = d; best = i;}
  }
  return P[best];
}

// Rigid skinning rips the SDF sheet apart at joints — the surface is a
// continuum but each rigid triangle follows ONE bone fully, so a limb
// bend opens a real see-through gap at the primitive seam (the visible
// "holes"). Blend the two nearest DISTINCT-bone primitives over a band
// instead: verts at the seam interpolate between both bones like a
// properly weighted mesh.
// Rigid per-TRIANGLE: per-vertex bone assignment lets a crease-spanning
// tri stretch into a strip when its verts follow different bones. One
// prim per whole triangle → the flap stays rigid on one side.

// ---------- naive surface nets ----------
const NX = Math.ceil(2.5 / H) + 1, NY = Math.ceil(1.45 / H) + 1, NZ = Math.ceil(2.4 / H) + 1;
const at = (x, y, z) => x + NX * (y + NY * z);
const F = new Float32Array(NX * NY * NZ);
for (let z = 0; z < NZ; z++) {
  for (let y = 0; y < NY; y++) {
    for (let x = 0; x < NX; x++) {
      F[at(x, y, z)] = field(ORIGIN[0] + x * H, ORIGIN[1] + y * H, ORIGIN[2] + z * H);
    }
  }
}

const CX = NX - 1, CY = NY - 1, CZ = NZ - 1;
const cellOf = (x, y, z) => x + CX * (y + CY * z);
const cellVert = new Int32Array(CX * CY * CZ).fill(-1);
const verts = [];
const CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

for (let z = 0; z < CZ; z++) {
  for (let y = 0; y < CY; y++) {
    for (let x = 0; x < CX; x++) {
      const v = CORNERS.map(([i, j, k]) => F[at(x + i, y + j, z + k)]);
      if (v.every(d => d < 0) || v.every(d => d >= 0)) {continue;}
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (const [a, b] of EDGES) {
        if ((v[a] < 0) === (v[b] < 0)) {continue;}
        const t = v[a] / (v[a] - v[b]);
        const pa = CORNERS[a], pb = CORNERS[b];
        sx += pa[0] + t * (pb[0] - pa[0]);
        sy += pa[1] + t * (pb[1] - pa[1]);
        sz += pa[2] + t * (pb[2] - pa[2]);
        n++;
      }
      cellVert[cellOf(x, y, z)] = verts.length;
      verts.push([ORIGIN[0] + (x + sx / n) * H, ORIGIN[1] + (y + sy / n) * H, ORIGIN[2] + (z + sz / n) * H]);
    }
  }
}

const quads = [];
const pushQuad = (inside, c0, c1, c2, c3) => {
  const ids = [c0, c1, c2, c3].map(([x, y, z]) => cellVert[cellOf(x, y, z)]);
  if (ids.every(id => id >= 0)) {quads.push([ids[0], ids[1], ids[2], ids[3]]);}
};
for (let z = 0; z < NZ; z++) {
  for (let y = 0; y < NY; y++) {
    for (let x = 0; x < NX; x++) {
      const inside = F[at(x, y, z)] < 0;
      if (x < NX - 1 && y >= 1 && z >= 1 && y <= NY - 2 && z <= NZ - 2
        && inside !== (F[at(x + 1, y, z)] < 0)) {
        pushQuad(inside, [x, y - 1, z - 1], [x, y, z - 1], [x, y, z], [x, y - 1, z]);
      }
      if (y < NY - 1 && x >= 1 && z >= 1 && x <= NX - 2 && z <= NZ - 2
        && inside !== (F[at(x, y + 1, z)] < 0)) {
        pushQuad(inside, [x - 1, y, z - 1], [x, y, z - 1], [x, y, z], [x - 1, y, z]);
      }
      if (z < NZ - 1 && x >= 1 && y >= 1 && x <= NX - 2 && y <= NY - 2
        && inside !== (F[at(x, y - 1, z)] < 0)) {
        pushQuad(inside, [x - 1, y - 1, z], [x, y - 1, z], [x, y, z], [x - 1, y, z]);
      }
    }
  }
}

// ---------- flat-shaded triangles, grouped by material ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
const toGltf = ([x, y, z]) => [x, z, -y];
const jointOf = Object.fromEntries(readGltfJoints().map((name, i) => [name, i]));
let totalVol = 0;

function readGltfJoints() {
  const src = readFileSync(SRC);
  const jl = src.readUInt32LE(12);
  const g = JSON.parse(src.subarray(20, 20 + jl).toString('utf8'));
  return g.skins[0].joints.map(n => g.nodes[n].name);
}

const groups = [[], [], []];
for (const q of quads) {
  for (const [i0, i1, i2] of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) {
    let a = verts[i0], b = verts[i1], c = verts[i2];
    const centre = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const n = cross(sub(b, a), sub(c, a));
    const prim = nearest(...centre);
    // gradient() points outward; keep triangles facing outward.
    if (dot(n, gradient(...centre)) < 0) {[b, c] = [c, b];}
    const n2 = cross(sub(b, a), sub(c, a));
    const g = groups[prim.mat];
    const nrm = toGltf(unit(n2));
    const j = jointOf[prim.bone];
    for (const p of [a, b, c]) {
      g.push({ p: toGltf(p), n: nrm, j1: j, j2: j, w1: 1, w2: 0 });
    }
    totalVol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
}

// ---------- GLB writer: brute's skeleton, skin, clips and mesh nodes ----------
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

for (const m of gltf.materials ?? []) {m.doubleSided = true;}

gltf.meshes = groups.map((g, m) => {
  const n = g.length;
  const pos = new Float32Array(g.flatMap(v => local(v.p)));
  const min = [0, 1, 2].map(a => Math.min(...pos.filter((_, i) => i % 3 === a)));
  const max = [0, 1, 2].map(a => Math.max(...pos.filter((_, i) => i % 3 === a)));
  const nrm = new Float32Array(g.flatMap(v => v.n));
  const jnt = new Uint8Array(g.flatMap(v => [v.j1, v.j2, 0, 0]));
  const wgt = new Float32Array(g.flatMap(v => [v.w1, v.w2, 0, 0]));
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
console.log(`juggernaut_og (SDF): ${P.length} primitives, ${verts.length} surface verts, ${tris} tris -> ${OUT}`);
