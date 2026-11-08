/* oxlint-disable typescript/no-explicit-any -- Manifold WASM + window debug handles */
// gunlab - live weapon inspection page (/gunlab.html). Left rail = one
// button per viewmodel weapon; FPS pose or detached turntable inspect.
// Live updates: vite HMR re-runs this module on code edits (state parked
// on window so selection survives), and a HEAD poll on the baked
// /weapons/*.glb/_ao.png files hot-swaps bake assets in place - no reload.
import * as THREE from 'three';
import { AtmosphericSky } from './world/atmosphericSky.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import ManifoldModuleFactory from 'manifold-3d';
import manifoldWasmUrl from 'manifold-3d/manifold.wasm?url';
import { ViewModel } from './entities/ViewModel.js';
import { MODEL_BUILDERS } from './entities/viewmodel/weaponsGeo.js';
import { ARCHIVE_BUILDERS } from './entities/viewmodel/weaponsGeoArchive.js';
import { bakeVertexAO, enhanceWeaponMaterial } from './effects/vertexAO.js';
import { metalMat } from './entities/procMetal.js';
import { WeaponType } from '../../shared/weaponTable.js';
import { CREATURES, PICKUPS, ITEMS, CLASSES, STRUCTURES, previewLive, initPreviews } from './gunlab/previews.js';
import type { AnimationState } from './entities/playerClips.js';
import { zScan, holeScan, gapScan, volScan } from './gunlab/scans.js';

const CAT_TABLES = { classes: CLASSES, creatures: CREATURES, items: ITEMS, pickups: PICKUPS, structures: STRUCTURES } as const;

// Player-facing lab: served on prod too - the ESC-menu button opens it
// on any host, so there is no isDevHost gate on the entry.

// Load profiling: T0 lands after module-eval imports (three, manifold
// wrapper) finish - that span shows as 'module imports' in the first lap.
// nav+ is wall time since navigationStart, the number you feel on F5.
const T0 = performance.now();
let lapT = T0;
// Reload-to-reload timing: beforeunload stamps wall-clock so the next
// boot reports the full F5 round trip (unload → server → module eval).
addEventListener('beforeunload', (): void => {
  try { localStorage.setItem('gunlab.unloadAt', String(Date.now())); } catch { /* private mode */ }
});
const reloadGap = ((): number | null => {
  try {
    const t = Number(localStorage.getItem('gunlab.unloadAt'));
    return t > 0 ? Date.now() - t : null;
  } catch { return null; }
})();
if (reloadGap !== null) {console.log(`[gunlab] F5 round trip: ${reloadGap}ms`);}

const lap = (label: string): void => {
  const now = performance.now();
  console.log(`[gunlab] ${label} +${(now - lapT).toFixed(0)}ms (nav+${now.toFixed(0)}ms)`);
  lapT = now;
};
lap('module imports');

interface LabState { wt: number; inspect: boolean; yaw: number; pitch: number; cam?: number[]; tgt?: number[]; fov?: number; z?: boolean; cat?: string; pick?: string; heldWt?: number; heldTeam?: string; heldMark?: string; heldSide?: string }
// Persisted so noreload-mode F5s come back to the same gun+angle - the
// window park only survives HMR accepts.
const saved = ((): LabState | undefined => {
  try {
    const s = JSON.parse(localStorage.getItem('gunlab') ?? '') as LabState;
    return s;
  } catch { return (window as any).__gunlab as LabState | undefined; }
})();
const state: LabState = saved ?? { wt: 0, inspect: false, yaw: 0.75, pitch: 0 };
(window as any).__gunlab = state;
let saveTimer: ReturnType<typeof setTimeout> | undefined = undefined;
function flushSave(): void {
  // state IS window.__gunlab - probes bolt `scene` and other live objects
  // onto it, and swarm meshes carry deliberately-circular dbg tags, so
  // persist an explicit whitelist rather than stringifying the handle.
  const persist: LabState = {
    wt: state.wt, inspect: state.inspect, yaw: state.yaw, pitch: state.pitch,
    cam: state.cam, tgt: state.tgt, fov: state.fov, z: state.z,
    cat: state.cat, pick: state.pick, heldWt: state.heldWt, heldTeam: state.heldTeam, heldMark: state.heldMark, heldSide: state.heldSide,
  };
  localStorage.setItem('gunlab', JSON.stringify(persist));
}


function saveState(): void {
  state.cam = camera.position.toArray();
  state.tgt = orbit.target.toArray();
  // Debounced - orbit 'change' can fire per frame while damping settles.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}
addEventListener('pagehide', flushSave); // a pending debounce dies with the page

// --- render rig: identical to vmdump so shading matches in-game ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.4; // TONE_MAPPING_EXPOSURE
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x25_28_2E);
// FOV + lights mirror world/viewmodelScene.ts - the game renders the
// viewmodel in its own pass at FOV 55, so this rig must match or the
// FPS view judges the gun wider and warmer-lit than in-game.
const camera = new THREE.PerspectiveCamera(state.fov ?? 55, innerWidth / innerHeight, 0.01, 100);
initPreviews(camera); // creature/deployable builders aim at this eye
lap('renderer+scene');
scene.add(camera);
scene.add(new THREE.AmbientLight(0x88_99_AA, 0.9));
const sun = new THREE.DirectionalLight(0xFF_FF_FF, 1.2);
sun.position.set(0.5, 1, 0.4);
scene.add(sun);
// The game's real atmospheric sky - mounted before the env bake so
// scene.environment IS the sky (transmission/metal reflect it) and the
// dome itself draws behind every preview. 4km dome scaled inside the
// camera's 100 far plane; the shader is view-direction based so scale
// only affects depth, never the gradient.
new AtmosphericSky(scene);
(scene.getObjectByName('__sky') as THREE.Mesh).scale.setScalar(60 / 4000);
// PMREM env bake - physical materials (transmission/metal) are dead
// without something to reflect/refract; same recipe as main.ts.
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(scene, 0.06).texture;
  pmrem.dispose();
}
// Probes read state.pick AND dump baked attributes off scene - same
// object both times: a second assignment here silently dropped the
// state side once this module finished booting.
Object.assign((window as any).__gunlab ??= {}, { scene });

// Sketchfab-style orbit rig - the convention everyone copies: LMB
// orbits, wheel dollies, RMB pans. Enabled only in inspect mode; in FPS
// pose the camera is the rig and a drag is a look-sway instead.
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.enabled = false;
orbit.minDistance = 0.06; // never let the camera into the mesh
orbit.maxDistance = 8;
const trackDir = (): void => {
  // Remember where the camera sits relative to the target - weapon
  // swaps refit distance along THIS line so the angle never jumps.
  const d = camera.position.clone().sub(orbit.target);
  if (d.lengthSq() > 1e-8) {inspectDir.copy(d.normalize());}
  saveState();
};
orbit.addEventListener('change', trackDir); // debounced inside - safe per frame
(window as any).__gl = { camera, orbit }; // debug handle

