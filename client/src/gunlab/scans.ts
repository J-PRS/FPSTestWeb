// gunlab geometry scans — the lab's mesh lints, all pure functions
// over a built Object3D. zScan: coplanar triangle pairs are what
// shimmer — collect world-space triangles, bucket by plane (normal +
// offset), then SAT-test overlaps within a bucket. holeScan:
// welded-edge census — an edge referenced by exactly one triangle is
// an open rim, i.e. a hole boundary (or an intentionally open face
// like mkBore's disc — the report doesn't judge intent). gapScan:
// floating-part lint via AABB union-find — a part whose box touches
// no other part's box is detached geometry. volScan: signed-volume
// winding census (divergence theorem) — a closed mesh sums positive
// when its tris face outward, NEGATIVE when it's inside-out; catches
// the inverted-mesh bug holeScan can't since it's still watertight.
import * as THREE from 'three';

const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
const EDGE = new THREE.Vector3();
const _tmpC = new THREE.Vector3();
interface ZTri { n: THREE.Vector3; d: number; p: [THREE.Vector3, THREE.Vector3, THREE.Vector3]; m: number }

// 2D SAT: project both triangles on each of the 6 edge-normal axes.
function zOverlap2d(a: THREE.Vector2[], b: THREE.Vector2[]): boolean {
  for (const t of [a, b]) {
    for (let i = 0; i < 3; i++) {
      const p = t[i]!, q = t[(i + 1) % 3]!;
      const nx = -(q.y - p.y), ny = q.x - p.x;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const v of a) { const s = v.x * nx + v.y * ny; aMin = Math.min(aMin, s); aMax = Math.max(aMax, s); }
      for (const v of b) { const s = v.x * nx + v.y * ny; bMin = Math.min(bMin, s); bMax = Math.max(bMax, s); }
      if (aMax < bMin || bMax < aMin) {return false;}
    }
  }
  return true;
}

/** Returns { pairs, at[], flagVerts } — flagVerts is the flat xyz list of
 *  every flagged triangle, for the magenta paint pass. */
