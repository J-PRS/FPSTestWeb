import * as THREE from 'three';
import Logger from '../../core/Logger.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Shared material palette + tube/bore helpers for the procedural weapon
// builders. Hoisted so every family file (weaponsGeo, weaponsGeoEnergy,
// weaponsGeoSidearm) builds against the same palette.
export const bodyMat = new THREE.MeshLambertMaterial({ color: 0x55_5a_60, emissive: 0x1C1E20 });
export const darkMat = new THREE.MeshLambertMaterial({ color: 0x2A2D30, emissive: 0x0E0F10 });
export const boreMat = new THREE.MeshBasicMaterial({ color: 0x00_00_00 });
export const shellMat = new THREE.MeshLambertMaterial({ color: 0xa8_24_1a, emissive: 0x2a_06_04 });
export const brassMat = new THREE.MeshLambertMaterial({ color: 0xB08A3A, emissive: 0x241A08 });

// hseg: vertex AO bakes per-vertex — a 1-segment cylinder only has two
// vert rings, so one occluded rim shades the WHOLE length black. Long
// tubes need a few height segments for the bake to resolve locally.
export const mkTube = (r1: number, r2: number, len: number, z: number, mat: THREE.Material, hseg = 1) => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, 8, hseg), mat);
  m.rotation.x = Math.PI / 2;
  m.position.z = z;
  return m;
};
export const mkBore = (r: number, z: number) => {
  const m = new THREE.Mesh(new THREE.CircleGeometry(r, 8), boreMat);
  m.position.z = z;
  return m;
};

// --- Loft kit -------------------------------------------------------------
// Build hard-surface parts by skinning 2D ring profiles along Z instead of
// hand-placing primitives. Every section must carry the same point count —
// the profile helpers all take a seg count for that reason.

export type Ring2 = [number, number][];
/** A section is a ring or a point — points collapse the skin to a
 *  triangle fan, i.e. dome/taper terminations without a hand-made cap. */
export interface LoftSection { z: number; ring?: Ring2; point?: [number, number]; dx?: number; dy?: number }

/** Same profile, scaled — the CAD "offset" move. Use for tapers/steps
 *  instead of re-authoring the ring. */
export const scaleRing = (r: Ring2, s: number): Ring2 => r.map(([x, y]) => [x * s, y * s] as [number, number]);
/** Twist a ring around its center — rotated sections make rifled/spiral
 *  forms and let you clock hex flats wherever they read best. */
export const rotRing = (r: Ring2, rad: number): Ring2 => {
  const c = Math.cos(rad), s = Math.sin(rad);
  return r.map(([x, y]) => [x * c - y * s, x * s + y * c] as [number, number]);
};

/** Circular ring profile. */
export const profCircle = (r: number, seg = 16): Ring2 => {
  const pts: Ring2 = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
};

/** Superellipse ring — n=2 ellipse, n>=6 is a chamfered rectangle (flat
 *  45° corner facets, no rounded fillet). This is the clean-chamfer answer
 *  RoundedBoxGeometry couldn't give us. */
export const profSuper = (w: number, h: number, n = 6, seg = 32): Ring2 => {
  const pts: Ring2 = [];
  const e = 2 / n;
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    pts.push([Math.sign(c) * Math.abs(c) ** e * w / 2, Math.sign(s) * Math.abs(s) ** e * h / 2]);
  }
  return pts;
};

/** Chamfered-rectangle ring — an 8-point octagon with true planar 45°
 *  corner facets (mkSoftBox's silhouette as a loft profile). Sharper
 *  than profSuper at any n — the hard-surface house style. */
export const profOct = (w: number, h: number, r: number): Ring2 => {
  const hw = w / 2, hh = h / 2;
  // CCW winding to match profCircle/profSuper — normals face outward.
  return [
    [ hw - r, -hh], [ hw, -hh + r], // bottom-right chamfer
    [ hw,  hh - r], [ hw - r,  hh], // top-right
    [-hw + r,  hh], [-hw,  hh - r], // top-left
    [-hw, -hh + r], [-hw + r, -hh], // bottom-left
  ];
};

/** Build-time lint for ring profiles — catches the silent bug class we
 *  kept hitting in the lab: clockwise rings render inside-out (watertight
 *  but inverted — hole scans can't see it), mismatched section counts
 *  silently skin garbage, duplicate points make degenerate faces.
 *  Cheap enough to run on every build; warns, never throws. */