// The geometry lints live in gunlab/scans.ts - the __gl hooks below
// just run them across every builder for the headless report
// (_tools/e2e/zfight.ts calls these).
(window as any).__gl.zcheck = (): { wt: number; pairs: number; at: number[][]; who: string[] }[] => {
  const results: { wt: number; pairs: number; at: number[][]; who: string[] }[] = [];
  for (const [wt, mk] of MODEL_BUILDERS) {
    const built = mk() as THREE.Group | { g: THREE.Group };
    const root = 'g' in built ? built.g : built;
    root.visible = true; // builders park themselves invisible
    const r = zScan(root);
    if (r.pairs) {results.push({ wt, pairs: r.pairs, at: r.at, who: r.who });}
  }
  return results;
};
(window as any).__gl.holecheck = (): { wt: number; holes: number; at: number[][]; who: string[] }[] => {
  const results: { wt: number; holes: number; at: number[][]; who: string[] }[] = [];
  for (const [wt, mk] of MODEL_BUILDERS) {
    const built = mk() as THREE.Group | { g: THREE.Group };
    const root = 'g' in built ? built.g : built;
    root.visible = true;
    const r = holeScan(root);
    if (r.holes) {results.push({ wt, holes: r.holes, at: r.at, who: r.who });}
  }
  return results;
};
(window as any).__gl.gapcheck = (): { wt: number; orphans: number; clusters: number; who: string[]; at: number[][] }[] => {
  const results: { wt: number; orphans: number; clusters: number; who: string[]; at: number[][] }[] = [];
  for (const [wt, mk] of MODEL_BUILDERS) {
    const built = mk() as THREE.Group | { g: THREE.Group };
    const root = 'g' in built ? built.g : built;
    root.visible = true;
    const r = gapScan(root);
    if (r.orphans || r.clusters > 1) {results.push(Object.assign({}, {wt}, r));}
  }
  return results;
};
(window as any).__gl.normcheck = (): { wt: number; inverted: number; who: string[] }[] => {
  const results: { wt: number; inverted: number; who: string[] }[] = [];
  for (const [wt, mk] of MODEL_BUILDERS) {
    const built = mk() as THREE.Group | { g: THREE.Group };
    const root = 'g' in built ? built.g : built;
    root.visible = true;
    const r = volScan(root);
    if (r.inverted) {results.push(Object.assign({}, {wt}, r));}
  }
  return results;
};
// Info dump - clipboard truth per weapon: mesh/vert/tri census,
// footprint size, baked attributes present, then the three checks
// (z-fight pairs, hole rims, floating parts). Alt+Q = ACTIVE weapon
// (the live viewmodel group, bake swap included); Alt+W = all weapons
// off the builders. ⓘ info runs the current weapon.
function dumpWeapon(wt: number, root: THREE.Object3D, name: string): string {
  root.updateMatrixWorld(true);
  let meshes = 0, verts = 0, tris = 0, bytes = 0;
  const attrs = new Set<string>();
  const wb = new THREE.Box3();
  root.traverse((o): void => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) {return;}
meshes += 1;
    const pos = m.geometry.getAttribute('position');
    verts += pos.count;
    tris += m.geometry.index ? m.geometry.index.count / 3 : pos.count / 3;
    // Buffer footprint: every attribute + index - the on-GPU weight of
    // the data as-shown (says nothing about the .glb file's compression).
    for (const k of Object.keys(m.geometry.attributes)) {
      attrs.add(k);
      const a = m.geometry.getAttribute(k) as THREE.BufferAttribute;
      bytes += a.count * a.itemSize * a.array.BYTES_PER_ELEMENT;
    }
    if (m.geometry.index) {bytes += m.geometry.index.count * m.geometry.index.array.BYTES_PER_ELEMENT;}
    m.geometry.computeBoundingBox();
    wb.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld));
  });
  const size = wb.getSize(new THREE.Vector3());
  const z = zScan(root);
  const holes = holeScan(root);
  const gaps = gapScan(root);
  const vol = volScan(root);
  const kb = bytes / 1024;
  return (
    `w${wt} ${name}: ${meshes} meshes, ${verts}v/${tris}t ` +
    `${kb >= 1024 ? `${(kb / 1024).toFixed(2)}MB` : `${kb.toFixed(1)}KB`}, ` +
    `size ${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)}, ` +
    `attrs {${[...attrs].join(',')}} - ` +
    `z:${z.pairs} holes:${holes.holes} inverted:${vol.inverted} floaters:${gaps.orphans} clusters:${gaps.clusters}${ 
    vol.inverted ? ` INV[${vol.who.join('; ')}]` : '' 
    }${gaps.orphans ? ` [${gaps.who.join('; ')}]` : ''}`
  );
}
// Live stats overlay - bottom-left corner census of whatever is on
// stage (weapon, preview, inspect anchor). Cheap counts only: the heavy
// scans (zScan/holes/gaps) stay behind ⓘ info - they recompute geometry
// and would stutter if run per-tick.
let statOn = false;
let statEl: HTMLDivElement | null = null;
let statAt = 0;
function statRoot(): THREE.Object3D | undefined {
  return inspectAnchor ?? archiveGroup ??
    vm.group.children.find((c): boolean => c.visible && c !== vm.flashMesh && c !== vm.flashMesh2);
}
function updateStats(): void {
  if (!statEl) {return;}
  const root = statRoot();
  if (!root) { statEl.textContent = 'nothing on stage'; return; }
  root.updateMatrixWorld(true);
  let meshes = 0, insts = 0, verts = 0, tris = 0, bytes = 0;
  const mats = new Set<THREE.Material>();
  const wb = new THREE.Box3();
  const _b = new THREE.Box3();
  root.traverse((o): void => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) {return;}
    if ((m as THREE.InstancedMesh).isInstancedMesh) {insts += 1;}
    else {meshes += 1;}
    const pos = m.geometry.getAttribute('position');
    if (!pos) {return;}
    const n = m.geometry.index ? m.geometry.index.count / 3 : pos.count / 3;
    const times = (m as THREE.InstancedMesh).count ?? 1;
    verts += pos.count * times;
    tris += n * times;
    for (const k of Object.keys(m.geometry.attributes)) {
      const a = m.geometry.getAttribute(k) as THREE.BufferAttribute;
      bytes += a.count * a.itemSize * a.array.BYTES_PER_ELEMENT;
    }
    if (m.geometry.index) {bytes += m.geometry.index.count * m.geometry.index.array.BYTES_PER_ELEMENT;}
    for (const mm of Array.isArray(m.material) ? m.material : [m.material]) {mats.add(mm);}
    if (m.geometry.boundingBox === null) {m.geometry.computeBoundingBox();}
    if (m.geometry.boundingBox) {wb.union(_b.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld));}
  });
  const s = wb.isEmpty() ? new THREE.Vector3() : wb.getSize(new THREE.Vector3());
  let label = `w${state.wt}`;
  if (inspectAnchor) {label = `${inspectAnchor.name || 'inspect'}`;}
  else if (archiveGroup) {label = archiveLabel;}
  statEl.textContent =
    `${label}\n` +
    `${meshes} meshes${insts ? ` + ${insts} inst` : ''} · ${mats.size} mats\n` +
    `${verts.toLocaleString()} v · ${Math.round(tris).toLocaleString()} t · ${(bytes / 1024).toFixed(1)} KB\n` +
    `${s.x.toFixed(2)} × ${s.y.toFixed(2)} × ${s.z.toFixed(2)} m`;
}

// --- rail UI ---
function paintRail(): void {
  rail.innerHTML = '';
  // Category picker - weapons today, creatures/pickups/etc as they get
  // previewable builds. The select repaints the rail below it.
  const cats: [id: string, label: string][] = [['weapons', 'weapons'], ['classes', 'classes'], ['creatures', 'creatures'], ['items', 'items'], ['pickups', 'pickups'], ['structures', 'structures']];
  const catSel = document.createElement('select');
  catSel.className = 'catsel';
  for (const [id, label] of cats) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = label;
    if ((state.cat ?? 'weapons') === id) {o.selected = true;}
    catSel.append(o);
  }
  catSel.addEventListener('change', (): void => { state.cat = catSel.value; saveState(); paintRail(); });
  rail.append(catSel);
  const catTable = CAT_TABLES[state.cat as keyof typeof CAT_TABLES] ?? null;
  if (catTable) {
    for (const [label, build] of catTable) {
      const b = document.createElement('button');
      b.textContent = label;
      if (archiveLabel === label && archiveGroup) {b.classList.add('active');}
      b.addEventListener('click', (): void => selectArchive(label, build));
      rail.append(b);
    }
    paintTools();
    return;
  }
  // MODEL_BUILDERS + Chaingun - the weapons map also carries the Implodisc
  // alias (same Disc group, pull muzzle node), which needs no rail pick.
  const wts = [...MODEL_BUILDERS.map(([wt]) => wt), WeaponType.Chaingun].toSorted((a, b): number => a - b);
  for (const wt of wts) {
    const b = document.createElement('button');
    b.textContent = `${wt} ${WeaponType[wt] ?? '?'}`;
    if (wt === state.wt) {b.classList.add('active');}
    b.addEventListener('click', (): void => select(wt));
    rail.append(b);
  }
  // Archive shelf - retired builders, for A/B against the live versions.
  if (ARCHIVE_BUILDERS.length > 0) {
    const sep = document.createElement('div');
    sep.className = 'tools';
    sep.innerHTML = '<span style="opacity:.5;padding:2px 4px">archive</span>';
    rail.append(sep);
    for (const [label, mkArc] of ARCHIVE_BUILDERS) {
      const b = document.createElement('button');
      b.textContent = `† ${label}`;
      if (archiveLabel === label && archiveGroup) {b.classList.add('active');}
      b.addEventListener('click', (): void => selectArchive(label, mkArc));
      rail.append(b);
    }
  }
  paintTools();
}


