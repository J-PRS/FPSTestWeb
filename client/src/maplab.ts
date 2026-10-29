/* oxlint-disable typescript/no-explicit-any -- window debug handle */
// maplab — live terrain synth viewer (/maplab.html). Sliders → seeded
// field synth + hydraulic erosion → heightmap relief + a 3D view built
// from the same baked bytes the sim reads, so the preview IS the physics.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { hmParseBin, hmHeight, hmNormal, hmSurface, HM_HEIGHT_SCALE } from '../../shared/heightfield.js';
import { MoveSim } from '../../shared/movement.js';
import { terrainFrag } from './world/terrainShaders.js';
import { hillshadeImage } from './world/hillshade.js';
import { synthField, erode, talusPass, streamPower, drainage, faultPass, glacierPass, smoothPass, flatsPass, DEFAULTS, type GenParams, type Drainage } from './maplab/gen.js';

// Player-facing lab: served on prod too — no isDevHost gate on the entry.

const state: GenParams & { heightScale: number; preset: number; showRaw: boolean; wire: boolean; slopeOverlay: boolean; flowOverlay: boolean; dropHeight: number; map: string } =
  Object.assign({}, DEFAULTS, { heightScale: 1, preset: 1, showRaw: false, wire: false, slopeOverlay: true, flowOverlay: true, dropHeight: 0, map: '' });
try { Object.assign(state, JSON.parse(localStorage.getItem('maplab') ?? '{}')); } catch { /* fresh */ }
const save = (): void => { localStorage.setItem('maplab', JSON.stringify(state)); };

// --- rig ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1A_20_26);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 1, 8000);
camera.position.set(700, 600, 700);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.maxDistance = 4000;
scene.add(new THREE.AmbientLight(0x88_99_AA, 0.8));
const sun = new THREE.DirectionalLight(0xFF_FF_FF, 1.6);
sun.position.set(-0.5, 1, 0.35);
scene.add(sun);

const WS = 1500;
const SEG = 256;
const geo = new THREE.PlaneGeometry(WS, WS, SEG, SEG);
geo.rotateX(-Math.PI / 2);
// The REAL terrain fragment shader — the plane is authored in world
// space so vWorldPos/vNormal come straight from the attributes and the
// procedural palette renders exactly as in-game (spec.terrainPreset is
// the compile-time TERRAIN_PRESET define).
const LAB_VERT = /* glsl */`
  varying vec3 vNormal; varying vec3 vWorldPos; varying vec3 vCameraPos;
  void main() {
    vWorldPos = position;
    vNormal = normal;
    vCameraPos = cameraPosition;
    gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  }
`;
const mat = new THREE.ShaderMaterial({
  vertexShader: LAB_VERT,
  fragmentShader: terrainFrag,
  lights: true,
  defines: { TERRAIN_PRESET: state.preset },
  uniforms: Object.assign({}, THREE.UniformsLib.lights, {
    hscale: { value: HM_HEIGHT_SCALE },
    sunDir: { value: new THREE.Vector3(-0.5, 1, 0.35).normalize() },
    sunColor: { value: new THREE.Color(1, 0.94, 0.8) },
    ambientColor: { value: new THREE.Color(0.38, 0.45, 0.55) },
    fogColor: { value: new THREE.Color(0xBB_D0_E8) },
    fogStart: { value: 400 }, fogEnd: { value: 4000 },
    innerHalfSize: { value: 0 }, innerGridOrigin: { value: new THREE.Vector2() },
    edgeHalf: { value: 0 },
    albedoMap: { value: null }, useAlbedo: { value: false },
    matTiles: { value: null }, matAlphaA: { value: null }, matAlphaB: { value: null },
    useMats: { value: false }, tileMeters: { value: 5.86 },
    tileMeans: { value: new Float32Array(8).fill(0.5) },
    hmWorldScaleFrag: { value: WS },
    scorchData: { value: Array.from({ length: 16 }, () => new THREE.Vector4()) },
    scorchEmber: { value: new Float32Array(16) },
    splatData: { value: Array.from({ length: 24 }, () => new THREE.Vector4()) },
    splatTint: { value: Array.from({ length: 24 }, () => new THREE.Vector3()) },
    splatDir: { value: Array.from({ length: 24 }, () => new THREE.Vector3()) },
    fieldRing: { value: Array.from({ length: 32 }, () => new THREE.Vector4()) },
    fieldTint: { value: Array.from({ length: 32 }, () => new THREE.Vector3()) },
    fieldY: { value: new Float32Array(32) },
    scorchCount: { value: 0 }, splatCount: { value: 0 }, fieldCount: { value: 0 },
    dbgStage: { value: -1 },
    litKnee: { value: 0.85 }, litKeep: { value: 0.2 }, colCap: { value: 0.99 },
  }),
});
const terrain = new THREE.Mesh(geo, mat);
scene.add(terrain);
// Frame grid — the tile edge, so wrap-seams read at a glance.
const frame = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.PlaneGeometry(WS, WS).rotateX(-Math.PI / 2)),
  new THREE.LineBasicMaterial({ color: 0x55_AA_FF }),
);
frame.position.y = 1;
scene.add(frame);