export function zScan(root: THREE.Object3D): { pairs: number; at: number[][]; flagVerts: number[]; who: string[] } {
  root.updateMatrixWorld(true);
  const tris: ZTri[] = [];
  const names: string[] = [''];
  let meshId = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) {return;}
    meshId++;
    names[meshId] = m.name || m.geometry.type;
    const pos = m.geometry.getAttribute('position');
    const idx = m.geometry.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
      const [ia, ib, ic] = idx ? [idx.getX(t * 3), idx.getX(t * 3 + 1), idx.getX(t * 3 + 2)] : [t * 3, t * 3 + 1, t * 3 + 2];
      A.fromBufferAttribute(pos, ia).applyMatrix4(m.matrixWorld);
      B.fromBufferAttribute(pos, ib).applyMatrix4(m.matrixWorld);
      C.fromBufferAttribute(pos, ic).applyMatrix4(m.matrixWorld);
      const n = new THREE.Vector3().subVectors(B, A).cross(EDGE.subVectors(C, A));
      if (n.lengthSq() < 1e-12) {continue;}
      n.normalize();
      tris.push({ n, d: n.dot(A), p: [A.clone(), B.clone(), C.clone()], m: meshId });
    }
  });
  let pairs = 0;
  const at: number[][] = [], flagVerts: number[] = [], who: string[] = [];
  for (let i = 0; i < tris.length; i++) {
    for (let j = i + 1; j < tris.length; j++) {
      const x = tris[i]!, y = tris[j]!;
      // Cross-mesh only — same-mesh coplanarity is authored tessellation
      // (extrude caps, fan splits), not a fight between two surfaces.
      if (x.m === y.m) {continue;}
      // Same-FACING coplanar only: opposite-facing pairs are flush butt
      // joints hidden inside the model — they can't win pixels.
      if (x.n.dot(y.n) < 0.9999) {continue;}
      if (Math.abs(x.d - y.d) > 5e-4) {continue;}
      // Project to the plane's dominant 2D axes for the SAT overlap.
      const an = new THREE.Vector3(Math.abs(x.n.x), Math.abs(x.n.y), Math.abs(x.n.z));
      const drop = an.x > an.y ? (an.x > an.z ? 0 : 2) : (an.y > an.z ? 1 : 2);
      const proj = (v: THREE.Vector3) => drop === 0 ? new THREE.Vector2(v.y, v.z) : drop === 1 ? new THREE.Vector2(v.x, v.z) : new THREE.Vector2(v.x, v.y);
      const xa = x.p.map(proj), ya = y.p.map(proj);
      if (!zOverlap2d(xa, ya)) {continue;}
      // Clip x's projected tri by y's half-planes — the INTERSECTION is
      // the fighting patch; painting whole tris flags innocent surface.
      let poly = xa;
      const cx = (ya[0]!.x + ya[1]!.x + ya[2]!.x) / 3, cy = (ya[0]!.y + ya[1]!.y + ya[2]!.y) / 3;
      for (let e = 0; e < 3 && poly.length; e++) {
        const p = ya[e]!, q = ya[(e + 1) % 3]!;
        const nx = -(q.y - p.y), ny = q.x - p.x; // edge normal
        const sign = Math.sign(nx * (cx - p.x) + ny * (cy - p.y)) || 1; // inside = centroid side
        const inside = (v: THREE.Vector2) => sign * (nx * (v.x - p.x) + ny * (v.y - p.y)) >= -1e-9;
        const out: THREE.Vector2[] = [];
        for (let k = 0; k < poly.length; k++) {
          const s = poly[k]!, t = poly[(k + 1) % poly.length]!;
          if (inside(s)) {out.push(s);}
          const sin = inside(s), tin = inside(t);
          if (sin !== tin) {
            const ds = sign * (nx * (s.x - p.x) + ny * (s.y - p.y));
            const dt = sign * (nx * (t.x - p.x) + ny * (t.y - p.y));
            const f = ds / (ds - dt);
            out.push(new THREE.Vector2(s.x + (t.x - s.x) * f, s.y + (t.y - s.y) * f));
          }
        }
        poly = out;
      }
      if (poly.length < 3) {continue;}
      pairs++;
      // Lift each clipped 2D point back to x's 3D plane via barycentrics
      // of the projected triangle — axis-drop projection is affine.
      const [p0, p1, p2] = xa, [q0, q1, q2] = x.p;
      const den = (p1.y - p2.y) * (p0.x - p2.x) + (p2.x - p1.x) * (p0.y - p2.y);
      const lift = (v: THREE.Vector2): number[] => {
        const w0 = ((p1.y - p2.y) * (v.x - p2.x) + (p2.x - p1.x) * (v.y - p2.y)) / den;
        const w1 = ((p2.y - p0.y) * (v.x - p2.x) + (p0.x - p2.x) * (v.y - p2.y)) / den;
        const w2 = 1 - w0 - w1;
        return [q0.x * w0 + q1.x * w1 + q2.x * w2,
          q0.y * w0 + q1.y * w1 + q2.y * w2,
          q0.z * w0 + q1.z * w1 + q2.z * w2];
      };
      // Fan-triangulate the (convex) clip polygon into the flat vert list.
      for (let k = 1; k + 1 < poly.length; k++) {
        flagVerts.push(...lift(poly[0]!), ...lift(poly[k]!), ...lift(poly[k + 1]!));
      }
      if (at.length < 6) {
        const c = x.p[0].clone().add(x.p[1]).add(x.p[2]).multiplyScalar(1 / 3);
        at.push(c.toArray().map(v => Number(v.toFixed(3))));
        who.push(`${names[x.m]}~${names[y.m]}`);
      }
    }
  }
  return { pairs, at, flagVerts, who };
}

// Same 1mm weld tolerance as the edge bake.
export function holeScan(root: THREE.Object3D): { holes: number; at: number[][]; who: string[] } {
  root.updateMatrixWorld(true);
  interface ERef { a: THREE.Vector3; b: THREE.Vector3; m: number }
  const edges = new Map<string, ERef[]>();
  const names: string[] = [''];
  let meshId = 0;
  const pk = (v: THREE.Vector3) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) {return;}
    meshId++;
    names[meshId] = m.name || m.geometry.type;
    const pos = m.geometry.getAttribute('position');
    const idx = m.geometry.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
      const [ia, ib, ic] = idx ? [idx.getX(t * 3), idx.getX(t * 3 + 1), idx.getX(t * 3 + 2)] : [t * 3, t * 3 + 1, t * 3 + 2];
      A.fromBufferAttribute(pos, ia).applyMatrix4(m.matrixWorld);
      B.fromBufferAttribute(pos, ib).applyMatrix4(m.matrixWorld);
      C.fromBufferAttribute(pos, ic).applyMatrix4(m.matrixWorld);
      const pts = [A, B, C];
      for (const [u, w] of [[0, 1], [1, 2], [2, 0]] as const) {
        const ka = pk(pts[u]!), kb = pk(pts[w]!);
        const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        let l = edges.get(key);
        if (!l) {edges.set(key, l = []);}
        l.push({ a: pts[u]!.clone(), b: pts[w]!.clone(), m: meshId });
      }
    }
  });
  let holes = 0;
  const at: number[][] = [], who: string[] = [];
  for (const l of edges.values()) {
    if (l.length !== 1) {continue;}
    holes++;
    if (at.length < 8) {
      const e = l[0]!;
      at.push(e.a.clone().add(e.b).multiplyScalar(0.5).toArray().map(v => Number(v.toFixed(3))));
      who.push(names[e.m]!);
    }
  }
  return { holes, at, who };
}

