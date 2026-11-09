/**
 * q3conv — Quake3-style .map → our map spec pipeline.
 *
 *   bun _tools/q3conv.ts <in.map> <outName> [--scale 0.0254] [--ws 256]
 *
 * Emits:
 *   maps/<outName>.json                  spec (spawns, interiors, killY, fog…)
 *   maps/t2/<outName>/hullboxes.json     per-brush collision boxes
 *   maps/<outName>.bin                   baked floor heightfield
 *   maps/t2/dif/<outName>.glb            merged brush mesh (flat-color mats)
 *
 * Units: .map coords are inches → meters via --scale (0.0254 = 1in).
 * XZ is translated so the map sits inside [0,ws)² (the heightfield's
 * periodic domain); Y is lifted so the lowest floor sits ~60m up, with
 * killY at 30 and empty cells reading as y=0 deep field.
 *
 * Collision: each brush becomes a yaw-OBB when it's an upright box
 * (hullboxes.json `yaw` → StructureSpec.rotY), else Y-sliced AABBs so
 * wedges/stairs collide as stair-steps instead of one fat block.
 * Only worldspawn/func_* brushes are world geometry — trigger, item,
 * light and misc entities carry brush VOLUMES that must never collide.
 * Sky/caulk-only shell brushes are dropped from both sides.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const MAPS = join(ROOT, 'maps');
const DIF = join(MAPS, 't2', 'dif');

let YSCALE = 0.0254;

// ── .map parsing ────────────────────────────────────────────────────────

interface Plane {
  pts: [number, number, number][];
  n: [number, number, number];
  d: number;          // n·x + d = 0
  shader: string;
  tex: number[];      // sShift tShift rotate sScale tScale ...
  texvec?: number[][]; // TrenchBroom explicit texture axes (q3 space)
}
interface Brush { planes: Plane[]; ent: string }
interface Ent { cls: string; fields: Map<string, string>; brushes: Brush[] }

function parseMap(src: string): Ent[] {
  let i = 0;
  const n = src.length;
  const ws = (): void => { while (i < n && /\s/.test(src[i]!)) {i++;} };
  const word = (): string => {
    ws();
    if (i >= n) { return ''; }
    if (src[i] === '"') {
      i++;
      let s = '';
      while (i < n && src[i] !== '"') { if (src[i] === '\\') {i++;} s += src[i++]; }
      i++;
      return s;
    }
    let s = '';
    while (i < n && !/[\s(){}"]/.test(src[i]!)) { s += src[i++]; }
    return s;
  };

  interface Block { pairs: [string, string][]; children: Block[]; planes: { pts: [number, number, number][]; shader: string; tex: number[]; texvec?: number[][] }[] }
  const parseBlock = (): Block => {
    const b: Block = { pairs: [], children: [], planes: [] };
    ws();
    if (src[i] !== '{') { throw new Error(`expected { at ${i}: ${src.slice(i, i + 40)}`); }
    i++;
    for (;;) {
      ws();
      if (i >= n) { break; }
      const c = src[i]!;
      if (c === '}') { i++; break; }
      if (c === '{') { b.children.push(parseBlock()); continue; }
      if (c === '(') {
        const pts: [number, number, number][] = [];
        for (let k = 0; k < 3; k++) {
          ws();
          if (src[i] !== '(') { throw new Error(`plane pt ${k} at ${i}`); }
          i++;
          const p: number[] = [];
          for (let m = 0; m < 3; m++) { p.push(Number(word())); }
          ws();
          if (src[i] !== ')') { throw new Error(`plane ) at ${i}`); }
          i++;
          pts.push([p[0]!, p[1]!, p[2]!]);
        }
        // TrenchBroom dialect: ( ( texX ) ( texY ) ) group before the shader
        let texvec: number[][] | undefined;
        ws();
        if (src[i] === '(') {
          i++;
          texvec = [];
          for (;;) {
            ws();
            if (src[i] === ')') { i++; break; }
            if (src[i] !== '(') { throw new Error(`texvec at ${i}`); }
            i++;
            const v: number[] = [];
            for (let m = 0; m < 3; m++) { v.push(Number(word())); }
            ws();
            if (src[i] !== ')') { throw new Error(`texvec ) at ${i}`); }
            i++;
            texvec.push(v);
          }
        }
        const shader = word();
        // trailing texture params: sShift tShift rotate sScale tScale then
        // flags — first five drive QuakeTextureVecs (q3map/map.c)
        const tex: number[] = [];
        for (let k = 0; k < 8; k++) {
          const save = i;
          const w = word();
          if (w === '' || !Number.isFinite(Number(w))) { i = save; break; }
          tex.push(Number(w));
        }
        // Quake is Z-up; our world/three is Y-up. Swizzle (x,y,z)→(x,z,y)
        // here so ALL downstream geometry stays Y-up.
        b.planes.push({ pts: pts.map(([x, y, z]) => [x, z, y] as [number, number, number]), shader, tex, texvec });
        continue;
      }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') {i++;} continue; }
      if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {i++;} i += 2; continue; }
      const k = word();
      // patchDef2/3 = curved mesh patches — different grammar ((x y z u v)
      // control-point grids). Skip the whole block; v1 renders brushes only.
      if (k === 'patchDef2' || k === 'patchDef3') {
        ws();
        if (src[i] === '{') {
          let depth = 0;
          do {
            if (src[i] === '{') { depth++; }
            else if (src[i] === '}') { depth--; }
            i++;
          } while (i < n && depth > 0);
        }
        continue;
      }
      const v = word();
      if (k) { b.pairs.push([k, v]); }
    }
    return b;
  };

  const ents: Ent[] = [];
  const flatten = (b: Block, parentCls: string): void => {
    const fields = new Map(b.pairs);
    const cls = fields.get('classname') ?? parentCls;
    // Own brushes only — inheriting ancestor brushes downward made every
    // world brush re-emit once per nested func_* entity (dm8: 28.8k specs
    // for ~200 unique colliders).
    const brushes: Brush[] = [];
    for (const ch of b.children) {
      if (ch.planes.length > 0) {
        brushes.push({ planes: ch.planes.map((p) => makePlane(p.pts, p.shader, p.tex, p.texvec)), ent: cls });
      } else {
        flatten(ch, cls);
      }
    }
    if (b.pairs.length > 0 || cls) { ents.push({ cls, fields, brushes }); }
  };
  while (i < n) {
    ws();
    if (i >= n) { break; }
    if (src[i] === '{') { flatten(parseBlock(), ''); }
    else { i++; }
  }
  return ents;
}

function makePlane(pts: [number, number, number][], shader: string, tex: number[] = [], texvec?: number[][]): Plane {
  const [a, b, c] = pts;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let n = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  n = [n[0] / len, n[1] / len, n[2] / len];
  const d = -(n[0] * a[0] + n[1] * a[1] + n[2] * a[2]);
  return { pts, n: n as [number, number, number], d, shader, tex, texvec };
}

// ── brush → convex solid ────────────────────────────────────────────────

const EPS = 1e-3;

/** f_j(v) signed value of point v against plane j. */
const fval = (pl: Plane, v: number[]): number => pl.n[0] * v[0] + pl.n[1] * v[1] + pl.n[2] * v[2] + pl.d;