export const validateRing = (r: Ring2, tag = 'ring'): void => {
  let area = 0;
  for (let i = 0; i < r.length; i++) {
    const [x0, y0] = r[i]!, [x1, y1] = r[(i + 1) % r.length]!;
    area += x0 * y1 - x1 * y0;
    if (Math.hypot(x1 - x0, y1 - y0) < 1e-6) {Logger.warn(`[weaponKit] ${tag}: duplicate/degenerate point at ${i}`);}
  }
  if (area < 0) {Logger.warn(`[weaponKit] ${tag}: ring wound clockwise — normals will face INWARD`);}
  if (r.length < 3) {Logger.warn(`[weaponKit] ${tag}: ring has ${r.length} points`);}
};
const validateLoft = (sections: LoftSection[]): void => {
  let n = -1;
  for (const s of sections) {
    if (!s.ring) {continue;}
    if (n < 0) {n = s.ring.length;}
    else if (s.ring.length !== n) {Logger.warn(`[weaponKit] loft: section count mismatch ${s.ring.length} vs ${n} — resampleRing first`);}
    validateRing(s.ring, 'loft section');
  }
};

/** Skin ring sections into a solid along Z, ngon-cap both ends. Non-indexed
 *  so faces are flat-shaded (hard-surface read + vertex-AO friendly).
 *  UVs are surface-relative: u wraps the ring, v runs the length. */
export const mkLoft = (sections: LoftSection[], mat: THREE.Material, cap = true): THREE.Mesh => {
  validateLoft(sections);
  const seg = (sections.find(s => s.ring)?.ring ?? []).length;
  const pos: number[] = [], uv: number[] = [];
  const pt = (s: LoftSection): [number, number, number] => [s.point![0] + (s.dx ?? 0), s.point![1] + (s.dy ?? 0), s.z];
  const ring = (s: LoftSection, j: number): [number, number, number] => {
    const p = s.ring![j % seg]!;
    return [p[0] + (s.dx ?? 0), p[1] + (s.dy ?? 0), s.z];
  };
  const quad = (a: number[], b: number[], c: number[], d: number[], u0: number, u1: number, v0: number, v1: number) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
  };
  const tri = (a: number[], b: number[], c: number[], u0: number, u1: number, v0: number, v1: number) => {
    pos.push(...a, ...b, ...c);
    uv.push((u0 + u1) / 2, v0, u1, v1, u0, v1);
  };
  for (let i = 0; i < sections.length - 1; i++) {
    const s0 = sections[i]!, s1 = sections[i + 1]!;
    for (let j = 0; j < seg; j++) {
      if (s0.point && s1.ring) {tri(pt(s0), ring(s1, j), ring(s1, j + 1), j / seg, (j + 1) / seg, s0.z, s1.z);}
      else if (s0.ring && s1.point) {tri(pt(s1), ring(s0, j + 1), ring(s0, j), j / seg, (j + 1) / seg, s0.z, s1.z);}
      else if (s0.ring && s1.ring) {
        const a = ring(s0, j), b = ring(s1, j), c = ring(s1, j + 1), d = ring(s0, j + 1);
        quad(a, b, c, d, j / seg, (j + 1) / seg, s0.z, s1.z);
      }
    }
  }
  if (cap) {
    const capEnd = (s: LoftSection, flip: boolean) => {
      if (!s.ring) {return;} // point ends are already closed by the fan
      let cx = 0, cy = 0;
      for (const p of s.ring) { cx += p[0]; cy += p[1]; }
      cx = cx / seg + (s.dx ?? 0); cy = cy / seg + (s.dy ?? 0);
      for (let j = 0; j < seg; j++) {
        const a = ring(s, j), b = ring(s, j + 1);
        if (flip) {pos.push(cx, cy, s.z, ...a, ...b);} else {pos.push(cx, cy, s.z, ...b, ...a);}
        uv.push(0.5, s.z, (j + 1) / seg, s.z, j / seg, s.z);
      }
    };
    capEnd(sections[0]!, true);        // +Z end faces forward
    capEnd(sections[sections.length - 1]!, false); // −Z end faces back
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
};

/** Morph between two ring profiles — circle→octagon transitions in ONE
 *  loft (round barrel flowing into a square receiver) instead of a
 *  butt-joint. Rings need equal point counts; resampleRing fixes that.
 *  t=0 returns a, t=1 returns b. */