const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;

// --- ski-ball probe: frictionless MoveSim ice cubes (skiHeld, inelastic
// landings) — same physics as _tools/sweeps/skiProbe.ts, watched live.
// Each ball is a vertical loot-beam (Borderlands style): a thin glow
// pillar, hue-ramped cold→hot by speed, visible through terrain.
// Alpha blend, NOT additive: additive over the bright terrain palette
// sums every overlapping hue to white (the smear this used to read as),
// and ACES tone mapping flattens what's left — toneMapped:false keeps
// the debug hues literal.
const BALL_N = 150;
const BEAM_H = 140;
const ballMesh = new THREE.InstancedMesh(
  new THREE.CylinderGeometry(1.4, 1.4, 1, 8, 1, true),
  new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0.5, blending: THREE.NormalBlending,
    depthWrite: false, depthTest: false, side: THREE.DoubleSide, toneMapped: false,
  }),
  BALL_N,
);
ballMesh.count = 0;
ballMesh.frustumCulled = false;
ballMesh.renderOrder = 99;
scene.add(ballMesh);
let balls: MoveSim[] = [];
const _m4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3(1, BEAM_H, 1);
const _q = new THREE.Quaternion();
const _bc = new THREE.Color();
function dropBalls(): void {
  balls = [];
  skiLine = ''; skiT = 0; // the score recomputes on the fresh field
  const surf = hmSurface(field);
  for (let i = 0; i < BALL_N; i += 1) {
    const x = (Math.random() - 0.5) * WS * 0.96, z = (Math.random() - 0.5) * WS * 0.96;
    const sim = new MoveSim(surf, {
      pos: { x, y: hmHeight(field, x, z) + 0.7 + state.dropHeight, z },
      vel: { x: 0, y: 0, z: 0 },
      yaw: 0, pitch: 0, onGround: state.dropHeight === 0,
    });
    sim.setInput({ skiHeld: true });
    sim.eyeHeight = 0.4; sim.bodyRadius = 0.4;
    balls.push(sim);
  }
  ballMesh.count = balls.length;
  ballMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  Object.assign(ballPeaks, { mean: 0, med: 0, p10: 0, p90: 0, max: 0, horiz: 0, abs: 0, vert: 0, vertAbs: 0 });
}
function clearBalls(): void { balls = []; ballMesh.count = 0; ballHud.textContent = 'balls: 0'; }
function tickBalls(dt: number): void {
  for (let i = 0; i < balls.length; i += 1) {
    const sim = balls[i]!;
    sim.update(dt);
    const s = sim.state;
    _pos.set(s.pos.x, s.pos.y - 0.4 + BEAM_H / 2, s.pos.z); // beam root at feet
    _m4.compose(_pos, _q.identity(), _scl);
    ballMesh.setMatrixAt(i, _m4);
    const v = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
    // cold→hot hue ramp: 0 m/s = deep blue, 60+ = red. Pick the HSL in
    // sRGB so the swatch reads as authored (working space is linear).
    _bc.setHSL(0.66 - 0.66 * Math.min(v / 60, 1), 0.95, 0.55, THREE.SRGBColorSpace);
    ballMesh.setColorAt(i, _bc);
  }
  ballMesh.instanceMatrix.needsUpdate = true;
  if (ballMesh.instanceColor) {ballMesh.instanceColor.needsUpdate = true;}
}

// --- play mode: drive ONE real MoveSim from the keyboard, first person.
// Same shared movement sim the game predicts with, so the ski/fall/jet
// feel is authentic. Always-ski (like the ball probe); Space jets.
let player: MoveSim | null = null;
let lookYaw = 0;
let lookPitch = -0.15;
let jumpEdge = false;
const held = new Set<string>();
addEventListener('keydown', (e: KeyboardEvent): void => {
  if (e.code === 'Space') {e.preventDefault();}
  if (!e.repeat) {if (e.code === 'Space') {jumpEdge = true;}}
  if (player && e.code === 'Escape') {exitPlay(); return;}
  held.add(e.code);
});
addEventListener('keyup', (e: KeyboardEvent): void => { held.delete(e.code); });
// Mouse look — pointer lock, same convention as the game (yaw gains going
// right, pitch gains looking up; MoveSim forward = (sin yaw, ·, cos yaw)).
addEventListener('mousemove', (e: MouseEvent): void => {
  if (!player || document.pointerLockElement !== renderer.domElement) {return;}
  lookYaw -= e.movementX * 0.0025;
  lookPitch = Math.max(-1.5, Math.min(1.5, lookPitch - e.movementY * 0.0025));
});
renderer.domElement.addEventListener('click', (): void => {
  if (player) {renderer.domElement.requestPointerLock();}
});
function enterPlay(): void {
  const x = 0, z = 0;
  player = new MoveSim(hmSurface(field), {
    pos: { x, y: hmHeight(field, x, z) + 2, z },
    vel: { x: 0, y: 0, z: 0 }, yaw: lookYaw, pitch: lookPitch, onGround: true,
  });
  player.setInput({ skiHeld: true });
  orbit.enabled = false;
  renderer.domElement.requestPointerLock();
  flash('play: WASD · space jet · mouse look · esc exit');
}
function exitPlay(): void {
  if (!player) {return;}
  const p = player.state.pos;
  player = null;
  document.exitPointerLock();
  held.clear();
  orbit.enabled = true;
  orbit.target.set(p.x, p.y, p.z);
  camera.position.set(p.x + 160, p.y + 110, p.z + 160);
  orbit.update();
}
function tickPlay(dt: number): void {
  const p = player!;
  const forward = (held.has('KeyW') ? 1 : 0) - (held.has('KeyS') ? 1 : 0);
  const right = (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0);
  const jet = held.has('Space');
  p.state.yaw = lookYaw; p.state.pitch = lookPitch;
  p.setInput({ forward, right, skiHeld: true, jetHeld: jet, jumpHeld: jet, jumpPressed: jumpEdge });
  jumpEdge = false;
  p.update(dt);
  camera.position.set(p.state.pos.x, p.state.pos.y, p.state.pos.z);
  camera.rotation.order = 'YXZ';
  camera.rotation.set(p.state.pitch, p.state.yaw + Math.PI, 0);
}

