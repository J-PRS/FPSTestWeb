/* oxlint-disable typescript/no-explicit-any -- window debug handle */
// maplab - live terrain synth viewer (/maplab.html). Sliders → seeded
// field synth + hydraulic erosion → heightmap relief + a 3D view built
// from the same baked bytes the sim reads, so the preview IS the physics.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { hmParseBin, hmHeight, hmNormal, hmSurface, HM_HEIGHT_SCALE } from '../../shared/heightfield.js';
import { MoveSim } from '../../shared/movement.js';
import { terrainFrag } from './world/terrainShaders.js';
import { hillshadeImage } from './world/hillshade.js';
import { synthField, erode, talusPass, streamPower, drainage, faultPass, glacierPass, smoothPass, flatsPass, rockPass, playaPass, dunesPass, terracePass, cliffPass, fanPass, floodPass, sinkPass, sharpenPass, foldPass, platesPass, canyonPass, snowPass, lakePass, slumpPass, ruggedPass, contrastPass, stretchPass, breachPass, scramblePass, DEFAULTS, type GenParams, type Drainage } from './maplab/gen.js';

// Player-facing lab: served on prod too - no isDevHost gate on the entry.

const state: GenParams & { heightScale: number; preset: number; showRaw: boolean; wire: boolean; slopeOverlay: boolean; flowOverlay: boolean; dropHeight: number; ballTerm: number; map: string; verbs: string[] } =
  Object.assign({}, DEFAULTS, { heightScale: 1, preset: 1, showRaw: false, wire: false, slopeOverlay: true, flowOverlay: true, dropHeight: 0, ballTerm: 100, map: '', verbs: [] });
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
// The REAL terrain fragment shader - the plane is authored in world
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
// Frame grid - the tile edge, so wrap-seams read at a glance.
const frame = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.PlaneGeometry(WS, WS).rotateX(-Math.PI / 2)),
  new THREE.LineBasicMaterial({ color: 0x55_AA_FF }),
);
frame.position.y = 1;
scene.add(frame);

const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;

