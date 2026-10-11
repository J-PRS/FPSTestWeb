// AO/edge-wear tuning page — /aodump.html?w=<WeaponType>
// Uniform-driven grunge+wear shader with live sliders, channel-isolation
// views, and rebake controls. Never loaded by the game — tuning tool only.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ViewModel } from './entities/ViewModel.js';
import { bakeVertexAO } from './effects/vertexAO.js';
import { WeaponType } from '../../shared/weapons.js';
import { isDevHost } from './core/params.js';

if (!isDevHost()) {
  document.body.innerHTML = '<div style="color:#cde;font:14px monospace;padding:2em">dev tool — not available on this build.</div>';
  throw new Error('aodump: dev-only surface');
}

const q = new URLSearchParams(window.location.search);

// ---- scene rig — same lights/exposure as vmdump -------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.4;
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x25_28_2E);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0.45, 0.3, 0.55);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.02, 0);

scene.add(new THREE.AmbientLight(0x88_66_44, 0.35));
scene.add(new THREE.HemisphereLight(0x55_99_CC, 0x66_44_22, 0.5));
const sun = new THREE.DirectionalLight(0xFF_E8_AA, 3.2);
sun.position.set(2, 4, 1);
scene.add(sun);
// Fill from camera side so edges read — game viewmodels are lit mostly by sun+hemi.
const fill = new THREE.DirectionalLight(0x88_99_BB, 0.8);
fill.position.set(-1.5, 1, 2);
scene.add(fill);

const vm = new ViewModel(camera);
scene.add(vm.group);

// ---- tunable uniforms ----------------------------------------------------
// Every slider writes into this shared table; materials read them as
// uniforms so tweaks apply the same frame — no recompile.
const U = {
  uGrungeAmp:  { value: 0.14 },
  uGrungeFreq: { value: 35 },
  uLineW:      { value: Number.parseFloat(q.get('lw') ?? '3') },   // barycentric edge line width
  uLineGain:   { value: 1 },   // edge line strength
  uEdgeLo:     { value: 0.22 },  // curv smoothstep low
  uEdgeHi:     { value: 0.7 },  // curv smoothstep high
  uVWLo:       { value: 0.45 },  // vWear smoothstep low
  uVWHi:       { value: 0.95 },  // vWear smoothstep high
  uVGain:      { value: 0.4 },  // vWear weight vs curv
  uPatchFloor: { value: 0.5 },  // patches mask floor
  uPatchFreq:  { value: 90 },
  uPatchLo:    { value: 0.55 },
  uPatchHi:    { value: 0.8 },
  uExpLo:      { value: 0.45 },  // AO exposure mask low
  uExpHi:      { value: 0.85 },  // AO exposure mask high
  uWearMix:    { value: 0.85 },  // final wear blend strength
  uWearTint:   { value: new THREE.Color(0.72, 0.7, 0.68) },
  uScratch:    { value: 0.12 },
  uCavityLo:   { value: 0.2 },  // AO cavity ramp low
  uCavityHi:   { value: 0.75 },
  uCavityFloor:{ value: 0.6 },  // darkest cavity multiplier
  uSpace:      { value: 0 },     // 0 = object space, 1 = world space
  uView:       { value: 0 },     // 0 final, 1 AO, 2 wear attr, 3 edge, 4 normal
};

