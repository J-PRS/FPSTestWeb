// For each clip in a GLB, list every quat-track target that is NOT a
// Bone (armature/root objects can carry facing that hip fixes miss),
// plus whether pelvis tracks exist at all.
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
const q = new THREE.Quaternion(), fwd = new THREE.Vector3();
const deg = r => (r * 180 / Math.PI).toFixed(0).padStart(5);

const WANT = new Set(process.argv[3] ? process.argv[3].split(',') : ['Walk', 'Jump_air', 'Jump_2', 'Slide', 'Idle_A', 'Sprint']);
for (const clip of gltf.animations) {
  if (!WANT.has(clip.name)) continue;
  console.log(`\n${clip.name}:`);
  for (const tr of clip.tracks) {
    if (!tr.name.endsWith('.quaternion')) continue;
    const name = tr.name.slice(0, -'.quaternion'.length);
    const node = model.getObjectByName(name);
    if (!node) { console.log(`  ${name}: MISSING NODE`); continue; }
    if (node.isBone) continue; // bones covered by clipyaw dump
    const v = tr.values;
    q.set(v[0], v[1], v[2], v[3]);
    fwd.set(0, 0, 1).applyQuaternion(q);
    console.log(`  NON-BONE ${name} type=${node.type} yaw0=${deg(Math.atan2(fwd.x, fwd.z))} keys=${v.length / 4}`);
  }
}
// also: what is pelvis's parent chain orientation?
const pelvis = model.getObjectByName('pelvis');
if (pelvis) {
  let p = pelvis;
  const chain = [];
  while (p && p !== model) { chain.push(`${p.name || p.type}(yaw=${deg(p.rotation.y)})`); p = p.parent; }
  console.log('\npelvis chain:', chain.join(' <- '));
}