export const morphRing = (a: Ring2, b: Ring2, t: number): Ring2 => {
  if (a.length !== b.length) {b = resampleRing(b, a.length);}
  return a.map(([ax, ay], i) => {
    const [bx, by] = b[i]!;
    return [ax + (bx - ax) * t, ay + (by - ay) * t] as [number, number];
  });
};

/** Profile-keyframe loft — list ring sections with DIFFERENT profiles or
 *  counts and get back a mkLoft-ready section list with the transitions
 *  interpolated. `subdiv` morph slices are inserted between each key pair
 *  (point sections pass through untouched — morph only ring→ring spans).
 *  Barrel→receiver in one call: morphLoft([{z:0, ring:profOct(...)},
 *  {z:-0.1, ring:profCircle(...)}]) → mkLoft(...). */
export const morphLoft = (keys: LoftSection[], subdiv = 4): LoftSection[] => {
  const out: LoftSection[] = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!, next = keys[i + 1];
    out.push(k);
    if (!next || !k.ring || !next.ring) {continue;}
    const n = Math.max(k.ring.length, next.ring.length);
    const a = resampleRing(k.ring, n), b = resampleRing(next.ring, n);
    for (let s = 1; s <= subdiv; s++) {
      const t = s / (subdiv + 1);
      out.push({ z: k.z + (next.z - k.z) * t, ring: morphRing(a, b, t), dx: (k.dx ?? 0) + ((next.dx ?? 0) - (k.dx ?? 0)) * t, dy: (k.dy ?? 0) + ((next.dy ?? 0) - (k.dy ?? 0)) * t });
    }
  }
  return out;
};

/** Revolve (lathe) — rotate a 2D [radius, z] profile around Z. Barrels,
 *  muzzle bells, dial knobs, optic lenses: any turned part. Winding is
 *  fixed for profiles ordered toward +Z (rear→nose in our convention:
 *  z increasing along the list). seg = radial resolution. Open-ended
 *  profiles (r never hits 0) make a tube; r=0 rows close as point caps. */
