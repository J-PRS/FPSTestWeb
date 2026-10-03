// gunlab — live weapon inspection page (/gunlab.html). Left rail = one
// button per viewmodel weapon; FPS pose or detached turntable inspect.
// Live updates: vite HMR re-runs this module on code edits (state parked
// on window so selection survives), and a HEAD poll on the baked
// /weapons/*.glb/_ao.png files hot-swaps bake assets in place — no reload.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import ManifoldModule from 'manifold-3d';
import manifoldWasmUrl from 'manifold-3d/manifold.wasm?url';
import { ViewModel } from './entities/ViewModel.js';
import { MODEL_BUILDERS } from './entities/viewmodel/weaponsGeo.js';
import { ARCHIVE_BUILDERS } from './entities/viewmodel/weaponsGeoArchive.js';
import { bakeVertexAO } from './effects/vertexAO.js';
import { WeaponType } from '../../shared/weaponTable.js';

interface LabState { wt: number; inspect: boolean; yaw: number; pitch: number; cam?: number[]; tgt?: number[]; fov?: number; z?: boolean }
// Persisted so noreload-mode F5s come back to the same gun+angle — the
// window park only survives HMR accepts.
const saved = (() => {
  try {
    const s = JSON.parse(localStorage.getItem('gunlab') ?? '') as LabState;
    return s;
  } catch { return (window as any).__gunlab as LabState | undefined; }
})();
const state: LabState = saved ?? { wt: 0, inspect: false, yaw: 0.75, pitch: 0 };
(window as any).__gunlab = state;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveState(): void {
  state.cam = camera.position.toArray();
  state.tgt = orbit.target.toArray();
  // Debounced — orbit 'change' can fire per frame while damping settles.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}
function flushSave(): void {
  localStorage.setItem('gunlab', JSON.stringify(state));
}
addEventListener('pagehide', flushSave); // a pending debounce dies with the page

// --- render rig: identical to vmdump so shading matches in-game ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.4; // TONE_MAPPING_EXPOSURE
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x25282e);
// FOV + lights mirror world/viewmodelScene.ts — the game renders the
// viewmodel in its own pass at FOV 55, so this rig must match or the
// FPS view judges the gun wider and warmer-lit than in-game.
const camera = new THREE.PerspectiveCamera(state.fov ?? 55, innerWidth / innerHeight, 0.01, 100);
scene.add(camera);
scene.add(new THREE.AmbientLight(0x8899aa, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(0.5, 1, 0.4);
scene.add(sun);
(window as any).__gunlab = { scene }; // debug hook — lets headless probes dump baked attributes

// Sketchfab-style orbit rig — the convention everyone copies: LMB
// orbits, wheel dollies, RMB pans. Enabled only in inspect mode; in FPS
// pose the camera is the rig and a drag is a look-sway instead.
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.enabled = false;
orbit.minDistance = 0.06; // never let the camera into the mesh
orbit.maxDistance = 8;
const trackDir = () => {
  // Remember where the camera sits relative to the target — weapon
  // swaps refit distance along THIS line so the angle never jumps.
  const d = camera.position.clone().sub(orbit.target);
  if (d.lengthSq() > 1e-8) inspectDir.copy(d.normalize());
  saveState();
};
orbit.addEventListener('change', trackDir); // debounced inside — safe per frame
(window as any).__gl = { camera, orbit }; // debug handle

// Z-fight probe — coplanar triangle pairs are what shimmer. Collect
// world-space triangles, bucket by plane (normal + offset), then SAT-test
// overlaps within a bucket. Flagged tris feed both the headless report
// (_tools/e2e/zfight.ts) and the ⚠z paint toggle below.
const N = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
const EDGE = new THREE.Vector3();
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
      if (aMax < bMin || bMax < aMin) return false;
    }
  }
  return true;
}
/** Returns { pairs, at[], flagVerts } — flagVerts is the flat xyz list of
 *  every flagged triangle, for the magenta paint pass. */