// --- pipeline ---
let field: ReturnType<typeof hmParseBin>;   // refresh()/loadMap() assign before the loop starts
let bakedBytes = new Uint8Array(8 + 4);
let drain: Drainage | null = null;          // last accumulation — the flow overlay
// Vertical gain of the DISPLAYED field: synth uses the slider, a loaded
// map uses its spec — paintHeightmap/the palette read this, not state.
let activeHeightScale = 1;
// Which map is currently painted — refresh() skips a redundant re-fetch
// when a synth slider pokes it while an existing map is on screen.
let loadedMap = '';

function refresh(): void {
  // An existing map is a fixed .bin, not a synth — fetch + paint it.
  if (state.map) {
    if (state.map !== loadedMap) { loadMap(state.map); }
    return;
  }
  loadedMap = '';
  const t0 = performance.now();
  const h = synthField(state);
  if (!state.showRaw) {
    faultPass(h, state.size, state);        // geometry: scarp before water reacts
    if (state.smoothIters > 0) { smoothPass(h, state.size, state.smoothIters); }
    streamPower(h, state.size, state);      // macro: coherent valley network
    if (state.droplets > 0) { erode(h, state.size, state); } // micro: gullies
    glacierPass(h, state.size, state);      // U-troughs on the drainage spine
    if (state.talus > 0) { talusPass(h, state.size, state); }
  }
  flatsPass(h, state.size, state);          // base pads level last — not erosion
  // Flow map for the overlay — computed on the DISPLAYED field so the
  // channels you see are the ones the surface actually drains.
  drain = state.flowOverlay ? drainage(h, state.size) : null;
  const N = state.size;
  const bytes = new Uint8Array(8 + N * N);
  for (let i = 0; i < N * N; i += 1) { bytes[8 + i] = Math.round(Math.min(1, Math.max(0, h[i]! * state.vscale)) * 255); }
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, N, true); dv.setUint32(4, N, true);
  bakedBytes = bytes;
  activeHeightScale = state.heightScale;
  field = hmParseBin(bytes, state.heightScale);
  mat.defines.TERRAIN_PRESET = state.preset; // synth palette = the slider
  mat.needsUpdate = true;
  paintField(performance.now() - t0);
}

// Fetch an existing map's spec + terrain .bin off /maps (the same route
// the game loads), then paint those bytes. Bails if the pick changed
// while the fetch was in flight — the dropdown can fire faster than the
// network. Palette preset falls back to the current slider when the spec
// omits terrainPreset.
async function loadMap(name: string): Promise<void> {
  const t0 = performance.now();
  try {
    const spec = await (await fetch(`/maps/${name}.json`, { cache: 'no-cache' })).json() as
      { terrain?: string; heightScale?: number; terrainPreset?: number };
    const file = spec.terrain ?? `${name}.bin`;
    const buf = new Uint8Array(await (await fetch(`/maps/${file}`, { cache: 'no-cache' })).arrayBuffer());
    if (state.map !== name) { return; }
    drain = null; // flow overlay is a synth product — an existing map has none
    activeHeightScale = spec.heightScale ?? 1;
    field = hmParseBin(buf, activeHeightScale);
    loadedMap = name;
    mat.defines.TERRAIN_PRESET = spec.terrainPreset ?? state.preset;
    mat.needsUpdate = true;
    paintField(performance.now() - t0);
    flash(`map ${name}`);
  } catch {
    flash(`map ${name} failed`);
  }
}

// Shared tail of refresh()/loadMap(): push the parsed field to the GPU
// palette, the mesh, the heightmap, the stats — and drop stale balls.
function paintField(ms: number): void {
  mat.uniforms.hscale.value = HM_HEIGHT_SCALE * activeHeightScale;
  clearBalls(); // field changed — old balls roll on stale terrain
  paintMesh();
  paintHeightmap();
  paintStats(ms);
}

