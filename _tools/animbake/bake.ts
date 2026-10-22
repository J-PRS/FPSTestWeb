// Offline UAL retarget bake — the same pipeline PlayerModel would run at
// load, executed here and shipped as public/assets/anims/<variant>.glb.
// Runtime prefers the baked file so no client ever flashes bind pose or
// pays the resample; the runtime bake stays as the dev fallback.
//
// Run:  cd client && node --experimental-transform-types ../_tools/animbake/bake.ts
// Dynamic imports let bare 'three' resolve through client/node_modules
// even though this entry lives outside it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as THREE from 'three';
import type { GLTFLoader as GLTFLoaderT } from 'three/addons/loaders/GLTFLoader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// This file also runs as emitted JS under client/.animbake-tmp/ — walk up
// until the dir whose client/node_modules/three exists.
function findClient(start: string): string {
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'client/node_modules/three'))) return path.join(d, 'client');
    d = path.dirname(d);
  }
  throw new Error('client/node_modules/three not found above ' + start);
}
const CLIENT = findClient(here);
const NM = path.join(CLIENT, 'node_modules/three');
const MODELS = path.join(CLIENT, 'public/assets/models');
const OUT = path.join(CLIENT, 'public/assets/anims');
const mod = (p: string) => pathToFileURL(path.join(NM, p)).href;

const THREE = await import(mod('build/three.module.js')) as typeof import('three');
const { GLTFLoader } = await import(mod('examples/jsm/loaders/GLTFLoader.js')) as { GLTFLoader: typeof GLTFLoaderT };
// Repacked model GLBs are meshopt-quantized — without the decoder the
// parse promise never settles and the bake exits silently.
const { MeshoptDecoder } = await import(mod('examples/jsm/libs/meshopt_decoder.module.js')) as {
  MeshoptDecoder: { ready: Promise<void>; decode(buffer: ArrayBuffer, count: number, size: number, source: Uint8Array, offset: number): Uint8Array };
};
await MeshoptDecoder.ready;
const { GLTFExporter } = await import(mod('examples/jsm/exporters/GLTFExporter.js')) as {
  GLTFExporter: new () => {
    parse(input: THREE.Object3D, onDone: (r: ArrayBuffer) => void, onErr: (e: Error) => void, opts?: object): void;
  };
};
// Logger (pulled in by playerUal) installs browser hooks at module load —
// stub the two listeners it touches; nothing else DOM runs headlessly.
(globalThis as Record<string, unknown>).window ??= { addEventListener: () => {}, location: { search: '' } };
(globalThis as Record<string, unknown>).document ??= { addEventListener: () => {} };
// GLTFExporter serializes through FileReader — a Blob-backed shim is all
// it needs for buffer-only output.
(globalThis as Record<string, unknown>).FileReader ??= class {
  result: unknown = null;
  onloadend?: () => void; onerror?: (e: unknown) => void;
  readAsArrayBuffer(b: Blob): void {
    b.arrayBuffer().then(r => { this.result = r; this.onloadend?.(); }).catch(e => this.onerror?.(e));
  }
  readAsDataURL(b: Blob): void {
    b.arrayBuffer().then(r => {
      this.result = 'data:application/octet-stream;base64,' + Buffer.from(r).toString('base64');
      this.onloadend?.();
    }).catch(e => this.onerror?.(e));
  }
};

const { bakeUALClips } = await import('../../client/src/entities/playerUal.js');

// variant → its model GLB. Keep in sync with PlayerModel's MODEL_SPECS.
const RIGS: Record<string, string> = {
  robot: 'RobotExpressive.glb',
  mannequin: 'mannequin.glb',
  knight: 'knight.glb',
  scifisoldier: 'class_light.glb',
  cybersoldier: 'class_cyber.glb',
  vexa: 'class_medium.glb',
  polyart: 'class_heavy.glb',
};