function enhance(mat: THREE.Material): void {
  if (mat.userData['__tuned']) {return;}
  mat.userData['__tuned'] = true;
  mat.onBeforeCompile = (sh): void => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vLpos; varying vec3 vWpos;
        attribute float wear; varying float vWear;
        attribute vec3 abary; varying vec3 vBary;
        attribute vec3 aedge; varying vec3 vAedge;`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>
        vLpos = position;
        vWpos = (modelMatrix * vec4(position, 1.0)).xyz;
        vWear = wear; vBary = abary; vAedge = aedge;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vLpos; varying vec3 vWpos; varying float vWear;
        varying vec3 vBary; varying vec3 vAedge;
        uniform float uLineW, uLineGain;
        uniform float uGrungeAmp, uGrungeFreq, uEdgeLo, uEdgeHi, uVWLo, uVWHi, uVGain;
        uniform float uPatchFloor, uPatchFreq, uPatchLo, uPatchHi;
        uniform float uExpLo, uExpHi, uWearMix, uScratch;
        uniform float uCavityLo, uCavityHi, uCavityFloor;
        uniform float uSpace; uniform int uView;
        uniform vec3 uWearTint;
        float whash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float wnoise(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(whash(i), whash(i+vec3(1,0,0)), f.x), mix(whash(i+vec3(0,1,0)), whash(i+vec3(1,1,0)), f.x), f.y),
            mix(mix(whash(i+vec3(0,0,1)), whash(i+vec3(1,0,1)), f.x), mix(whash(i+vec3(0,1,1)), whash(i+vec3(1,1,1)), f.x), f.y),
            f.z);
        }
        float wfbm(vec3 p) { return 0.5 * wnoise(p) + 0.25 * wnoise(p*2.17) + 0.125 * wnoise(p*4.31); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 npos = mix(vLpos, vWpos, uSpace);
          float g = wfbm(npos * uGrungeFreq);
          diffuseColor.rgb *= 1.0 - uGrungeAmp * 0.5 + uGrungeAmp * g;

          // Barycentric edge line — crisp pixel-width line on sharp edges.
          vec3 ew = vBary + (1.0 - vAedge) * 4.0;
          float eDist = min(ew.x, min(ew.y, ew.z));
          float ePx = fwidth(vBary.x) + fwidth(vBary.y) + fwidth(vBary.z);
          float eline = (1.0 - smoothstep(0.0, ePx * uLineW, eDist)) * uLineGain;
          float curv = length(fwidth(normalize(vNormal)));
          float edge = max(eline, max(smoothstep(uEdgeLo, uEdgeHi, curv),
                           smoothstep(uVWLo, uVWHi, vWear) * uVGain));
          float patches = uPatchFloor + (1.0 - uPatchFloor) *
                          smoothstep(uPatchLo, uPatchHi, wnoise(npos * uPatchFreq));
          #ifdef USE_COLOR
            float exposure = smoothstep(uExpLo, uExpHi, vColor.g);
          #else
            float exposure = 1.0;
          #endif
          float wear = edge * patches * exposure;
          float scratch = wnoise(npos * 700.0) * uScratch;
          diffuseColor.rgb = mix(diffuseColor.rgb, uWearTint, wear * uWearMix);
          diffuseColor.rgb *= 1.0 - wear * scratch;
          #ifdef USE_COLOR
            diffuseColor.rgb *= uCavityFloor + (1.0 - uCavityFloor) *
                                smoothstep(uCavityLo, uCavityHi, vColor.g);
          #endif
          if (uView == 1) { // AO channel
            #ifdef USE_COLOR
            diffuseColor.rgb = vec3(vColor.g);
            #else
            diffuseColor.rgb = vec3(1.0);
            #endif
          } else if (uView == 2) diffuseColor.rgb = vec3(vWear);
          else if (uView == 3) diffuseColor.rgb = vec3(edge);
          else if (uView == 4) diffuseColor.rgb = normalize(vNormal) * 0.5 + 0.5;
          else if (uView == 5) diffuseColor.rgb = vec3(eline);
          else if (uView == 6) diffuseColor.rgb = vAedge;
          else if (uView == 7) diffuseColor.rgb = vBary;
        }`);
  };
  // Re-patching an already-compiled material (async baked-GLB swap) needs a
  // real needsUpdate — setting it inside onBeforeCompile is a no-op.
  mat.needsUpdate = true;
  mat.customProgramCacheKey = (): string => 'aodump'; // single program per material type
  console.log('[aodump] patched', mat.type, 'name=', mat.name || '(anon)');
}

function applyTo(group: THREE.Group): void {
  group.traverse((o): void => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) {return;}
    if ((m.material as THREE.Material).type === 'MeshBasicMaterial') {return;}
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mt of mats) {enhance(mt);}
  });
}

// ---- bake toggle -----------------------------------------------------------
let aoOn = q.get('ao') !== 'off';
const bakedGroups = new WeakSet<THREE.Group>();
function show(wt: number): void {
  currentW = wt;
  for (const [w, g] of vm.weapons) {g.visible = w === wt;}
  const g = vm.weapons.get(wt);
  if (g) {applyTo(g);}
}


function rebake(): void {
  for (const [, g] of vm.weapons) {
    if (bakedGroups.has(g)) {continue;} // vertex attrs can't be re-baked cleanly
    if (!aoOn) {continue;}
    g.visible = true;
    bakeVertexAO(g);
    g.visible = false;
    bakedGroups.add(g);
    applyTo(g);
  }
  show(currentW);
}