function toggleStats(): void {
  statOn = !statOn;
  if (statOn && !statEl) {
    statEl = document.createElement('div');
    statEl.style.cssText =
      'position:fixed;left:8px;bottom:8px;z-index:20;pointer-events:none;' +
      'font:11px/1.5 monospace;color:#9fd;white-space:pre;' +
      'background:rgba(8,12,16,.72);padding:6px 9px;border:1px solid #2a4a55;';
    document.body.append(statEl);
  }
  if (statEl) {statEl.style.display = statOn ? 'block' : 'none';}
  if (statOn) {updateStats();}
  paintRail();
}

function flashStatus(msg: string): void {
  statusEl.innerHTML = `<span class="hot">${msg}</span>`;
  setTimeout((): void => { statusEl.innerHTML = ''; }, 1500);
}


async function infoDump(all = false): Promise<void> {
  const lines: string[] = [`gunlab info - ${new Date().toISOString()}`];
  if (all) {
    for (const [wt, mk] of MODEL_BUILDERS) {
      const built = mk() as THREE.Group | { g: THREE.Group };
      const root = 'g' in built ? built.g : built;
      root.visible = true;
      lines.push(dumpWeapon(wt, root, mk.name || '?'));
    }
  } else {
    // Active weapon, live state - the procedural bake, swapped GLB, or
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
    const name = MODEL_BUILDERS.find(([wt]): boolean => wt === state.wt)?.[1].name || '?';
    lines.push(dumpWeapon(state.wt, g, `${name} (live)`));
  }
  await navigator.clipboard?.writeText(lines.join('\n'));
  flashStatus(all ? 'info (all) → clipboard' : `w${state.wt} info → clipboard`);
  console.log(lines.join('\n'));
}
// ⚠z toggle - rebuilds the flagged tris of the ACTIVE weapon into an
// error-magenta overlay, the way missing-texture pipelines mark broken
// surfaces. Paints the live weapon (inspect or FPS pose), so it rides
// along with whatever angle you're inspecting from.
let zOverlay: THREE.Mesh | null = null;
function zPaint(on: boolean): void {
  if (zOverlay) { scene.remove(zOverlay); zOverlay.geometry.dispose(); zOverlay = null; }
  if (!on) {return;}
  const root = inspectAnchor ?? vm.group.children.find((c): boolean => c.visible && c !== vm.flashMesh);
  if (!root) { flashStatus('no active weapon'); return; }
  const { pairs, flagVerts } = zScan(root);
  if (!pairs) { flashStatus('zcheck: clean'); return; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(flagVerts, 3));
  // depthTest off + late renderOrder: the overlay sits ON the fighting
  // plane - let it win outright or it becomes the thing it highlights.
  const mat = new THREE.MeshBasicMaterial({ color: 0xFF_00_FF, side: THREE.DoubleSide, depthTest: false });
  zOverlay = new THREE.Mesh(geo, mat);
  zOverlay.renderOrder = 999;
  scene.add(zOverlay);
  flashStatus(`zcheck: ${pairs} fighting pairs painted`);
}
orbit.addEventListener('end', trackDir);   // and once more on mouse-up

const zeroVel = new THREE.Vector3();
const rail = document.querySelector('#rail')!;
const statusEl = document.querySelector('#status')!;

// --- viewmodel lifecycle (rebuilt on bake-asset change / HMR) ---
let vm = new ViewModel(camera);
// Probes need the live viewmodel to drive envelopes (a swing, a punch, a
// reload) from outside the page - the rail buttons are the manual path, but
// a scripted capture wants to step the same instance.
const exposeVm = (): void => {Object.assign((window as any).__gunlab ??= {}, { vm, renderer, camera });};
exposeVm();
vm.switchWeapon(state.wt);
for (let i = 0; i < 60; i += 1) {vm.update(1 / 60, 0, 0, zeroVel, camera);} // settle past switch dip
lap('viewmodel init');

// Inspect mode parks the ACTIVE weapon group in the scene on a manual
// orbit; the rest of the viewmodel (hands/flash) stays offstage. The
// group's viewmodel-space transform is saved and restored on exit -
// leaving it mutated is what stranded the gun off-screen in FPS view.
let inspectAnchor: THREE.Object3D | null = null;
const focus = new THREE.Vector3();
// Live-focus tracking scratches - the loop applies the focus's frame
// delta so RMB pan's edits to orbit.target survive (see render loop).
const _camW = new THREE.Vector3();
const _lastFocus = new THREE.Vector3();
let liveFocusOn = false;
// The last orbit direction - weapon swaps and FPS↔inspect toggles keep
// this angle; only the fit distance changes.
const inspectDir = new THREE.Vector3(0.45, 0.3, 0.85).normalize();
// Wireframe overlay - THREE line children per visible mesh, drawn with
// depth-test ON but polygon-offset toward the eye: a blue
// WireframeGeometry layer paints EVERY triangle edge (coplanar
// triangulation splits included), a yellow EdgesGeometry layer marks
// >1° breaks, and a RED layer draws the wear bake's own flagged-edge
// list (geo.userData.__sharpEdges) - comparing red-vs-wear-line splits
// bake misses from shader artifacts. ~1px via LineBasicMaterial.
let wireOn = false;
const wireLines: THREE.LineSegments[] = [];
// toneMapped:false - ACES otherwise crushes the flat line colors into
// murk on the dark model; these are debug markup, they should punch.
const wireMat = new THREE.LineBasicMaterial({
  color: 0xFF_DD_00, depthWrite: false, toneMapped: false,
  polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
});
const wireFlatMat = new THREE.LineBasicMaterial({
  color: 0x33_AA_FF, depthWrite: false, transparent: true, opacity: 0.45, toneMapped: false,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
});
const wireSharpMat = new THREE.LineBasicMaterial({
  color: 0xFF_33_55, depthWrite: false, toneMapped: false,
  // Biggest depth pull - the flagged list sits at the same spots as the
  // other two layers' lines, so without a clear offset margin the
  // brighter layers cover the debug red.
  polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
});
function applyWire(): void {
  for (const l of wireLines) { l.parent?.remove(l); l.geometry.dispose(); }
  wireLines.length = 0;
  // Previews that own a hit capsule (class lineup) expose colliderWire -
  // the ▧ wire toggle shows the sim capsule alongside the tri overlay.
  const cw = (inspectAnchor ?? archiveGroup)?.userData.colliderWire as ((on: boolean) => void) | undefined;
  cw?.(wireOn);
  if (!wireOn) {return;}
  const root = inspectAnchor ?? vm.group.children.find((c): boolean => c.visible && c !== vm.flashMesh && c !== vm.flashMesh2);
  if (!root) {return;}
  root.traverse((o): void => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) {return;}
    // White underlay: every tri edge, including flat-face seams.
    const flat = new THREE.LineSegments(new THREE.WireframeGeometry(m.geometry), wireFlatMat);
    flat.renderOrder = 5;
    m.add(flat);
    wireLines.push(flat);
    // Yellow overlay: only edges with a >1° dihedral - designed breaks.
    const l = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 1), wireMat);
    l.renderOrder = 6;
    m.add(l);
    wireLines.push(l);
    // Red overlay: the wear bake's flagged-edge list verbatim - what the
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
  const active = vm.group.children.find((c): boolean => c.visible && c !== vm.flashMesh) as THREE.Group | undefined;
  if (!active) {return;}
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
  active.userData.inspectPos = active.position.clone(); // kick delta rides THIS, not home
  const dist = Math.max(size * 0.75, 0.25);
  // Structures and lineup previews are tens of meters across - the
  // weapon-scale 8m cap makes them impossible to frame from outside.
  orbit.maxDistance = Math.max(8, size * 2.5);
  orbit.target.copy(focus.set(0, 0, 0));
  camera.position.copy(focus).addScaledVector(inspectDir, dist);
  orbit.update();
  applyWire();
  saveState();
}

