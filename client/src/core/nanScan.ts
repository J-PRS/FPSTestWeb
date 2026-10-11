import * as THREE from 'three';
import Logger from './Logger.js';
import { aimProbe } from './aimProbe.js';

// "Black frame" hunter: a single non-finite vertex position rasterizes as a
// screen-covering triangle (undefined per GL spec — drivers stretch rather
// than cull), which reads as a fullscreen black flash. Scans dynamic position
// and instance-matrix attributes for NaN/Inf and reports the owning mesh.

interface Hit {
  name: string;
  kind: string;
  attr: string;
  index: number;
  value: number;
  count: number;
}

function scanArray(arr: ArrayLike<number>, hit: Hit, maxBad = 4): number {
  let bad = 0;
  for (let i = 0; i < arr.length; i += 1) {
    const v = arr[i]!;
    if (!Number.isFinite(v)) {
      if (bad === 0) { hit.index = i; hit.value = v; }
bad += 1;
      if (bad >= maxBad) {break;}
    }
  }
  hit.count = bad;
  return bad;
}

// A finite-but-absurd vertex draws the same screen-covering triangle as a
// NaN — scan |v|>1e5 too (gameplay coords stay within a few km).
function scanHuge(arr: ArrayLike<number>, hit: Hit, maxBad = 4): number {
  let bad = 0;
  for (let i = 0; i < arr.length; i += 1) {
    const v = arr[i]!;
    if (Number.isFinite(v) && Math.abs(v) > 1e5) {
      if (bad === 0) { hit.index = i; hit.value = v; }
      if (++bad >= maxBad) {break;}
    }
  }
  hit.count = bad;
  return bad;
}

function label(o: THREE.Object3D): string {
  const bits = [o.type];
  if (o.name) {bits.push(`"${o.name}"`);}
  const mesh = o as THREE.Mesh;
  if (mesh.geometry) {
    bits.push(`verts:${mesh.geometry.getAttribute('position')?.count ?? '?'}`);
    const mat = mesh.material as THREE.Material | undefined;
    if (mat) {bits.push(`mat:${mat.type}${mat.name ? ` "${mat.name}"` : ''}`);}
  }
  const wp = new THREE.Vector3();
  o.getWorldPosition(wp);
  bits.push(`@(${Math.round(wp.x)},${Math.round(wp.y)},${Math.round(wp.z)})`);
  let p = o.parent;
  let hops = 0;
  while (p && hops++ < 3) { if (p.name) {bits.push(`<"${p.name}"`);} p = p.parent; }
  return bits.join(' ');
}

function scanMesh(o: THREE.Object3D, hits: Hit[]): void {
  const base: Hit = { name: label(o), kind: o.type, attr: '', index: -1, value: 0, count: 0 };
  const mesh = o as THREE.Mesh;
  if (!mesh.geometry) {return;}
  const geo = mesh.geometry;

  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (pos) {
    const h = { ...base, attr: 'position'};
    if (scanArray(pos.array, h)) {hits.push(h);}
    const huge = { ...base, attr: 'positionHuge'};
    if (scanHuge(pos.array, huge)) {hits.push(huge);}
  }

  scanInstAndBones(o, base, hits);

  // InstancedBufferAttributes other than position (ribbon cols, opacity,
  // quarks particle data all live in custom attributes)
  for (const [name, attr] of Object.entries(geo.attributes)) {
    if (name === 'position' || name === 'normal' || name === 'uv') {continue;}
    const h = { ...base, attr: name};
    if (scanArray((attr as THREE.BufferAttribute).array, h)) {hits.push(h);}
  }
}

// Instanced matrices + skinned bones — shared by the full-buffer scan and
// the per-frame transform scan (a one-frame NaN bone/matrix is the exact
// transient that covers the screen then recomputes clean).
function scanInstAndBones(o: THREE.Object3D, base: Hit, hits: Hit[]): void {
  const inst = o as THREE.InstancedMesh;
  if (inst.isInstancedMesh && inst.instanceMatrix) {
    const h = { ...base, attr: 'instanceMatrix'};
    if (scanArray(inst.instanceMatrix.array, h)) {hits.push(h);}
    const hugeM = { ...base, attr: 'instanceMatrixHuge'};
    if (scanHuge(inst.instanceMatrix.array, hugeM)) {hits.push(hugeM);}
  }

  // Only flag NON-FINITE spheres — a big finite radius is legit (sky domes
  // and starfields are deliberately huge) and doesn't rasterize anything.
  const bs = (o as THREE.Mesh).geometry?.boundingSphere;
  if (bs && (!Number.isFinite(bs.radius) || !Number.isFinite(bs.center.x))) {
    const h = { ...base, attr: 'boundingSphere',index: -1,value: bs.radius,count: 1};
    hits.push(h);
  }

  const sk = o as THREE.SkinnedMesh;
  const bones = sk.isSkinnedMesh ? sk.skeleton?.boneMatrices : null;
  if (bones) {
    const h = { ...base, attr: 'boneMatrices'};
    if (scanArray(bones, h)) {hits.push(h);}
    const hugeB = { ...base, attr: 'boneMatricesHuge'};
    if (scanHuge(bones, hugeB)) {hits.push(hugeB);}
  }
}