interface Solid {
  verts: number[][];
  faces: { plane: number; poly: number[][] }[];
  signs: number[];
  min: number[]; max: number[];
}

function brushSolid(brush: Brush): Solid | null {
  const planes = brush.planes;
  if (planes.length < 4) { return null; }
  const P = planes.length;
  // .map plane points are arbitrary coplanar refs (often OUTSIDE the face),
  // so "other planes' points" can't reveal the interior side. Instead:
  // enumerate triple intersections, then refine each plane's interior sign
  // by the median f-value of surviving candidates — real verts dominate
  // once bogus far intersections are filtered out.
  const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  for (const pl of planes) for (const p of pl.pts) for (let k = 0; k < 3; k++) {
    bmin[k] = Math.min(bmin[k]!, p[k]!); bmax[k] = Math.max(bmax[k]!, p[k]!);
  }
  const pad = Math.max(bmax[0]! - bmin[0]!, bmax[1]! - bmin[1]!, bmax[2]! - bmin[2]!) * 0.5 + 128;
  const cand: number[][] = [];
  for (let a = 0; a < P; a++) for (let b = a + 1; b < P; b++) for (let c = b + 1; c < P; c++) {
    const va = solve3(planes[a]!, planes[b]!, planes[c]!);
    if (!va || !va.every(Number.isFinite)) { continue; }
    if (va.some((x, k) => x < bmin[k]! - pad || x > bmax[k]! + pad)) { continue; }
    cand.push(va);
  }
  if (cand.length < 4) { return null; }
  // Fast path: the centroid of a convex brush's face points sits inside
  // the solid, so each plane's interior sign is just the sign of fval at
  // the centroid — one shot, no iteration. The iterative median-refine
  // below collapses (alive<4) on ~20% of real brushes whose candidate
  // set is polluted by near-parallel triple hits. Non-convex brushes can
  // fool the centroid; those still fall through to the iterative path
  // when the fast filter starves, and the fast result is only accepted
  // when it keeps >=4 candidates AND every plane keeps a face.
  let signs: number[] | null = null;
  let alive: number[][] | null = null;
  {
    const c = [0, 0, 0];
    let np = 0;
    for (const pl of planes) for (const p of pl.pts) {
      c[0]! += p[0]!; c[1]! += p[1]!; c[2]! += p[2]!; np++;
    }
    for (let k = 0; k < 3; k++) { c[k]! /= np; }
    const s = planes.map((pl) => { const f = fval(pl, c); return f < -1e-6 ? -1 : 1; });
    const a = cand.filter((v) => planes.every((pl, i) => s[i]! * fval(pl, v) >= -0.5));
    if (a.length >= 4) {
      // every plane must retain >=3 on-face verts or it's not a closed solid
      const ok = planes.every((pl) => a.filter((v) => Math.abs(fval(pl, v)) < 0.5).length >= 3);
      if (ok) { signs = s; alive = a; }
    }
  }
  if (!alive) {
    signs = planes.map(() => 1);
    alive = cand;
    for (let it = 0; it < 5; it++) {
      signs = planes.map((pl) => {
        const vals = alive!.map((v) => fval(pl, v)).sort((x, y) => x - y);
        return vals.length && vals[vals.length >> 1]! < 0 ? -1 : 1;
      });
      const next = alive.filter((v) => planes.every((pl, i) => signs[i]! * fval(pl, v) >= -0.5));
      if (next.length === 0) { break; }
      if (next.length === alive.length && it > 0) { alive = next; break; }
      alive = next;
    }
  }
  if (alive.length < 4) {
    if (process.env.Q3DEBUG) { console.log(`  fail planes=${P} cand=${cand.length} alive=${alive.length}`); }
    return null;
  }
  const verts: number[][] = [];
  const seen = new Set<string>();
  for (const v of alive) {
    const k = v.map((x) => Math.round(x * 100)).join(',');
    if (!seen.has(k)) { seen.add(k); verts.push(v); }
  }
  if (verts.length < 4) { return null; }
  const faces: { plane: number; poly: number[][] }[] = [];
  for (let i = 0; i < P; i++) {
    const pl = planes[i]!;
    const on = verts.filter((v) => Math.abs(fval(pl, v)) < 0.5);
    if (on.length < 3) { continue; }
    faces.push({ plane: i, poly: orderPoly(on, outwardNormal(pl, signs[i]!)) });
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k]!, v[k]!); max[k] = Math.max(max[k]!, v[k]!);
  }
  return { verts, faces, signs, min, max };
}

function outwardNormal(pl: Plane, interiorSign: number): [number, number, number] {
  return [-pl.n[0] * interiorSign, -pl.n[1] * interiorSign, -pl.n[2] * interiorSign];
}