function disposeVm(v: ViewModel): void {
  v.group.traverse((o): void => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) {return;}
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
function selectArchive(label: string, mk: () => THREE.Group): void {
  unshell();
  unmetal();
  // parent-remove, not vm.group.remove: inspect mode re-parents the
  // preview into `scene` as the orbit anchor, so a group-only remove
  // silently leaves the old pick on stage (and setInspect re-homes it).
  if (archiveGroup) {
    (archiveGroup.userData.disposeCreature as (() => void) | undefined)?.();
    archiveGroup.parent?.remove(archiveGroup);
    if (inspectAnchor === archiveGroup) {inspectAnchor = null;}
  }
  for (const g of vm.weapons.values()) {g.visible = false;}
  archiveGroup = mk();
  bakeVertexAO(archiveGroup); // same AO+grunge+wear pipeline the live weapons get
  archiveGroup.visible = true;
  archiveGroup.name = `archive:${label}`;
  archiveLabel = label;
  state.pick = label; // survives F5 - same slot the weapon pick uses
  saveState();
  vm.group.add(archiveGroup);
  if (state.inspect) { setInspect(false); setInspect(true); }
  applyWire();
  paintRail();
  paintAnimRail();
  flashStatus(`archive: ${label}`);
}



function rebuild(): void {
  const wasInspect = state.inspect;
  if (wasInspect) {setInspect(false);}
  (archiveGroup?.userData.disposeCreature as (() => void) | undefined)?.();
  disposeVm(vm);
  archiveGroup = null; archiveLabel = ''; // died with the old vm group
  vm = new ViewModel(camera);
  exposeVm();
  vm.switchWeapon(state.wt);
  for (let i = 0; i < 60; i += 1) {vm.update(1 / 60, 0, 0, zeroVel, camera);}
  // A creature/pickup/archive pick died with the old group - respawn it.
  if (state.pick) {
    const hit = [...ARCHIVE_BUILDERS, ...CREATURES, ...PICKUPS, ...CLASSES, ...STRUCTURES, ...ITEMS].find(([l]): boolean => l === state.pick);
    if (hit) {selectArchive(hit[0], hit[1] as () => THREE.Group);}
  }
  if (wasInspect) {setInspect(true);}
  if (zOverlay) {zPaint(true);} // re-flag the rebuilt weapon, not the stale one
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
// Manifold (WASM) - guaranteed-watertight booleans, unlike three-bvh-csg
// which shreds on coplanar/sliver inputs. Loaded lazily on first toggle.
let maniMod: any = null;
async function mani(): Promise<any> {
  if (!maniMod) {
    maniMod = await (ManifoldModuleFactory as any)({ locateFile: () => manifoldWasmUrl });
    maniMod.setup();
  }
  return maniMod;
}
// Collect a group's lit meshes as Manifold solids in GROUP space -
// shared input for both the union preview and the shell carve.
async function manifoldParts(g: THREE.Group): Promise<{ Manifold: any; parts: THREE.Mesh[]; manis: any[]; rejected: number; inV: number; inT: number }> {
  const { Manifold, Mesh: MMesh } = await mani();
  g.updateWorldMatrix(true, true);
  const parts: THREE.Mesh[] = [];
  g.traverse((o): void => {
    const m = o as THREE.Mesh;
    if (m.isMesh && (m.material as THREE.Material).type !== 'MeshBasicMaterial') {parts.push(m);}
  });
  const inv = g.matrixWorld.clone().invert();
  const manis: any[] = [];
  const kept: THREE.Mesh[] = [];
  let inV = 0, inT = 0, rejected = 0;
  for (const m of parts) {
    // Strip baked attrs BEFORE welding - mergeVertices only merges verts
    // whose whole attribute set matches, and per-vertex AO/wear differs,
    // so nothing welded and every part read as non-manifold.
    const stripped = m.geometry.clone().applyMatrix4(inv.clone().multiply(m.matrixWorld));
    for (const name of Object.keys(stripped.attributes)) {if (name !== 'position') {stripped.deleteAttribute(name);}}
    const geo = mergeVertices(stripped);
    if (!geo.index) {geo.setIndex([...Array(geo.attributes.position!.count).keys()]);}
    inV += geo.attributes.position!.count;
    inT += geo.index!.count / 3;
    try {
      manis.push(new Manifold(new MMesh({
        numProp: 3,
        vertProperties: (geo.attributes.position!.array as Float32Array).slice(),
        triVerts: new Uint32Array(geo.index!.array as ArrayLike<number>),
      })));
      kept.push(m);
    } catch (error) {
rejected += 1;
      console.warn(`[union] part ${parts.indexOf(m)} (${m.geometry.type}) not manifold:`, error);
    }
    geo.dispose();
  }
  return { Manifold, parts: kept, manis, rejected, inV, inT };
}

// Manifold mesh → BufferGeometry (group space). Keeps Manifold's shared
// vertex pool INDEXED - going non-indexed forces flat facet normals, and
// curved tubes (mkTube/cylinders) shade faceted. toCreasedNormals then
// splits only at real creases: tube segments smooth, box edges stay hard.
function maniToGeo(om: any): THREE.BufferGeometry {
  const np = om.numProp;
  const verts = new Float32Array(om.numVert * 3);
  for (let v = 0; v < om.numVert; v += 1) { verts[v * 3] = om.vertProperties[v * np]!; verts[v * 3 + 1] = om.vertProperties[v * np + 1]!; verts[v * 3 + 2] = om.vertProperties[v * np + 2]!; }
  const ni = new THREE.BufferGeometry();
  ni.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  ni.setIndex(new THREE.BufferAttribute(new Uint32Array(om.triVerts), 1));
  return toCreasedNormals(ni, Math.PI / 3); // 60° - tube facets (~20-36°) smooth, 90° edges hard
}

async function unionToggle(): Promise<void> {
  const g = vm.weapons.get(state.wt);
  if (!g) {return;}
  if (unionOn && unioned) {
    g.remove(unioned.mesh);
    unioned.mesh.geometry.dispose();
    (unioned.mesh.material as THREE.Material).dispose();
    for (const o of unioned.hidden) {o.visible = true;}
    unioned = null;
    unionOn = false;
    return;
  }
  const t0 = performance.now();
  const { Manifold, parts, manis, rejected, inV, inT } = await manifoldParts(g);
  if (manis.length === 0) {return;}
  // oxlint-disable-next-line init-declarations -- assigned later
  let solid!: any;
  try {
    solid = Manifold.union(manis);
    if (solid.isEmpty()) { console.warn('[union] empty result'); return; }
  } catch (error) { console.warn('[union] manifold failed:', error); return; }
  const om = solid.getMesh();
  console.log(`[union] w${state.wt}: ${parts.length} parts (${rejected} rejected) - ${inV}v/${inT}t in → ${om.numVert}v/${om.triVerts.length / 3}t out, ${(performance.now() - t0).toFixed(0)}ms`);
  const ni = maniToGeo(om);
  for (const mm of manis) {mm.delete?.();}
  solid.delete?.();
  // Clone material - shared bodyMat's wearTex must not be retargeted -
  // and run the wear/grunge/edge bake so the shell matches the parts.
  const umat = (parts[0]!.material as THREE.Material).clone();
  // clone() copies userData - including __grunge, which would make
  // enhanceWeaponMaterial skip injecting the procedural shader.
  delete umat.userData.__grunge;
  const out = new THREE.Mesh(ni, umat);
  const wrap = new THREE.Group();
  wrap.add(out); // identity transform: geometry is already in g-space
  // Manifold output IS watertight, so the full raycast AO bake is safe
  // here (this was the original point of the union preview anyway).
  bakeVertexAO(wrap);
  const hidden: THREE.Object3D[] = [];
  g.traverse((o): void => { const m = o as THREE.Mesh; if (m.isMesh && (m.material as THREE.Material).type !== 'MeshBasicMaterial') { m.visible = false; hidden.push(m); } });
  g.add(out);
  unioned = { mesh: out, hidden };
  unionOn = true;
}

// --- shell: the fake union ---
// Subtract every other part from each part (part_i − union(rest)) - the
// intersection curves become REAL verts, so the bake's merged occluder
// reads like the union shell while every part keeps its own material
// and geometry identity. Toggle restores the authored buffers - no
// rebake needed, the originals kept their bake.
let shellOn = false;
const shelled = new Map<THREE.Mesh, THREE.BufferGeometry>();

function unshell(): void {
  for (const [m, orig] of shelled) { m.geometry.dispose(); m.geometry = orig; }
  shelled.clear();
  shellOn = false;
}

async function shellToggle(): Promise<void> {
  const g = vm.weapons.get(state.wt);
  if (!g) {return;}
  if (shellOn) {unshell(); return;}
  const t0 = performance.now();
  const { Manifold, parts, manis, rejected } = await manifoldParts(g);
  if (manis.length < 2) {return;} // a lone part has nothing to carve against
  g.updateWorldMatrix(true, true);
  let carved = 0, outT = 0;
  for (let i = 0; i < manis.length; i += 1) {
    const m = parts[i]!;
    const rest = Manifold.union(manis.filter((_, j): boolean => j !== i));
    const cut = manis[i].subtract(rest);
    rest.delete?.();
    const om = cut.getMesh();
    cut.delete?.();
    if (om.numVert === 0) {continue;} // fully buried part - keep it authored
    // Manifold works in group space; swap back into this mesh's local
    // frame so its own transform keeps applying.
    const geo = maniToGeo(om);
    geo.applyMatrix4(m.matrixWorld.clone().invert().multiply(g.matrixWorld));
    if (!shelled.has(m)) {shelled.set(m, m.geometry);}
    m.geometry = geo;
    outT += om.triVerts.length / 3;
carved += 1;
  }
  for (const mm of manis) {mm.delete?.();}
  if (carved === 0) {return;}
  shellOn = true;
  // Occluder is now the trimmed surface - union-quality AO on authored
  // parts. Rejected/non-manifold parts stay as-is in the merge.
  bakeVertexAO(g);
  console.log(`[shell] w${state.wt}: carved ${carved}/${manis.length} parts (${rejected} rejected) → ${outT}t, ${(performance.now() - t0).toFixed(0)}ms`);
}

// --- metal: procMetal A/B ---
// Swaps the active pick's Lambert bodies for the metalMat recipe -
// Lambert can't show specular, so this is the whole point of the toggle.
// Fresh Standard mats get the wear/grunge shader re-injected (that's
// what sells worn metal vs flat plastic). Stash + restore like shell.
let metalOn = false;
const metaled = new Map<THREE.Mesh, THREE.Material>();
const metalCache = new Map<THREE.Material, THREE.MeshStandardMaterial>();
function metalFor(src: THREE.Material): THREE.MeshStandardMaterial {
  let m = metalCache.get(src);
  if (!m) {
    const l = src as THREE.MeshLambertMaterial;
    m = metalMat(l.color?.getHex() ?? 0x3A_40_48);
    if (l.emissive) {m.emissive.copy(l.emissive);} // Lambert fakes ambient via emissive - carry it
    enhanceWeaponMaterial(m);
    metalCache.set(src, m);
  }
  return m;
}
function unmetal(): void {
  for (const [m, orig] of metaled) {m.material = orig;}
  metaled.clear();
  metalOn = false;
}
function metalToggle(): void {
  const g = archiveGroup ?? vm.weapons.get(state.wt);
  if (!g) {return;}
  if (metalOn) {unmetal(); return;}
  let n = 0;
  g.traverse((o): void => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m.material as THREE.Material).type !== 'MeshLambertMaterial') {return;}
    if (!metaled.has(m)) {metaled.set(m, m.material as THREE.Material);}
    m.material = metalFor(m.material as THREE.Material);
n += 1;
  });
  if (n === 0) {return;}
  metalOn = true;
}