function zScan(root: THREE.Object3D): { pairs: number; at: number[][]; flagVerts: number[]; who: string[] } {
  root.updateMatrixWorld(true);
  const tris: ZTri[] = [];
  const names: string[] = [''];
  let meshId = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
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
      if (n.lengthSq() < 1e-12) continue;
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
      if (x.m === y.m) continue;
      // Same-FACING coplanar only: opposite-facing pairs are flush butt
      // joints hidden inside the model — they can't win pixels.
      if (x.n.dot(y.n) < 0.9999) continue;
      if (Math.abs(x.d - y.d) > 5e-4) continue;
      // Project to the plane's dominant 2D axes for the SAT overlap.
      const an = new THREE.Vector3(Math.abs(x.n.x), Math.abs(x.n.y), Math.abs(x.n.z));
      const drop = an.x > an.y ? (an.x > an.z ? 0 : 2) : (an.y > an.z ? 1 : 2);
      const proj = (v: THREE.Vector3) => drop === 0 ? new THREE.Vector2(v.y, v.z) : drop === 1 ? new THREE.Vector2(v.x, v.z) : new THREE.Vector2(v.x, v.y);
      const xa = x.p.map(proj), ya = y.p.map(proj);
      if (!zOverlap2d(xa, ya)) continue;
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
          if (inside(s)) out.push(s);
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
      if (poly.length < 3) continue;
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
        at.push(c.toArray().map(v => +v.toFixed(3)));
        who.push(`${names[x.m]}~${names[y.m]}`);
      }
    }
  }
  return { pairs, at, flagVerts, who };
}
(window as any).__gl.zcheck = (): { wt: number; pairs: number; at: number[][]; who: string[] }[] => {
  const results: { wt: number; pairs: number; at: number[][]; who: string[] }[] = [];
  for (const [wt, mk] of MODEL_BUILDERS) {
    const built = mk() as THREE.Group | { g: THREE.Group };
    const root = 'g' in built ? built.g : built;
    root.visible = true; // builders park themselves invisible
    const r = zScan(root);
    if (r.pairs) results.push({ wt, pairs: r.pairs, at: r.at, who: r.who });
  }
  return results;
};
// Hole check — welded-edge census: an edge referenced by exactly one
// triangle is an open rim, i.e. a hole boundary (or an intentionally
// open face like mkBore's disc — the report doesn't judge intent).
// Same 1mm weld tolerance as the edge bake.
function holeScan(root: THREE.Object3D): { holes: number; at: number[][]; who: string[] } {
  root.updateMatrixWorld(true);
  interface ERef { a: THREE.Vector3; b: THREE.Vector3; m: number }
  const edges = new Map<string, ERef[]>();
  const names: string[] = [''];
  let meshId = 0;
  const pk = (v: THREE.Vector3) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
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
        if (!l) edges.set(key, l = []);
        l.push({ a: pts[u]!.clone(), b: pts[w]!.clone(), m: meshId });
      }
    }
  });
  let holes = 0;
  const at: number[][] = [], who: string[] = [];
  for (const l of edges.values()) {
    if (l.length !== 1) continue;
    holes++;
    if (at.length < 8) {
      const e = l[0]!;
      at.push(e.a.clone().add(e.b).multiplyScalar(0.5).toArray().map(v => +v.toFixed(3)));
      who.push(names[e.m]!);
    }
  }
  return { holes, at, who };
}
(window as any).__gl.holecheck = (): { wt: number; holes: number; at: number[][]; who: string[] }[] => {
  const results: { wt: number; holes: number; at: number[][]; who: string[] }[] = [];
  for (const [wt, mk] of MODEL_BUILDERS) {
    const built = mk() as THREE.Group | { g: THREE.Group };
    const root = 'g' in built ? built.g : built;
    root.visible = true;
    const r = holeScan(root);
    if (r.holes) results.push({ wt, holes: r.holes, at: r.at, who: r.who });
  }
  return results;
};
// Gap check — floating-part lint: build every mesh's world AABB, then
// any part whose box (expanded a hair) touches NO other part's box is
// detached geometry — floating glow discs, prongs that miss their seat.
// Reported per weapon with the orphan's name + center + nearest gap.
const _bb = new THREE.Box3();
function gapScan(root: THREE.Object3D): { orphans: number; who: string[]; at: number[][]; clusters: number } {
  root.updateMatrixWorld(true);
  const parts: { m: THREE.Mesh; box: THREE.Box3 }[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
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
    for (let j = i + 1; j < parts.length; j++)
      if (touch(parts[i]!.box, parts[j]!.box)) parent[find(i)] = find(j);
  const roots = new Set(parts.map((_, i) => find(i)));
  // Orphan = a cluster of one (not merely a small cluster).
  const size = new Map<number, number>();
  for (let i = 0; i < parts.length; i++) size.set(find(i), (size.get(find(i)) ?? 0) + 1);
  const orphans: { m: THREE.Mesh; box: THREE.Box3 }[] = [];
  for (let i = 0; i < parts.length; i++) if (size.get(find(i)) === 1) orphans.push(parts[i]!);
  const who: string[] = [], at: number[][] = [];
  for (const o of orphans.slice(0, 8)) {
    who.push(o.m.name || o.m.geometry.type);
    at.push(o.box.getCenter(_tmpC).toArray().map(v => +v.toFixed(3)));
  }
  return { orphans: orphans.length, who, at, clusters: roots.size };
}
const _tmpC = new THREE.Vector3();
(window as any).__gl.gapcheck = (): { wt: number; orphans: number; clusters: number; who: string[]; at: number[][] }[] => {
  const results: { wt: number; orphans: number; clusters: number; who: string[]; at: number[][] }[] = [];
  for (const [wt, mk] of MODEL_BUILDERS) {
    const built = mk() as THREE.Group | { g: THREE.Group };
    const root = 'g' in built ? built.g : built;
    root.visible = true;
    const r = gapScan(root);
    if (r.orphans || r.clusters > 1) results.push({ wt, ...r });
  }
  return results;
};
// Winding check — signed-volume census per mesh (divergence theorem):
// a closed mesh sums positive when its tris face outward, NEGATIVE when
// it's inside-out. Catches the mkLoft bug holeScan can't — an inverted
// mesh is still watertight. Open pieces (bore discs, glow strips) are
// allowed a small negative read: they report |vol| relative to bbox so
// only real flips flag.
function volScan(root: THREE.Object3D): { inverted: number; who: string[] } {
  root.updateMatrixWorld(true);
  const who: string[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
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
    if (Math.min(bb.x, bb.y, bb.z) < 0.002) return;
    const norm = vol / Math.max(bb.x * bb.y * bb.z, 1e-9);
    if (norm < -0.02) who.push(`${m.name || m.geometry.type}(${norm.toFixed(2)})`);
  });
  return { inverted: who.length, who };
}
(window as any).__gl.normcheck = (): { wt: number; inverted: number; who: string[] }[] => {
  const results: { wt: number; inverted: number; who: string[] }[] = [];
  for (const [wt, mk] of MODEL_BUILDERS) {
    const built = mk() as THREE.Group | { g: THREE.Group };
    const root = 'g' in built ? built.g : built;
    root.visible = true;
    const r = volScan(root);
    if (r.inverted) results.push({ wt, ...r });
  }
  return results;
};
// Info dump — clipboard truth per weapon: mesh/vert/tri census,
// footprint size, baked attributes present, then the three checks
// (z-fight pairs, hole rims, floating parts). Alt+Q = ACTIVE weapon
// (the live viewmodel group, bake swap included); Alt+W = all weapons
// off the builders. ⓘ info runs the current weapon.
function dumpWeapon(wt: number, root: THREE.Object3D, name: string): string {
  root.updateMatrixWorld(true);
  let meshes = 0, verts = 0, tris = 0;
  const attrs = new Set<string>();
  const wb = new THREE.Box3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    meshes++;
    const pos = m.geometry.getAttribute('position');
    verts += pos.count;
    tris += m.geometry.index ? m.geometry.index.count / 3 : pos.count / 3;
    for (const k of Object.keys(m.geometry.attributes)) attrs.add(k);
    m.geometry.computeBoundingBox();
    wb.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld));
  });
  const size = wb.getSize(new THREE.Vector3());
  const z = zScan(root);
  const holes = holeScan(root);
  const gaps = gapScan(root);
  const vol = volScan(root);
  return (
    `w${wt} ${name}: ${meshes} meshes, ${verts}v/${tris}t, ` +
    `size ${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)}, ` +
    `attrs {${[...attrs].join(',')}} — ` +
    `z:${z.pairs} holes:${holes.holes} inverted:${vol.inverted} floaters:${gaps.orphans} clusters:${gaps.clusters}` +
    (vol.inverted ? ` INV[${vol.who.join('; ')}]` : '') +
    (gaps.orphans ? ` [${gaps.who.join('; ')}]` : '')
  );
}
async function infoDump(all = false): Promise<void> {
  const lines: string[] = [`gunlab info — ${new Date().toISOString()}`];
  if (all) {
    for (const [wt, mk] of MODEL_BUILDERS) {
      const built = mk() as THREE.Group | { g: THREE.Group };
      const root = 'g' in built ? built.g : built;
      root.visible = true;
      lines.push(dumpWeapon(wt, root, mk.name || '?'));
    }
  } else {
    // Active weapon, live state — the procedural bake, swapped GLB, or
    // an archived build if one's parked in the group.
    if (archiveGroup) {
      lines.push(dumpWeapon(-1, archiveGroup, `${archiveLabel} (archive)`));
      await navigator.clipboard?.writeText(lines.join('\n'));
      flashStatus(`${archiveLabel} info → clipboard`);
      console.log(lines.join('\n'));
      return;
    }
    const g = vm.weapons.get(state.wt);
    if (!g) { flashStatus('no active weapon'); return; }
    const name = MODEL_BUILDERS.find(([wt]) => wt === state.wt)?.[1].name || '?';
    lines.push(dumpWeapon(state.wt, g, `${name} (live)`));
  }
  await navigator.clipboard?.writeText(lines.join('\n'));
  flashStatus(all ? 'info (all) → clipboard' : `w${state.wt} info → clipboard`);
  console.log(lines.join('\n'));
}
// ⚠z toggle — rebuilds the flagged tris of the ACTIVE weapon into an
// error-magenta overlay, the way missing-texture pipelines mark broken
// surfaces. Paints the live weapon (inspect or FPS pose), so it rides
// along with whatever angle you're inspecting from.
let zOverlay: THREE.Mesh | null = null;
function zPaint(on: boolean): void {
  if (zOverlay) { scene.remove(zOverlay); zOverlay.geometry.dispose(); zOverlay = null; }
  if (!on) return;
  const root = inspectAnchor ?? vm.group.children.find(c => c.visible && c !== vm.flashMesh);
  if (!root) { flashStatus('no active weapon'); return; }
  const { pairs, flagVerts } = zScan(root);
  if (!pairs) { flashStatus('zcheck: clean'); return; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(flagVerts, 3));
  // depthTest off + late renderOrder: the overlay sits ON the fighting
  // plane — let it win outright or it becomes the thing it highlights.
  const mat = new THREE.MeshBasicMaterial({ color: 0xff00ff, side: THREE.DoubleSide, depthTest: false });
  zOverlay = new THREE.Mesh(geo, mat);
  zOverlay.renderOrder = 999;
  scene.add(zOverlay);
  flashStatus(`zcheck: ${pairs} fighting pairs painted`);
}
orbit.addEventListener('end', trackDir);   // and once more on mouse-up