function solve3(a: Plane, b: Plane, c: Plane): number[] | null {
  const m = [a.n, b.n, c.n];
  const r = [-a.d, -b.d, -c.d];
  const det =
    m[0]![0] * (m[1]![1] * m[2]![2] - m[1]![2] * m[2]![1]) -
    m[0]![1] * (m[1]![0] * m[2]![2] - m[1]![2] * m[2]![0]) +
    m[0]![2] * (m[1]![0] * m[2]![1] - m[1]![1] * m[2]![0]);
  if (Math.abs(det) < 1e-9) { return null; }
  const x =
    (r[0]! * (m[1]![1] * m[2]![2] - m[1]![2] * m[2]![1]) -
     m[0]![1] * (r[1]! * m[2]![2] - m[1]![2] * r[2]!) +
     m[0]![2] * (r[1]! * m[2]![1] - m[1]![1] * r[2]!)) / det;
  const y =
    (m[0]![0] * (r[1]! * m[2]![2] - m[1]![2] * r[2]!) -
     r[0]! * (m[1]![0] * m[2]![2] - m[1]![2] * m[2]![0]) +
     m[0]![2] * (m[1]![0] * r[2]! - r[1]! * m[2]![0])) / det;
  const z =
    (m[0]![0] * (m[1]![1] * r[2]! - r[1]! * m[2]![1]) -
     m[0]![1] * (m[1]![0] * r[2]! - r[1]! * m[2]![0]) +
     r[0]! * (m[1]![0] * m[2]![1] - m[1]![1] * m[2]![0])) / det;
  return [x, y, z];
}

function orderPoly(pts: number[][], n: [number, number, number]): number[][] {
  const c = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) { c[k]! += p[k]! / pts.length; }
  const up = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = [
    up[1] * n[2] - up[2] * n[1],
    up[2] * n[0] - up[0] * n[2],
    up[0] * n[1] - up[1] * n[0],
  ];
  const ul = Math.hypot(u[0], u[1], u[2]) || 1;
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v = [
    n[1] * u[2] - n[2] * u[1],
    n[2] * u[0] - n[0] * u[2],
    n[0] * u[1] - n[1] * u[0],
  ];
  return [...pts].sort((p, q) => {
    const ap = Math.atan2(
      (p[1]! - c[1]!) * v[1]! + (p[0]! - c[0]!) * v[0]! + (p[2]! - c[2]!) * v[2]!,
      (p[0]! - c[0]!) * u[0]! + (p[1]! - c[1]!) * u[1]! + (p[2]! - c[2]!) * u[2]!,
    );
    const aq = Math.atan2(
      (q[1]! - c[1]!) * v[1]! + (q[0]! - c[0]!) * v[0]! + (q[2]! - c[2]!) * v[2]!,
      (q[0]! - c[0]!) * u[0]! + (q[1]! - c[1]!) * u[1]! + (q[2]! - c[2]!) * u[2]!,
    );
    return ap - aq;
  });
}

// ── collision emission ──────────────────────────────────────────────────

/** Upright yaw-rotated box → local-frame bounds + yaw, else null.
 *  cx/cz are the box center; hx/hz half-extents on the yaw axes;
 *  y0/y1 world-unit bottom/top. */
function brushObb(s: Solid): { cx: number; cz: number; y0: number; y1: number; hx: number; hz: number; yaw: number } | null {
  if (s.faces.length !== 6 || s.verts.length !== 8) { return null; }
  const v0 = s.verts[0]!;
  const dirs: number[][] = [];
  for (const v of s.verts.slice(1)) {
    const d = [v[0] - v0[0], v[1] - v0[1], v[2] - v0[2]];
    const l = Math.hypot(d[0], d[1], d[2]);
    if (l < 1e-6) { continue; }
    const dn = [d[0] / l, d[1] / l, d[2] / l];
    if (dirs.some((o) => Math.abs(o[0] * dn[0] + o[1] * dn[1] + o[2] * dn[2]) > 0.999)) { continue; }
    dirs.push(dn);
    if (dirs.length === 3) { break; }
  }
  if (dirs.length !== 3) { return null; }
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    if (Math.abs(dirs[i]![0] * dirs[j]![0] + dirs[i]![1] * dirs[j]![1] + dirs[i]![2] * dirs[j]![2]) > 0.01) { return null; }
  }
  const vi = dirs.findIndex((d) => Math.abs(d[1]) > 0.99);
  if (vi < 0) { return null; }
  const horiz = [dirs[(vi + 1) % 3]!, dirs[(vi + 2) % 3]!];
  // pick the horizontal axis nearest world +X as local X
  const ax = Math.abs(horiz[0]![0]) >= Math.abs(horiz[1]![0]) ? horiz[0]! : horiz[1]!;
  const az = horiz[0] === ax ? horiz[1]! : horiz[0]!;
  const axLen = Math.hypot(ax[0], ax[2]) || 1;
  const axn = [ax[0] / axLen, 0, ax[2] / axLen];
  const azLen = Math.hypot(az[0], az[2]) || 1;
  const azn = [az[0] / azLen, 0, az[2] / azLen];
  // structureColliders: local +X → world (cos, sin) in xz; yaw = atan2(ax_z, ax_x)
  const yaw = Math.atan2(axn[2], axn[0]);
  const c = [0, 0, 0];
  for (const v of s.verts) for (let k = 0; k < 3; k++) { c[k]! += v[k]! / 8; }
  const axes = [axn, dirs[vi]!, azn];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const v of s.verts) {
    for (let a = 0; a < 3; a++) {
      const t = (v[0]! - c[0]!) * axes[a]![0] + (v[1]! - c[1]!) * axes[a]![1] + (v[2]! - c[2]!) * axes[a]![2];
      lo[a] = Math.min(lo[a]!, t); hi[a] = Math.max(hi[a]!, t);
    }
  }
  return {
    cx: c[0]!, cz: c[2]!, y0: c[1]! + lo[1]!, y1: c[1]! + hi[1]!,
    hx: (hi[0]! - lo[0]!) / 2, hz: (hi[2]! - lo[2]!) / 2,
    yaw,
  };
}