// --- right rail: anim states, when the preview exposes a driver ----
// A preview parks `userData.anims = { set(state), dir?(f,side) }` - the
// classes lineup drives all three bodies in lockstep through it.
const animRail = document.getElementById('animrail')!;
const ANIM_STATES: AnimationState[] = ['idle', 'walk', 'run', 'jump', 'ski', 'jet', 'shoot', 'throw', 'hit', 'death'];
// Facing-frame (fwd, side) - same convention as PlayerModel.setLocomotionVector.
const DIR_BTNS: [label: string, v: [number, number]][] = [
  ['FL', [0.7, -0.7]], ['F', [1, 0]], ['FR', [0.7, 0.7]],
  ['L', [0, -1]], ['·', [0, 0]], ['R', [0, 1]],
  ['BL', [-0.7, -0.7]], ['B', [-1, 0]], ['BR', [-0.7, 0.7]],
];
interface AnimHook { set: (s: AnimationState) => void; dir?: (f: number, s: number) => void; weapon?: (wt: number) => void; team?: (t: string) => void; mark?: (t: string) => void; side?: (t: string) => void; gib?: (speed?: number) => void; gibJuicy?: (speed?: number) => void; ragdoll?: (speed?: number) => void; bind?: () => void }
let animSel: AnimationState | '' = '';
let bindHeld = false;

// Held-weapon picker - same builders the viewmodel rail uses (+ the
// chaingun's ballistic builder) so hand props match real silhouettes.
// heldWt persists across F5 - the lineup rebuilds every reload, so
// re-applying the saved pick is the only way it stays armed.
function mkWeaponSel(hook: AnimHook): HTMLSelectElement {
  const wsel = document.createElement('select');
  wsel.className = 'wsel';
  const wts = [...MODEL_BUILDERS.keys(), WeaponType.Chaingun].toSorted((a, b): number => a - b);
  for (const wt of wts) {
    const o = document.createElement('option');
    o.value = String(wt);
    o.textContent = WeaponType[wt] ?? String(wt);
    wsel.append(o);
  }
  if (state.heldWt != null && wts.includes(state.heldWt)) {wsel.value = String(state.heldWt);}
  hook.weapon!(Number(wsel.value));
  wsel.addEventListener('change', (): void => {
    state.heldWt = Number(wsel.value);
    saveState();
    hook.weapon!(state.heldWt);
  });
  return wsel;
}

// Team paint preview - neutral/red/blue, persisted like heldWt.
function mkTeamSel(hook: AnimHook): HTMLSelectElement {
  const tsel = document.createElement('select');
  tsel.className = 'wsel';
  for (const t of ['neutral', 'red', 'blue']) {
    const o = document.createElement('option');
    o.value = t; o.textContent = t;
    tsel.append(o);
  }
  if (state.heldTeam) {tsel.value = state.heldTeam;}
  hook.team!(tsel.value);
  tsel.addEventListener('change', (): void => {
    state.heldTeam = tsel.value;
    saveState();
    hook.team!(tsel.value);
  });
  return tsel;
}

// Enemy-mark overlay - outline hull / fresnel rim / both; independent of
// the team tint so they combine freely.
function mkMarkSel(hook: AnimHook): HTMLSelectElement {
  const msel = document.createElement('select');
  msel.className = 'wsel';
  for (const t of ['none', 'outline', 'rim', 'out+rim']) {
    const o = document.createElement('option');
    o.value = t; o.textContent = t;
    msel.append(o);
  }
  if (state.heldMark) {msel.value = state.heldMark;}
  hook.mark!(msel.value);
  msel.addEventListener('change', (): void => {
    state.heldMark = msel.value;
    saveState();
    hook.mark!(msel.value);
  });
  return msel;
}

// Mark color side - enemy scarlet / ally green / neutral white.
function mkSideSel(hook: AnimHook): HTMLSelectElement {
  const ssel = document.createElement('select');
  ssel.className = 'wsel';
  for (const t of ['enemy', 'ally', 'neutral']) {
    const o = document.createElement('option');
    o.value = t; o.textContent = t;
    ssel.append(o);
  }
  if (state.heldSide) {ssel.value = state.heldSide;}
  hook.side!(ssel.value);
  ssel.addEventListener('change', (): void => {
    state.heldSide = ssel.value;
    saveState();
    hook.side!(ssel.value);
  });
  return ssel;
}

function paintAnimRail(): void {
  animRail.innerHTML = '';
  const hook = archiveGroup?.userData.anims as AnimHook | undefined;
  if (!hook) {animRail.style.display = 'none'; return;}
  animRail.style.display = '';
  for (const s of ANIM_STATES) {
    const b = document.createElement('button');
    b.textContent = s;
    if (s === animSel) {b.classList.add('active');}
    b.addEventListener('click', (): void => { animSel = s; bindHeld = false; hook.set(s); paintAnimRail(); });
    animRail.append(b);
  }
  // Rest-pose button last - clears animSel, bones snap to the authored T.
  if (hook.bind) {
    const b = document.createElement('button');
    b.textContent = 'tpose';
    if (bindHeld) {b.classList.add('active');}
    b.addEventListener('click', (): void => { animSel = ''; bindHeld = true; hook.bind!(); paintAnimRail(); });
    animRail.append(b);
  }
  if (hook.weapon) {animRail.append(mkWeaponSel(hook));}
  if (hook.team) {animRail.append(mkTeamSel(hook));}
  if (hook.mark) {animRail.append(mkMarkSel(hook));}
  if (hook.side) {animRail.append(mkSideSel(hook));}
  appendScaleBtns(hook.gib, 'pulverize');
  appendScaleBtns(hook.gibJuicy, 'pulv juicy');
  if (hook.ragdoll) {
    const b = document.createElement('button');
    b.textContent = 'ragdoll';
    b.addEventListener('click', (): void => hook.ragdoll!());
    animRail.append(b);
  }
  if (hook.dir) {appendDirRow(hook);}
}

