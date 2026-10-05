// Viewmodel screenshot page — renders a single weapon at /vmdump.html?w=<WeaponType>&ao=on|off
// for the headless iteration pipeline. Never referenced by the game.
import * as THREE from 'three';
import { ViewModel } from './entities/ViewModel.js';

const q = new URLSearchParams(location.search);
const w = parseInt(q.get('w') ?? '0');
const ao = q.get('ao') !== 'off';

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(innerWidth, innerHeight);
// Match the game's render rig exactly — ACES at game exposure + the real
// light set — so these shots show what the bake looks like in play.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.4; // TONE_MAPPING_EXPOSURE
document.body.append(renderer.domElement);
document.body.style.margin = '0';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x25282e);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 100);
scene.add(camera);
scene.add(new THREE.AmbientLight(0x886644, 0.35));            // AMBIENT_*
scene.add(new THREE.HemisphereLight(0x5599cc, 0x664422, 0.5)); // HEMI_*
const sun = new THREE.DirectionalLight(0xffe8aa, 3.2);         // SUN_*
sun.position.set(2, 4, 1);
scene.add(sun);

const vm = new ViewModel(camera);

if (q.get('export')) {
  // Serialize every weapon group to GLB for the Blender bake pipeline.
  // Part colors become vertex COLOR_0 so Blender can bake them into the map.
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const exporter = new GLTFExporter();
  const out: Record<number, string> = {};
  for (const [wt, g] of vm.weapons) {
    g.visible = true;
    const glow: THREE.Mesh[] = [];
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) {return;}
      // Glow parts stay procedural — they're neon-bright, not baked metal.
      if ((m.material as THREE.Material).type === 'MeshBasicMaterial') { glow.push(m); return; }
      const geo = m.geometry as THREE.BufferGeometry;
      // bakeVertexAO already wrote a 'color' attr with AO values — and any
      // extra color sets export as COLOR_1.. and confuse the bake's pick.
      // Strip every color-ish attribute before writing the part paint.
      for (const name of Object.keys(geo.attributes)) {
        if (name.startsWith('color')) {geo.deleteAttribute(name);}
      }
      const col = ((m.material as THREE.MeshLambertMaterial).color ?? new THREE.Color(1, 1, 1)).clone();
      const n = geo.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    });
    for (const m of glow) {m.visible = false;}
    const glb: ArrayBuffer = await new Promise((res, rej) =>
      exporter.parse(g, (r) => res(r as ArrayBuffer), rej, { binary: true }));
    for (const m of glow) {m.visible = true;}
    const bytes = new Uint8Array(glb);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) {bin += String.fromCharCode(bytes[i]);}
    out[wt] = btoa(bin);
    g.visible = false;
  }
  window.__glb = out;
  window.__ready = true;
}
if (q.get('export')) {throw 0;} // export mode ends above — __ready already set
if (!ao) {
  // Unbake: drop the vertex-color attribute so we capture the pre-AO look.
  vm.group.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) {return;}
    const m = o as THREE.Mesh;
    m.geometry.deleteAttribute('color');
    const mat = m.material as THREE.Material & { vertexColors?: boolean };
    if (mat.vertexColors !== undefined) { mat.vertexColors = false; mat.needsUpdate = true; }
  });
}
vm.switchWeapon(w);
// Skip past the switch dip so the weapon sits at rest for the shot.
const zeroVel = new THREE.Vector3();
for (let i = 0; i < 60; i++) {vm.update(1 / 60, 0, 0, zeroVel, camera);}

if (q.get('close')) {
  // Detach the active weapon from the viewmodel rig and frame it directly —
  // view-space shots are too small to judge shading detail.
  const active = vm.group.children.find(c => c.visible && c !== vm.flashMesh) as THREE.Group;
  camera.remove(vm.group);
  if (active) {
    active.position.set(0, 0, 0);
    active.rotation.set(0, Math.PI * parseFloat(q.get('yaw') ?? '0.75'), 0); // default: muzzle toward camera, 3/4 view
    scene.add(active);
    const box = new THREE.Box3().setFromObject(active);
    const size = box.getSize(new THREE.Vector3()).length();
    const c = box.getCenter(new THREE.Vector3());
    camera.position.set(c.x + size * 0.34, c.y + size * 0.18, c.z + size * 0.34);
    camera.lookAt(c);
  }
}
// Keep rendering — the baked GLB+texture swap lands asynchronously, so a
// fixed early frame would screenshot pre-swap procedural meshes.
renderer.setAnimationLoop(() => renderer.render(scene, camera));
window.__ready = true;