// 3D mesh — displaced by the BAKED byte field through hmHeight (chord =
// the rendered clipmap the sim walks on). Vertex colors: slope ramp —
// ski-able flats read green, steep faces rock, tops snow.
const _n = { x: 0, y: 0, z: 0 };
function paintMesh(): void {
  for (let i = 0; i < posAttr.count; i += 1) {
    const x = posAttr.getX(i), z = posAttr.getZ(i);
    const y = hmHeight(field, x, z);
    posAttr.setY(i, y);
  }
  posAttr.needsUpdate = true;
  geo.computeVertexNormals();
}

// Hillshade relief — same picture hillshade.cjs emits for shipped maps,
// plus a red overlay where the face is too steep to ski (slope > ~0.8).
const hmcv = document.querySelector<HTMLCanvasElement>('#hmview')!;
const hmctx = hmcv.getContext('2d')!;
function paintHeightmap(): void {
  const N = field.size;
  hmcv.width = N; hmcv.height = N;
  hmctx.putImageData(hillshadeImage(field, {
    ws: WS,
    vmax: HM_HEIGHT_SCALE * state.vscale * activeHeightScale,
    steep: state.slopeOverlay,
    drain: drain ?? undefined,
  }), 0, 0);
}

const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const ballHud = document.createElement('div');
ballHud.style.cssText = 'position:fixed;right:8px;top:120px;color:#cde;font:11px monospace;text-align:right;z-index:10;text-shadow:0 1px 2px #000;pointer-events:none;white-space:pre;max-width:260px;';
document.body.append(ballHud);
const ballPeaks = { mean: 0, med: 0, p10: 0, p90: 0, max: 0, horiz: 0, abs: 0, vert: 0, vertAbs: 0 };
let ballHudT = 0;
// Ski-ball aggregate — mean/p90 speed + the fast share, reported in the
// status once the probe has run ~4s. The only metric that captures route
// connectivity (dead-end bowls trap balls even at good slope).
let skiLine = '';
let skiT = 0;
function skiScore(dt: number): void {
  skiT += dt;
  if (skiT < 4 || balls.length === 0) {return;}
  const vs = balls.map((b) => Math.hypot(b.state.vel.x, b.state.vel.y, b.state.vel.z)).sort((a, b) => a - b);
  const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
  const p90 = vs[Math.floor(vs.length * 0.9)]!;
  const fast = vs.filter((v) => v >= 45).length / vs.length;
  skiLine = `ski μ${mean.toFixed(0)} p90 ${p90.toFixed(0)} · ${(fast * 100).toFixed(0)}% fast`;
  skiT = 3.5; // update ~2×/s after warm-up
}
function updateBallHud(): void {
  if (balls.length === 0) { ballHud.textContent = 'balls: 0'; return; }
  const speeds = balls.map((b) => Math.hypot(b.state.vel.x, b.state.vel.y, b.state.vel.z));
  const horiz = balls.map((b) => Math.hypot(b.state.vel.x, b.state.vel.z));
  const vert = balls.map((b) => b.state.vel.y);
  const vertAbs = balls.map((b) => Math.abs(b.state.vel.y));
  const absSpeeds = balls.map((b) => Math.abs(b.state.vel.x) + Math.abs(b.state.vel.y) + Math.abs(b.state.vel.z));
  speeds.sort((a, b) => a - b);
  const n = speeds.length;
  const mean = speeds.reduce((a, b) => a + b, 0) / n;
  const med = speeds[Math.floor(n * 0.5)]!;
  const p10 = speeds[Math.floor(n * 0.1)]!;
  const p90 = speeds[Math.floor(n * 0.9)]!;
  const max = speeds[n - 1]!;
  const horizMean = horiz.reduce((a, b) => a + b, 0) / n;
  const absMean = absSpeeds.reduce((a, b) => a + b, 0) / n;
  const vertMean = vert.reduce((a, b) => a + b, 0) / n;
  const vertAbsMean = vertAbs.reduce((a, b) => a + b, 0) / n;
  ballPeaks.mean = Math.max(ballPeaks.mean, mean);
  ballPeaks.med = Math.max(ballPeaks.med, med);
  ballPeaks.p10 = Math.max(ballPeaks.p10, p10);
  ballPeaks.p90 = Math.max(ballPeaks.p90, p90);
  ballPeaks.max = Math.max(ballPeaks.max, max);
  ballPeaks.horiz = Math.max(ballPeaks.horiz, horizMean);
  ballPeaks.abs = Math.max(ballPeaks.abs, absMean);
  ballPeaks.vert = Math.max(ballPeaks.vert, Math.abs(vertMean));
  ballPeaks.vertAbs = Math.max(ballPeaks.vertAbs, vertAbsMean);
  ballHud.textContent =
    `balls ${  n 
    }\nV mean ${  mean.toFixed(0)  } (peak ${  ballPeaks.mean.toFixed(0)  })` +
    `\nmed ${  med.toFixed(0)  }  p10 ${  p10.toFixed(0)  }  p90 ${  p90.toFixed(0) 
    }\ntop ${  max.toFixed(0)  } (peak ${  ballPeaks.max.toFixed(0)  })` +
    `\n|V|sum ${  absMean.toFixed(0)  } (peak ${  ballPeaks.abs.toFixed(0)  })` +
    `\nVxy mean ${  horizMean.toFixed(0)  } (peak ${  ballPeaks.horiz.toFixed(0)  })` +
    `\nVy mean ${  vertMean.toFixed(0)  }  |Vy| mean ${  vertAbsMean.toFixed(0)}`;
}