// Full-scale + 0.1x preview buttons for a scale-taking hook.
function appendScaleBtns(fn: ((s: number) => void) | undefined, base: string): void {
  if (!fn) {return;}
  for (const [label, s] of [[base, 1], [`${base} 0.1x`, 0.1]] as const) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', (): void => fn(s));
    animRail.append(b);
  }
}

function appendDirRow(hook: AnimHook): void {
  const drow = document.createElement('div');
  drow.className = 'dirrow';
  for (const [label, [f, s]] of DIR_BTNS) {
    const b = document.createElement('button');
    b.textContent = label;
    b.disabled = label === '·';
    b.addEventListener('click', (): void => hook.dir!(f, s));
    drow.append(b);
  }
  animRail.append(drow);
}

function select(wt: number): void {
  state.wt = wt;
  unshell(); // carved geos don't follow a weapon swap
  unmetal();
  if (archiveGroup) {
    (archiveGroup.userData.disposeCreature as (() => void) | undefined)?.();
    archiveGroup.parent?.remove(archiveGroup);
    if (inspectAnchor === archiveGroup) {inspectAnchor = null;}
    archiveGroup = null; archiveLabel = '';
    paintAnimRail(); // weapons expose no anim driver - rail hides
  }
  state.pick = undefined;
  vm.switchWeapon(wt);
  for (let i = 0; i < 60; i += 1) {vm.update(1 / 60, 0, 0, zeroVel, camera);} // skip the holster dip
  // Re-anchor whatever just became active - inspect mode follows the
  // pick; setInspect refits along the tracked inspectDir, so the view
  // angle survives the swap.
  if (state.inspect) { setInspect(false); setInspect(true); }
  if (zOverlay) {zPaint(true);} // flag the new pick - old overlay's tris are gone
  applyWire();
  paintRail();
  saveState();
}



function paintTools(): void {
  const tools = document.createElement('div');
  tools.className = 'tools';
  // FOV slider FIRST - it shapes the FPS view, which is what the lab is
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
  fovIn.addEventListener('input', (): void => {
    camera.fov = Number(fovIn.value);
    camera.updateProjectionMatrix();
    fovVal.textContent = `${fovIn.value}°`;
    state.fov = camera.fov;
    saveState();
  });
  // Right-click snaps back to the game's viewmodel FOV.
  fovIn.addEventListener('contextmenu', (e): void => {
    e.preventDefault();
    fovIn.value = '55';
    fovIn.dispatchEvent(new Event('input'));
  });
  fovWrap.append('fov ', fovIn, fovVal);
  tools.append(fovWrap);
  // Side-by-side button pairs - same visual as the rows, half the rail.
  const row = (labels: [label: string, fn: () => void][]): HTMLButtonElement[] => {
    const div = document.createElement('div');
    div.className = 'btnrow';
    const bs = labels.map(([label, fn]): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', fn);
      div.append(b);
      return b;
    });
    tools.append(div);
    return bs;
  };
  // Procedural is the default - ?bake opts INTO the GLB swap (vmBaked
  // reads the same flag). View+gun survive the reload via the saved pose.
  const baked = new URLSearchParams(window.location.search).has('bake');
  const [, bakeB] = row([
    [state.inspect ? '◈ FPS' : '◉ inspect', (): void => { setInspect(!state.inspect); paintRail(); }],
    ['▣ baked', (): void => {
      const u = new URL(window.location.href);
      if (baked) {u.searchParams.delete('bake');} else {u.searchParams.set('bake', '1');}
      flushSave();
      window.location.href = u.toString();
    }],
  ]);
  bakeB!.classList.toggle('active', baked);
  const [, zB] = row([
    ['▦ sheet', shotSheet],
    ['⚠ z', (): void => { zPaint(!zOverlay); state.z = Boolean(zOverlay); saveState(); paintRail(); }],
  ]);
  zB!.classList.toggle('active', Boolean(zOverlay));
  // Wear-mask debug - paints R=final wear / G=grime / B=edge flag instead
  // of shading. It's a shader define, so it needs a reload like ?bake.
  const wearViz = new URLSearchParams(window.location.search).has('wearviz');
  // union (rendered weld) and shell (per-part carve) share one row -
  // they're the same question asked two ways.
  const [unionB, shellB, metalB] = row([
    ['⛛ union', (): void => { unionToggle().then(paintRail).catch((): void => undefined); }],
    ['◨ shell', (): void => { shellToggle().then(paintRail).catch((): void => undefined); }],
    ['▤ metal', (): void => { metalToggle(); paintRail(); }],
  ]);
  unionB!.classList.toggle('active', unionOn);
  shellB!.classList.toggle('active', shellOn);
  metalB!.classList.toggle('active', metalOn);
  const [wireB, wearB] = row([
    ['▧ wire', (): void => { wireOn = !wireOn; applyWire(); paintRail(); }],
    ['◐ wearviz', (): void => {
      const u = new URL(window.location.href);
      if (wearViz) {u.searchParams.delete('wearviz');} else {u.searchParams.set('wearviz', '1');}
      flushSave();
      window.location.href = u.toString();
    }],
  ]);
  wireB!.classList.toggle('active', wireOn);
  wearB!.classList.toggle('active', wearViz);
  const [, statB] = row([
    ['ⓘ info', (): Promise<void> => infoDump()],
    ['▦ stat', (): void => toggleStats()],
    ['▣ src', (): Promise<void> => copyBuilderSrc()],
  ]);
  statB!.classList.toggle('active', statOn);
  row([
    ['▸ kick', (): void => vm.kick(1)],
    ['▸ punch', (): void => vm.punch(false)],
    ['▸ swing', (): void => vm.swing(false)],
    ['▸ throw', (): void => vm.startThrow()],
  ]);
  rail.append(tools);
}


async function copyBuilderSrc(): Promise<void> {
  const entry = MODEL_BUILDERS.find(([wt]): boolean => wt === state.wt);
  if (!entry) { flashStatus('no builder'); return; }
  const name = entry[1].name || 'mk?';
  const head = `export function ${name}`;
  for (const load of Object.values(GEO_SOURCES)) {
    const src = await load() as string;
    const at = src.indexOf(head);
    if (at === -1) {continue;}
    let depth = 0, end = at;
    for (let i = src.indexOf('{', at); i < src.length; i += 1) {
      if (src[i] === '{') {depth += 1;}
      else if (src[i] === '}' && (depth -= 1) === 0) { end = i + 1; break; }
    }
    // Grab the comment block above it too - the "why" matters.
    let start = at;
    const before = src.slice(0, at);
    const m = before.match(/(?:\n\s*\/\/[^\n]*)+\s*$|\n\/\*[\s\S]*?\*\/\s*$/);
    if (m) {start = m.index ?? at;}
    await navigator.clipboard?.writeText(src.slice(start, end).trimStart());
    flashStatus(`copied ${name}()`);
    return;
  }
  flashStatus(`${name} not found in sources`);
}