/** Clip a face polygon to slab y∈[ya,yb]; returns XZ points of the section. */
function slabPoints(f: { poly: number[][] }, ya: number, yb: number): number[][] {
  const pts: number[][] = [];
  const poly = f.poly;
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k]!, q = poly[(k + 1) % poly.length]!;
    const pin = p[1] >= ya - 1e-4 && p[1] <= yb + 1e-4;
    const qin = q[1] >= ya - 1e-4 && q[1] <= yb + 1e-4;
    if (pin) { pts.push(p); }
    if (pin !== qin) {
      for (const yy of [ya, yb]) {
        const dy = q[1]! - p[1]!;
        if (Math.abs(dy) < 1e-9) { continue; }
        const t = (yy - p[1]!) / dy;
        if (t > 0 && t < 1) {
          pts.push([p[0]! + t * (q[0]! - p[0]!), yy, p[2]! + t * (q[2]! - p[2]!)]);
        }
      }
    }
  }
  return pts;
}

function xzHull(pts: number[][]): number[][] {
  const p = [...pts].sort((a, b) => a[0]! - b[0]! || a[2]! - b[2]!);
  const cross = (o: number[], a: number[], b: number[]): number =>
    (a[0]! - o[0]!) * (b[2]! - o[2]!) - (a[2]! - o[2]!) * (b[0]! - o[0]!);
  const lower: number[][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) { lower.pop(); }
    lower.push(q);
  }
  const upper: number[][] = [];
  for (let k = p.length - 1; k >= 0; k--) {
    const q = p[k]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) { upper.pop(); }
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** Non-box brush → Y-sliced AABBs (staircase collision for wedges).
 *  Consecutive slabs with near-identical XZ hulls merge into one box —
 *  straight walls/ramps don't need a box per slab. */
function brushSlices(s: Solid, slab: number): { min: number[]; max: number[] }[] {
  const raw: { min: number[]; max: number[] }[] = [];
  const y0 = s.min[1]!, y1 = s.max[1]!;
  if (y1 - y0 < 1e-6) { return raw; }
  const bands = Math.max(1, Math.min(24, Math.ceil((y1 - y0) / slab)));
  const h = (y1 - y0) / bands;
  for (let b = 0; b < bands; b++) {
    const ya = y0 + b * h, yb = ya + h;
    const pts: number[][] = [];
    for (const f of s.faces) { pts.push(...slabPoints(f, ya, yb)); }
    if (pts.length < 3) { continue; }
    const hull = xzHull(pts);
    if (hull.length < 3) { continue; }
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of hull) {
      x0 = Math.min(x0, p[0]!); x1 = Math.max(x1, p[0]!);
      z0 = Math.min(z0, p[2]!); z1 = Math.max(z1, p[2]!);
    }
    // skip slivers too thin in any horizontal direction
    if (x1 - x0 < 0.5 || z1 - z0 < 0.5) { continue; }
    raw.push({ min: [x0, ya, z0], max: [x1, Math.min(yb, y1), z1] });
  }
  const out: { min: number[]; max: number[] }[] = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    if (last && Math.abs(r.min[0]! - last.min[0]!) < 0.5 && Math.abs(r.min[2]! - last.min[2]!) < 0.5 &&
        Math.abs(r.max[0]! - last.max[0]!) < 0.5 && Math.abs(r.max[2]! - last.max[2]!) < 0.5 &&
        r.min[1]! - last.max[1]! < 1) {
      last.max[1] = r.max[1]; last.max[0] = Math.max(last.max[0]!, r.max[0]!);
      last.max[2] = Math.max(last.max[2]!, r.max[2]!);
      last.min[0] = Math.min(last.min[0]!, r.min[0]!);
      last.min[2] = Math.min(last.min[2]!, r.min[2]!);
      continue;
    }
    out.push(r);
  }
  return out;
}

// ── heightfield bake ────────────────────────────────────────────────────

const HM_N = 513;

function polyNewell(poly: number[][]): [number, number, number] {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    nx += (p[1]! - q[1]!) * (p[2]! + q[2]!);
    ny += (p[2]! - q[2]!) * (p[0]! + q[0]!);
    nz += (p[0]! - q[0]!) * (p[1]! + q[1]!);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

function heightToByte(y: number): number {
  return Math.max(0, Math.min(255, Math.round((y / 125) * 255)));
}

/** Up-facing faces → lowest floor height per bin cell (world meters). */
function bakeHeightfield(faces: { polyW: number[][]; n: [number, number, number] }[], ws: number): Uint8Array {
  const bin = new Uint8Array(8 + HM_N * HM_N);
  const view = new DataView(bin.buffer);
  view.setUint32(0, HM_N, true); view.setUint32(4, HM_N, true);
  const cell = ws / HM_N;
  for (const f of faces) {
    const n = f.n;
    if (n[1] < 0.5) { continue; }
    // world-space polygon for rasterization
    const wpoly = f.polyW;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of wpoly) {
      x0 = Math.min(x0, p[0]!); x1 = Math.max(x1, p[0]!);
      z0 = Math.min(z0, p[2]!); z1 = Math.max(z1, p[2]!);
    }
    const i0 = Math.max(0, Math.floor(x0 / cell)), i1 = Math.min(HM_N - 1, Math.ceil(x1 / cell));
    const j0 = Math.max(0, Math.floor(z0 / cell)), j1 = Math.min(HM_N - 1, Math.ceil(z1 / cell));
    if (i1 < i0 || j1 < j0) { continue; }
    const p0 = wpoly[0]!;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const wx = (i + 0.5) * cell, wz = (j + 0.5) * cell;
        if (!pointInPoly(wx, wz, wpoly)) { continue; }
        const y = p0[1]! - (n[0]! * (wx - p0[0]!) + n[2]! * (wz - p0[2]!)) / n[1]!;
        const hq = heightToByte(y);
        const idx = 8 + j * HM_N + i;
        const cur = bin[idx]!;
        if (cur === 0 || hq < cur) { bin[idx] = hq; }
      }
    }
  }
  return bin;
}

function pointInPoly(wx: number, wz: number, poly: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!, pj = poly[j]!;
    if ((pi[2]! > wz) !== (pj[2]! > wz) &&
        wx < (pj[0]! - pi[0]!) * (wz - pi[2]!) / (pj[2]! - pi[2]!) + pi[0]!) {
      inside = !inside;
    }
  }
  return inside;
}

// ── q3 texture axes (port of q3map TextureAxisFromPlane/QuakeTextureVecs) ──