const zeroVel = new THREE.Vector3();
const rail = document.getElementById('rail')!;
const statusEl = document.getElementById('status')!;

// --- viewmodel lifecycle (rebuilt on bake-asset change / HMR) ---
let vm = new ViewModel(camera);
vm.switchWeapon(state.wt);
for (let i = 0; i < 60; i++) vm.update(1 / 60, 0, 0, zeroVel, camera); // settle past switch dip

// Inspect mode parks the ACTIVE weapon group in the scene on a manual
// orbit; the rest of the viewmodel (hands/flash) stays offstage. The
// group's viewmodel-space transform is saved and restored on exit —
// leaving it mutated is what stranded the gun off-screen in FPS view.
let inspectAnchor: THREE.Object3D | null = null;
const focus = new THREE.Vector3();
// The last orbit direction — weapon swaps and FPS↔inspect toggles keep
// this angle; only the fit distance changes.
const inspectDir = new THREE.Vector3(0.45, 0.3, 0.85).normalize();
// Wireframe overlay — THREE line children per visible mesh, drawn with
// depth-test ON but polygon-offset toward the eye: a blue
// WireframeGeometry layer paints EVERY triangle edge (coplanar
// triangulation splits included), a yellow EdgesGeometry layer marks
// >1° breaks, and a RED layer draws the wear bake's own flagged-edge
// list (geo.userData.__sharpEdges) — comparing red-vs-wear-line splits
// bake misses from shader artifacts. ~1px via LineBasicMaterial.
let wireOn = false;
const wireLines: THREE.LineSegments[] = [];
// toneMapped:false — ACES otherwise crushes the flat line colors into
// murk on the dark model; these are debug markup, they should punch.
const wireMat = new THREE.LineBasicMaterial({
  color: 0xffdd00, depthWrite: false, toneMapped: false,
  polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
});
const wireFlatMat = new THREE.LineBasicMaterial({
  color: 0x33aaff, depthWrite: false, transparent: true, opacity: 0.45, toneMapped: false,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
});
const wireSharpMat = new THREE.LineBasicMaterial({
  color: 0xff3355, depthWrite: false, toneMapped: false,
  // Biggest depth pull — the flagged list sits at the same spots as the
  // other two layers' lines, so without a clear offset margin the
  // brighter layers cover the debug red.
  polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
});
function applyWire(): void {
  for (const l of wireLines) { l.parent?.remove(l); l.geometry.dispose(); }
  wireLines.length = 0;
  if (!wireOn) return;
  const root = inspectAnchor ?? vm.group.children.find(c => c.visible && c !== vm.flashMesh && c !== vm.flashMesh2);
  if (!root) return;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    // White underlay: every tri edge, including flat-face seams.
    const flat = new THREE.LineSegments(new THREE.WireframeGeometry(m.geometry), wireFlatMat);
    flat.renderOrder = 5;
    m.add(flat);
    wireLines.push(flat);
    // Yellow overlay: only edges with a >1° dihedral — designed breaks.
    const l = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 1), wireMat);
    l.renderOrder = 6;
    m.add(l);
    wireLines.push(l);
    // Red overlay: the wear bake's flagged-edge list verbatim — what the
    // shader was TOLD to line. Gaps here = detection; gaps only in the
    // shaded wear = the barycentric interpolation.
    const flagged = m.geometry.userData.__sharpEdges as Float32Array | undefined;
    if (flagged) {
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(flagged, 3));
      const s = new THREE.LineSegments(sg, wireSharpMat);
      s.renderOrder = 7;
      m.add(s);
      wireLines.push(s);
    }
  });
}