function paintStats(genMs: number): void {
  // Field stats in world units — the signature terrainstats.js measures
  // on shipped maps: relief + sd + mean slope + steep share, tagged with
  // the Tribes band the field lands in (roller/dramatic/mixed).
  let mn = Infinity, mx = -Infinity, sum = 0, sum2 = 0, slopeSum = 0, steep = 0, n = 0;
  for (let z = 0; z < field.size; z += 8) {
    for (let x = 0; x < field.size; x += 8) {
      const wx = (x / field.size - 0.5) * WS, wz = (z / field.size - 0.5) * WS;
      const h = hmHeight(field, wx, wz);
      hmNormal(field, wx, wz, _n);
      const deg = Math.atan(Math.hypot(_n.x, _n.z) / _n.y) * 180 / Math.PI;
      if (h < mn) { mn = h; } if (h > mx) { mx = h; }
      sum += h; sum2 += h * h;
      slopeSum += deg; if (deg > 45) { steep += 1; }
      n += 1;
    }
  }
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  const meanDeg = slopeSum / n;
  const steepPct = steep / n * 100;
  // Shipped bands (terrainstats.js, 10 fields): rollers ≈ sd 19-35,
  // steep ≤7%; dramatic ≈ sd 30-47, steep ≥18%. Anything else is mixed.
  const style = steepPct >= 18 ? 'dramatic' : (steepPct <= 8 && sd <= 38 ? 'roller' : 'mixed');
  statusEl.innerHTML =
    `${state.map ? `map ${state.map} · ${field.size}²` : `seed ${state.seed} · ${field.size}²`} · ${genMs.toFixed(0)}ms
` +
    `relief ${(mx - mn).toFixed(0)}m · sd ${sd.toFixed(1)}m
` +
    `slope ${meanDeg.toFixed(1)}° · steep ${steepPct.toFixed(1)}% · ${style}
${ 
    skiLine ? `${skiLine}
` : ''}`;
}

// --- rail UI ---
const rail = document.querySelector<HTMLDivElement>('#rail')!;
type SliderDef = [key: keyof GenParams | 'heightScale', label: string, min: number, max: number, step: number, group?: string];
const SLIDERS: SliderDef[] = [
  ['size', 'grid size', 65, 513, 64],
  ['seed', 'seed', 0, 9999, 1],
  ['freq', 'base freq', 0.4, 3, 0.05],
  ['detail', 'detail', 0, 2, 0.05],
  ['warp', 'warp', 0, 2, 0.05],
  ['curl', 'curl warp', 0, 1, 0.05],
  ['ridge', 'ridged', 0, 1, 0.05],
  ['elong', 'elongate', 1, 8, 0.25],
  ['smoothIters', 'creep', 0, 40, 2],
  ['fault', 'fault', -0.4, 0.4, 0.02, 'shape'],
  ['faultAngle', 'fault angle', 0, 180, 5],
  ['tilt', 'tilt', 0, 1, 0.05],
  ['bowlR', 'bowl r', 0, 600, 10],
  ['bowlDepth', 'bowl depth', 0, 1, 0.05],
  ['plateauR', 'mesa r', 0, 600, 10],
  ['plateauLift', 'mesa lift', 0, 1, 0.05],
  ['seaR', 'sea r', 0, 750, 10],
  ['seaDepth', 'sea depth', 0, 1, 0.05],
  ['flats', 'base pads', 0, 6, 1],
  ['padR', 'pad radius', 10, 80, 5],
  ['stream', 'stream power', 0, 2, 0.05, 'erosion'],
  ['streamIters', 'stream iters', 0, 10, 1],
  ['droplets', 'droplets k', 0, 400, 5],
  ['inertia', 'inertia', 0, 1, 0.05],
  ['erodeRate', 'erode rate', 0, 1, 0.05],
  ['depositRate', 'deposit', 0, 1, 0.05],
  ['capacity', 'capacity', 0, 10, 0.25],
  ['evap', 'evaporation', 0, 0.1, 0.005],
  ['glacier', 'glacier', 0, 1, 0.05],
  ['talus', 'talus iters', 0, 60, 2],
  ['talusAngle', 'talus angle', 0.005, 0.1, 0.005],
  ['vscale', 'u8 gain', 0.2, 1, 0.05, 'output'],
  ['heightScale', 'heightScale', 0.5, 3, 0.1],
];

let regenT: ReturnType<typeof setTimeout> | undefined;
function schedule(): void {
  clearTimeout(regenT);
  regenT = setTimeout(refresh, 120);
}

