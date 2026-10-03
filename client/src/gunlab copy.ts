// gunlab — live weapon inspection page (/gunlab.html). Left rail = one
// button per viewmodel weapon; FPS pose or detached turntable inspect.
// Live updates: vite HMR re-runs this module on code edits (state parked
// on window so selection survives), and a HEAD poll on the baked
// /weapons/*.glb/_ao.png files hot-swaps bake assets in place — no reload.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ViewModel } from './entities/ViewModel.js';
import { MODEL_BUILDERS } from './entities/viewmodel/weaponsGeo.js';
import { WeaponType } from '../../shared/weaponTable.js';

interface LabState { wt: number; inspect: boolean; yaw: number; pitch: number; cam?: number[]; tgt?: number[]; fov?: number; z?: boolean }
// Persisted so noreload-mode F5s come back to the same gun+angle — the
// window park only survives HMR accepts.
const saved = (() => {
  try {
    const s = JSON.parse(localStorage.getItem('gunlab') ?? '') as LabState;
    console.log('[gunlab] restored state:', JSON.stringify(s));
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
// Wireframe overlay — an EdgesGeometry child per visible mesh, drawn
// with depth-test ON but polygon-offset toward the eye: lines sit on
// top of the model surface without bleeding through it. ~1px via
// LineBasicMaterial (GL lines, not screen-constant, but reads so).
let wireOn = false;
const wireLines: THREE.LineSegments[] = [];
const wireMat = new THREE.LineBasicMaterial({
  color: 0xffdd00, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
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
    // Threshold 1° — near-full wireframe; only coplanar triangulation
    // seams get culled. Set back to ~30 if you want silhouette-only.
    const l = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 1), wireMat);
    l.renderOrder = 5;
    m.add(l);
    wireLines.push(l);
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
  vm = new ViewModel(camera);
  vm.switchWeapon(state.wt);
  for (let i = 0; i < 60; i++) vm.update(1 / 60, 0, 0, zeroVel, camera);
  if (wasInspect) setInspect(true);
  if (zOverlay) zPaint(true); // re-flag the rebuilt weapon, not the stale one
  applyWire();
  paintRail();
  flashStatus('rebuilt');
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
  const tools = document.createElement('div');
  tools.className = 'tools';
  const mk = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    tools.appendChild(b);
    return b;
  };
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
  const fused = new URLSearchParams(location.search).has('fuse');
  mk(fused ? '⛭ fuse: ON' : '⛭ fuse', () => {
    // ?fuse opts the AO bake into CSG-unioning the weapon first —
    // bake-time change, so same reload path as ?nobake.
    const u = new URL(location.href);
    if (fused) u.searchParams.delete('fuse'); else u.searchParams.set('fuse', '1');
    flushSave();
    location.href = u.toString();
  });
  const noMask = new URLSearchParams(location.search).has('nomask');
  mk(noMask ? '⬡ mask: OFF' : '⬡ mask', () => {
    // ?nomask flattens the wear-mask texture to neutral — A/B the edge
    // wear with and without the real noise map. Shader-level, needs reload.
    const u = new URL(location.href);
    if (noMask) u.searchParams.delete('nomask'); else u.searchParams.set('nomask', '1');
    flushSave();
    location.href = u.toString();
  });
  const noWear = new URLSearchParams(location.search).has('nowear');
  mk(noWear ? '◐ wear: OFF' : '◐ wear', () => {
    // ?nowear kills the bright edge-wear term entirely — clean A/B for
    // how much the white edging contributes vs AO + grime alone.
    const u = new URL(location.href);
    if (noWear) u.searchParams.delete('nowear'); else u.searchParams.set('nowear', '1');
    flushSave();
    location.href = u.toString();
  });
  mk('▦ sheet', shotSheet);
  mk(zOverlay ? '⚠ z: ON' : '⚠ z', () => { zPaint(!zOverlay); state.z = !!zOverlay; saveState(); paintRail(); });
  mk(wireOn ? '▧ wire: ON' : '▧ wire', () => { wireOn = !wireOn; applyWire(); paintRail(); });
  mk('▣ src', () => void copyBuilderSrc());
  // FOV slider — game viewmodel runs at 55, but per-weapon judgement
  // sometimes wants tighter/wider. Persisted like the rest of the lab state.
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

function select(wt: number): void {
  state.wt = wt;
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
  const label = `${WeaponType[state.wt] ?? state.wt} › ${segs.join(' › ')} hit(${hit.point.x.toFixed(3)}, ${hit.point.y.toFixed(3)}, ${hit.point.z.toFixed(3)}) rel(${rel.x.toFixed(3)}, ${rel.y.toFixed(3)}, ${rel.z.toFixed(3)})`;
  void navigator.clipboard?.writeText(label);
  flashStatus(`copied: ${label}`);
  // Flash the picked mesh — the piece materials are SHARED across the
  // gun, so flash by swapping this mesh's material, not by mutating one.
  // A re-click during the window must not capture the flash mat as the
  // "original" — that would restore TO flash, i.e. permanent highlight.
  const mesh = hit.object as THREE.Mesh;
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
