// modeldump - bake the runtime merged+AO'd atlas geometry to GLB.
// Driven by _tools/bake_atlas.ts: each class variant's PlayerModel loads
// (the live mergeAtlasParts + bakeVertexAO path runs for real), the
// cached merged geometry is exported with its baked vertex attrs, and
// the driver writes it to public/assets/models/<variant>_atlas.glb.
// Runtime mergeAtlasParts prefers that file → the 4-5s raycast bake
// never runs at boot.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { UVUnwrapper } from 'xatlas-three';
import { PlayerModel } from './entities/PlayerModel.js';
import { CLASS_BODY_VARIANT } from './entities/playerClips.js';

// Real unwrap for the AO bake: xatlas welds shared verts (unlike per-tri
// cell UVs), so the uv'd geometry dedupes AND the bake map can bilinear-
// filter. Offline tool only - wasm path never ships.
/** Weld verts identical in position+skinIndex+skinWeight - keeps the
 *  first copy's full attribute set (aedge corners differ across tris,
 *  so attr-hash welds can't see the duplicates at all). */
function weldByPosSkin(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const ji = geo.getAttribute('skinIndex'), jw = geo.getAttribute('skinWeight');
  const keyOf = (i: number): string =>
    `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}|` +
    `${ji?.getX(i)},${ji?.getY(i)},${ji?.getZ(i)},${ji?.getW(i)}|${jw?.getX(i)},${jw?.getY(i)},${jw?.getZ(i)},${jw?.getW(i)}`;
  const map = new Map<string, number>();
  const remap = new Uint32Array(pos.count);
  const order: number[] = [];
  for (let i = 0; i < pos.count; i += 1) {
    const k = keyOf(i);
    const hit = map.get(k);
    if (hit === undefined) {map.set(k, order.length); remap[i] = order.length; order.push(i);}
    else {remap[i] = hit;}
  }
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) {
    const a = attr as THREE.BufferAttribute;
    const arr = new (a.array.constructor as new (n: number) => typeof a.array)(order.length * a.itemSize);
    for (let i = 0; i < order.length; i += 1) {arr.set(a.array.slice(order[i]! * a.itemSize, order[i]! * a.itemSize + a.itemSize), i * a.itemSize);}
    out.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
  }
  out.setIndex(new THREE.BufferAttribute(remap, 1));
  out.userData = { ...geo.userData };
  return out;
}

const unwrapper = new UVUnwrapper({ BufferAttribute: THREE.BufferAttribute });
await unwrapper.loadLibrary(
  (mode: string, progress: number): void => console.log('xatlas', mode, progress),
  `${location.origin}/node_modules/xatlasjs/dist/xatlas.wasm`,
  `${location.origin}/node_modules/xatlasjs/dist/xatlas.js`,
);
unwrapper.chartOptions = { ...unwrapper.chartOptions, normalSeamWeight: 4 };
unwrapper.packOptions = { ...unwrapper.packOptions, resolution: 1024, padding: 8, texelsPerUnit: 0 };
const aoOut: Record<string, string> = {};

// ?atlasdump=1 marks this page as the bake source - PlayerModel skips
// prefetchAtlas here or a rebake would round-trip the previous file.
const scene = new THREE.Scene();
const variants = [...new Set(Object.values(CLASS_BODY_VARIANT))];

const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
const exporter = new GLTFExporter();
// One Group, one mesh per variant - a single exported GLB carries all
// baked atlases (one fetch, shared buffers, single compression stream).
const atlasRoot = new THREE.Group();