// --- terrain picker: custom synth, or an existing maps/<name>.bin off
// the same /maps route the game loads. The list arrives async; paintRail
// repaints once it lands. Falls back to custom-only if the server is down.
let mapNames: string[] = [];
let mapT2: boolean[] = [];
async function loadMapList(): Promise<void> {
  try {
    const rows = await (await fetch('/maps', { cache: 'no-cache' })).json() as { name: string; hidden?: boolean; t2?: boolean; t1?: boolean }[];
    const filtered = rows.filter((r): boolean => !r.hidden);
    const grouped = filtered.toSorted((a, b): number => {
      const ta = (a.t2 || a.t1) ? 1 : 0, tb = (b.t2 || b.t1) ? 1 : 0;
      if (ta !== tb) {return ta - tb;}
      return a.name.localeCompare(b.name);
    });
    mapNames = grouped.map((r) => r.name);
    mapT2 = grouped.map((r) => (r.t2 || r.t1) === true);
    paintRail();
  } catch {
    flash('maps list unavailable — custom only');
  }
}

function terrainSelect(): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'terrainsel';
  const custom = document.createElement('option');
  custom.value = ''; custom.textContent = state.map ? 'custom (synth)' : 'custom (synth) ▸';
  if (!state.map) {custom.selected = true;}
  sel.append(custom);
  for (const name of mapNames) {
    const o = document.createElement('option');
    o.value = name; const isT2 = mapT2[mapNames.indexOf(name)] === true; o.textContent = (isT2 ? '[T2] ' : '[C] ') + name;
    if (state.map === name) {o.selected = true;}
    sel.append(o);
  }
  sel.addEventListener('change', (): void => {
    state.map = sel.value; save(); refresh(); paintRail();
  });
  return sel;
}

// Full-width first-person ski toggle — sits at the top of the rail next to
// the terrain picker because it's the headline action on the page.
function playButton(): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = player ? '⛷ stop' : '⛷ play';
  if (player) {b.classList.add('active');}
  b.addEventListener('click', (): void => {
    if (player) {exitPlay();} else {enterPlay();}
    paintRail();
  });
  return b;
}

// Noise archetype select — fBm / billow / swiss / jordan per-octave
// shaping (gen.ts `shape`). Same row pattern as the tilt-axis select.
function noiseRow(): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('label'); lab.textContent = 'noise';
  const sel = document.createElement('select');
  for (const [v, label] of [[0, 'fBm'], [1, 'billow'], [2, 'swiss'], [3, 'jordan']] as [number, string][]) {
    const o = document.createElement('option'); o.value = String(v); o.textContent = label;
    if (state.noiseType === v) {o.selected = true;}
    sel.append(o);
  }
  sel.addEventListener('change', (): void => { state.noiseType = Number(sel.value); save(); schedule(); });
  row.append(lab, sel);
  return row;
}

function stepMap(dir: number): void {
  if (mapNames.length === 0) {return;}
  const idx = mapNames.indexOf(state.map);
  let nextIdx: number;
  if (idx === -1) { nextIdx = dir > 0 ? 0 : mapNames.length - 1; }
  else { nextIdx = (idx + dir + mapNames.length) % mapNames.length; }
  state.map = mapNames[nextIdx]!; save(); refresh(); paintRail();
}