function shotSheet(): void {
  (window as unknown as { __sheetPNG?: string }).__sheetPNG = undefined;
  const wasInspect = state.inspect;
  const cell = 256; // 512² sheet total - vision tokens scale with pixels
  const comp = document.createElement('canvas');
  comp.width = cell * 2; comp.height = cell * 2;
  const g2 = comp.getContext('2d')!;
  const keepPos = camera.position.clone();
  const keepQuat = camera.quaternion.clone();
  const keepAspect = camera.aspect;
  const shot = (cx: number, cy: number, label: string): void => {
    renderer.render(scene, camera);
    g2.drawImage(renderer.domElement, cx * cell, cy * cell, cell, cell);
    g2.fillStyle = '#8f8';
    g2.font = '18px monospace';
    g2.textAlign = 'center';
    g2.fillText(label, cx * cell + cell / 2, cy * cell + 42);
  };
  // FPS cell first - weapon still in viewmodel pose, camera at the eye.
  // Keep the canvas's real aspect: squashing to square shrinks the
  // horizontal FOV and shoves REST_POS out to the corner - nothing like
  // the in-game frame. Center-crop the wide buffer into the cell instead.
  if (wasInspect) {setInspect(false);}
  camera.position.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);
  // A single update only lerps partway to REST_POS - settle the pose
  // like rebuild() does or the gun floats wherever inspect left it.
  for (let i = 0; i < 60; i += 1) {vm.update(1 / 60, 0, 0, zeroVel, camera);}
  renderer.render(scene, camera);
  {
    const buf = renderer.domElement;
    const crop = Math.min(buf.width, buf.height);
    // Right-anchored crop: REST_POS holds the gun on the right of the
    // frame - a centered crop clips it at the cell edge.
    g2.drawImage(buf, buf.width - crop, (buf.height - crop) / 2, crop, crop,
      cell, cell, cell, cell);
    g2.fillStyle = '#8f8';
    g2.font = '18px monospace';
    g2.textAlign = 'center';
    g2.fillText('fps', cell + cell / 2, cell + 42);
  }
  camera.aspect = 1;
  camera.updateProjectionMatrix();
  // External cells - park the weapon centered at origin like inspect does.
  setInspect(true);
  const box = new THREE.Box3().setFromObject(inspectAnchor!);
  // Fit the BOX (not its bounding sphere) inside the frustum: project the
  // 8 corners into camera space and pull back only until the widest
  // extent clears the cell - the sphere wastes ~40% of every cell on a
  // long thin gun. FPS cell is untouched (it mirrors the real view).
  const r = box.getSize(new THREE.Vector3()).length() / 2;
  const halfFov = THREE.MathUtils.degToRad(camera.fov) / 2;
  const tanHalf = Math.tan(halfFov);
  const corners: THREE.Vector3[] = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        corners.push(new THREE.Vector3(x, y, z));
      }
    }
  }
  const tgt = new THREE.Vector3();
  const keepUp = camera.up.clone();
  const corner = new THREE.Vector3();
  for (const [i, [label, v]] of Object.entries(shotDir).entries()) {
    if (v.up) {camera.up.copy(v.up);}
    camera.position.copy(tgt).addScaledVector(v.d, Math.max(r * 3, 0.3));
    camera.lookAt(tgt);
    camera.updateMatrixWorld();
    // Pull back until every corner's |x|,|y| <= depth * tan(fov/2) * 0.92
    // (the 8% margin keeps edges off the cell boundary).
    let pull = 0;
    for (const c of corners) {
      corner.copy(c).applyMatrix4(camera.matrixWorldInverse);
      const need = Math.max(Math.abs(corner.x), Math.abs(corner.y)) / (tanHalf * 0.92) + corner.z;
      if (need > pull) {pull = need;}
    }
    camera.position.copy(tgt).addScaledVector(v.d, Math.max(r * 3 + pull, 0.3));
    camera.lookAt(tgt);
    camera.up.copy(keepUp);
    shot(i % 2, Math.trunc((i / 2)), label);
  }
  // Restore whatever the user was doing.
  camera.aspect = keepAspect;
  camera.updateProjectionMatrix();
  camera.position.copy(keepPos);
  camera.quaternion.copy(keepQuat);
  if (!wasInspect) {setInspect(false);}
  // dataURL park for the /gunsheet middleware - it polls window for this
  // rather than scraping the canvas (toBlob is async either way).
  (window as unknown as { __sheetPNG?: string }).__sheetPNG = comp.toDataURL('image/png');
  comp.toBlob((b): void => {
    if (!b) {return;}
    // Clipboard for instant paste; /shot middleware drops the file in
    // client/shots/ so agents can read it without a download dance.
    const name = `w${state.wt}_sheet.png`;
    navigator.clipboard?.write?.([new ClipboardItem({ 'image/png': b })])
      .catch((): void => flashStatus('clipboard blocked - file still saved'));
    fetch(`/shot?name=${name}`, { method: 'POST', body: b });
  });
  flashStatus(`w${state.wt} sheet → clipboard + shots/`);
}



// 4-up reference sheet: side / top / front-¾ / first-person in one PNG.
// Each shot renders full-frame then gets blitted into a composite cell -
// the drawing buffer is only guaranteed valid within the same task, so
// every render+drawImage pair runs synchronously.
// cell layout - `up` pins the camera roll: without it lookAt rolls
// arbitrarily and "top" ends up tilted on two axes instead of one.
const shotDir: Record<string, { d: THREE.Vector3; up?: THREE.Vector3 }> = {
  side:  { d: new THREE.Vector3(1, 0.05, 0) },
  // up=-X puts the muzzle (-Z) to screen-right - same heading as the
  // side cell, just seen from above.
  top:   { d: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(-1, 0, 0) },
  front: { d: new THREE.Vector3(-0.55, 0.25, -0.78) }, // gunner-facing ¾
};

// Copy the active weapon's builder source - import.meta.glob pulls
// every .ts under viewmodel/ as raw text, so new builder files are
// picked up with zero wiring. fn.name survives bundling here because
// vite dev serves the modules unminified.
const GEO_SOURCES = import.meta.glob('./entities/viewmodel/*.ts', { query: '?raw', import: 'default' });

// Retired-model preview - archive builders spawn straight into
// vm.group so inspect/zcheck/gapcheck treat them like any weapon.
let archiveGroup: THREE.Group | null = null;
let archiveLabel = '';

// --- baked-asset watch: HEAD signatures on this weapon's bake files ---
const watched = new Map<string, string>();
async function pollBakes(): Promise<void> {
  const files = [
    `/weapons/w${state.wt}_baked.glb`,
    `/weapons/w${state.wt}_ao.webp`,
    `/weapons/w${state.wt}_ao.png`,
    `/weapons/w${state.wt}b_ao.webp`,
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
    } catch { /* dev-server blip - retry next tick */ }
  }
}
// Only armed under ?bake - procedural mode has no bake files to watch.
const pollTimer = new URLSearchParams(window.location.search).has('bake')
  ? setInterval(pollBakes, 1500)
  : 0;

// --- drag look (FPS pose sway). Inspect-mode dragging is owned by
// OrbitControls on the canvas - these listeners only feed the sway. ---
let dragging = false, lastX = 0, lastY = 0;
let lookDX = 0, lookDY = 0;
addEventListener('mousedown', (e: MouseEvent): void => {
  if ((e.target as HTMLElement).tagName === 'BUTTON') {return;}
  lastX = e.clientX; lastY = e.clientY;
  dragging = true;
});
addEventListener('mouseup', (): void => { dragging = false; });
addEventListener('keydown', (e: KeyboardEvent): void => {
  if (e.altKey && e.code === 'KeyQ') { e.preventDefault(); infoDump(false); return; }
  if (e.altKey && e.code === 'KeyW') { e.preventDefault(); infoDump(true); return; }
  if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
    e.preventDefault();
    const step = e.code === 'ArrowDown' ? 1 : -1;
    const table = CAT_TABLES[state.cat as keyof typeof CAT_TABLES] ?? null;
    if (table?.length) {
      const i = table.findIndex(([l]): boolean => l === archiveLabel);
      const next = table[(i + step + table.length) % table.length];
      selectArchive(next[0], next[1]);
      return;
    }
    const wts = [...MODEL_BUILDERS.map(([wt]) => wt), WeaponType.Chaingun].toSorted((a, b): number => a - b);
    if (wts.length > 0) {
      const i = wts.indexOf(state.wt);
      select(wts[(i + step + wts.length) % wts.length]);
    }
    return;
  }
  if (e.code !== 'Space' || e.repeat) {return;}
  e.preventDefault(); // page scroll
  setInspect(!state.inspect);
  paintRail();
});
addEventListener('mousemove', (e: MouseEvent): void => {
  lookDX = e.clientX - lastX; lookDY = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  if (state.inspect || !dragging) { lookDX = 0; lookDY = 0; }
});

// --- click-pick: copies a piece path so "delete piece X" feedback can
// name the exact mesh. Click = press+release with no drag; anything
// bigger counts as an orbit/pan gesture. ---
const raycaster = new THREE.Raycaster();
const pickNDC = new THREE.Vector2();
const pickFlashMat = new THREE.MeshBasicMaterial({ color: 0xFF_EE_66 });
// Surface dot: marks the exact raycast hit while the flash marks the mesh.
const pickDot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8),
  new THREE.MeshBasicMaterial({ color: 0xFF_FF_FF, depthTest: false }));