// ---- weapon picker -----------------------------------------------------------
const wnames = Object.entries(WeaponType).filter(([, v]): boolean => typeof v === 'number') as [string, number][];
let currentW = Number.parseInt(q.get('w') ?? '0');

// ---- UI ---------------------------------------------------------------------
const panel = document.querySelector('#panel')!;
const h = (t: string): void => { const e = document.createElement('h3'); e.textContent = t; panel.append(e); };
const slider = (label: string, u: { value: number }, lo: number, hi: number, step = 0.01): void => {
  const row = document.createElement('div'); row.className = 'row';
  const l = document.createElement('label'); l.textContent = label;
  const inp = document.createElement('input'); inp.type = 'range';
  inp.min = String(lo); inp.max = String(hi); inp.step = String(step); inp.value = String(u.value);
  const val = document.createElement('span'); val.className = 'val'; val.textContent = String(u.value);
  inp.addEventListener('input', (): void => { u.value = Number(inp.value); val.textContent = inp.value; });
  row.append(l, inp, val); panel.append(row);
};

h('WEAPON');
const wrow = document.createElement('div'); wrow.id = 'wrow';
for (const [name, id] of wnames) {
  const b = document.createElement('button');
  b.textContent = name;
  b.addEventListener('click', (): void => { show(id); for (const x of wrow.children) {(x as HTMLElement).classList.remove('on');} b.classList.add('on'); });
  wrow.append(b);
}
panel.append(wrow);

h('BAKE');
const aoBtn = document.createElement('button');
aoBtn.textContent = 'AO ON';
const bakeBtn = document.createElement('button'); bakeBtn.textContent = 'BAKE NOW';
aoBtn.addEventListener('click', (): void => { aoOn = !aoOn; aoBtn.textContent = aoOn ? 'AO ON' : 'AO OFF'; aoBtn.classList.toggle('on', aoOn); });
bakeBtn.addEventListener('click', rebake);
panel.append(aoBtn, bakeBtn);
if (aoOn) {aoBtn.classList.add('on');}

h('VIEW');
const views: [string, number][] = [['FINAL', 0], ['AO', 1], ['WEAR ATTR', 2], ['EDGE', 3], ['NORMAL', 4]];
for (const [label, v] of views) {
  const b = document.createElement('button'); b.textContent = label;
  b.addEventListener('click', (): void => { U.uView.value = v; });
  panel.append(b);
}

h('GRUNGE');
slider('amp', U.uGrungeAmp, 0, 0.4);
slider('freq', U.uGrungeFreq, 5, 120, 1);
slider('space 0=obj', U.uSpace, 0, 1, 1);

h('EDGE LINE (bary)');
slider('line width', U.uLineW, 0.5, 40, 0.1);
slider('line gain', U.uLineGain, 0, 1.5);

h('EDGE (fwidth)');
slider('edge lo', U.uEdgeLo, 0, 1, 0.01);
slider('edge hi', U.uEdgeHi, 0.05, 2, 0.01);

h('WEAR ATTR');
slider('vw lo', U.uVWLo, 0, 1);
slider('vw hi', U.uVWHi, 0, 1);
slider('vw gain', U.uVGain, 0, 1);

h('PATCH MASK');
slider('floor', U.uPatchFloor, 0, 1);
slider('freq', U.uPatchFreq, 10, 300, 1);
slider('lo', U.uPatchLo, 0, 1);
slider('hi', U.uPatchHi, 0, 1);

h('AO EXPOSURE MASK');
slider('exp lo', U.uExpLo, 0, 1);
slider('exp hi', U.uExpHi, 0, 1);

h('OUTPUT');
slider('wear mix', U.uWearMix, 0, 1);
slider('scratch', U.uScratch, 0, 0.4);
slider('cav lo', U.uCavityLo, 0, 1);
slider('cav hi', U.uCavityHi, 0, 1);
slider('cav floor', U.uCavityFloor, 0.2, 1);

const qv = Number.parseInt(q.get('view') ?? '0');
if (!isNaN(qv)) {U.uView.value = qv;}

rebake();
show(currentW);

addEventListener('resize', (): void => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// The baked-GLB swap is async — meshes arrive AFTER applyTo first ran, so
// keep re-running it until every lit material carries the tunable patch
// (the __tuned guard makes it a no-op for already-patched materials).
setInterval((): void => { for (const [, g] of vm.weapons) {applyTo(g);} }, 400);

renderer.setAnimationLoop((): void => {
  controls.update();
  renderer.render(scene, camera);
});