for (const variant of variants) {
  const m = new PlayerModel(scene, variant as 'scout' | 'brawler' | 'brute');
  await m.load();
  const atlasMesh = m.model?.getObjectByName('atlas-body') as THREE.Mesh | undefined;
  const merged = atlasMesh?.geometry as THREE.BufferGeometry | undefined;
  if (merged) {
    // authColor/tintMask ride geometry.userData at runtime, which glTF
    // drops - stash them as attributes so the bake round-trips them.
    const auth = merged.userData.authColor as Float32Array | undefined;
    const mask = merged.userData.tintMask as Float32Array | undefined;
    if (auth) {merged.setAttribute('auth', new THREE.BufferAttribute(auth, 3));}
    if (mask) {merged.setAttribute('tint', new THREE.BufferAttribute(mask, 1));}
    // Derivable attrs don't ship - abary is the canonical corner pattern,
    // aalt is per-tri altitude, awear is a constant fill; prefetchAtlas
    // rebuilds all three in ~ms from position alone. aedge stays (it's
    // the actual sharp-edge analysis - the bake, not a derivation).
    for (const a of ['abary', 'aalt', 'awear']) {merged.deleteAttribute(a);}
    // mergeVertices can't dedupe - aedge is per-corner data, so copies
    // of the same vertex differ per-tri and never hash equal. Weld on
    // position+skin only: the first copy's full attr set survives; the
    // edge flag is vertex-level data that tolerates the share.
    const welded = weldByPosSkin(merged);
    await unwrapper.packAtlas([welded], 'uv', 'uv');
    // Two channel-packed webps carry every bake attr: _ao = RGB color +
    // A wear; _fx = R grime + G aedge-flag (sharp-flag OR'd across the
    // tri's corner rows into the texel) + B tint mask. Geometry then
    // ships pos/norm/uv/skin only.
    const wear = welded.getAttribute('wear') as THREE.BufferAttribute | undefined;
    const grime = welded.getAttribute('grime') as THREE.BufferAttribute | undefined;
    const aedge = welded.getAttribute('aedge') as THREE.BufferAttribute | undefined;
    // Rasterize the 'color' attr (AO-modulated albedo) into the unwrap:
    // barycentric interp per texel inside each tri. Ship as ao.webp;
    // material.map carries it, so 'color' leaves the vertex payload.
    const uv = welded.getAttribute('uv') as THREE.BufferAttribute;
    const col = welded.getAttribute('color') as THREE.BufferAttribute;
    const idx = welded.getIndex()!;
    const SIZE = 1024;
    const img = new ImageData(SIZE, SIZE);
    const tri = { a: new THREE.Vector2(), b: new THREE.Vector2(), c: new THREE.Vector2() };
    const ca = new THREE.Color(), cb = new THREE.Color(), cc = new THREE.Color();
    for (let t = 0; t < idx.count / 3; t += 1) {
      const v = [idx.getX(t * 3), idx.getX(t * 3 + 1), idx.getX(t * 3 + 2)];
      tri.a.set(uv.getX(v[0]!) * SIZE, uv.getY(v[0]!) * SIZE);
      tri.b.set(uv.getX(v[1]!) * SIZE, uv.getY(v[1]!) * SIZE);
      tri.c.set(uv.getX(v[2]!) * SIZE, uv.getY(v[2]!) * SIZE);
      ca.fromBufferAttribute(col, v[0]!); cb.fromBufferAttribute(col, v[1]!); cc.fromBufferAttribute(col, v[2]!);
      const x0 = Math.floor(Math.min(tri.a.x, tri.b.x, tri.c.x)), x1 = Math.ceil(Math.max(tri.a.x, tri.b.x, tri.c.x));
      const y0 = Math.floor(Math.min(tri.a.y, tri.b.y, tri.c.y)), y1 = Math.ceil(Math.max(tri.a.y, tri.b.y, tri.c.y));
      const d = (tri.b.y - tri.c.y) * (tri.a.x - tri.c.x) + (tri.c.x - tri.b.x) * (tri.a.y - tri.c.y);
      if (Math.abs(d) < 1e-9) {continue;}
      for (let y = Math.max(0, y0); y <= Math.min(SIZE - 1, y1); y += 1) {
        for (let x = Math.max(0, x0); x <= Math.min(SIZE - 1, x1); x += 1) {
          const w0 = ((tri.b.y - tri.c.y) * (x - tri.c.x) + (tri.c.x - tri.b.x) * (y - tri.c.y)) / d;
          const w1 = ((tri.c.y - tri.a.y) * (x - tri.c.x) + (tri.a.x - tri.c.x) * (y - tri.c.y)) / d;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) {continue;}
          const p = (y * SIZE + x) * 4;
          img.data[p] = Math.min(255, Math.round((ca.r * w0 + cb.r * w1 + cc.r * w2) * 255));
          img.data[p + 1] = Math.min(255, Math.round((ca.g * w0 + cb.g * w1 + cc.g * w2) * 255));
          img.data[p + 2] = Math.min(255, Math.round((ca.b * w0 + cb.b * w1 + cc.b * w2) * 255));
          img.data[p + 3] = wear ? Math.min(255, Math.round((wear.getX(v[0]!) * w0 + wear.getX(v[1]!) * w1 + wear.getX(v[2]!) * w2) * 255)) : 255;
        }
      }
    }
    const cnv = document.createElement('canvas');
    cnv.width = cnv.height = SIZE;
    cnv.getContext('2d')!.putImageData(img, 0, 0);
    aoOut[variant] = cnv.toDataURL('image/webp', 0.9);
    // _fx pass: grime / aedge / tint channels over the same uv tris.
    const tint = (welded.userData.tintMask ?? merged.userData.tintMask) as Float32Array | undefined;
    const fx = new ImageData(SIZE, SIZE);
    for (let t = 0; t < idx.count / 3; t += 1) {
      const v = [idx.getX(t * 3), idx.getX(t * 3 + 1), idx.getX(t * 3 + 2)];
      tri.a.set(uv.getX(v[0]!) * SIZE, uv.getY(v[0]!) * SIZE);
      tri.b.set(uv.getX(v[1]!) * SIZE, uv.getY(v[1]!) * SIZE);
      tri.c.set(uv.getX(v[2]!) * SIZE, uv.getY(v[2]!) * SIZE);
      const x0 = Math.floor(Math.min(tri.a.x, tri.b.x, tri.c.x)), x1 = Math.ceil(Math.max(tri.a.x, tri.b.x, tri.c.x));
      const y0 = Math.floor(Math.min(tri.a.y, tri.b.y, tri.c.y)), y1 = Math.ceil(Math.max(tri.a.y, tri.b.y, tri.c.y));
      const d = (tri.b.y - tri.c.y) * (tri.a.x - tri.c.x) + (tri.c.x - tri.b.x) * (tri.a.y - tri.c.y);
      if (Math.abs(d) < 1e-9) {continue;}
      for (let y = Math.max(0, y0); y <= Math.min(SIZE - 1, y1); y += 1) {
        for (let x = Math.max(0, x0); x <= Math.min(SIZE - 1, x1); x += 1) {
          const w0 = ((tri.b.y - tri.c.y) * (x - tri.c.x) + (tri.c.x - tri.b.x) * (y - tri.c.y)) / d;
          const w1 = ((tri.c.y - tri.a.y) * (x - tri.c.x) + (tri.a.x - tri.c.x) * (y - tri.c.y)) / d;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) {continue;}
          const p = (y * SIZE + x) * 4;
          fx.data[p] = grime ? Math.round((grime.getX(v[0]!) * w0 + grime.getX(v[1]!) * w1 + grime.getX(v[2]!) * w2) * 255) : 0;
          fx.data[p + 1] = aedge ? Math.min(255, Math.round((aedge.getX(v[0]!) * w0 + aedge.getX(v[1]!) * w1 + aedge.getX(v[2]!) * w2) * 255)) : 0;
          fx.data[p + 2] = tint ? Math.round((tint[v[0]!] * w0 + tint[v[1]!] * w1 + tint[v[2]!] * w2) * 255) : 0;
          fx.data[p + 3] = 255;
        }
      }
    }
    const cnv2 = document.createElement('canvas');
    cnv2.width = cnv2.height = SIZE;
    cnv2.getContext('2d')!.putImageData(fx, 0, 0);
    aoOut[`${variant}_fx`] = cnv2.toDataURL('image/webp', 0.9);
    // Attrs moved to textures - strip them from the vertex payload.
    for (const a of ['color', 'wear', 'grime', 'aedge']) {welded.deleteAttribute(a);}
    const node = new THREE.SkinnedMesh(welded, new THREE.MeshLambertMaterial());
    node.name = variant;
    atlasRoot.add(node);
    merged.deleteAttribute('auth');
    merged.deleteAttribute('tint');
  }
  m.dispose();
}

const glb: ArrayBuffer = await new Promise((res, rej): void =>
  exporter.parse(atlasRoot, (r): void => res(r as ArrayBuffer), rej, { binary: true }));
let bin = '';
for (const b of new Uint8Array(glb)) {bin += String.fromCharCode(b);}
const out = { players: btoa(bin) };

(window as unknown as { __glb: Record<string, string> }).__glb = out;
(window as unknown as { __ao: Record<string, string> }).__ao = aoOut;
(window as unknown as { __ready: boolean }).__ready = true;
