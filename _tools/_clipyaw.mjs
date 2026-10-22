// Dump frame-0 hip-bone yaw per animation clip in each class GLB.
// Mirrors playerAnim.ts hipTrackOf/yawOf: shallowest bone with a
// quaternion track, forward = +Z of that quat, yaw = atan2(x,z).
import * as THREE from '../client/node_modules/three/build/three.module.js';
import { GLTFLoader } from '../client/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '../client/node_modules/three/examples/jsm/libs/meshopt_decoder.module.js';
import { readFileSync } from 'node:fs';

// Node shims for GLTFLoader's browser-only texture path — we only need
// scene graph + clips, textures just need to not throw.
globalThis.self = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:stub';
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};

const dir = new URL('../client/public/assets/models/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const files = process.argv.slice(2);
if (!files.length) files.push('class_light.glb','class_medium.glb','class_heavy.glb','class_cyber.glb','class_brute.glb','class_brawler.glb','class_scout.glb','mannequin.glb','RobotExpressive.glb','knight.glb');

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const q = new THREE.Quaternion(), fwd = new THREE.Vector3();

for (const f of files) {
  const buf = readFileSync(dir + f);
  const gltf = await new Promise((res, rej) => loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
  const model = gltf.scene;
  const depthOf = (n) => { let d = 0; for (let p = n.parent; p && p !== model; p = p.parent) d++; return d; };
  console.log(`\n=== ${f} (${gltf.animations.length} clips)`);
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
    if (!hit) { console.log(`  ${clip.name}: NO QUAT TRACK`); continue; }
    // frame 0 AND max-yaw deviation across the clip — a slide pose can
    // start straight and twist mid-anim.
    const v = hit.tr.values;
    let y0 = null, yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < v.length; i += 4) {
      q.set(v[i], v[i + 1], v[i + 2], v[i + 3]);
      fwd.set(0, 0, 1).applyQuaternion(q);
      const y = Math.atan2(fwd.x, fwd.z);
      if (y0 === null) y0 = y;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
    const deg = (r) => (r * 180 / Math.PI).toFixed(0).padStart(4);
    console.log(`  ${clip.name.padEnd(28)} ${hit.node.name.padEnd(12)} yaw0=${deg(y0)} range=[${deg(yMin)}..${deg(yMax)}]`);
  }
}
