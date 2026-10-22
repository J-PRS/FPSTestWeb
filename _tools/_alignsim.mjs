// Simulate alignHipYaw() from playerAnim.ts on a class GLB:
// canonical = modal 10-deg bucket of native (non-UAL_) clip hip yaws;
// each clip's delta = yaw0 - canonical; |delta|>=0.5rad gets fixed.
// Prints what the algorithm WOULD produce so we can see why it fails.
import * as THREE from '../client/node_modules/three/build/three.module.js';
import { GLTFLoader } from '../client/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '../client/node_modules/three/examples/jsm/libs/meshopt_decoder.module.js';
import { readFileSync } from 'node:fs';

globalThis.self = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:stub';

const f = process.argv[2] || 'class_scout.glb';
const dir = new URL('../client/public/assets/models/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const buf = readFileSync(dir + f);
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const gltf = await new Promise((res, rej) => loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
const model = gltf.scene;
const depthOf = (n) => { let d = 0; for (let p = n.parent; p && p !== model; p = p.parent) d++; return d; };
const q = new THREE.Quaternion(), fwd = new THREE.Vector3();
const yawOf = (tr) => { const v = tr.values; q.set(v[0], v[1], v[2], v[3]); fwd.set(0, 0, 1).applyQuaternion(q); return Math.atan2(fwd.x, fwd.z); };
const deg = r => (r * 180 / Math.PI).toFixed(0).padStart(5);

const rows = [];
for (const clip of gltf.animations) {
  let best = null, any = null;
  for (const tr of clip.tracks) {
    if (!tr.name.endsWith('.quaternion')) continue;
    const node = model.getObjectByName(tr.name.slice(0, -'.quaternion'.length));
    if (!node) continue;
    if (node.isBone && (!best || depthOf(node) < depthOf(best.node))) best = { tr, node };
    if (!any || depthOf(node) < depthOf(any.node)) any = { tr, node };
  }
  const hit = best ?? any;
  if (hit) rows.push({ name: clip.name, node: hit.node.name, y: yawOf(hit.tr) });
}

// canonical — natives only (no UAL_ on this rig) — 10deg buckets
const buckets = new Map();
for (const r of rows) {
  const k = Math.round(r.y / (Math.PI / 18));
  const b = buckets.get(k) ?? { sum: 0, n: 0 };
  b.sum += r.y; b.n += 1; buckets.set(k, b);
}
let bestB = { sum: 0, n: 0 }, bestK = 0;
for (const [k, b] of buckets) if (b.n > bestB.n) { bestB = b; bestK = k; }
const canonical = bestB.sum / bestB.n;
console.log(`${f}: canonical=${deg(canonical)} (bucket k=${bestK}, n=${bestB.n} of ${rows.length})`);

// what would get "fixed"
for (const r of rows) {
  let d = r.y - canonical;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const tag = Math.abs(d) < 0.5 ? 'keep' : 'FIX ';
  console.log(`  ${tag} ${r.name.padEnd(22)} ${r.node.padEnd(8)} yaw0=${deg(r.y)} delta=${deg(d)} -> ${deg(r.y - d)}`);
}
