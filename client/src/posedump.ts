// Pose screenshot page — one model, one clip, on a flat white background,
// framed tight for review galleries. Never referenced by the game.
//   /posedump.html?model=robot|mannequin&clip=<name>&t=<seconds>
// window.__clips lists clip names once loaded; window.__ready when posed.
import * as THREE from 'three';
import { mkGltfLoader } from './gltfLoad';

const q = new URLSearchParams(location.search);
const mann = q.get('model') === 'mannequin';
const wantClip = q.get('clip') ?? '';
const wantT = parseFloat(q.get('t') ?? '0.4');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
document.body.append(renderer.domElement);
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

// pmodel mode drives the real PlayerModel (retarget bake included) — the
// raw-clip path below can't show clips that only exist post-bake.
//   /posedump.html?pmodel=mannequin&state=ski&t=0.5
const pvariant = q.get('pmodel');
if (pvariant) {
  const { PlayerModel } = await import('./entities/PlayerModel.js');
  const pm = new PlayerModel(scene, pvariant as 'robot' | 'mannequin' | 'knight');
  await pm.load();
  // &weapon=<WeaponType int> drives the real hand-prop swap; &pitch=<rad>
  // feeds setRotation so the aim bones/aim layer pose mid-frame.
  const wantWeapon = q.get('weapon');
  if (wantWeapon !== null) {pm.setWeapon(parseInt(wantWeapon));}
  const wantPitch = parseFloat(q.get('pitch') ?? '0');
  if (wantPitch) {pm.setRotation(0, wantPitch, 0);}
  const wantState = q.get('state') ?? 'ski';
  // dir=B|BL|L|FL|FR|R|BR feeds setLocomotionVector before the state
  // resolves — exercises the KevDev directional clip table.
  const dir = q.get('dir');
  if (dir) {
    const DIRS: Record<string, [number, number]> = {
      F: [1, 0], FR: [1, 1], R: [0, 1], BR: [-1, 1],
      B: [-1, 0], BL: [-1, -1], L: [0, -1], FL: [1, -1],
    };
    const v = DIRS[dir] ?? DIRS.F;
    pm.setLocomotionVector(v[0], v[1]);
  }
  // Optional locomotion direction for the KevDev 8-dir table —
  // &dir=B|L|R|FL|FR|BL|BR makes walk/run pick the strafe/backpedal clip.
  const wantDir = q.get('dir');
  const DIRV: Record<string, [number, number]> = {
    F: [1, 0], FR: [0.7, 0.7], R: [0, 1], BR: [-0.7, 0.7],
    B: [-1, 0], BL: [-0.7, -0.7], L: [0, -1], FL: [0.7, -0.7],
  };
  const poll = () => {
    const model = pm.object3D;
    const anims = (pm as unknown as { animations: Map<string, unknown> }).animations;
    // Retargeted frames can land outside the bind-pose bounds — same fix
    // the raw path applies below.
    model?.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) {o.frustumCulled = false;} });
    // Wait for the GLB AND the async retarget bake — natives fill the map
    // first, so a bare size check would race past the bake every time.
    // Mannequin bakes the KevDev set (UAL clips are native); robot bakes
    // the full UAL set including UAL2's Slide.
    const need = pvariant === 'mannequin'
      ? anims.has('UAL_Walk01_Left')
      : pvariant === 'robot' ? anims.has('UAL_Slide_Loop') : anims.size > 0;
    if (!model || !anims || !need) { setTimeout(poll, 120); return; }
    if (wantDir && DIRV[wantDir]) {(pm as unknown as { setLocomotionVector(f: number, s: number): void })
      .setLocomotionVector(DIRV[wantDir][0], DIRV[wantDir][1]);}
    pm.forceAnimationState(wantState as never);
    window.__pm = pm;
    // Step the mixer a fixed phase so loops settle mid-cycle.
    for (let i = 0; i < 30; i++) {pm.update(1 / 60 * wantT * 4);}
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    const d = (size / 2) / Math.tan(camera.fov * Math.PI / 360) * 1.12;
    camera.position.set(c.x + d * 0.55, c.y + size * 0.14, c.z + d);
    camera.lookAt(c);
    renderer.setAnimationLoop(() => { pm.update(1 / 60); renderer.render(scene, camera); });
    window.__clips = [...anims.keys()];
    window.__ready = true;
  };
  poll();
} else {
const ual2 = q.get('model') === 'ual2';
const knight = q.get('model') === 'knight';
const url = knight ? '/assets/models/knight.glb'
  : q.get('glb') ? `/assets/models/${q.get('glb')}.glb`
  : ual2 ? '/assets/models/mannequin2.glb'
  : mann ? '/assets/models/mannequin.glb' : '/assets/models/RobotExpressive.glb';
mkGltfLoader().load(url, (gltf) => {
  const model = gltf.scene;
  // Same world scale the game uses (robot 0.5, mannequin fit-2m).
  const box0 = new THREE.Box3().setFromObject(model);
  const size0 = box0.getSize(new THREE.Vector3());
  const classScale = parseFloat(q.get('scale') ?? '1') || 1;
  model.scale.setScalar((mann || ual2 || knight ? 2.0 / size0.y : 0.5) * classScale);
  model.rotation.y = Math.PI * 0.8; // 3/4 front — galleries read better than flat profile
  model.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) {o.frustumCulled = false;} });
  scene.add(model);

  const mixer = new THREE.AnimationMixer(model);
  const boot = (clips: THREE.AnimationClip[]) => {
    window.__clips = clips.map(c => c.name);
    const clip = clips.find(c => c.name === wantClip) ?? clips[0];
    if (clip) {
      const action = mixer.clipAction(clip);
      action.play();
      // For one-shot clips sample mid-arc; loops grab a fixed phase.
      const t = Math.min(clip.duration * wantT, clip.duration - 0.01);
      mixer.update(Math.max(t, 0.001));
    }
    finish();
  };
  const finish = () => {
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
    window.__ready = true;
  };
  // UAL2's mannequin ships bone-identical but clip-less — its clips live in
  // robot-anims2.glb, same UE-style rig, so they bind natively.
  if (ual2) {
    mkGltfLoader().load('/assets/models/robot-anims2.glb', (g) => boot(g.animations));
  } else {
    boot(gltf.animations);
  }
});
}
