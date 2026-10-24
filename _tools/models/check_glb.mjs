#!/usr/bin/env node
// Headless mesh lint for class GLBs — the Node twin of client/src/gunlab
// scans.ts (holeScan + volScan), so a model can be checked without opening
// gunlab. Positions are dequantised through the mesh node first, then edges
// are welded at 1mm across every mesh, the same way holeScan does.
//
//   node _tools/models/check_glb.mjs <file.glb> [more.glb ...]
//
// holes      edges referenced by exactly one triangle (open rims)
// nonmanif   edges referenced by three or more triangles
// inverted   signed volume < 0 (inside-out winding)
// degenerate zero-area triangles
import { readFileSync } from 'node:fs';

const WELD = 0.001;

function readGlb(path) {
  const b = readFileSync(path);
  const jl = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + jl).toString('utf8'));
  const bl = b.readUInt32LE(20 + jl);
  const bin = b.subarray(28 + jl, 28 + jl + bl);
  return { j, bin };
}

function readAccessor(j, bin, ai) {
  const ac = j.accessors[ai];
  const bv = j.bufferViews[ac.bufferView];
  if (bv.extensions) {throw new Error('meshopt view: decode required');}
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[ac.type];
  const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[ac.componentType];
  const ArrT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }[ac.componentType];
  const stride = bv.byteStride || comps * size;
  const base = bin.byteOffset + (bv.byteOffset || 0) + (ac.byteOffset || 0);
  const out = new Array(ac.count * comps);
  for (let i = 0; i < ac.count; i += 1) {
    const v = new ArrT(bin.buffer, base + i * stride, comps);
    for (let c = 0; c < comps; c += 1) {out[i * comps + c] = v[c];}
  }
  return { out, comps };
}

function lint(path) {
  const { j, bin } = readGlb(path);
  const edges = new Map();
  let tris = 0, degenerate = 0, volume = 0;
  const holesAt = [];
  const key = (p) => p.map(v => Math.round(v / WELD)).join(',');
  const ek = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  for (const node of j.nodes) {
    if (node.mesh === undefined) {continue;}
    const m = j.meshes[node.mesh];
    const t = node.translation || [0, 0, 0];
    const s = node.scale || [1, 1, 1];
    for (const prim of m.primitives) {
      const { out: pos, comps } = readAccessor(j, bin, prim.attributes.POSITION);
      const world = [];
      for (let i = 0; i < pos.length / comps; i += 1) {
        world.push([0, 1, 2].map(a => pos[i * comps + a] * s[a] + t[a]));
      }
      const idx = prim.indices !== undefined
        ? readAccessor(j, bin, prim.indices).out
        : world.map((_, i) => i);
      for (let k = 0; k + 2 < idx.length; k += 3) {
        const A = world[idx[k]], B = world[idx[k + 1]], C = world[idx[k + 2]];
        tris += 1;
        const ab = B.map((v, i) => v - A[i]), ac = C.map((v, i) => v - A[i]);
        const cr = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
        if (Math.hypot(...cr) < 1e-12) {degenerate += 1;}
        volume += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6;
        const kk = [key(A), key(B), key(C)];
        for (const [u, w] of [[0, 1], [1, 2], [2, 0]]) {
          const k2 = ek(kk[u], kk[w]);
          let e = edges.get(k2);
          if (!e) {edges.set(k2, e = { n: 0, fwd: 0, mid: [A, B, C][u].map((v, i) => (v + [A, B, C][w][i]) / 2) });}
          e.n += 1;
          if (kk[u] < kk[w]) {e.fwd += 1;}
        }
      }
    }
  }

  let holes = 0, nonmanif = 0, flipped = 0;
  const flippedAt = [];
  for (const e of edges.values()) {
    if (e.n === 1) {holes += 1; if (holesAt.length < 6) {holesAt.push(e.mid.map(v => v.toFixed(3)).join(' '));}}
    else if (e.n > 2) {nonmanif += 1;}
    else if (e.n === 2 && (e.fwd === 0 || e.fwd === 2)) {
      flipped += 1;
      if (flippedAt.length < 6) {flippedAt.push(e.mid.map(v => v.toFixed(3)).join(' '));}
    }
  }
  const inverted = volume < 0;
  const ok = holes === 0 && nonmanif === 0 && flipped === 0 && !inverted && degenerate === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${path}`);
  console.log(`  tris ${tris}  holes ${holes}  nonmanifold ${nonmanif}  flipped-faces ${flipped}  inverted ${inverted ? 'YES' : 'no'}  degenerate ${degenerate}  volume ${volume.toFixed(4)}`);
  if (flippedAt.length) {console.log(`  flipped edges at (m): ${flippedAt.join(' | ')}`);}
  if (holesAt.length) {console.log(`  first open edges at (m): ${holesAt.join(' | ')}`);}
  return ok;
}

const files = process.argv.slice(2);
if (!files.length) {console.error('usage: check_glb.mjs <file.glb> ...'); process.exit(2);}
let failed = 0;
for (const f of files) {if (!lint(f)) {failed += 1;}}
process.exit(failed ? 1 : 0);