function setInspect(on: boolean): void {
  state.inspect = on;
  if (inspectAnchor) {
    const home = inspectAnchor.userData.home as { p: THREE.Vector3; q: THREE.Quaternion } | undefined;
    if (home) { inspectAnchor.position.copy(home.p); inspectAnchor.quaternion.copy(home.q); }
    vm.group.add(inspectAnchor);
    inspectAnchor = null;
  }
  vm.group.visible = !on; // hands/flash stay on-camera otherwise
  orbit.enabled = on;
  if (!on) {
    // FPS pose lives at the rig origin looking down -Z (player eye).
    camera.position.set(0, 0, 0);
    camera.rotation.set(0, 0, 0);
    applyWire();
    return;
  }
  const active = vm.group.children.find(c => c.visible && c !== vm.flashMesh) as THREE.Group | undefined;
  if (!active) return;
  inspectAnchor = active;
  scene.add(active);
  const box = new THREE.Box3().setFromObject(active);
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  // Recentre the weapon on the world origin so the orbit target is the
  // gun itself, not wherever the viewmodel pose left it.
  active.userData.home = { p: active.position.clone(), q: active.quaternion.clone() };
  active.position.sub(c);
  active.rotation.set(0, 0, 0);
  const dist = Math.max(size * 0.75, 0.25);
  orbit.target.copy(focus.set(0, 0, 0));
  camera.position.copy(focus).addScaledVector(inspectDir, dist);
  orbit.update();
  applyWire();
  saveState();
}

function disposeVm(v: ViewModel): void {
  v.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      const lm = mat as THREE.MeshLambertMaterial;
      lm.map?.dispose();
      mat.dispose();
    }
  });
  camera.remove(v.group);
}

function rebuild(): void {
  const wasInspect = state.inspect;
  if (wasInspect) setInspect(false);
  disposeVm(vm);
  archiveGroup = null; archiveLabel = ''; // died with the old vm group
  vm = new ViewModel(camera);
  vm.switchWeapon(state.wt);
  for (let i = 0; i < 60; i++) vm.update(1 / 60, 0, 0, zeroVel, camera);
  if (wasInspect) setInspect(true);
  if (zOverlay) zPaint(true); // re-flag the rebuilt weapon, not the stale one
  applyWire();
  paintRail();
  flashStatus('rebuilt');
}