// rows: [dominant axis dir, axisS, axisT] in QUAKE space (z-up, y-fwd)
const BASE_AXIS: [number[], number[], number[]][] = [
  [[0, 0, 1], [1, 0, 0], [0, -1, 0]],
  [[0, 0, -1], [1, 0, 0], [0, 1, 0]],
  [[1, 0, 0], [0, 1, 0], [0, 0, -1]],
  [[-1, 0, 0], [0, 1, 0], [0, 0, 1]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
];

function textureAxes(nQ3: number[], rotateDeg: number): [number[], number[]] {
  const a = [Math.abs(nQ3[0]!), Math.abs(nQ3[1]!), Math.abs(nQ3[2]!)];
  let d = 0;
  if (a[1]! > a[d]!) { d = 1; }
  if (a[2]! > a[d]!) { d = 2; }
  const sgn = nQ3[d]! >= 0 ? 1 : -1;
  let s: number[] = BASE_AXIS[0]![1], t: number[] = BASE_AXIS[0]![2];
  for (const row of BASE_AXIS) {
    const ax = row[0]!;
    const ai = ax.findIndex((v) => v !== 0);
    if (ai === d && Math.sign(ax[ai]!) === sgn) { s = row[1]!; t = row[2]!; break; }
  }
  if (rotateDeg !== 0) {
    const r = (rotateDeg * Math.PI) / 180;
    const c = Math.cos(r), sn = Math.sin(r);
    const s2 = s.map((v, i) => v * c + t[i]! * sn);
    const t2 = t.map((v, i) => v * c - s[i]! * sn);
    s = s2; t = t2;
  }
  return [s, t];
}

interface TexInfo { f: string; ow: number; oh: number }

function loadTexIndex(): Map<string, TexInfo | null> {
  const p = join(MAPS, 't2', 'q3tex', 'index.json');
  const out = new Map<string, TexInfo | null>();
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, TexInfo | null>;
    for (const [k, v] of Object.entries(j)) { out.set(k, v); }
  } catch { /* no textures baked yet */ }
  return out;
}

/** Face-vertex UVs in q3 space. Internal coords are (x, yUp, z) ↔ q3 (x, z, y). */
function faceUVs(plane: Plane, poly: number[][], tex: TexInfo): [number, number][] {
  // TrenchBroom stores explicit projection axes — uv = dot(pos, axis).
  // shortcut: assumes axes are already in texture-fraction units; if TB
  // actually wants /texWidth, textures will tile ~ow× too fast — verify
  // visually and drop the /ow below if so.
  if (plane.texvec && plane.texvec.length >= 2) {
    const [su, tv] = plane.texvec;
    return poly.map((p) => {
      const q = [p[0]!, p[2]!, p[1]!];
      return [
        su![0]! * q[0]! + su![1]! * q[1]! + su![2]! * q[2]!,
        tv![0]! * q[0]! + tv![1]! * q[1]! + tv![2]! * q[2]!,
      ] as [number, number];
    });
  }
  const tp = plane.tex;
  const sShift = tp[0] ?? 0, tShift = tp[1] ?? 0;
  const rot = tp[2] ?? 0, sScale = tp[3] || 1, tScale = tp[4] || 1;
  // plane.n is internal y-up → q3 normal swaps y/z
  const nQ3 = [plane.n[0], plane.n[2], plane.n[1]];
  const [s, t] = textureAxes(nQ3, rot);
  // mapvec = axis / scale (q3map QuakeTextureVecs)
  const mv0 = s.map((v) => v / sScale);
  const mv1 = t.map((v) => v / tScale);
  const w = tex.ow || 128, h = tex.oh || 128;
  return poly.map((p) => {
    const q = [p[0]!, p[2]!, p[1]!]; // internal → q3
    const u = (sShift + mv0[0]! * q[0]! + mv0[1]! * q[1]! + mv0[2]! * q[2]!) / w;
    const v = (tShift + mv1[0]! * q[0]! + mv1[1]! * q[1]! + mv1[2]! * q[2]!) / h;
    return [u, v] as [number, number];
  });
}

// ── GLB writer ──────────────────────────────────────────────────────────

interface GlbPrim { pos: number[]; nrm: number[]; uv: number[]; idx: number[]; mat: number }
interface GlbMat { color: [number, number, number]; tex?: TexInfo }