export const mkRevolve = (profile: [number, number][], mat: THREE.Material, seg = 12, smooth = false): THREE.Mesh => {
  const pos: number[] = [], uv: number[] = [];
  const n = profile.length;
  for (let i = 0; i < n - 1; i++) {
    const [r0, z0] = profile[i]!, [r1, z1] = profile[i + 1]!;
    for (let j = 0; j < seg; j++) {
      const a0 = (j / seg) * Math.PI * 2, a1 = ((j + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      if (r0 === 0) { // point cap at this end — fan, no quad
        pos.push(0, 0, z0, r1 * c1, r1 * s1, z1, r1 * c0, r1 * s0, z1);
        uv.push(0, z0, 0, z1, 1, z1);
      } else if (r1 === 0) {
        pos.push(r0 * c0, r0 * s0, z0, r0 * c1, r0 * s1, z0, 0, 0, z1);
        uv.push(0, z0, 1, z0, 1, z1);
      } else {
        pos.push(r0 * c0, r0 * s0, z0, r1 * c1, r1 * s1, z1, r1 * c0, r1 * s0, z1);
        pos.push(r0 * c0, r0 * s0, z0, r0 * c1, r0 * s1, z0, r1 * c1, r1 * s1, z1);
        uv.push(0, z0, 0, z1, 1, z1, 0, z0, 1, z1, 1, z0);
      }
    }
  }
  let geo: THREE.BufferGeometry = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  // smooth welds the seam — barrels/knobs want averaged normals, not
  // per-face facets (mid-poly rule: chamfers hard, turned parts soft).
  if (smooth) {geo = mergeVertices(geo);}
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
};

/** Gear/star ring — `teeth` flat-tipped splines alternating root↔tip
 *  radius. Drop into mkLoft for knurled dials, spline shafts, finned
 *  heat sinks. Duty controls how fat the tooth flat is (0..0.5). */
export const profGear = (teeth: number, rRoot: number, rTip: number, duty = 0.3): Ring2 => {
  const pts: Ring2 = [];
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    // 4 points per tooth: root→tip→tip→root keeps flats planar.
    const A = a, B = a + step * duty, C = a + step * (1 - duty), D = a + step;
    pts.push([Math.cos(A) * rRoot, Math.sin(A) * rRoot]);
    pts.push([Math.cos(B) * rTip, Math.sin(B) * rTip]);
    pts.push([Math.cos(C) * rTip, Math.sin(C) * rTip]);
    pts.push([Math.cos(D) * rRoot, Math.sin(D) * rRoot]);
  }
  return pts;
};

/** Cut a rectangular notch into edge `edge` of a ring — the machined-
 *  groove move. Because the notch lives in the PROFILE, lofted bodies
 *  get real grooves that follow tapers for free; no decals, no booleans.
 *  edge indexes ring[i]→ring[i+1]; t0..t1 position the notch along it;
 *  depth pushes the notch floor toward the ring center. `spans` are
 *  [t0,t1] pairs along the edge — all applied at once since each notch
 *  grows the ring (apply edges in DESCENDING index order). `slope` insets
 *  the groove floor toward each span's middle — sloped walls catch light
 *  so the groove READS (0 = vertical walls, which render flat — per the
 *  id Quake4 art guidance, pure 90° indents carry no shading gradient). */
export const notchRing = (r: Ring2, edge: number, spans: [number, number][], depth: number, slope = 0): Ring2 => {
  const m = r.length;
  const a = r[edge % m]!, b = r[(edge + 1) % m]!;
  const lerp = (t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const dip = (p: [number, number]): [number, number] => {
    const l = Math.hypot(p[0], p[1]) || 1;
    return [p[0] * (1 - depth / l), p[1] * (1 - depth / l)];
  };
  const out = r.slice(0, edge + 1);
  for (const [t0, t1] of [...spans].toSorted((x, y) => x[0] - y[0])) {
    const s = slope * (t1 - t0);
    out.push(lerp(t0), dip(lerp(t0 + s)), dip(lerp(t1 - s)), lerp(t1));
  }
  for (let i = edge + 1; i < m; i++) {out.push(r[i]!);}
  return out;
};

/** Re-sample a ring to n points by arc length — keeps the polygon's
 *  SHAPE (extra points land on the flats), just changes the count so
 *  mkAnnulus's inner/outer rings can mismatch in segment count. */
export const resampleRing = (r: Ring2, n: number): Ring2 => {
  const m = r.length;
  const lens: number[] = [0];
  for (let i = 0; i < m; i++) {
    const [x0, y0] = r[i]!, [x1, y1] = r[(i + 1) % m]!;
    lens.push(lens[i]! + Math.hypot(x1 - x0, y1 - y0));
  }
  const total = lens[m]!;
  const out: Ring2 = [];
  let e = 0;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * total;
    while (e < m - 1 && lens[e + 1]! < t) {e++;}
    const f = (t - lens[e]!) / Math.max(lens[e + 1]! - lens[e]!, 1e-9);
    const [x0, y0] = r[e]!, [x1, y1] = r[(e + 1) % m]!;
    out.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f]);
  }
  return out;
};

/** Annulus — a ring extrusion with a TRUE through-hole (mkLoft can't
 *  express one: its caps always close). Skins the outer wall, inner wall,
 *  and both flat ring faces. Both rings need the same point count; the
 *  hole takes `inner`'s shape, so a hex ring can carry a round bore.
 *  Sections ordered like mkLoft: first z is the back (+Z) face. */
export const mkAnnulus = (outer: Ring2, inner: Ring2, zBack: number, zFront: number, mat: THREE.Material): THREE.Mesh => {
  const seg = outer.length;
  // Counts mismatch? Re-sample the inner to the outer's count so e.g. a
  // hex rim can carry a 12-sided bore. Starts must be angle-aligned.
  validateRing(outer, 'annulus outer');
  if (inner.length === seg) {validateRing(inner, 'annulus inner');}
  else {inner = resampleRing(inner, seg);}
  const pos: number[] = [], uv: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], u0: number, u1: number, v0: number, v1: number) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
  };
  const O = (j: number, z: number) => [...outer[j % seg]!, z] as number[];
  const I = (j: number, z: number) => [...inner[j % seg]!, z] as number[];
  for (let j = 0; j < seg; j++) {
    const u0 = j / seg, u1 = (j + 1) / seg;
    quad(O(j, zBack), O(j, zFront), O(j + 1, zFront), O(j + 1, zBack), u0, u1, zBack, zFront); // outer wall (outward)
    quad(I(j, zBack), I(j + 1, zBack), I(j + 1, zFront), I(j, zFront), u0, u1, zBack, zFront); // inner wall (faces the hole)
    quad(O(j, zBack), O(j + 1, zBack), I(j + 1, zBack), I(j, zBack), u0, u1, 0, 1);           // back face (+Z)
    quad(O(j, zFront), I(j, zFront), I(j + 1, zFront), O(j + 1, zFront), u0, u1, 0, 1);        // front face (−Z)
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
};

