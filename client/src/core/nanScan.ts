import * as THREE from 'three';
import { Logger } from './Logger.js';
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
      if ((bad += 1) >= maxBad) {break;}
    }
  }
  hit.count = bad;
  return bad;
}

// Scale is the hole NaN scans don't see: a bone or model root blown to
// ×50 keeps every value finite AND every bone within visAudit's 60m
// spread — while its skinned verts smear across the whole sky. Column
// lengths of the upper 3×3 give world scale; >8 is never a legit rig.
function scanScale(el: ArrayLike<number>, hit: Hit, limit = 8): number {
  const m = Math.max(
    Math.hypot(el[0]!, el[1]!, el[2]!),
    Math.hypot(el[4]!, el[5]!, el[6]!),
    Math.hypot(el[8]!, el[9]!, el[10]!),
  );
  if (!(m > limit)) {return 0;}
  hit.index = -1; hit.value = m; hit.count = 1;
  return 1;
}

// Per-bone scale + translation — one inflated or flung bone stretches its
// verts across the sky while staying finite (under scanHuge's 1e5) and
// inside visAudit's 60m bone-POSITION spread. Translations bind-space —
// cm-authored rigs legitimately sit ~100 units off, so flag only >2km.
function scanBoneScale(bones: Float32Array, base: Hit, hits: Hit[]): void {
  for (let b = 0; b + 16 <= bones.length; b += 16) {
    const hs = Object.assign({}, base, {attr: 'boneScale', index: b / 16});
    if (scanScale(bones.subarray(b, b + 16), hs)) {hits.push(hs); break;}
    const m = Math.hypot(bones[b + 12]!, bones[b + 13]!, bones[b + 14]!);
    if (m > 2000) {
      hits.push(Object.assign({}, base, {attr: 'boneOffset', index: b / 16, value: m, count: 1}));
      break;
    }
  }
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
  while (p && ((hops += 1) - 1) < 3) { if (p.name) {bits.push(`<"${p.name}"`);} p = p.parent; }
  return bits.join(' ');
}

// Instanced matrices + skinned bones — shared by the full-buffer scan and
// the per-frame transform scan (a one-frame NaN bone/matrix is the exact
// transient that covers the screen then recomputes clean).
function scanInstAndBones(o: THREE.Object3D, base: Hit, hits: Hit[]): void {
  const inst = o as THREE.InstancedMesh;
  if (inst.isInstancedMesh && inst.instanceMatrix) {
    const h = Object.assign({}, base, {attr: 'instanceMatrix'});
    if (scanArray(inst.instanceMatrix.array, h)) {hits.push(h);}
    const hugeM = Object.assign({}, base, {attr: 'instanceMatrixHuge'});
    if (scanHuge(inst.instanceMatrix.array, hugeM)) {hits.push(hugeM);}
  }

  // Only flag NON-FINITE spheres — a big finite radius is legit (sky domes
  // and starfields are deliberately huge) and doesn't rasterize anything.
  const bs = (o as THREE.Mesh).geometry?.boundingSphere;
  if (bs && (!Number.isFinite(bs.radius) || !Number.isFinite(bs.center.x))) {
    const h = Object.assign({}, base, {attr: 'boundingSphere',index: -1,value: bs.radius,count: 1});
    hits.push(h);
  }

  const sk = o as THREE.SkinnedMesh;
  const bones = sk.isSkinnedMesh ? sk.skeleton?.boneMatrices : null;
  if (bones) {
    const h = Object.assign({}, base, {attr: 'boneMatrices'});
    if (scanArray(bones, h)) {hits.push(h);}
    const hugeB = Object.assign({}, base, {attr: 'boneMatricesHuge'});
    if (scanHuge(bones, hugeB)) {hits.push(hugeB);}
    scanBoneScale(bones, base, hits);
  }
}



function scanMesh(o: THREE.Object3D, hits: Hit[]): void {
  const base: Hit = { name: label(o), kind: o.type, attr: '', index: -1, value: 0, count: 0 };
  const mesh = o as THREE.Mesh;
  if (!mesh.geometry) {return;}
  const geo = mesh.geometry;

  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (pos) {
    const h = Object.assign({}, base, {attr: 'position'});
    if (scanArray(pos.array, h)) {hits.push(h);}
    const huge = Object.assign({}, base, {attr: 'positionHuge'});
    if (scanHuge(pos.array, huge)) {hits.push(huge);}
  }

  scanInstAndBones(o, base, hits);

  // InstancedBufferAttributes other than position (ribbon cols, opacity,
  // quarks particle data all live in custom attributes)
  for (const [name, attr] of Object.entries(geo.attributes)) {
    if (name === 'position' || name === 'normal' || name === 'uv') {continue;}
    const h = Object.assign({}, base, {attr: name});
    if (scanArray((attr as THREE.BufferAttribute).array, h)) {hits.push(h);}
  }
}

export function nanScanScene(scene: THREE.Scene): Hit[] {
  const hits: Hit[] = [];
  scene.traverse((o): void => {
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
const isDynAttr = (a: unknown): boolean =>
  (a as THREE.BufferAttribute).usage === THREE.DynamicDrawUsage
  || (a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute === true;

export function nanScanTransforms(scene: THREE.Scene): Hit[] {
  const hits: Hit[] = [];
  scene.traverse((o): void => {
    const base: Hit = { name: label(o), kind: o.type, attr: '', index: -1, value: 0, count: 0 };
    const mw = Object.assign({}, base, {attr: 'matrixWorld'});
    if (scanArray(o.matrixWorld.elements, mw)) {hits.push(mw);}
    const mwScale = Object.assign({}, base, {attr: 'matrixWorldScale'});
    if (scanScale(o.matrixWorld.elements, mwScale)) {hits.push(mwScale);}
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
        const h = Object.assign({}, base, {attr: `${name}(dyn)`});
        if (scanArray(arr, h)) {hits.push(h);}
        const huge = Object.assign({}, base, {attr: `${name}Huge(dyn)`});
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
      const h = Object.assign({}, base, {attr});
      if (scanArray((camera[attr] as THREE.Matrix4).elements, h)) {report(h);}
    }
  }
  for (const h of nanScanTransforms(scene)) {report(h);}
  if ((tick += 1) % EVERY === 0) {
    for (const h of nanScanScene(scene)) {report(h);}
  }
}

// Raycast probe: B key logs what the crosshair covers — a persistent
// black region means a REAL object is rendering black (fragment-NaN
// material or unlit mesh), so name it instead of hunting buffers that
// stay clean. Shares the Alt+Q aim probe: tagged FX objects report their
// owner/slot/pool identity, not just mesh type.
export function nanScanBindProbe(getCtx: () => { scene: THREE.Scene; camera: THREE.Camera }): void {
  window.addEventListener('keydown', (e): void => {
    if (e.code !== 'KeyB') {return;}
    const { scene, camera } = getCtx();
    const rows = aimProbe(scene, camera);
    Logger.warn(`[nanprobe] ${  rows.join(' | ') || 'no hits'}`);
  });
}