// --- union preview ---
// CSG-weld the active weapon's lit meshes into one solid: parts that
// cross get real intersection geometry, which is what the AO ray bake
// and the bevel-edge shader both need to stop reading part seams as
// wear. Toggles the group between unioned shell and authored parts.
let unionOn = false;
let unioned: { mesh: THREE.Mesh; hidden: THREE.Object3D[] } | null = null;
// Manifold (WASM) — guaranteed-watertight booleans, unlike three-bvh-csg
// which shreds on coplanar/sliver inputs. Loaded lazily on first toggle.
let maniMod: any = null;
async function mani(): Promise<any> {
  if (!maniMod) {
    maniMod = await (ManifoldModule as any)({ locateFile: () => manifoldWasmUrl });
    maniMod.setup();
  }
  return maniMod;
}
async function unionToggle(): Promise<void> {
  const g = vm.weapons.get(state.wt);
  if (!g) return;
  if (unionOn && unioned) {
    g.remove(unioned.mesh);
    unioned.mesh.geometry.dispose();
    (unioned.mesh.material as THREE.Material).dispose();
    for (const o of unioned.hidden) o.visible = true;
    unioned = null;
    unionOn = false;
    return;
  }
  const { Manifold, Mesh: MMesh } = await mani();
  g.updateWorldMatrix(true, true);
  const parts: THREE.Mesh[] = [];
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && (m.material as THREE.Material).type !== 'MeshBasicMaterial') parts.push(m);
  });
  if (!parts.length) return;
  const inv = g.matrixWorld.clone().invert();
  const manis: any[] = [];
  let inV = 0, inT = 0, rejected = 0;
  const t0 = performance.now();
  for (const m of parts) {
    // Strip baked attrs BEFORE welding — mergeVertices only merges verts
    // whose whole attribute set matches, and per-vertex AO/wear differs,
    // so nothing welded and every part read as non-manifold.
    const stripped = m.geometry.clone().applyMatrix4(inv.clone().multiply(m.matrixWorld));
    for (const name of Object.keys(stripped.attributes)) if (name !== 'position') stripped.deleteAttribute(name);
    const geo = mergeVertices(stripped);
    if (!geo.index) geo.setIndex([...Array(geo.attributes.position!.count).keys()]);
    inV += geo.attributes.position!.count;
    inT += geo.index!.count / 3;
    try {
      manis.push(new Manifold(new MMesh({
        numProp: 3,
        vertProperties: (geo.attributes.position!.array as Float32Array).slice(),
        triVerts: new Uint32Array(geo.index!.array as ArrayLike<number>),
      })));
    } catch (e) {
      rejected++;
      console.warn(`[union] part ${parts.indexOf(m)} (${m.geometry.type}) not manifold:`, e);
    }
    geo.dispose();
  }
  if (!manis.length) return;
  let solid: any;
  try {
    solid = Manifold.union(manis);
    if (solid.isEmpty()) { console.warn('[union] empty result'); return; }
  } catch (e) { console.warn('[union] manifold failed:', e); return; }
  const om = solid.getMesh();
  console.log(`[union] w${state.wt}: ${parts.length} parts (${rejected} rejected) — ${inV}v/${inT}t in → ${om.numVert}v/${om.triVerts.length / 3}t out, ${(performance.now() - t0).toFixed(0)}ms`);
  const geo = new THREE.BufferGeometry();
  const np = om.numProp;
  const verts = new Float32Array(om.numVert * 3);
  for (let v = 0; v < om.numVert; v++) { verts[v * 3] = om.vertProperties[v * np]!; verts[v * 3 + 1] = om.vertProperties[v * np + 1]!; verts[v * 3 + 2] = om.vertProperties[v * np + 2]!; }
  // Non-indexed + face normals — hard-surface shading, matches the kit look.
  const ni = new THREE.BufferGeometry();
  const pos = new Float32Array(om.triVerts.length * 3);
  for (let t = 0; t < om.triVerts.length; t++) {
    const vi = om.triVerts[t]!;
    pos[t * 3] = verts[vi * 3]!; pos[t * 3 + 1] = verts[vi * 3 + 1]!; pos[t * 3 + 2] = verts[vi * 3 + 2]!;
  }
  ni.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  ni.computeVertexNormals();
  geo.dispose();
  for (const mm of manis) mm.delete?.();
  solid.delete?.();
  // Clone material — shared bodyMat's wearTex must not be retargeted —
  // and run the wear/grunge/edge bake so the shell matches the parts.
  const umat = (parts[0]!.material as THREE.Material).clone();
  // clone() copies userData — including __grunge, which would make
  // enhanceWeaponMaterial skip injecting the procedural shader.
  delete umat.userData.__grunge;
  const out = new THREE.Mesh(ni, umat);
  const wrap = new THREE.Group();
  wrap.add(out); // identity transform: geometry is already in g-space
  // Manifold output IS watertight, so the full raycast AO bake is safe
  // here (this was the original point of the union preview anyway).
  bakeVertexAO(wrap);
  const hidden: THREE.Object3D[] = [];
  g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && parts.includes(m)) { m.visible = false; hidden.push(m); } });
  g.add(out);
  unioned = { mesh: out, hidden };
  unionOn = true;
}

// --- rail UI ---
function paintRail(): void {
  rail.innerHTML = '';
  const wts = [...vm.weapons.keys()].toSorted((a, b) => a - b);
  for (const wt of wts) {
    const b = document.createElement('button');
    b.textContent = `${wt} ${WeaponType[wt] ?? '?'}`;
    if (wt === state.wt) b.classList.add('active');
    b.addEventListener('click', () => select(wt));
    rail.appendChild(b);
  }
  // Archive shelf — retired builders, for A/B against the live versions.
  if (ARCHIVE_BUILDERS.length) {
    const sep = document.createElement('div');
    sep.className = 'tools';
    sep.innerHTML = '<span style="opacity:.5;padding:2px 4px">archive</span>';
    rail.appendChild(sep);
    for (const [label, mkArc] of ARCHIVE_BUILDERS) {
      const b = document.createElement('button');
      b.textContent = `† ${label}`;
      if (archiveLabel === label && archiveGroup) b.classList.add('active');
      b.addEventListener('click', () => selectArchive(label, mkArc));
      rail.appendChild(b);
    }
  }
  const tools = document.createElement('div');
  tools.className = 'tools';
  const mk = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    tools.appendChild(b);
    return b;
  };
  // FOV slider FIRST — it shapes the FPS view, which is what the lab is
  // for. Game viewmodel runs at 55, but per-weapon judgement sometimes
  // wants tighter/wider. Persisted like the rest of the lab state.
  const fovWrap = document.createElement('label');
  fovWrap.className = 'fovslider';
  const fovVal = document.createElement('span');
  fovVal.textContent = `${Math.round(camera.fov)}°`;
  const fovIn = document.createElement('input');
  fovIn.type = 'range';
  fovIn.min = '35'; fovIn.max = '110'; fovIn.step = '1';
  fovIn.value = String(camera.fov);
  fovIn.addEventListener('input', () => {
    camera.fov = Number(fovIn.value);
    camera.updateProjectionMatrix();
    fovVal.textContent = `${fovIn.value}°`;
    state.fov = camera.fov;
    saveState();
  });
  // Right-click snaps back to the game's viewmodel FOV.
  fovIn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    fovIn.value = '55';
    fovIn.dispatchEvent(new Event('input'));
  });
  fovWrap.append('fov ', fovIn, fovVal);
  tools.appendChild(fovWrap);
  mk(state.inspect ? '◈ FPS view' : '◉ inspect view', () => { setInspect(!state.inspect); paintRail(); });
  const noBake = new URLSearchParams(location.search).has('nobake');
  mk(noBake ? '▣ bake: OFF' : '▢ bake: ON', () => {
    // ?nobake forces procedural viewmodels — view+gun survive the
    // reload via the localStorage pose.
    const u = new URL(location.href);
    if (noBake) u.searchParams.delete('nobake'); else u.searchParams.set('nobake', '1');
    flushSave();
    location.href = u.toString();
  });
  mk('▦ sheet', shotSheet);
  mk(zOverlay ? '⚠ z: ON' : '⚠ z', () => { zPaint(!zOverlay); state.z = !!zOverlay; saveState(); paintRail(); });
  mk(wireOn ? '▧ wire: ON' : '▧ wire', () => { wireOn = !wireOn; applyWire(); paintRail(); });
  // Wear-mask debug — paints R=final wear / G=grime / B=edge flag instead
  // of shading. It's a shader define, so it needs a reload like ?bake.
  const wearViz = new URLSearchParams(location.search).has('wearviz');
  mk(wearViz ? '◐ wearviz: ON' : '◐ wearviz', () => {
    const u = new URL(location.href);
    if (wearViz) u.searchParams.delete('wearviz'); else u.searchParams.set('wearviz', '1');
    flushSave();
    location.href = u.toString();
  });
  mk(unionOn ? '⛛ union: ON' : '⛛ union', () => { void unionToggle().then(paintRail); });
  mk('ⓘ info', () => void infoDump());
  mk('▣ src', () => void copyBuilderSrc());
  mk('▸ kick', () => vm.kick(1));
  mk('▸ punch', () => vm.punch(false));
  mk('▸ throw', () => vm.startThrow());
  rail.appendChild(tools);
}

