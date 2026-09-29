// Pose screenshot page — one model, one clip, on a flat white background,
// framed tight for review galleries. Never referenced by the game.
//   /posedump.html?model=robot|mannequin&clip=<name>&t=<seconds>
// window.__clips lists clip names once loaded; window.__ready when posed.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const q = new URLSearchParams(location.search);
const mann = q.get('model') === 'mannequin';
const wantClip = q.get('clip') ?? '';
const wantT = parseFloat(q.get('t') ?? '0.4');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
document.body.appendChild(renderer.domElement);
document.body.style.margin = '0';

const scene = new THREE.Scene();
// Studio look: white cyclorama + neutral lighting so silhouette/shading read clean.
scene.background = new THREE.Color(0xf2f3f5);
scene.fog = null;
scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(3, 5, 4);
scene.add(key);
const rim = new THREE.DirectionalLight(0xdde8ff, 1.0);
rim.position.set(-3, 3, -4);
scene.add(rim);

// Light floor so feet/legs have a ground reference without scene clutter.
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(6, 48),
  new THREE.MeshStandardMaterial({ color: 0xe2e5e9, roughness: 1 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 100);

const url = mann ? '/assets/models/mannequin.glb' : '/assets/models/RobotExpressive.glb';
new GLTFLoader().load(url, (gltf) => {
  const model = gltf.scene;
  // Same world scale the game uses (robot 0.5, mannequin fit-2m).
  const box0 = new THREE.Box3().setFromObject(model);
  const size0 = box0.getSize(new THREE.Vector3());
  model.scale.setScalar(mann ? 2.0 / size0.y : 0.5);
  model.rotation.y = Math.PI * 0.8; // 3/4 front — galleries read better than flat profile
  model.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false; });
  scene.add(model);

  const mixer = new THREE.AnimationMixer(model);
  (window as any).__clips = gltf.animations.map(c => c.name);

  const clip = gltf.animations.find(c => c.name === wantClip) ?? gltf.animations[0];
  if (clip) {
    const action = mixer.clipAction(clip);
    action.play();
    // For one-shot clips sample mid-arc; loops grab a fixed phase.
    const t = Math.min(clip.duration * wantT, clip.duration - 0.01);
    mixer.update(Math.max(t, 0.001));
  }

  // Frame the posed model — bounds AFTER the pose is applied so death/jump
  // clips don't get cropped.
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  // Fit the bounding *diagonal* inside the 45° fov with margin — diagonal
  // guarantees the widest clip arc stays in frame.
  const d = (size / 2) / Math.tan(camera.fov * Math.PI / 360) * 1.12;
  camera.position.set(c.x + d * 0.55, c.y + size * 0.14, c.z + d);
  camera.lookAt(c);

  renderer.setAnimationLoop(() => renderer.render(scene, camera));
  renderer.render(scene, camera);
  (window as any).__ready = true;
});