function writeGlb(path: string, prims: GlbPrim[], mats: GlbMat[]): void {
  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'q3conv' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'world' }],
    meshes: [{ primitives: [] }],
    materials: [] as Record<string, unknown>[],
    textures: [] as Record<string, unknown>[],
    images: [] as Record<string, unknown>[],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    accessors: [] as Record<string, unknown>[],
    bufferViews: [] as Record<string, unknown>[],
    buffers: [{ byteLength: 0 }],
  };
  const texIndex = new Map<TexInfo, number>();
  const matJson = mats.map((m) => {
    const pbr: Record<string, unknown> = {
      baseColorFactor: [...m.color, 1], metallicFactor: 0, roughnessFactor: 0.9,
    };
    if (m.tex) {
      let ti = texIndex.get(m.tex);
      if (ti === undefined) {
        ti = (json.textures as unknown[]).length;
        texIndex.set(m.tex, ti);
        (json.textures as unknown[]).push({ sampler: 0, source: ti });
        (json.images as unknown[]).push({ mimeType: 'image/png', bufferView: -1 - ti }); // patched below
      }
      pbr.baseColorTexture = { index: ti };
    }
    return { name: 'm', pbrMetallicRoughness: pbr };
  });
  json.materials = matJson;

  const chunks: Uint8Array[] = [];
  const views: Record<string, unknown>[] = [];
  const accs: Record<string, unknown>[] = [];
  let cursor = 0;
  const align = (): void => { const pad = (4 - (cursor % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); cursor += pad; } };
  const addView = (data: Uint8Array, target: number): number => {
    align();
    const byteOffset = cursor;
    chunks.push(data); cursor += data.length;
    views.push({ buffer: 0, byteOffset, byteLength: data.length, target });
    return views.length - 1;
  };
  // embedded PNGs — bufferView indices assigned after geometry views
  const imgViews: { tex: TexInfo; bv: number }[] = [];
  for (const [tex, ti] of [...texIndex.entries()].sort((a, b) => a[1] - b[1])) {
    const data = readFileSync(join(MAPS, 't2', 'q3tex', tex.f));
    imgViews.push({ tex, bv: addView(data, 0) });
    ((json.images as Record<string, unknown>[])[ti] as Record<string, unknown>).bufferView = imgViews[imgViews.length - 1]!.bv;
  }

  const primsJson: Record<string, unknown>[] = [];
  for (const p of prims) {
    const pos = new Float32Array(p.pos);
    const nrm = new Float32Array(p.nrm);
    const uv = new Float32Array(p.uv);
    const idx = new Uint32Array(p.idx);
    const vp = addView(new Uint8Array(pos.buffer, pos.byteOffset, pos.byteLength), 34962);
    const vn = addView(new Uint8Array(nrm.buffer, nrm.byteOffset, nrm.byteLength), 34962);
    const vu = addView(new Uint8Array(uv.buffer, uv.byteOffset, uv.byteLength), 34962);
    const vi = addView(new Uint8Array(idx.buffer, idx.byteOffset, idx.byteLength), 34963);
    const mk = (bv: number, comp: number, count: number, type: string, minmax = false): number => {
      const a: Record<string, unknown> = { bufferView: bv, componentType: comp, count, type };
      if (minmax) {
        let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (let k = 0; k < count; k++) for (let j = 0; j < 3; j++) {
          const v = pos[k * 3 + j]!;
          mn[j] = Math.min(mn[j]!, v); mx[j] = Math.max(mx[j]!, v);
        }
        a.min = mn; a.max = mx;
      }
      accs.push(a);
      return accs.length - 1;
    };
    const vc = p.pos.length / 3;
    primsJson.push({
      attributes: {
        POSITION: mk(vp, 5126, vc, 'VEC3', true),
        NORMAL: mk(vn, 5126, vc, 'VEC3'),
        TEXCOORD_0: mk(vu, 5126, vc, 'VEC2'),
      },
      indices: mk(vi, 5125, p.idx.length, 'SCALAR'),
      material: p.mat,
    });
  }
  (json.meshes as { primitives: Record<string, unknown>[] }[])[0]!.primitives = primsJson;
  json.accessors = accs;
  json.bufferViews = views;

  const bin = new Uint8Array(cursor);
  let o = 0;
  for (const c of chunks) { bin.set(c, o); o += c.length; }
  (json.buffers as { byteLength: number }[])[0]!.byteLength = bin.length;

  const jsonStr = JSON.stringify(json);
  const jsonPad = (4 - (jsonStr.length % 4)) % 4;
  const jsonBuf = new TextEncoder().encode(jsonStr + ' '.repeat(jsonPad));
  const binPad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + jsonBuf.length + 8 + bin.length + binPad;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBuf.length, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBuf, 20);
  let p = 20 + jsonBuf.length;
  dv.setUint32(p, bin.length + binPad, true); dv.setUint32(p + 4, 0x004e4942, true);
  out.set(bin, p + 8);
  writeFileSync(path, out);
}

// ── main ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const inMap = args[0];
const outName = args[1];
if (!inMap || !outName || !/^[\w-]+$/.test(outName)) {
  console.error('usage: q3conv <in.map> <outName> [--scale f] [--ws n]');
  process.exit(1);
}
const opt = (k: string, d: number): number => {
  const i = args.indexOf(k);
  return i >= 0 ? Number(args[i + 1]) : d;
};
YSCALE = opt('--scale', 0.0254);
const WS = opt('--ws', 256);

const ents = parseMap(readFileSync(inMap, 'utf8'));

// world-geometry brushes: worldspawn + func_* only. Trigger/item/light/
// misc entities carry brush VOLUMES (teleporters, spawns) that must not collide.
const WORLD_ENT = (cls: string): boolean =>
  cls === '' || cls === 'worldspawn' || (cls.startsWith('func_') && !cls.startsWith('func_illusionary'));
const brushes: Brush[] = [];
const brushSeen = new Set<string>();
for (const e of ents) {
  if (!WORLD_ENT(e.cls)) { continue; }
  for (const b of e.brushes) {
    // identical plane sets appear twice in some sources — collide once
    const key = b.planes.map((p) => p.pts.map((q) => q.map((v) => v.toFixed(1)).join(',')).join(';') + '|' + p.shader).join('#');
    if (brushSeen.has(key)) { continue; }
    brushSeen.add(key);
    brushes.push(b);
  }
}
console.log(`entities: ${ents.length}, world brushes: ${brushes.length}`);

const SKIP_RENDER = /caulk|nodraw|clip|skip|sky/i;
// clip/skip faces are non-solid in Q3 — a brush made only of them must not collide
const NONSOLID = /clip|skip/i;

// solids
const solids: { brush: Brush; solid: Solid }[] = [];
let bad = 0;
const badHist = new Map<number, number>();
for (const b of brushes) {
  const s = brushSolid(b);
  if (!s) { bad++; badHist.set(b.planes.length, (badHist.get(b.planes.length) ?? 0) + 1); continue; }
  solids.push({ brush: b, solid: s });
}
console.log(`solids: ${solids.length} (unparsed: ${bad})`);
if (process.env.Q3DEBUG) {
  const hist = new Map<number, number>();
  for (const { solid } of solids) { hist.set(solid.verts.length, (hist.get(solid.verts.length) ?? 0) + 1); }
  console.log('vert-count hist:', [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));
  console.log('failed plane-count hist:', [...badHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));
  // largest solids by X span — find the bogus ones
  const big = [...solids].sort((a, b) =>
    (b.solid.max[0]! - b.solid.min[0]!) - (a.solid.max[0]! - a.solid.min[0]!)).slice(0, 5);
  for (const { brush, solid } of big) {
    console.log('BIG brush', brush.ent, 'planes', brush.planes.length, 'verts', solid.verts.length,
      'min', solid.min.map((v) => v.toFixed(0)), 'max', solid.max.map((v) => v.toFixed(0)),
      'shaders', brush.planes.slice(0, 3).map((p) => p.shader));
  }
  for (const { brush, solid } of solids.slice(0, 5)) {
    console.log('brush', brush.ent, 'planes', brush.planes.length, 'verts', solid.verts.length,
      'min', solid.min.map((v) => v.toFixed(0)), 'max', solid.max.map((v) => v.toFixed(0)));
  }
}