// 4-up reference sheet: side / top / front-¾ / first-person in one PNG.
// Each shot renders full-frame then gets blitted into a composite cell —
// the drawing buffer is only guaranteed valid within the same task, so
// every render+drawImage pair runs synchronously.
// cell layout — `up` pins the camera roll: without it lookAt rolls
// arbitrarily and "top" ends up tilted on two axes instead of one.
const shotDir: Record<string, { d: THREE.Vector3; up?: THREE.Vector3 }> = {
  side:  { d: new THREE.Vector3(1, 0.05, 0) },
  // up=-X puts the muzzle (-Z) to screen-right — same heading as the
  // side cell, just seen from above.
  top:   { d: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(-1, 0, 0) },
  front: { d: new THREE.Vector3(-0.55, 0.25, -0.78) }, // gunner-facing ¾
};
function shotSheet(): void {
  (window as unknown as { __sheetPNG?: string }).__sheetPNG = undefined;
  const wasInspect = state.inspect;
  const cell = 512;
  const comp = document.createElement('canvas');
  comp.width = cell * 2; comp.height = cell * 2;
  const g2 = comp.getContext('2d')!;
  const keepPos = camera.position.clone();
  const keepQuat = camera.quaternion.clone();
  const keepAspect = camera.aspect;
  const shot = (cx: number, cy: number, label: string) => {
    renderer.render(scene, camera);
    g2.drawImage(renderer.domElement, cx * cell, cy * cell, cell, cell);
    g2.fillStyle = '#8f8';
    g2.font = '18px monospace';
    g2.textAlign = 'center';
    g2.fillText(label, cx * cell + cell / 2, cy * cell + 42);
  };
  // FPS cell first — weapon still in viewmodel pose, camera at the eye.
  // Keep the canvas's real aspect: squashing to square shrinks the
  // horizontal FOV and shoves REST_POS out to the corner — nothing like
  // the in-game frame. Center-crop the wide buffer into the cell instead.
  if (wasInspect) setInspect(false);
  camera.position.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);
  // A single update only lerps partway to REST_POS — settle the pose
  // like rebuild() does or the gun floats wherever inspect left it.
  for (let i = 0; i < 60; i++) vm.update(1 / 60, 0, 0, zeroVel, camera);
  renderer.render(scene, camera);
  {
    const buf = renderer.domElement;
    const crop = Math.min(buf.width, buf.height);
    // Right-anchored crop: REST_POS holds the gun on the right of the
    // frame — a centered crop clips it at the cell edge.
    g2.drawImage(buf, buf.width - crop, (buf.height - crop) / 2, crop, crop,
      cell, cell, cell, cell);
    g2.fillStyle = '#8f8';
    g2.font = '18px monospace';
    g2.textAlign = 'center';
    g2.fillText('fps', cell + cell / 2, cell + 42);
  }
  camera.aspect = 1;
  camera.updateProjectionMatrix();
  // External cells — park the weapon centered at origin like inspect does.
  setInspect(true);
  const box = new THREE.Box3().setFromObject(inspectAnchor!);
  // Fit the bounding sphere inside the frustum: half-diagonal is the
  // radius, then back off until r / sin(fov/2) clears the cell edge.
  const r = box.getSize(new THREE.Vector3()).length() / 2;
  const halfFov = THREE.MathUtils.degToRad(camera.fov) / 2;
  const dist = Math.max((r / Math.sin(halfFov)) * 1.08, 0.3);
  const tgt = new THREE.Vector3();
  const keepUp = camera.up.clone();
  for (const [i, [label, v]] of Object.entries(shotDir).entries()) {
    if (v.up) camera.up.copy(v.up);
    camera.position.copy(tgt).addScaledVector(v.d, dist);
    camera.lookAt(tgt);
    camera.up.copy(keepUp);
    shot(i % 2, (i / 2) | 0, label);
  }
  // Restore whatever the user was doing.
  camera.aspect = keepAspect;
  camera.updateProjectionMatrix();
  camera.position.copy(keepPos);
  camera.quaternion.copy(keepQuat);
  if (!wasInspect) setInspect(false);
  // dataURL park for the /gunsheet middleware — it polls window for this
  // rather than scraping the canvas (toBlob is async either way).
  (window as unknown as { __sheetPNG?: string }).__sheetPNG = comp.toDataURL('image/png');
  comp.toBlob((b) => {
    if (!b) return;
    // Clipboard for instant paste; /shot middleware drops the file in
    // client/shots/ so agents can read it without a download dance.
    const name = `w${state.wt}_sheet.png`;
    void navigator.clipboard?.write?.([new ClipboardItem({ 'image/png': b })])
      .catch(() => flashStatus('clipboard blocked — file still saved'));
    void fetch(`/shot?name=${name}`, { method: 'POST', body: b });
  });
  flashStatus(`w${state.wt} sheet → clipboard + shots/`);
}