function paintRail(): void {
  rail.innerHTML = '';
  const nav = document.createElement('div'); nav.className = 'terrnav';
  const prev = document.createElement('button'); prev.textContent = '\u25C0';
  prev.addEventListener('click', (): void => { stepMap(-1); });
  const sel = terrainSelect();
  const next = document.createElement('button'); next.textContent = '\u25B6';
  next.addEventListener('click', (): void => { stepMap(1); });
  nav.append(prev, sel, next); rail.append(nav);
  let group = '';
  for (const [key, label, min, max, step, g] of SLIDERS) {
    if (g && g !== group) {
      group = g;
      const d = document.createElement('div');
      d.className = 'group'; d.textContent = g;
      rail.append(d);
    }
    const row = document.createElement('div');
    row.className = 'row';
    const lab = document.createElement('label');
    lab.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = String(min); inp.max = String(max); inp.step = String(step);
    inp.value = String(state[key]);
    const val = document.createElement('span');
    val.textContent = key === 'droplets'
      ? `${(Number(state[key])).toFixed(0)}k`
      : Number(state[key]).toFixed(step >= 1 ? 0 : 2);
    inp.addEventListener('input', (): void => {
      (state as unknown as Record<string, unknown>)[key] = Number(inp.value);
      val.textContent = key === 'droplets' ? `${Number(inp.value).toFixed(0)}k` : Number(inp.value).toFixed(step >= 1 ? 0 : 2);
      save(); schedule();
    });
    row.append(lab, inp, val);
    rail.append(row);
  }
  rail.append(presetRow());
  rail.append(styleRow());
  rail.append(noiseRow());
  rail.append(tiltRow());

  // Probe-only control (not a GenParams key) — must NOT call schedule(),
  // so it lives here instead of SLIDERS. Re-drops live balls on release.
  rail.append(dropHeightRow());
  rail.append(dbgStageRow());
  // lit-knee tuning — live uniforms, no regen. See terrainShaders desert block.
  for (const [key, min, max] of [['litKnee', 0.5, 1], ['litKeep', 0, 0.6], ['colCap', 0.9, 1]] as const) {
    rail.append(uniformRow(key, min, max));
  }

  const btns = document.createElement('div');
  btns.className = 'group'; btns.textContent = 'view + export';
  rail.append(btns);
  const row1 = document.createElement('div'); row1.className = 'btnrow';
  const mk = (label: string, fn: () => void, active = false): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = label;
    if (active) {b.classList.add('active');}
    b.addEventListener('click', fn);
    return b;
  };
  row1.append(
    playButton(),
    mk(state.showRaw ? 'A/B: raw' : 'A/B: eroded', function (this: HTMLButtonElement): void {
      state.showRaw = !state.showRaw; save(); paintRail(); refresh();
    }, state.showRaw),
    mk('wireframe', function (this: HTMLButtonElement): void {
      state.wire = !state.wire; mat.wireframe = state.wire; save(); paintRail();
    }, state.wire),
    mk('slope tint', function (this: HTMLButtonElement): void {
      state.slopeOverlay = !state.slopeOverlay; save(); paintRail(); paintHeightmap();
    }, state.slopeOverlay),
    mk('flow map', function (this: HTMLButtonElement): void {
      state.flowOverlay = !state.flowOverlay; save(); paintRail(); refresh();
    }, state.flowOverlay),
  );
  rail.append(row1);
  const row2 = document.createElement('div'); row2.className = 'btnrow';
  row2.append(
    mk('🎲 seed', (): void => {
      state.seed = Math.floor(Math.random() * 9999); save(); paintRail(); refresh();
    }),
    mk('⬇ .bin', (): void => {
      const blob = new Blob([bakedBytes.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `maplab_s${state.seed}.bin`;
      a.click();
      URL.revokeObjectURL(a.href);
      flash('bin downloaded');
    }),
    mk('copy spec', async (): Promise<void> => {
      const spec = { terrain: `maplab_s${state.seed}.bin`, heightScale: state.heightScale, terrainPreset: state.preset };
      await navigator.clipboard?.writeText(JSON.stringify(spec, null, 2));
      flash('spec → clipboard');
    }),
    mk('copy params', async (): Promise<void> => {
      // Full knob set (synth params + heightScale + preset) so an AI
      // or a teammate can reproduce the field exactly.
      const params = Object.assign({}, state);
      await navigator.clipboard?.writeText(JSON.stringify(params, null, 2));
      flash('params -> clipboard');
    }),
    mk('⛸ balls', function (this: HTMLButtonElement): void {
      if (balls.length > 0) { clearBalls(); this.classList.remove('active'); }
      else { dropBalls(); this.classList.add('active'); }
    }),
  );
  rail.append(row2);
  const note = document.createElement('div');
  note.style.cssText = 'opacity:.45;margin-top:8px;line-height:1.5';
  note.textContent = 'droplets>0 erodes live · A/B flips raw↔eroded · .bin = maps/<name>.bin format · same lattice as genmap.js';
  rail.append(note);
}

// Spawn-height slider for the ski-ball probe. Deliberately outside
// paintRail's SLIDERS loop: changing it must NOT regenerate the field,
// and re-dropping live balls happens on release ('change'), not drag.
function dropHeightRow(): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('label'); lab.textContent = 'ball drop ht';
  const inp = document.createElement('input');
  inp.type = 'range'; inp.min = '0'; inp.max = '1200'; inp.step = '25';
  inp.value = String(state.dropHeight);
  const val = document.createElement('span'); val.textContent = String(state.dropHeight);
  inp.addEventListener('input', (): void => {
    state.dropHeight = Number(inp.value); val.textContent = String(state.dropHeight); save();
  });
  inp.addEventListener('change', (): void => { if (balls.length > 0) {dropBalls();} });
  row.append(lab, inp, val);
  return row;
}

// Shader stage bisect (desert preset only): -1 full pipeline, then
// 0 palette / 1 detail / 2 decals / 3 lit / 4 glows / 5 seaTint / 6 fog,
// 7 sun·diff² / 8 amb+rim / 9 shadowMask alone.
const DBG_NAMES = ['palette', 'detail', 'decals', 'lit', 'glows', 'seaTint', 'fog', 'sun·diff²', 'amb+rim', 'shadowMsk'];
function dbgStageRow(): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('label'); lab.textContent = 'dbg stage';
  const inp = document.createElement('input');
  inp.type = 'range'; inp.min = '-1'; inp.max = '9'; inp.step = '1';
  inp.value = String(mat.uniforms.dbgStage!.value as number);
  const val = document.createElement('span'); val.textContent = 'off';
  inp.addEventListener('input', (): void => {
    const v = Number(inp.value);
    mat.uniforms.dbgStage!.value = v;
    val.textContent = v < 0 ? 'off' : `${v}: ${DBG_NAMES[v] ?? '?'}`;
  });
  row.append(lab, inp, val);
  return row;
}