// spawns first — needed for the shell test
const SPAWN_CLASSES = new Set([
  'info_player_deathmatch', 'info_player_start', 'info_player_intermission', 'info_player_coop',
  // TDM/CTF team spawns — also feed teamSpawns below
  'info_player_dd_red', 'info_player_dd_blue', 'info_player_team',
  'team_CTF_redspawn', 'team_CTF_bluespawn', 'team_CTF_redplayer', 'team_CTF_blueplayer',
]);
// Q3 blue-family → our alpha, red-family → bravo
const SPAWN_TEAM: Record<string, 'alpha' | 'bravo'> = {
  info_player_dd_blue: 'alpha', team_CTF_bluespawn: 'alpha', team_CTF_blueplayer: 'alpha',
  info_player_dd_red: 'bravo', team_CTF_redspawn: 'bravo', team_CTF_redplayer: 'bravo',
};
const spawnRaw: number[][] = [];
const teamSpawnRaw: Record<'alpha' | 'bravo', number[][]> = { alpha: [], bravo: [] };
for (const e of ents) {
  if (!SPAWN_CLASSES.has(e.cls)) { continue; }
  const o = e.fields.get('origin');
  if (!o) { continue; }
  const p = o.split(/\s+/).map(Number);
  if (!(p.length >= 3 && p.every(Number.isFinite))) { continue; }
  const w = [p[0]!, p[2]!, p[1]!]; // z-up → y-up
  spawnRaw.push(w);
  const tm = SPAWN_TEAM[e.cls];
  if (tm) { teamSpawnRaw[tm].push(w); }
}

// map bounds (map units)
let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
for (const { solid } of solids) {
  for (let k = 0; k < 3; k++) {
    const lo = solid.min[k]!, hi = solid.max[k]!;
    if (k === 0) { bx0 = Math.min(bx0, lo); bx1 = Math.max(bx1, hi); }
    if (k === 1) { by0 = Math.min(by0, lo); by1 = Math.max(by1, hi); }
    if (k === 2) { bz0 = Math.min(bz0, lo); bz1 = Math.max(bz1, hi); }
  }
}
const spanX = (bx1 - bx0) * YSCALE, spanZ = (bz1 - bz0) * YSCALE;
console.log(`bounds m: ${spanX.toFixed(1)} x ${((by1 - by0) * YSCALE).toFixed(1)} x ${spanZ.toFixed(1)}`);

// transform: XZ → [0,WS)², Y lifted so lowest floor ≈ 60m
const margin = WS * 0.06;
const offX = margin - bx0 * YSCALE;
const offZ = margin - bz0 * YSCALE;
const offY = 60 - by0 * YSCALE;
const toWorld = (p: number[]): number[] => [p[0] * YSCALE + offX, p[1] * YSCALE + offY, p[2] * YSCALE + offZ];

// ── collision → spec.structures (kind 'hull' = collision-only) ──────────
// Every collider ships IN the spec so solo (?map=) and hosted rooms see the
// identical set — no hullboxes.json second source to drift.
const structures: Record<string, unknown>[] = [];
let obbCount = 0, sliceCount = 0, dropCount = 0;
const SLAB = 48;

const worldSpawns = spawnRaw.map((p) => toWorld(p));
const pushAabb = (min: number[], max: number[]): void => {
  const size = [max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!];
  if (size.some((v) => v < 0.01)) { return; }
  structures.push({
    kind: 'hull',
    pos: { x: +((min[0]! + max[0]!) / 2).toFixed(3), y: +min[1]!.toFixed(3), z: +((min[2]! + max[2]!) / 2).toFixed(3) },
    size: { x: +size[0]!.toFixed(3), y: +size[1]!.toFixed(3), z: +size[2]!.toFixed(3) },
  });
};

for (const { brush, solid } of solids) {
  const shaders = brush.planes.map((p) => p.shader);
  const allDecor = shaders.every((s) => SKIP_RENDER.test(s));
  const allNonSolid = shaders.every((s) => NONSOLID.test(s));
  // shell test: brush containing ≥90% of spawn origins = enclosing skybox
  let contains = 0;
  for (const sp of worldSpawns) {
    const mp = [ (sp[0]! - offX) / YSCALE, (sp[1]! - offY) / YSCALE, (sp[2]! - offZ) / YSCALE ];
    if (mp[0]! >= solid.min[0]! - 1 && mp[0]! <= solid.max[0]! + 1 &&
        mp[1]! >= solid.min[1]! - 1 && mp[1]! <= solid.max[1]! + 1 &&
        mp[2]! >= solid.min[2]! - 1 && mp[2]! <= solid.max[2]! + 1) { contains++; }
  }
  const isShell = worldSpawns.length > 0 && contains >= worldSpawns.length * 0.9;
  if (allDecor || allNonSolid || isShell) { dropCount++; continue; }

  const obb = brushObb(solid);
  if (obb) {
    obbCount++;
    const hx = obb.hx * YSCALE, hz = obb.hz * YSCALE;
    const hy = (obb.y1 - obb.y0) / 2 * YSCALE;
    const wcy = (obb.y0 + obb.y1) / 2 * YSCALE + offY;
    if (hx > 0.005 && hz > 0.005 && hy > 0.005) {
      structures.push({
        kind: 'hull',
        pos: { x: +(obb.cx * YSCALE + offX).toFixed(3), y: +(wcy - hy).toFixed(3), z: +(obb.cz * YSCALE + offZ).toFixed(3) },
        size: { x: +(hx * 2).toFixed(3), y: +(hy * 2).toFixed(3), z: +(hz * 2).toFixed(3) },
        rotY: +obb.yaw.toFixed(5),
      });
    }
    continue;
  }
  for (const sl of brushSlices(solid, SLAB)) {
    sliceCount++;
    const wmin = toWorld(sl.min), wmax = toWorld(sl.max);
    pushAabb(wmin, wmax);
  }
}
console.log(`colliders: ${obbCount} obb + ${sliceCount} slices (${structures.length} specs), dropped ${dropCount}`);