// Copy the active weapon's builder source — import.meta.glob pulls
// every .ts under viewmodel/ as raw text, so new builder files are
// picked up with zero wiring. fn.name survives bundling here because
// vite dev serves the modules unminified.
const GEO_SOURCES = import.meta.glob('./entities/viewmodel/*.ts', { query: '?raw', import: 'default' });
async function copyBuilderSrc(): Promise<void> {
  const entry = MODEL_BUILDERS.find(([wt]) => wt === state.wt);
  if (!entry) { flashStatus('no builder'); return; }
  const name = entry[1].name || 'mk?';
  const head = `export function ${name}`;
  for (const load of Object.values(GEO_SOURCES)) {
    const src = await load() as string;
    const at = src.indexOf(head);
    if (at < 0) continue;
    let depth = 0, end = at;
    for (let i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    // Grab the comment block above it too — the "why" matters.
    let start = at;
    const before = src.slice(0, at);
    const m = before.match(/(?:\n\s*\/\/[^\n]*)+\s*$|\n\/\*[\s\S]*?\*\/\s*$/);
    if (m) start = m.index ?? at;
    await navigator.clipboard?.writeText(src.slice(start, end).trimStart());
    flashStatus(`copied ${name}()`);
    return;
  }
  flashStatus(`${name} not found in sources`);
}

// Retired-model preview — archive builders spawn straight into
// vm.group so inspect/zcheck/gapcheck treat them like any weapon.
let archiveGroup: THREE.Group | null = null;
let archiveLabel = '';
function selectArchive(label: string, mk: () => THREE.Group): void {
  if (archiveGroup) vm.group.remove(archiveGroup);
  for (const g of vm.weapons.values()) g.visible = false;
  archiveGroup = mk();
  bakeVertexAO(archiveGroup); // same AO+grunge+wear pipeline the live weapons get
  archiveGroup.visible = true;
  archiveGroup.name = `archive:${label}`;
  archiveLabel = label;
  vm.group.add(archiveGroup);
  if (state.inspect) { setInspect(false); setInspect(true); }
  applyWire();
  paintRail();
  flashStatus(`archive: ${label}`);
}

function select(wt: number): void {
  state.wt = wt;
  if (archiveGroup) { vm.group.remove(archiveGroup); archiveGroup = null; archiveLabel = ''; }
  vm.switchWeapon(wt);
  for (let i = 0; i < 60; i++) vm.update(1 / 60, 0, 0, zeroVel, camera); // skip the holster dip
  // Re-anchor whatever just became active — inspect mode follows the
  // pick; setInspect refits along the tracked inspectDir, so the view
  // angle survives the swap.
  if (state.inspect) { setInspect(false); setInspect(true); }
  if (zOverlay) zPaint(true); // flag the new pick — old overlay's tris are gone
  applyWire();
  paintRail();
  saveState();
}

function flashStatus(msg: string): void {
  statusEl.innerHTML = `<span class="hot">${msg}</span>`;
  setTimeout(() => { statusEl.innerHTML = ''; }, 1500);
}

// --- baked-asset watch: HEAD signatures on this weapon's bake files ---
const watched = new Map<string, string>();
async function pollBakes(): Promise<void> {
  const files = [
    `/weapons/w${state.wt}_baked.glb`,
    `/weapons/w${state.wt}_ao.png`,
    `/weapons/w${state.wt}b_ao.png`,
  ];
  for (const url of files) {
    try {
      const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      const sig = r.ok && !(r.headers.get('content-type') ?? '').includes('html')
        ? `${r.headers.get('last-modified')}|${r.headers.get('content-length')}`
        : 'MISSING';
      const prev = watched.get(url);
      watched.set(url, sig);
      if (prev !== undefined && prev !== sig) { flashStatus(`${url.split('/').pop()} changed`); rebuild(); return; }
    } catch { /* dev-server blip — retry next tick */ }
  }
}
const pollTimer = setInterval(pollBakes, 1500);

// --- drag look (FPS pose sway). Inspect-mode dragging is owned by
// OrbitControls on the canvas — these listeners only feed the sway. ---
let dragging = false, lastX = 0, lastY = 0;
let lookDX = 0, lookDY = 0;
addEventListener('mousedown', (e) => {
  if ((e.target as HTMLElement).tagName === 'BUTTON') return;
  lastX = e.clientX; lastY = e.clientY;
  dragging = true;
});
addEventListener('mouseup', () => { dragging = false; });
addEventListener('keydown', (e) => {
  if (e.altKey && e.code === 'KeyQ') { e.preventDefault(); void infoDump(false); return; }
  if (e.altKey && e.code === 'KeyW') { e.preventDefault(); void infoDump(true); return; }
  if (e.code !== 'Space' || e.repeat) return;
  e.preventDefault(); // page scroll
  setInspect(!state.inspect);
  paintRail();
});
addEventListener('mousemove', (e) => {
  lookDX = e.clientX - lastX; lookDY = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  if (state.inspect || !dragging) { lookDX = 0; lookDY = 0; }
});

// --- click-pick: copies a piece path so "delete piece X" feedback can
// name the exact mesh. Click = press+release with no drag; anything
// bigger counts as an orbit/pan gesture. ---
const raycaster = new THREE.Raycaster();
const pickNDC = new THREE.Vector2();
const pickFlashMat = new THREE.MeshBasicMaterial({ color: 0xffee66 });
// Surface dot: marks the exact raycast hit while the flash marks the mesh.
const pickDot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8),
  new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