// --- ski-ball probe: frictionless MoveSim ice cubes (skiHeld, inelastic
// landings) - same physics as _tools/sweeps/skiProbe.ts, watched live.
// Each ball is a vertical loot-beam (Borderlands style): a thin glow
// pillar, hue-ramped cold→hot by speed, visible through terrain.
// Alpha blend, NOT additive: additive over the bright terrain palette
// sums every overlapping hue to white (the smear this used to read as),
// and ACES tone mapping flattens what's left - toneMapped:false keeps
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
    sim.terminalVelocity = state.ballTerm;
    balls.push(sim);
    ballStart.push({ x, z });
    ballPath.push([x, z]);
    ballPeak.push(0);
  }
  ballMesh.count = balls.length;
  ballMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  Object.assign(ballPeaks, { mean: 0, med: 0, p10: 0, p90: 0, max: 0, horiz: 0, abs: 0, vert: 0, vertAbs: 0 });
}
const ballDist: number[] = []; // per-ball horizontal distance covered (m)
const ballPeak: number[] = []; // per-ball top speed
const ballStart: { x: number; z: number }[] = [];
const ballPath: number[][] = [];   // flat [x,z,x,z...] trail for the minimap
function clearBalls(): void {
  balls = []; ballDist.length = 0; ballPeak.length = 0;
  ballStart.length = 0; ballPath.length = 0;
  ballMesh.count = 0; ballHud.textContent = 'balls: 0';
}
function tickBalls(dt: number): void {
  for (let i = 0; i < balls.length; i += 1) {
    const sim = balls[i]!;
    sim.update(dt);
    const s = sim.state;
    _pos.set(s.pos.x, s.pos.y - 0.4 + BEAM_H / 2, s.pos.z); // beam root at feet
    _m4.compose(_pos, _q.identity(), _scl);
    ballMesh.setMatrixAt(i, _m4);
    ballDist[i] = (ballDist[i] ?? 0) + Math.hypot(s.vel.x, s.vel.z) * dt;
    ballPeak[i] = Math.max(ballPeak[i] ?? 0, Math.hypot(s.vel.x, s.vel.z));
    const path = ballPath[i]!;
    const pl = path.length;
    if (Math.hypot(s.pos.x - path[pl - 2]!, s.pos.z - path[pl - 1]!) > 5 && pl < 800) {
      path.push(s.pos.x, s.pos.z);
    }
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
// Mouse look - pointer lock, same convention as the game (yaw gains going
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
let drain: Drainage | null = null;          // last accumulation - the flow overlay
// Vertical gain of the DISPLAYED field: synth uses the slider, a loaded
// map uses its spec - paintHeightmap/the palette read this, not state.
let activeHeightScale = 1;
// Which map is currently painted - refresh() skips a redundant re-fetch
// when a synth slider pokes it while an existing map is on screen.
let loadedMap = '';

// --- verbs: one-shot ops that replay cumulatively on every refresh ---
// The bake-chain sims (simrock/simwater/simsand) as buttons - the log
// persists in state, so sliders keep working and verbs layer on top.
// Each verb's seed derives from its log position, so replay is exact.
const VERBS: Record<string, (h: Float32Array, N: number, i: number) => void> = {
  rock:    (h, N, i) => rockPass(h, N, { rocks: 12, radius: 36, depth: 0.18, seed: state.seed * 31 + i }),
  scree:   (h, N) => talusPass(h, N, { ...state, talus: 6, talusAngle: 0.008 }),
  streams: (h, N) => streamPower(h, N, { ...state, stream: 1.8, streamIters: 5 }),
  erode:   (h, N) => erode(h, N, { ...state, droplets: Math.max(state.droplets, 200), erodeRate: Math.max(state.erodeRate, 0.5), capacity: Math.max(state.capacity, 6) }),
  smooth:  (h, N) => smoothPass(h, N, 4),
  glacier: (h, N) => glacierPass(h, N, { ...state, glacier: 0.5 }),
  playa:   (h, N) => playaPass(h, N),
  dunes:   (h, N) => dunesPass(h, N),
  terrace: (h, N) => terracePass(h, N),
  meteor:  (h, N, i) => { // big impacts first so small ones pit their floors
    rockPass(h, N, { rocks: 2, radius: 60, depth: 0.2, seed: state.seed * 31 + i });
    rockPass(h, N, { rocks: 14, radius: 16, depth: 0.1, seed: state.seed * 37 + i + 1 });
  },
  cliff:   (h, N) => cliffPass(h, N),
  fan:     (h, N) => fanPass(h, N),
  flood:   (h, N) => floodPass(h, N),
  sink:    (h, N) => sinkPass(h, N),
  sharpen: (h, N) => sharpenPass(h, N),
  fold:    (h, N) => foldPass(h, N),
  plates:  (h, N) => platesPass(h, N),
  canyon:  (h, N) => canyonPass(h, N),
  snow:    (h, N) => snowPass(h, N),
  lake:    (h, N) => lakePass(h, N),
  slump:   (h, N) => slumpPass(h, N),
  rugged:  (h, N) => ruggedPass(h, N),
  uplift:  (h, N) => { for (let i = 0; i < N * N; i += 1) { h[i] = h[i]! ** 0.7; } },
  contrast:(h, N) => contrastPass(h, N),
  stretch: (h, N) => stretchPass(h, N),
  breach:  (h, N) => breachPass(h, N),
  scramble:(h, N, i) => scramblePass(h, N, 12, state.seed * 53 + i),
};
function applyVerbs(h: Float32Array, N: number): void {
  state.verbs.forEach((op, i) => { VERBS[op]?.(h, N, i); });
}
function addVerb(op: string): void {
  state.verbs.push(op); save(); schedule();
}

function refresh(): void {
  // An existing map is a fixed .bin, not a synth - fetch + paint it.
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
  flatsPass(h, state.size, state);          // base pads level last - not erosion
  applyVerbs(h, state.size);                // one-shot ops replayed on top
  // Flow map for the overlay - computed on the DISPLAYED field so the
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
// while the fetch was in flight - the dropdown can fire faster than the
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
    // Verbs apply to loaded maps too - decode → mutate → re-encode so
    // hmParseBin sees the edited field (the shipped .bin stays untouched).
    if (state.verbs.length > 0) {
      const N = new DataView(buf.buffer, buf.byteOffset).getUint32(0, true);
      const h = new Float32Array(N * N);
      for (let i = 0; i < N * N; i += 1) { h[i] = buf[8 + i]! / 255; }
      applyVerbs(h, N);
      for (let i = 0; i < N * N; i += 1) { buf[8 + i] = Math.round(Math.min(1, Math.max(0, h[i]!)) * 255); }
    }
    drain = null; // flow overlay is a synth product - an existing map has none
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
// palette, the mesh, the heightmap, the stats - and drop stale balls.
function paintField(ms: number): void {
  mat.uniforms.hscale.value = HM_HEIGHT_SCALE * activeHeightScale;
  clearBalls(); // field changed - old balls roll on stale terrain
  paintMesh();
  paintHeightmap();
  paintStats(ms);
}

// 3D mesh - displaced by the BAKED byte field through hmHeight (chord =
// the rendered clipmap the sim walks on). Vertex colors: slope ramp -
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

// Hillshade relief - same picture hillshade.cjs emits for shipped maps,
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
ballHud.style.cssText = 'position:fixed;right:258px;top:120px;color:#cde;font:11px monospace;text-align:right;z-index:10;text-shadow:0 1px 2px #000;pointer-events:none;white-space:pre;max-width:260px;';
document.body.append(ballHud);
const ballPeaks = { mean: 0, med: 0, p10: 0, p90: 0, max: 0, horiz: 0, abs: 0, vert: 0, vertAbs: 0 };
let ballHudT = 0;
// Ski-ball aggregate - mean/p90 speed + the fast share, reported in the
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
  const stall = horiz.filter((v) => v < 3).length / n;
  let dispMean = 0;
  for (let i = 0; i < n; i += 1) {
    dispMean += Math.hypot(balls[i]!.state.pos.x - ballStart[i]!.x, balls[i]!.state.pos.z - ballStart[i]!.z);
  }
  dispMean /= n;
  const distMean = ballDist.reduce((a, b) => a + b, 0) / Math.max(1, ballDist.length);
  const tort = distMean / Math.max(1, dispMean); // 1 = straight routes; high = circling bowls
  const peaks = ballPeak.slice(0, n).sort((a, b) => a - b);
  drawBallTrails();
  ballHud.textContent =
    `balls ${  n 
    }\nV mean ${  mean.toFixed(0)  } (peak ${  ballPeaks.mean.toFixed(0)  })` +
    `\nmed ${  med.toFixed(0)  }  p10 ${  p10.toFixed(0)  }  p90 ${  p90.toFixed(0) 
    }\ntop ${  max.toFixed(0)  } (peak ${  ballPeaks.max.toFixed(0)  })` +
    `\n|V|sum ${  absMean.toFixed(0)  } (peak ${  ballPeaks.abs.toFixed(0)  })` +
    `\nVxy mean ${  horizMean.toFixed(0)  } (peak ${  ballPeaks.horiz.toFixed(0)  })` +
    `\nVy mean ${  vertMean.toFixed(0)  }  |Vy| mean ${  vertAbsMean.toFixed(0)}` +
    `\nXZ dist mean ${  (ballDist.reduce((a, b) => a + b, 0) / Math.max(1, ballDist.length)).toFixed(0)  }  max ${  Math.max(0, ...ballDist).toFixed(0)}` +
    `\ndisp mean ${  dispMean.toFixed(0)  }  tort ${  tort.toFixed(2)  }  stall ${  (stall * 100).toFixed(0)  }%` +
    `\npeakV p50 ${  peaks[Math.floor(n * 0.5)]!.toFixed(0)  }  p90 ${  peaks[Math.floor(n * 0.9)]!.toFixed(0)  }`;
}

// Ball trails over the minimap - the ski-line test made visible: live
// routes show as long strokes, dead-end bowls as tight scribbles.
function drawBallTrails(): void {
  const ws = field.worldScale ?? WS;
  const s = hmcv.width / ws;
  hmctx.save();
  hmctx.lineWidth = 1;
  hmctx.strokeStyle = 'rgba(255,120,40,0.55)';
  for (const path of ballPath) {
    if (path.length < 4) { continue; }
    hmctx.beginPath();
    hmctx.moveTo((path[0]! * s + hmcv.width / 2), (path[1]! * s + hmcv.height / 2));
    for (let i = 2; i < path.length; i += 2) {
      hmctx.lineTo(path[i]! * s + hmcv.width / 2, path[i + 1]! * s + hmcv.height / 2);
    }
    hmctx.stroke();
  }
  hmctx.restore();
}

function paintStats(genMs: number): void {
  // Field stats in world units - the signature terrainstats.js measures
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
// Right rail - actions (view/export) + the verb rack; params stay left.
const rail2 = document.querySelector<HTMLDivElement>('#rail2')!;

// Hover tooltip - one shared div, delegated; any element with data-tip
// gets the blurb at its right edge (the rail clips ::after tooltips).
const tipEl = document.querySelector<HTMLDivElement>('#tip')!;
document.addEventListener('mouseover', (e): void => {
  const t = (e.target as HTMLElement).closest?.('[data-tip]') as HTMLElement | null;
  if (!t) { tipEl.style.opacity = '0'; return; }
  tipEl.textContent = t.dataset.tip!;
  const r = t.getBoundingClientRect();
  tipEl.style.top = `${r.top}px`;
  // Right-rail items tip leftward - right+8 would overflow the edge.
  tipEl.style.left = t.closest('#rail2')
    ? `${r.left - tipEl.offsetWidth - 8}px`
    : `${r.right + 8}px`;
  tipEl.style.opacity = '1';
});
document.addEventListener('mouseout', (e): void => {
  if ((e.target as HTMLElement).closest?.('[data-tip]')) { tipEl.style.opacity = '0'; }
});
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
  ['tilt', 'tilt', -1, 1, 0.05],
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
  ['heightScale', 'heightScale', 0.5, 12, 0.1],
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
// Picker filter - 'custom' = shipped [C] maps, 'tribes' = T1/T2 ports.
let mapFilter: 'all' | 'custom' | 'tribes' = 'all';
const visMaps = (): { name: string; isT2: boolean }[] =>
  mapNames.map((n, i): { name: string; isT2: boolean } => ({ name: n, isT2: mapT2[i]! }))
    .filter((m): boolean => mapFilter === 'all' || (mapFilter === 'tribes') === m.isT2);
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
    flash('maps list unavailable - custom only');
  }
}

function terrainSelect(): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'terrainsel';
  const custom = document.createElement('option');
  custom.value = ''; custom.textContent = state.map ? 'custom (synth)' : 'custom (synth) ▸';
  if (!state.map) {custom.selected = true;}
  sel.append(custom);
  for (const { name, isT2 } of visMaps()) {
    const o = document.createElement('option');
    o.value = name; o.textContent = (isT2 ? '[T2] ' : '[C] ') + name;
    if (state.map === name) {o.selected = true;}
    sel.append(o);
  }
  sel.addEventListener('change', (): void => {
    state.map = sel.value; save(); refresh(); paintRail();
  });
  return sel;
}