function presetRow(): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('label'); lab.textContent = 'terrain';
  const sel = document.createElement('select');
  const PRESETS: [number, string][] = [[0, 'mixed'], [1, 'desert'], [2, 'grassland'], [3, 'snow'], [4, 'volcanic'], [5, 'badlands'], [6, 'coast'], [7, 'desert sun']];
  for (const [v, label] of PRESETS) {
    const o = document.createElement('option'); o.value = String(v); o.textContent = label;
    if (state.preset === v) {o.selected = true;}
    sel.append(o);
  }
  sel.addEventListener('change', (): void => {
    state.preset = Number(sel.value);
    mat.defines.TERRAIN_PRESET = state.preset;
    mat.needsUpdate = true; // preset is a compile-time define — recompiles once
    save();
  });
  row.append(lab, sel);
  return row;
}

// Style bundles — param sets tuned against the shipped maps' measured
// stats (terrainstats.js). One pick → the field lands in the genre band;
// sliders stay free to diverge after.
function styleRow(): HTMLDivElement {
  const BUNDLES: Record<string, Partial<GenParams & { heightScale: number; preset: number }>> = {
    roller: { freq: 0.8, detail: 0.7, warp: 0.6, ridge: 0, curl: 0.4, elong: 1, smoothIters: 6, droplets: 25, stream: 0.6, talus: 8, heightScale: 1, preset: 2 },
    dramatic: { freq: 1, detail: 1.2, warp: 0.8, ridge: 0.5, curl: 0.5, stream: 1.5, streamIters: 4, droplets: 40, fault: 0.2, faultAngle: 115, talus: 14, heightScale: 1.9, preset: 5 },
    dunes: { freq: 0.7, detail: 0.4, warp: 0.3, ridge: 0, elong: 5, smoothIters: 10, droplets: 0, stream: 0, heightScale: 1, preset: 1 },
    bowl: { freq: 0.6, detail: 0.8, warp: 0.5, ridge: 0.4, seaR: 520, seaDepth: 0.55, plateauR: 240, plateauLift: 0.5, stream: 0.8, heightScale: 1.6, preset: 4 },
    coast: { freq: 0.8, detail: 0.9, warp: 0.6, ridge: 0.2, seaR: 420, seaDepth: 0.5, plateauR: 180, plateauLift: 0.4, stream: 0.7, droplets: 30, heightScale: 1.2, preset: 6 },
  };
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('label'); lab.textContent = 'style';
  const sel = document.createElement('select');
  const none = document.createElement('option');
  none.value = ''; none.textContent = 'apply a style…';
  sel.append(none);
  for (const k of Object.keys(BUNDLES)) {
    const o = document.createElement('option'); o.value = k; o.textContent = k;
    sel.append(o);
  }
  sel.addEventListener('change', (): void => {
    const b = BUNDLES[sel.value];
    if (!b) {return;}
    state.map = '';           // styles are synth-side, drop any loaded map
    Object.assign(state, b);
    save(); refresh(); paintRail();
  });
  row.append(lab, sel);
  return row;
}

function tiltRow(): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('label'); lab.textContent = 'tilt axis';
  const sel = document.createElement('select');
  for (const a of ['x', 'z']) {
    const o = document.createElement('option'); o.value = a; o.textContent = a;
    if (state.tiltAxis === a) {o.selected = true;}
    sel.append(o);
  }
  sel.addEventListener('change', (): void => { state.tiltAxis = sel.value as 'x' | 'z'; save(); schedule(); });
  row.append(lab, sel);
  return row;
}

function uniformRow(key: string, min: number, max: number): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('label'); lab.textContent = key;
  const inp = document.createElement('input');
  inp.type = 'range'; inp.min = String(min); inp.max = String(max); inp.step = '0.01';
  inp.value = String(mat.uniforms[key]!.value as number);
  const val = document.createElement('span'); val.textContent = inp.value;
  inp.addEventListener('input', (): void => {
    mat.uniforms[key]!.value = Number(inp.value);
    val.textContent = inp.value;
  });
  row.append(lab, inp, val);
  return row;
}

function flash(msg: string): void {
  const s = document.createElement('span');
  s.className = 'hot'; s.textContent = ` ${msg}`;
  statusEl.append(s);
  setTimeout((): void => { s.remove(); }, 1500);
}

addEventListener('resize', (): void => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

paintRail();
refresh();
loadMapList();
mat.wireframe = state.wire;
const clock = new THREE.Clock();
const fpsEl = document.querySelector<HTMLDivElement>('#fps')!;
let fpsFrames = 0, fpsT = 0;
renderer.setAnimationLoop((): void => {
  const dt = Math.min(clock.getDelta(), 0.1);
  fpsFrames += 1; fpsT += dt;
  if (fpsT >= 0.5) { fpsEl.textContent = `${Math.round(fpsFrames / fpsT)} fps`; fpsFrames = 0; fpsT = 0; }
  if (player) {tickPlay(dt);} else {orbit.update();}
  if (balls.length > 0) {tickBalls(dt); skiScore(dt); ballHudT += dt; if (ballHudT >= 0.25) { ballHudT = 0; updateBallHud(); } }
  renderer.render(scene, camera);
});
(window as any).__maplab = { state, refresh, field: () => field };