pickDot.visible = false;
pickDot.renderOrder = 999;
scene.add(pickDot);
let pickDotTimer: ReturnType<typeof setTimeout> | undefined;
let downX = 0, downY = 0;
addEventListener('mousedown', (e) => { downX = e.clientX; downY = e.clientY; });
addEventListener('mouseup', (e) => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return;
  if ((e.target as HTMLElement).tagName === 'BUTTON') return;
  pickPiece(e.clientX, e.clientY);
});
function pickPiece(cx: number, cy: number): void {
  const root: THREE.Object3D = state.inspect && inspectAnchor ? inspectAnchor : vm.group;
  pickNDC.set((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pickNDC, camera);
  // Raycaster doesn't honor visible=false — skip hits inside a hidden
  // subtree (the non-active weapons parked invisible in vm.group).
  const hit = raycaster.intersectObject(root, true)
    .find(h => { for (let o: THREE.Object3D | null = h.object; o && o !== root.parent; o = o.parent) if (!o.visible) return false; return true; });
  if (!hit) return;
  // Path label: ancestor chain up to the weapon group, e.g.
  // "Chaingun › barrels[2] CylinderGeometry @(0.09, 0, -0.55)".
  const segs: string[] = [];
  let o: THREE.Object3D | null = hit.object;
  while (o && o !== vm.group && o !== scene) {
    const parent: THREE.Object3D | null = o.parent;
    const idx = parent ? parent.children.indexOf(o) : -1;
    const mesh = o as THREE.Mesh;
    const kind = mesh.isMesh ? ` ${mesh.geometry.type}` : '';
    segs.unshift(`${o.name || `child[${idx}]`}${kind}`);
    o = parent;
  }
  // hit.point is the exact surface point the ray touched (world space);
  // the second tuple is relative to the weapon's own center.
  const rel = hit.point.clone().sub(hit.object.getWorldPosition(new THREE.Vector3()));
  // Part fingerprint: world-space bbox center + size — "the 0.05-wide box
  // at (…)" survives child-index reshuffles and names the piece for real.
  const mesh = hit.object as THREE.Mesh;
  let fp = '';
  if (mesh.isMesh) {
    mesh.geometry.computeBoundingBox();
    const wb = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
    const c = wb.getCenter(new THREE.Vector3()), s = wb.getSize(new THREE.Vector3());
    fp = ` box(${s.x.toFixed(3)}×${s.y.toFixed(3)}×${s.z.toFixed(3)} @ ${c.x.toFixed(3)},${c.y.toFixed(3)},${c.z.toFixed(3)})`;
  }
  const label = `${WeaponType[state.wt] ?? state.wt} › ${segs.join(' › ')} hit(${hit.point.x.toFixed(3)}, ${hit.point.y.toFixed(3)}, ${hit.point.z.toFixed(3)}) rel(${rel.x.toFixed(3)}, ${rel.y.toFixed(3)}, ${rel.z.toFixed(3)})${fp}`;
  void navigator.clipboard?.writeText(label);
  flashStatus(`copied: ${label}`);
  // Flash the picked mesh — the piece materials are SHARED across the
  // gun, so flash by swapping this mesh's material, not by mutating one.
  // A re-click during the window must not capture the flash mat as the
  // "original" — that would restore TO flash, i.e. permanent highlight.
  if (!mesh.isMesh) return;
  if (mesh.userData.flashTimer) clearTimeout(mesh.userData.flashTimer as number);
  if (mesh.material !== pickFlashMat) mesh.userData.origMat = mesh.material;
  mesh.material = pickFlashMat;
  mesh.userData.flashTimer = setTimeout(() => {
    mesh.material = mesh.userData.origMat;
    mesh.userData.flashTimer = 0;
  }, 280);
  pickDot.position.copy(hit.point);
  pickDot.visible = true;
  clearTimeout(pickDotTimer);
  pickDotTimer = setTimeout(() => { pickDot.visible = false; }, 700);
}
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

paintRail();
// Restore the parked view — same gun, same angle, across reloads. Runs
// here, after every declaration, not beside the vm init (TDZ).
if (state.inspect) {
  // Snapshot FIRST — setInspect's own saveState would overwrite
  // state.cam/tgt with the default-fit pose before we could read them.
  const cam = state.cam ? [...state.cam] : null;
  const tgt = state.tgt ? [...state.tgt] : null;
  setInspect(true);
  if (cam && tgt) {
    camera.position.fromArray(cam);
    orbit.target.fromArray(tgt);
    orbit.update();
    flashStatus(`restored w${state.wt} view`);
  } else {
    flashStatus(`restored w${state.wt} (default angle — no saved pose)`);
  }
}
if (state.z) zPaint(true); // remembered ⚠z — after inspect restore (TDZ)
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (state.inspect && inspectAnchor) {
    orbit.update(); // damping settles between frames — must tick
  } else {
    vm.update(dt, lookDX * 0.002, lookDY * 0.002, zeroVel, camera);
  }
  lookDX = 0; lookDY = 0;
  renderer.render(scene, camera);
});

// HMR: a code edit re-imports this module — the fresh ViewModel above
// picks up the new geo builders, state survives on window. dispose()
// tears down THIS instance or every accept would stack renderers/pollers.
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    renderer.setAnimationLoop(null);
    clearInterval(pollTimer);
    orbit.dispose();
    disposeVm(vm);
    renderer.domElement.remove();
    renderer.dispose();
  });
}