// GLTFLoader's image paths need a DOM (ImageBitmap/canvas). The bake only
// needs joints + animations, so texture references are stripped from the
// JSON chunk before parse — materials degrade harmlessly.
function stripTextures(glb: Buffer): ArrayBuffer {
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const m of json.materials ?? []) {
    for (const k of Object.keys(m)) if (k.endsWith('Texture')) delete m[k];
    if (m.pbrMetallicRoughness) {
      for (const k of Object.keys(m.pbrMetallicRoughness)) if (k.endsWith('Texture')) delete m.pbrMetallicRoughness[k];
    }
    delete m.extensions;
  }
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad, 0x20)]);
  const bin = glb.subarray(20 + jsonLen);
  const out = Buffer.alloc(12 + 8 + jsonBuf.length + bin.length);
  glb.copy(out, 0, 0, 12);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonBuf.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16); // 'JSON'
  jsonBuf.copy(out, 20);
  bin.copy(out, 20 + jsonBuf.length);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
}

function loadGlb(file: string): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  const abs = path.isAbsolute(file) ? file : path.join(MODELS, file);
  const buf = stripTextures(fs.readFileSync(abs));
  return new Promise((resolve, reject) => {
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parse(buf, '', g =>
      resolve({ scene: g.scene, animations: g.animations }), reject);
  });
}

// SPECS urls are web-rooted '/assets/models/…' — map to disk for the
// headless loader injected into bakeUALClips.
const env = { loadGltf: (url: string) => loadGlb(url.replace(/^.*assets\/models\//, '')) };

function exportClips(scene: THREE.Object3D, clips: THREE.AnimationClip[]): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(scene, resolve, reject, { binary: true, animations: clips });
  });
}

fs.mkdirSync(OUT, { recursive: true });
console.log('bake: RIGS=' + Object.keys(RIGS).join(','));
for (const [variant, glb] of Object.entries(RIGS)) {
  console.log('bake: ' + variant + ' loading');
  const { scene } = await loadGlb(glb);
  const baked = await bakeUALClips(scene as THREE.Object3D, variant, env);
  // A marker-only pack would still satisfy loadBakedUALClips' non-empty
  // check and leave the rig with zero real clips at runtime.
  if (baked.size <= (baked.has('__holdbake1') ? 1 : 0)) { console.log(`${variant}: no real clips — skipped`); continue; }
  // Export the bone hierarchy only: a mesh-free armature scene keeps the
  // pack small; clip tracks bind by node name at load.
  const armature = new THREE.Scene();
  let sk: THREE.SkinnedMesh | undefined;
  scene.traverse((o: THREE.Object3D) => { if (!sk && (o as THREE.SkinnedMesh).isSkinnedMesh) sk = o as THREE.SkinnedMesh; });
  let exportRoot: THREE.Object3D = scene;
  const skelRoot = sk?.skeleton.bones[0];
  if (skelRoot) {
    // Climb to the topmost bone-chain ancestor so track node paths
    // resolve in the exported scene.
    let top: THREE.Object3D = skelRoot;
    while (top.parent && top.parent !== scene) top = top.parent;
    const clone = top.clone(true);
    clone.position.set(0, 0, 0); clone.quaternion.identity(); clone.scale.set(1, 1, 1);
    // The holdbake marker clip is empty — meshopt repacks strip it. The
    // armature root extras carry the same flag so -ke packs keep it.
    if (baked.has('__holdbake1')) {clone.userData = { holdbake1: 1 };}
    // Clip tracks only need named joint nodes — meshes inside the cloned
    // armature (Vexa parents hers under it) would ship megabytes of
    // geometry nobody loads.
    const meshes: THREE.Object3D[] = [];
    clone.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o); });
    for (const m of meshes) m.removeFromParent();
    armature.add(clone);
    exportRoot = armature;
  }
  const data = await exportClips(exportRoot, [...baked.values()]);
  const out = path.join(OUT, `${variant}.glb`);
  fs.writeFileSync(out, Buffer.from(data));
  console.log(`${variant}: ${baked.size} clips → ${out} (${(data.byteLength / 1024).toFixed(0)} KB)`);
}