/** Swept tube along a 3D polyline — cables, hoses, feed chutes, handguard
 *  rails: everything we've been faking with rotated boxes. Uses parallel-
 *  transport frames so the profile doesn't twist along the run. Radii may
 *  vary per point ([x,y,z,r] — r optional, defaults to `radius`). */
export const tubePath = (pts: [number, number, number, number?][], radius: number, mat: THREE.Material, seg = 8, cap = true): THREE.Mesh => {
  const n = pts.length;
  // Tangent per point (central differences), then parallel-transport a
  // normal down the chain: project out the tangent component each step.
  const T: THREE.Vector3[] = [], N: THREE.Vector3[] = [], B: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(n - 1, i + 1)]!;
    T.push(new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize());
  }
  let nv = Math.abs(T[0]!.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < n; i++) {
    nv.sub(T[i]!.clone().multiplyScalar(nv.dot(T[i]!))).normalize();
    N.push(nv.clone());
    B.push(new THREE.Vector3().crossVectors(T[i]!, nv));
    nv = B[i]!.clone().cross(T[i]!).normalize(); // carry forward
  }
  const pos: number[] = [], uv: number[] = [];
  const ring = (i: number, j: number): number[] => {
    const a = (j / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const p = pts[i]!, r = p[3] ?? radius;
    return [p[0] + (N[i]!.x * c + B[i]!.x * s) * r, p[1] + (N[i]!.y * c + B[i]!.y * s) * r, p[2] + (N[i]!.z * c + B[i]!.z * s) * r];
  };
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < seg; j++) {
      // Winding is mirrored vs mkLoft: sections advance ALONG the ring's
      // CCW axis (+t), where lofts travel against it.
      const a = ring(i, j), b = ring(i, j + 1), c = ring(i + 1, j + 1), d = ring(i + 1, j);
      pos.push(...a, ...b, ...c, ...a, ...c, ...d);
      uv.push(j / seg, i, (j + 1) / seg, i, (j + 1) / seg, i + 1, j / seg, i, (j + 1) / seg, i + 1, j / seg, i + 1);
    }
  }
  if (cap) {
    for (const [i, flip] of [[0, true], [n - 1, false]] as const) {
      const p = pts[i]!;
      for (let j = 0; j < seg; j++) {
        const a = ring(i, j), b = ring(i, j + 1);
        if (flip) {pos.push(p[0], p[1], p[2], ...b, ...a);} else {pos.push(p[0], p[1], p[2], ...a, ...b);}
        uv.push(0.5, i, 1, i, 0, i);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
};

// Chamfered box — a rectangle with chamfered corners, extruded with a
// flat bevel on the caps. All 12 edges get a planar 45° face and the
// corners close as clean triangles — no pinched corner vertex like
// RoundedBoxGeometry's seg-1 hack.
export const mkSoftBox = (w: number, h: number, d: number, mat: THREE.Material, r = 0.004) => {
  const hw = w / 2, hh = h / 2;
  const s = new THREE.Shape();
  s.moveTo(-hw + r, -hh);
  s.lineTo(hw - r, -hh); s.lineTo(hw, -hh + r);
  s.lineTo(hw, hh - r); s.lineTo(hw - r, hh);
  s.lineTo(-hw + r, hh); s.lineTo(-hw, hh - r);
  s.lineTo(-hw, -hh + r); s.closePath();
  const depth = Math.max(d - 2 * r, 0.001);
  // steps>1 subdivides the side walls — vertex AO bakes per-vertex, and a
  // steps:1 slab only samples its corners so the whole part bakes black.
  const steps = Math.max(1, Math.ceil(depth / 0.02));
  const geo = new THREE.ExtrudeGeometry(s, { depth, steps, bevelEnabled: true, bevelThickness: r, bevelSize: r, bevelSegments: 1 });
  geo.translate(0, 0, -depth / 2);
  return new THREE.Mesh(geo, mat);
};
