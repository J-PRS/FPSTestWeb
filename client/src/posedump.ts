// Pose screenshot page — one model, one clip, on a flat white background,

// framed tight for review galleries. Never referenced by the game.

//   /posedump.html?model=robot|mannequin&clip=<name>&t=<seconds>

// window.__clips lists clip names once loaded; window.__ready when posed.

import * as THREE from 'three';

import { mkGltfLoader } from './gltfLoad';

import { isDevHost } from './core/params.js';



if (!isDevHost()) {

  document.body.innerHTML = '<div style="color:#cde;font:14px monospace;padding:2em">dev tool — not available on this build.</div>';

  throw new Error('posedump: dev-only surface');

}



const q = new URLSearchParams(window.location.search);

const mann = q.get('model') === 'mannequin';

const wantClip = q.get('clip') ?? '';

const wantT = Number.parseFloat(q.get('t') ?? '0.4');



const renderer = new THREE.WebGLRenderer({ antialias: true });

renderer.setSize(innerWidth, innerHeight);

renderer.toneMapping = THREE.ACESFilmicToneMapping;

renderer.toneMappingExposure = 0.55;

document.body.append(renderer.domElement);

document.body.style.margin = '0';



const scene = new THREE.Scene();

// Studio look: white cyclorama + neutral lighting so silhouette/shading read clean.

scene.background = new THREE.Color(0xF2_F3_F5);

scene.fog = null;

scene.add(new THREE.HemisphereLight(0xFF_FF_FF, 0x88_99_AA, 1.1));

const key = new THREE.DirectionalLight(0xFF_FF_FF, 2.2);

key.position.set(3, 5, 4);

scene.add(key);

const rim = new THREE.DirectionalLight(0xDD_E8_FF, 1);

rim.position.set(-3, 3, -4);

scene.add(rim);



// Light floor so feet/legs have a ground reference without scene clutter.

const floor = new THREE.Mesh(

  new THREE.CircleGeometry(6, 48),

  new THREE.MeshStandardMaterial({ color: 0xE2_E5_E9, roughness: 1 }));

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

  if (wantWeapon !== null) {pm.setWeapon(Number.parseInt(wantWeapon));}

  const wantPitch = Number.parseFloat(q.get('pitch') ?? '0');

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

  const poll = (): void => {

    const model = pm.object3D;

    const anims = (pm as unknown as { animations: Map<string, unknown> }).animations;

    // Retargeted frames can land outside the bind-pose bounds — same fix

    // the raw path applies below.

    model?.traverse((o): void => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) {o.frustumCulled = false;} });

    // Wait for the GLB AND the async retarget bake — natives fill the map

    // first, so a bare size check would race past the bake every time.

    // Mannequin bakes the KevDev set (UAL clips are native); robot bakes

    // the full UAL set including UAL2's Slide.

    let need = anims.size > 0;

    if (pvariant === 'mannequin') {need = anims.has('UAL_Walk01_Left');}

    else if (pvariant === 'robot') {need = anims.has('UAL_Slide_Loop');}

    if (!model || !anims || !need) { setTimeout(poll, 120); return; }

    if (wantDir && DIRV[wantDir]) {(pm as unknown as { setLocomotionVector(f: number, s: number): void })

      .setLocomotionVector(DIRV[wantDir][0], DIRV[wantDir][1]);}

    pm.forceAnimationState(wantState as never);

    window.__pm = pm;

    // ?gunArrow=1 — fat debug arrow on the gun's +Z barrel axis so shots
    // reveal which way the prop actually points.
    if (q.get('gunArrow')) {
      const g = (pm as unknown as { gunCtl: { group?: THREE.Group } }).gunCtl.group;
      if (g) {
        const am = new THREE.MeshBasicMaterial({ color: 0xFF_22_22 });
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.9).rotateX(Math.PI / 2).translate(0, 0, 0.95), am);
        const head = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.28).rotateX(Math.PI / 2).translate(0, 0, 1.55), am);
        g.add(shaft, head);
      }
    }

    // Step the mixer a fixed phase so loops settle mid-cycle.

    for (let i = 0; i < 30; i += 1) {pm.update(1 / 60 * wantT * 4);}

    model.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(model);

    const c = box.getCenter(new THREE.Vector3());

    const size = box.getSize(new THREE.Vector3()).length();

    const d = (size / 2) / Math.tan(camera.fov * Math.PI / 360) * 1.12;

    camera.position.set(c.x + d * 0.55, c.y + size * 0.14, c.z + d);

    camera.lookAt(c);

    renderer.setAnimationLoop((): void => { pm.update(1 / 60); renderer.render(scene, camera); });

    (window as unknown as { __cam: THREE.PerspectiveCamera }).__cam = camera;

    window.__clips = [...anims.keys()];

    window.__ready = true;

  };

  poll();

} else {

const ual2 = q.get('model') === 'ual2';

const knight = q.get('model') === 'knight';

let url = '/assets/models/RobotExpressive.glb';

if (knight) {url = '/assets/models/knight.glb';}

else if (q.get('glb')) {url = `/assets/models/${q.get('glb')}.glb`;}

else if (ual2) {url = '/assets/models/mannequin2.glb';}

else if (mann) {url = '/assets/models/mannequin.glb';}

mkGltfLoader().load(url, (gltf): void => {

  const model = gltf.scene;
  (window as unknown as { __mdl: THREE.Object3D }).__mdl = model;

  // Same world scale the game uses (robot 0.5, mannequin fit-2m).

  const box0 = new THREE.Box3().setFromObject(model);

  const size0 = box0.getSize(new THREE.Vector3());

  const classScale = Number.parseFloat(q.get('scale') ?? '1') || 1;

  model.scale.setScalar((mann || ual2 || knight ? 2 / size0.y : 0.5) * classScale);

  model.rotation.y = Math.PI * 0.8; // 3/4 front — galleries read better than flat profile

  model.traverse((o): void => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) {o.frustumCulled = false;} });

  scene.add(model);



  const mixer = new THREE.AnimationMixer(model);

  const boot = (clips: THREE.AnimationClip[]): void => {

    window.__clips = clips.map((c): string => c.name);

    const clip = clips.find((c): boolean => c.name === wantClip) ?? clips[0];

  // oxlint-disable-next-line consistent-function-scoping -- captures callback-local model/camera/renderer
  const finish = (): void => {

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



    renderer.setAnimationLoop((): void => renderer.render(scene, camera));

    renderer.render(scene, camera);

    window.__ready = true;

  };

    if (clip) {

      const action = mixer.clipAction(clip);

      action.play();

      // For one-shot clips sample mid-arc; loops grab a fixed phase.

      const t = Math.min(clip.duration * wantT, clip.duration - 0.01);

      mixer.update(Math.max(t, 0.001));

    }

    finish();

  };

  // UAL2's mannequin ships bone-identical but clip-less — its clips live in

  // robot-anims2.glb, same UE-style rig, so they bind natively.

  if (ual2) {

    mkGltfLoader().load('/assets/models/robot-anims2.glb', (g): void => boot(g.animations));

  } else {

    boot(gltf.animations);

  }

});

}