pickDot.visible = false;
pickDot.renderOrder = 999;
scene.add(pickDot);
let pickDotTimer: ReturnType<typeof setTimeout> | undefined = undefined;
let downX = 0, downY = 0;
addEventListener('mousedown', (e: MouseEvent): void => { downX = e.clientX; downY = e.clientY; });
function pickPiece(cx: number, cy: number): void {
  const root: THREE.Object3D = state.inspect && inspectAnchor ? inspectAnchor : vm.group;
  pickNDC.set((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pickNDC, camera);
  // Raycaster doesn't honor visible=false - skip hits inside a hidden
  // subtree (the non-active weapons parked invisible in vm.group).
  const hit = raycaster.intersectObject(root, true)
    .find((h): boolean => { for (let o: THREE.Object3D | null = h.object; o && o !== root.parent; o = o.parent) {if (!o.visible) {return false;}} return true; });
  if (!hit) {return;}
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
  // Part fingerprint: world-space bbox center + size - "the 0.05-wide box
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
  navigator.clipboard?.writeText(label);
  flashStatus(`copied: ${label}`);
  // Flash the picked mesh - the piece materials are SHARED across the
  // gun, so flash by swapping this mesh's material, not by mutating one.
  // A re-click during the window must not capture the flash mat as the
  // "original" - that would restore TO flash, i.e. permanent highlight.
  if (!mesh.isMesh) {return;}
  if (mesh.userData.flashTimer) {clearTimeout(mesh.userData.flashTimer as number);}
  if (mesh.material !== pickFlashMat) {mesh.userData.origMat = mesh.material;}
  mesh.material = pickFlashMat;
  mesh.userData.flashTimer = setTimeout((): void => {
    mesh.material = mesh.userData.origMat;
    mesh.userData.flashTimer = 0;
  }, 280);
  pickDot.position.copy(hit.point);
  pickDot.visible = true;
  clearTimeout(pickDotTimer);
  pickDotTimer = setTimeout((): void => { pickDot.visible = false; }, 700);
}


addEventListener('mouseup', (e: MouseEvent): void => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) {return;}
  if ((e.target as HTMLElement).tagName === 'BUTTON') {return;}
  pickPiece(e.clientX, e.clientY);
});
addEventListener('resize', (): void => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

paintRail();
lap('rail paint');
// Snapshot the saved pose FIRST - selectArchive/setInspect both end in
// saveState, which would write the refit camera over state.cam/tgt
// before the restore below could read them.
const savedCam = state.cam ? [...state.cam] : null;
const savedTgt = state.tgt ? [...state.tgt] : null;
// Restore the parked non-weapon pick (archive/creature/pickup).
if (state.pick) {
  const tables = [...ARCHIVE_BUILDERS, ...CREATURES, ...PICKUPS, ...CLASSES, ...STRUCTURES, ...ITEMS];
  const hit = tables.find(([l]): boolean => l === state.pick);
  if (hit) {selectArchive(hit[0], hit[1] as () => THREE.Group);}
  else {state.pick = undefined;}
}
// Restore the parked view - same gun, same angle, across reloads. Runs
// here, after every declaration, not beside the vm init (TDZ).
if (state.inspect) {
  setInspect(true);
  if (savedCam && savedTgt) {
    camera.position.fromArray(savedCam);
    orbit.target.fromArray(savedTgt);
    orbit.update();
    flashStatus(`restored w${state.wt} view`);
  } else {
    flashStatus(`restored w${state.wt} (default angle - no saved pose)`);
  }
}
if (state.z) {zPaint(true);} // remembered ⚠z - after inspect restore (TDZ)
lap(`restore pick=${state.pick ?? '-'} inspect=${Boolean(state.inspect)} z=${Boolean(state.z)}`);
// First painted frame ≈ interactive - module eval + init + first render.
requestAnimationFrame((): void => {
  const tti = performance.now().toFixed(0);
  console.log(`[gunlab] interactive: nav+${tti}ms${reloadGap === null ? '' : ` f5-total ${Date.now() - Number(localStorage.getItem('gunlab.unloadAt'))}ms`}`);
});
let last = performance.now();
// __lab.freeze parks the pose at REST - vm.update's envelopes would
// nudge it back off canonical by sub-mm, which resamples the
// world-position wear noise over the whole weapon (≈25dB drift).
let labFrozen = false;
renderer.setAnimationLoop((): void => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  // vm.update always ticks: inspect needs it too - kickAmount, the bow
  // draw envelope, barrel spins all live on the weapon group's children.
  if (!labFrozen) {vm.update(dt, lookDX * 0.002, lookDY * 0.002, zeroVel, camera);}
  if (state.inspect && inspectAnchor) {
    orbit.update(); // damping settles between frames - must tick
    // The anchor is parked in the scene outside vm.group, so the pose
    // delta (kick + throw/switch dips + sway) never reaches it - mirror
    // the full post-write delta so detached weapons do everything.
    const ip = inspectAnchor.userData.inspectPos as THREE.Vector3 | undefined;
    if (ip) {
      inspectAnchor.position.copy(ip).add(vm.poseDeltaPos);
      inspectAnchor.rotation.set(vm.poseDeltaRotX, 0, vm.poseDeltaRotZ);
    }
  }
  previewLive.tick?.(dt); // creature previews tick real species sim (aim/track)
  // Creature anchor: the live body crawls (it aims at the camera), so the
  // orbit target follows IT - the frame never loses the critter.
  const liveFocus = inspectAnchor?.userData.liveFocus as (() => THREE.Vector3) | undefined;
  if (liveFocus && state.inspect) {
    focus.copy(liveFocus()); focus.y += 0.5; // mid-body, not feet
    // Apply only the focus's frame DELTA - overwriting orbit.target
    // clobbered RMB pan (its edits live in target). A crawling creature
    // still drags the frame along; a static lineup pans normally.
    if (!liveFocusOn) {_lastFocus.copy(focus); liveFocusOn = true;}
    _camW.subVectors(focus, _lastFocus);
    orbit.target.add(_camW);
    camera.position.add(_camW);
    _lastFocus.copy(focus);
  } else {liveFocusOn = false;}
  lookDX = 0; lookDY = 0;
  if (statOn && now - statAt > 250) { statAt = now; updateStats(); }
  renderer.render(scene, camera);
});

// Deterministic-shot hook for the e2e gallery: advance the parked
// preview by FIXED dt steps (mixer/species/uTime all ride previewLive)
// then stop it - the pose freezes at a reproducible sim time regardless
// of wall-clock frame pacing. Optional anim-state sets first (lineups).
(window as any).__lab = {
  hasAnims: (): boolean => Boolean(inspectAnchor?.userData.anims),
  freeze: (animState?: string, steps = 90): void => {
    const a = inspectAnchor?.userData.anims as
      { set?(s: string): void; cur?(): string | undefined; bind?(): void } | undefined;
    if (animState !== 'bind' && animState && a?.set) {
      // set() no-ops when the state already matches - models then keep
      // their load-timing-determined pose phase and shots flake. Force
      // a different state first so the target restarts at action t=0.
      if (a.cur?.() === animState) {a.set('hit');}
      a.set(animState);
    }
    const t = previewLive.tick;
    if (t) {
      for (let i = 0; i < steps; i += 1) {t(1 / 60);}
      previewLive.tick = null;
    }
    if (animState === 'bind' && a?.bind) {
      // Authored T-pose - the only fully wall-clock-free pose a lineup
      // has (mixer crossfade phase still lands run-to-run otherwise).
      // Must run AFTER the ticks stop: m.update() would crossfade the
      // rig straight back to its current anim state.
      a.bind();
    }
    // Orbit damping settles over frames AFTER the fit - a shot taken
    // mid-settle lands on a slightly different camera pose every run
    // (whole-frame sub-pixel shift = uniform PSNR loss). Snap-frozen.
    orbit.enableDamping = false;
    orbit.update();
    // vm pose rides wall-clock envelopes (kick spring, dips) - poseDelta
    // is the measured offset from REST_POS, so subtracting it snaps the
    // weapon + its inspect anchor to the canonical rest pose exactly.
    (vm as unknown as { kickAmount?: number; kickVel?: number }).kickAmount = 0;
    (vm as unknown as { kickVel?: number }).kickVel = 0;
    vm.group.position.sub(vm.poseDeltaPos);
    vm.group.rotation.x -= vm.poseDeltaRotX;
    vm.group.rotation.z -= vm.poseDeltaRotZ;
    if (inspectAnchor) {
      const ip = inspectAnchor.userData.inspectPos as THREE.Vector3 | undefined;
      if (ip) {inspectAnchor.position.copy(ip);}
      inspectAnchor.rotation.set(0, 0, 0);
    }
    labFrozen = true;
  },
};

// HMR: a code edit re-imports this module - the fresh ViewModel above
// picks up the new geo builders, state survives on window. dispose()
// tears down THIS instance or every accept would stack renderers/pollers.
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose((): void => {
    renderer.setAnimationLoop(null);
    clearInterval(pollTimer);
    orbit.dispose();
    disposeVm(vm);
    renderer.domElement.remove();
    renderer.dispose();
  });
}