// ── spawns → spec ───────────────────────────────────────────────────────
const spawns = worldSpawns.map((w) => ({ x: +w[0]!.toFixed(2), y: +(w[1]! + 1).toFixed(2), z: +w[2]!.toFixed(2), r: 2 }));
const mkTeam = (list: number[][]) => list.map((w) => ({ x: +w[0]!.toFixed(2), y: +(w[1]! + 1).toFixed(2), z: +w[2]!.toFixed(2), r: 2 }));
const teamSpawns = (teamSpawnRaw.alpha.length && teamSpawnRaw.bravo.length)
  ? { alpha: mkTeam(teamSpawnRaw.alpha.map(toWorld)), bravo: mkTeam(teamSpawnRaw.bravo.map(toWorld)) }
  : undefined;
console.log(`spawns: ${spawns.length}${teamSpawns ? ` (+${teamSpawns.alpha.length}/${teamSpawns.bravo.length} team)` : ''}`);

// ── GLB geometry ────────────────────────────────────────────────────────
const matIndex = new Map<string, number>();
const mats: GlbMat[] = [];
const prims = new Map<number, GlbPrim>();
const texDb = loadTexIndex();
const texCache = new Map<string, TexInfo | null>();
const lookupTex = (shader: string): TexInfo | null => {
  const key = shader.toLowerCase().replace(/^textures\//, '');
  if (!texCache.has(key)) { texCache.set(key, texDb.get(key) ?? null); }
  return texCache.get(key)!;
};
const hashColor = (s: string): [number, number, number] => {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  const hue = ((h % 360) + 360) % 360;
  const c = 0.45, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = 0.5 - c / 2;
  let r = 0, g = 0, b = 0;
  if (hue < 60) { r = c; g = x; } else if (hue < 120) { r = x; g = c; }
  else if (hue < 180) { g = c; b = x; } else if (hue < 240) { g = x; b = c; }
  else if (hue < 300) { r = x; b = c; } else { r = c; b = x; }
  return [r + m, g + m, b + m];
};

let triCount = 0, faceCount = 0;
const floorFaces: { poly: number[][]; polyW: number[][]; n: [number, number, number] }[] = [];
for (const { brush, solid } of solids) {
  const signs = solid.signs;
  for (const f of solid.faces) {
    const plane = brush.planes[f.plane]!;
    const n = outwardNormal(plane, signs[f.plane]!);
    // floor bake uses the same outward normal — up-facing = n.y > .5
    const wpoly = f.poly.map((p) => toWorld(p));
    if (n[1] > 0.5) { floorFaces.push({ poly: f.poly, polyW: wpoly, n }); }
    if (SKIP_RENDER.test(plane.shader)) { continue; }
    // cull sliver faces — adds no visible area, costs verts+tris
    let area2 = 0;
    for (let k = 0; k < f.poly.length; k++) {
      const p = f.poly[k]!, q = f.poly[(k + 1) % f.poly.length]!;
      area2 += p[0]! * q[2]! - q[0]! * p[2]!; // xz proj — undercounts walls, fine
    }
    if (Math.abs(area2) < 4 && Math.abs(n[1]) > 0.9) { continue; }
    faceCount++;
    let mi = matIndex.get(plane.shader);
    if (mi === undefined) {
      mi = mats.length;
      matIndex.set(plane.shader, mi);
      mats.push({ color: hashColor(plane.shader), tex: lookupTex(plane.shader) ?? undefined });
    }
    let prim = prims.get(mi);
    if (!prim) { prim = { pos: [], nrm: [], uv: [], idx: [], mat: mi }; prims.set(mi, prim); }
    const base = prim.pos.length / 3;
    const tex = mats[mi]!.tex;
    const uvs = tex ? faceUVs(plane, f.poly, tex) : null;
    for (let k = 0; k < f.poly.length; k++) {
      const p = f.poly[k]!;
      const w = toWorld(p);
      prim.pos.push(w[0]!, w[1]!, w[2]!);
      prim.nrm.push(n[0]!, n[1]!, n[2]!);
      const uv = uvs ? uvs[k]! : [0, 0];
      prim.uv.push(uv[0], uv[1]);
    }
    for (let k = 1; k + 1 < f.poly.length; k++) {
      prim.idx.push(base, base + k, base + k + 1);
      triCount++;
    }
  }
}
console.log(`mesh: ${triCount} tris, ${mats.length} materials (${mats.filter((m) => m.tex).length} textured), ${faceCount} faces`);

// ── terrain bin ─────────────────────────────────────────────────────────
const bin = bakeHeightfield(floorFaces, WS);
const covered = bin.subarray(8).reduce((a, b) => a + (b > 0 ? 1 : 0), 0);
console.log(`heightfield: ${(100 * covered / (HM_N * HM_N)).toFixed(1)}% floor coverage`);

// ── emit ────────────────────────────────────────────────────────────────
mkdirSync(DIF, { recursive: true });

const spec = {
  name: outName,
  mode: 'dm',
  _q3: true, // ported-map family badge — lobby splits T2/Q3/custom on this
  maxPlayers: 16,
  bots: 0,
  botFill: 0,
  balls: { base: 0, perPlayer: 0, max: 0 },
  spawns,
  ...(teamSpawns ? { teamSpawns } : {}),
  structures,
  terrain: `${outName}.bin`,
  tileSize: WS,
  heightScale: 1,
  killY: 30,
  interiors: [{ file: `${outName}.dif`, pos: { x: 0, y: 0, z: 0 } }],
  fog: { color: [0.7, 0.75, 0.8], distance: 60, visible: 400 },
  atmosphere: { rayleigh: 1.0, mie: 1.6, sunIntensity: 1.0, timeOfDay: 0.4 },
  _notes: `q3conv port of ${inMap} — ${brushes.length} brushes, ${solids.length} solids, ${triCount} tris.`,
};
writeFileSync(join(MAPS, `${outName}.json`), JSON.stringify(spec));
writeFileSync(join(MAPS, `${outName}.bin`), bin);
writeGlb(join(DIF, `${outName}.glb`), [...prims.values()], mats);
console.log(`wrote maps/${outName}.{json,bin}  maps/t2/dif/${outName}.glb`);