export function gapScan(root: THREE.Object3D): { orphans: number; who: string[]; at: number[][]; clusters: number } {
  root.updateMatrixWorld(true);
  const parts: { m: THREE.Mesh; box: THREE.Box3 }[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) {return;}
    m.geometry.computeBoundingBox();
    const box = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);
    parts.push({ m, box });
  });
  const EPS2 = 0.002;
  const touch = (a: THREE.Box3, b: THREE.Box3) =>
    a.min.x - EPS2 <= b.max.x && b.min.x - EPS2 <= a.max.x &&
    a.min.y - EPS2 <= b.max.y && b.min.y - EPS2 <= a.max.y &&
    a.min.z - EPS2 <= b.max.z && b.min.z - EPS2 <= a.max.z;
  // Union-find over box-overlap: cluster count + orphan detection in one pass.
  const parent = parts.map((_, i) => i);
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]!));
  for (let i = 0; i < parts.length; i++)
    {for (let j = i + 1; j < parts.length; j++)
      if (touch(parts[i]!.box, parts[j]!.box)) parent[find(i)] = find(j);}
  const roots = new Set(parts.map((_, i) => find(i)));
  // Orphan = a cluster of one (not merely a small cluster).
  const size = new Map<number, number>();
  for (let i = 0; i < parts.length; i++) {size.set(find(i), (size.get(find(i)) ?? 0) + 1);}
  const orphans: { m: THREE.Mesh; box: THREE.Box3 }[] = [];
  for (let i = 0; i < parts.length; i++) {if (size.get(find(i)) === 1) orphans.push(parts[i]!);}
  const who: string[] = [], at: number[][] = [];
  for (const o of orphans.slice(0, 8)) {
    who.push(o.m.name || o.m.geometry.type);
    at.push(o.box.getCenter(_tmpC).toArray().map(v => Number(v.toFixed(3))));
  }
  return { orphans: orphans.length, who, at, clusters: roots.size };
}

// Open pieces (bore discs, glow strips) are allowed a small negative
// read: they report |vol| relative to bbox so only real flips flag.
export function volScan(root: THREE.Object3D): { inverted: number; who: string[] } {
  root.updateMatrixWorld(true);
  const who: string[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) {return;}
    const pos = m.geometry.getAttribute('position');
    const idx = m.geometry.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    let vol = 0;
    for (let t = 0; t < triCount; t++) {
      const [ia, ib, ic] = idx ? [idx.getX(t * 3), idx.getX(t * 3 + 1), idx.getX(t * 3 + 2)] : [t * 3, t * 3 + 1, t * 3 + 2];
      A.fromBufferAttribute(pos, ia).applyMatrix4(m.matrixWorld);
      B.fromBufferAttribute(pos, ib).applyMatrix4(m.matrixWorld);
      C.fromBufferAttribute(pos, ic).applyMatrix4(m.matrixWorld);
      vol += A.dot(EDGE.copy(B).cross(C)) / 6;
    }
    // Normalise against the mesh's own AABB volume — a real shell reads
    // as a stable fraction of its box; open discs read ~0 either sign.
    m.geometry.computeBoundingBox();
    const bb = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld).getSize(EDGE);
    // Flat meshes (bore discs, glow strips) can't be volume-tested —
    // a near-zero bbox axis explodes the ratio; skip them.
    if (Math.min(bb.x, bb.y, bb.z) < 0.002) {return;}
    const norm = vol / Math.max(bb.x * bb.y * bb.z, 1e-9);
    if (norm < -0.02) {who.push(`${m.name || m.geometry.type}(${norm.toFixed(2)})`);}
  });
  return { inverted: who.length, who };
}