export function nanScanScene(scene: THREE.Scene): Hit[] {
  const hits: Hit[] = [];
  scene.traverse((o) => {
    // matrixWorld NaN: the attribute buffers stay clean — the GPU-side
    // NaN only appears after modelViewMatrix × position. Same triangle.
    const h: Hit = { name: label(o), kind: o.type, attr: 'matrixWorld', index: -1, value: 0, count: 0 };
    if (scanArray(o.matrixWorld.elements, h)) {hits.push(h);}
    scanMesh(o, hits);
  });
  return hits;
}

// Transforms are the transient case: a matrixWorld/instanceMatrix/bone
// matrix that goes NaN for exactly one frame draws the covering triangle,
// then recomputes clean — a scan every N frames would always miss it.
// Those arrays are tiny (matrices, not vertex buffers), so scan every frame.
const isDynAttr = (a: unknown) =>
  (a as THREE.BufferAttribute).usage === THREE.DynamicDrawUsage
  || (a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute === true;

export function nanScanTransforms(scene: THREE.Scene): Hit[] {
  const hits: Hit[] = [];
  scene.traverse((o) => {
    const base: Hit = { name: label(o), kind: o.type, attr: '', index: -1, value: 0, count: 0 };
    const mw = { ...base, attr: 'matrixWorld'};
    if (scanArray(o.matrixWorld.elements, mw)) {hits.push(mw);}
    scanInstAndBones(o, base, hits);

    // Dynamic buffers (quarks batcher, ribbons, arc lines) are rewritten
    // per frame — a NaN only lives until its particle dies, so the periodic
    // scene scan misses it. Batched particle quads are the normal-blended
    // suspects for the screen-covering black puff. Quarks keeps particle
    // data in instanced attributes, so scan ALL attrs of dynamic geos.
    const geo = (o as THREE.Mesh).geometry;
    if (geo && Object.values(geo.attributes).some(isDynAttr)) {
      for (const [name, attr] of Object.entries(geo.attributes)) {
        const arr = (attr as THREE.BufferAttribute).array;
        if (!arr) {continue;}
        const h = { ...base, attr: `${name}(dyn)`};
        if (scanArray(arr, h)) {hits.push(h);}
        const huge = { ...base, attr: `${name}Huge(dyn)`};
        if (scanHuge(arr, huge)) {hits.push(huge);}
      }
    }
  });
  return hits;
}

// Vertex buffers are the big arrays — those only get scanned every Nth
// frame (a persistent bad vertex persists across frames anyway).
const EVERY = 8;
let tick = 0;
const seen = new Set<string>();

function report(h: Hit): void {
  const key = `${h.kind}:${h.attr}:${h.name}`;
  if (seen.has(key)) {return;} // spam guard — first sighting per buffer only
  seen.add(key);
  Logger.warn(
    `[nanscan] BAD ${h.attr} @${h.index}=${h.value} (${h.count}+ non-finite) on ${h.name}`,
  );
}

export function nanScanTick(scene: THREE.Scene, camera?: THREE.Camera): void {
  // The camera isn't a scene child — traverse would never reach it, and a
  // one-frame NaN projection/view matrix blanks the whole world pass while
  // the DOM HUD and viewmodel pass survive: exactly the reported artifact.
  if (camera) {
    const base: Hit = { name: 'camera', kind: camera.type, attr: '', index: -1, value: 0, count: 0 };
    for (const attr of ['matrixWorld', 'projectionMatrix', 'projectionMatrixInverse'] as const) {
      const h = { ...base, attr};
      if (scanArray((camera[attr] as THREE.Matrix4).elements, h)) {report(h);}
    }
  }
  for (const h of nanScanTransforms(scene)) {report(h);}
  if (++tick % EVERY === 0) {
    for (const h of nanScanScene(scene)) {report(h);}
  }
}

// Raycast probe: B key logs what the crosshair covers — a persistent
// black region means a REAL object is rendering black (fragment-NaN
// material or unlit mesh), so name it instead of hunting buffers that
// stay clean. Shares the Alt+Q aim probe: tagged FX objects report their
// owner/slot/pool identity, not just mesh type.
export function nanScanBindProbe(getCtx: () => { scene: THREE.Scene; camera: THREE.Camera }): void {
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyB') {return;}
    const { scene, camera } = getCtx();
    const rows = aimProbe(scene, camera);
    Logger.warn(`[nanprobe] ${  rows.join(' | ') || 'no hits'}`);
  });
}