// Full-width first-person ski toggle - sits at the top of the rail next to
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

// Noise archetype select - fBm / billow / swiss / jordan per-octave
// shaping (gen.ts `shape`). Same row pattern as the tilt-axis select.
/** ◀/▶ cyclic option steppers - lets dropdowns be browsed like sliders
 *  without opening the native picker. */
function stepBtn(sel: HTMLSelectElement, dir: number): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'step';
  b.textContent = dir < 0 ? '\u25C0' : '\u25B6';
  b.addEventListener('click', (): void => {
    const n = sel.options.length;
    sel.selectedIndex = (((sel.selectedIndex + dir) % n) + n) % n;
    sel.dispatchEvent(new Event('change'));
  });
  return b;
}

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
  row.append(lab, stepBtn(sel, -1), sel, stepBtn(sel, 1));
  return row;
}

function stepMap(dir: number): void {
  const vis = visMaps();
  if (vis.length === 0) {return;}
  const idx = vis.findIndex((m): boolean => m.name === state.map);
  const next = idx === -1
    ? (dir > 0 ? vis[0] : vis[vis.length - 1])
    : vis[(idx + dir + vis.length) % vis.length];
  state.map = next!.name; save(); refresh(); paintRail();
}

function paintRail(): void {
  rail.innerHTML = '';
  rail2.innerHTML = '';
  const filt = document.createElement('div'); filt.className = 'btnrow';
  for (const [f, label] of [['all', 'All'], ['custom', 'Custom'], ['tribes', 'Tribes']] as const) {
    const b = document.createElement('button'); b.textContent = label;
    if (mapFilter === f) {b.classList.add('active');}
    b.addEventListener('click', (): void => { mapFilter = f; paintRail(); });
    filt.append(b);
  }
  rail.append(filt);
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

  // Probe-only control (not a GenParams key) - must NOT call schedule(),
  // so it lives here instead of SLIDERS. Re-drops live balls on release.
  rail.append(dropHeightRow());
  rail.append(ballTermRow());
  rail.append(dbgStageRow());
  // lit-knee tuning - live uniforms, no regen. See terrainShaders desert block.
  for (const [key, min, max] of [['litKnee', 0.5, 1], ['litKeep', 0, 0.6], ['colCap', 0.9, 1]] as const) {
    rail.append(uniformRow(key, min, max));
  }

  const btns = document.createElement('div');
  btns.className = 'group'; btns.textContent = 'view + export';
  rail2.append(btns);
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
  rail2.append(row1);
  const row2 = document.createElement('div'); row2.className = 'btnrow';
  row2.append(
    mk('🎲 seed', (): void => {
      state.seed = Math.floor(Math.random() * 9999); save(); paintRail(); refresh();
    }),
    mk('🎲 params', (): void => {
      // Every knob re-rolled within its own slider range (grid size + seed
      // excluded - size is a heavy regen, seed has its own dice).
      for (const [key, , min, max, step] of SLIDERS) {
        if (key === 'size' || key === 'seed') {continue;}
        (state as unknown as Record<string, unknown>)[key] = min + Math.round((Math.random() * (max - min)) / step) * step;
      }
      state.preset = Math.floor(Math.random() * 10); // PRESETS 0-9
      mat.defines.TERRAIN_PRESET = state.preset;
      mat.needsUpdate = true;
      state.noiseType = Math.floor(Math.random() * 4); // fBm/billow/swiss/jordan
      state.tiltAxis = Math.random() < 0.5 ? 'x' : 'z';
      state.map = '';
      save(); paintRail(); refresh();
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
  rail2.append(row2);
  // Verbs - one-shot sims applied cumulatively; the log replays on every
  // refresh, on synth fields AND loaded maps (the shipped .bin is safe -
  // the mutation only lives in the preview buffer).
  const verbGrp = document.createElement('div'); verbGrp.className = 'group';
  verbGrp.textContent = `verbs${state.verbs.length > 0 ? ` (${state.verbs.join(', ')})` : ''}`;
  rail2.append(verbGrp);
  const VERB_TIPS: Record<string, string> = {
    rock: '12 seeded impact craters - oblique lobate rims, rough floors',
    scree: 'talus slide ×12 - debris creeps to repose under cliffs',
    streams: 'stream-power ×2 - carve coherent river valleys on the drainage net',
    erode: '50k droplet hydraulic erosion - gullies and sediment fans',
    smooth: 'diffusion ×4 - softens ridges, kills the noise carpet',
    glacier: 'polish U-troughs along the high-flow drainage spine',
    playa: 'fill shallow basins to spill level - flat lakebeds where water ponds',
    dunes: 'aeolian drift - sand creeps downwind, ridges pile on the lee',
    terrace: 'quantize heights into jittered steps - farmland/badlands benches',
    meteor: '16 seeded impacts, big ones first - ancient pitted surface',
    cliff: 'steepen what is already steep - carved escarpments, flats untouched',
    fan: 'alluvial fans - sediment cones at slope breaks / valley mouths',
    flood: 'clamp everything below water level - flat seabed + coastline',
    sink: 'karst dissolve - seeded rimless sinkholes',
    sharpen: 'unsharp mask on crests - restores eroded ridgelines',
    fold: 'parallel bent ridges along an axis - folded strata',
    plates: 'voronoi plates with per-plate offsets - tectonic steps',
    canyon: 'noise-steered wandering channel - meandering river canyon',
    snow: 'deposit on high + gentle - cornices on ridges, bare cliffs',
    lake: 'fill closed basins to spill - real lakes, playa complement',
    slump: 'collapse steep cells - hillside lobes, flats untouched',
    rugged: 'amplify mid-frequency bumps - rocky texture, same shape',
    uplift: 'gamma-raise the field - mids and highs get taller',
    contrast: 'sigmoid around the median - canyonize: lows drop, highs lift',
    stretch: 'renormalize to full 0-1 - restores export range after verbs',
    breach: 'cut one outlet channel per closed basin - flow restructure',
    scramble: 'phase-scramble the spectrum - same vitals, shuffled identity (A/B: toggle in verb log)',
    undo: 'pop the last verb off the replay log',
    clear: 'empty the verb log - back to the raw pipeline',
  };
  const verbBtn = (op: string): HTMLButtonElement => {
    const b = mk(`+${op}`, () => { addVerb(op); paintRail(); });
    b.dataset.tip = VERB_TIPS[op]!;
    return b;
  };
  const row3 = document.createElement('div'); row3.className = 'btnrow';
  for (const op of ['rock', 'meteor', 'sink', 'terrace']) { row3.append(verbBtn(op)); }
  rail2.append(row3);
  const row4 = document.createElement('div'); row4.className = 'btnrow';
  for (const op of ['streams', 'erode', 'glacier', 'scree']) { row4.append(verbBtn(op)); }
  rail2.append(row4);
  const row4b = document.createElement('div'); row4b.className = 'btnrow';
  for (const op of ['dunes', 'fan', 'cliff', 'sharpen']) { row4b.append(verbBtn(op)); }
  rail2.append(row4b);
  const row4c = document.createElement('div'); row4c.className = 'btnrow';
  for (const op of ['playa', 'flood', 'smooth']) { row4c.append(verbBtn(op)); }
  rail2.append(row4c);
  const row4d = document.createElement('div'); row4d.className = 'btnrow';
  for (const op of ['fold', 'plates', 'uplift', 'rugged']) { row4d.append(verbBtn(op)); }
  rail2.append(row4d);
  const row4e = document.createElement('div'); row4e.className = 'btnrow';
  for (const op of ['canyon', 'snow', 'lake', 'slump']) { row4e.append(verbBtn(op)); }
  rail2.append(row4e);
  const row4f = document.createElement('div'); row4f.className = 'btnrow';
  for (const op of ['contrast', 'stretch', 'breach', 'scramble']) { row4f.append(verbBtn(op)); }
  rail2.append(row4f);
  const row5 = document.createElement('div'); row5.className = 'btnrow';
  for (const op of ['undo', 'clear']) {
    const b = mk(op, op === 'undo'
      ? () => { state.verbs.pop(); save(); schedule(); paintRail(); }
      : () => { state.verbs.length = 0; save(); schedule(); paintRail(); });
    b.dataset.tip = VERB_TIPS[op]!;
    row5.append(b);
  }
  rail2.append(row5);
  const note = document.createElement('div');
  note.style.cssText = 'opacity:.45;margin-top:8px;line-height:1.5';
  note.textContent = 'droplets>0 erodes live · A/B flips raw↔eroded · .bin = maps/<name>.bin format · same lattice as genmap.js';
  rail2.append(note);
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

// Ball terminal velocity - live-applies to falling balls, no re-drop.
// 0 disables the airborne fall clamp (free-fall accelerates forever).
function ballTermRow(): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('label'); lab.textContent = 'ball term V';
  const inp = document.createElement('input');
  inp.type = 'range'; inp.min = '0'; inp.max = '200'; inp.step = '5';
  inp.value = String(state.ballTerm);
  const val = document.createElement('span'); val.textContent = state.ballTerm === 0 ? 'off' : String(state.ballTerm);
  inp.addEventListener('input', (): void => {
    state.ballTerm = Number(inp.value);
    val.textContent = state.ballTerm === 0 ? 'off' : String(state.ballTerm);
    for (const sim of balls) { sim.terminalVelocity = state.ballTerm; }
    save();
  });
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
  const PRESETS: [number, string][] = [[0, 'mixed'], [1, 'desert'], [2, 'grassland'], [3, 'snow'], [4, 'volcanic'], [5, 'badlands'], [6, 'coast'], [7, 'crag'], [8, 'canyon'], [9, 'arcane']];
  for (const [v, label] of PRESETS) {
    const o = document.createElement('option'); o.value = String(v); o.textContent = label;
    if (state.preset === v) {o.selected = true;}
    sel.append(o);
  }
  sel.addEventListener('change', (): void => {
    state.preset = Number(sel.value);
    mat.defines.TERRAIN_PRESET = state.preset;
    mat.needsUpdate = true; // preset is a compile-time define - recompiles once
    save();
  });
  row.append(lab, stepBtn(sel, -1), sel, stepBtn(sel, 1));
  return row;
}

// Style bundles - param sets tuned against the shipped maps' measured
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
  row.append(lab, stepBtn(sel, -1), sel, stepBtn(sel, 1));
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
  row.append(lab, stepBtn(sel, -1), sel, stepBtn(sel, 1));
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
