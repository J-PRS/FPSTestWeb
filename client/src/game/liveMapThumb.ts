// liveMapThumb — dev-only live map preview for the lobby picker: the real
// terrain fragment shader + AtmosphericSky over the spec's own heightmap,
// so palette/preset/fog edits show in the picker instead of a stale baked
// maps/thumbs/<name>.png. Renders one frame per selection — no loop, no
// sim. Known gaps (documented, not silent): spec.sky baked cubemaps and
// spec.water surfaces are not drawn — the thumb shows the procedural sky.
import * as THREE from 'three';
import { hmParseBin, hmHeight, HM_HEIGHT_SCALE, HM_WORLD_SCALE, type Heightfield } from '../../../shared/heightfield.js';
import { terrainFrag } from '../world/terrainShaders.js';
import { AtmosphericSky } from '../world/atmosphericSky.js';
import { hillshadeImage } from '../world/hillshade.js';

const WS = 1500;
const SEG = 256;

const LAB_VERT = /* glsl */`
  varying vec3 vNormal; varying vec3 vWorldPos; varying vec3 vCameraPos;
  void main() {
    vWorldPos = position;
    vNormal = normal;
    vCameraPos = cameraPosition;
    gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  }
`;

interface Spec {
  terrain?: string;
  heightScale?: number;
  tileSize?: number;
  terrainPreset?: number;
  terrainTex?: string;
  fog?: { color?: [number, number, number] };
  arena?: { x?: number; z?: number; radius?: number };
  bases?: Record<string, { x?: number; z?: number }>;
  flags?: Record<string, { x?: number; z?: number }>;
  structures?: { pos: { x: number; z: number } }[];
}

interface Rig {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  ortho: THREE.OrthographicCamera;
  mesh: THREE.Mesh;
  sky: AtmosphericSky;
  mat: THREE.ShaderMaterial;
  geo: THREE.PlaneGeometry;
  texLoader: THREE.TextureLoader;
}

function buildRig(canvas: HTMLCanvasElement): Rig {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(480, 360, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 480 / 360, 1, 8000);
  const sky = new AtmosphericSky(scene, {});
  const geo = new THREE.PlaneGeometry(WS, WS, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    vertexShader: LAB_VERT,
    fragmentShader: terrainFrag,
    lights: true,
    defines: { TERRAIN_PRESET: 1 },
    uniforms: Object.assign({}, THREE.UniformsLib.lights, {
      hscale: { value: HM_HEIGHT_SCALE },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
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
  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);
  // Top-down ortho for the textured HEIGHTMAP tile — up=(0,0,-1) orients
  // +z down-screen so rows match the hillshade layout.
  const ortho = new THREE.OrthographicCamera();
  ortho.up.set(0, 0, -1);
  return { renderer, scene, camera, ortho, mesh, sky, mat, geo, texLoader: new THREE.TextureLoader() };
}

async function loadSpec(name: string): Promise<{ spec: Spec; field: Heightfield } | null> {
  const spec = await (await fetch(`/maps/${name}.json`, { cache: 'no-cache' })).json() as Spec;
  const buf = new Uint8Array(await (await fetch(`/maps/${spec.terrain ?? `${name}.bin`}`, { cache: 'no-cache' })).arrayBuffer());
  return { spec, field: hmParseBin(buf, spec.heightScale ?? 1, spec.tileSize) };
}

function displace(geo: THREE.PlaneGeometry, field: Heightfield, span: number): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const k = span / WS; // geometry spans WS; sample at world coords
  for (let i = 0; i < pos.count; i += 1) {
    pos.setY(i, hmHeight(field, pos.getX(i) * k, pos.getZ(i) * k));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

function applySpec(r: Rig, spec: Spec, hs: number, tile: number): void {
  r.mesh.scale.set(tile / WS, 1, tile / WS);
  r.mat.uniforms.hmWorldScaleFrag.value = tile;
  r.mat.defines.TERRAIN_PRESET = spec.terrainPreset ?? 1;
  r.mat.uniforms.hscale.value = HM_HEIGHT_SCALE * hs;
  r.mat.uniforms.sunDir.value = r.sky.getSunDirection();
  const fog = spec.fog?.color ? new THREE.Color(...spec.fog.color) : new THREE.Color(0xBB_D0_E8);
  r.mat.uniforms.fogColor.value = fog;
  const skyU = (r.scene.getObjectByName('__sky') as THREE.Mesh).material as THREE.ShaderMaterial;
  skyU.uniforms.fogColor.value = fog;
  skyU.uniforms.horizonColor.value = fog;
  r.mat.needsUpdate = true;
}

async function applyAlbedo(r: Rig, spec: Spec): Promise<void> {
  const tex = spec.terrainTex ? await r.texLoader.loadAsync(`/maps/${spec.terrainTex}`) : null;
  if (tex) { tex.colorSpace = THREE.SRGBColorSpace; }
  r.mat.uniforms.albedoMap.value = tex;
  r.mat.uniforms.useAlbedo.value = tex !== null;
}

// Vantage mirrors _tools/e2e/mapthumbs.ts: oblique aerial aimed at the
// alpha base (flag stand when authored), midfield fallback.
interface Vantage { vx: number; vz: number; aimX: number; aimZ: number; lift: number }

function vantage(spec: Spec): Vantage {
  const cx = spec.arena?.x ?? 0;
  const cz = spec.arena?.z ?? 0;
  const rr = spec.arena?.radius ?? 400;
  // Aim at the alpha base (flag stand when authored) when there is one —
  // a compound anchors the frame better than midfield dirt — but keep the
  // camera a steep aerial over it so the whole field's relief reads.
  const base = spec.flags?.alpha ?? spec.bases?.alpha;
  const aimX = base?.x ?? cx;
  const aimZ = base?.z ?? cz;
  // Camera offset diagonal off the aim point toward map center, pulled
  // high enough that a ~55°-fov frame spans roughly the play space.
  const mx = cx - aimX, mz = cz - aimZ;
  const d = Math.hypot(mx, mz) || 1;
  const back = rr * 0.55;
  const lift = Math.max(300, rr * 0.95);
  return { vx: aimX + (mx / d) * back, vz: aimZ + (mz / d) * back, aimX, aimZ, lift };
}

/** Exact-look heightmap: one ortho render through the same terrain
 *  shader (palette/preset/albedo/sun all live), blitted to the 2D
 *  canvas. Fog is lifted for the shot — at 3km top-down everything
 *  would be a haze card. */
function renderTopo(r: Rig, field: Heightfield, tile: number, hmEl: HTMLCanvasElement): void {
  const u = r.mat.uniforms;
  const fs = u.fogStart.value as number, fe = u.fogEnd.value as number;
  u.fogStart.value = 1e7; u.fogEnd.value = 1e7;
  const skyMesh = r.scene.getObjectByName('__sky');
  if (skyMesh) { skyMesh.visible = false; }
  // Fit the ortho to the mesh's real XZ extent — tile and mesh span can
  // disagree (scale applied to the whole plane), and any slack shows as
  // a fog-colored sky frame.
  const half = (r.geo.boundingBox?.max.x ?? WS / 2) * r.mesh.scale.x;
  const o = r.ortho;
  o.left = -half; o.right = half; o.top = half; o.bottom = -half;
  o.near = 1; o.far = 9000;
  o.position.set(0, 4000, 0);
  o.lookAt(0, 0, 0);
  o.updateProjectionMatrix();
  r.renderer.setSize(field.size, field.size, false);
  r.renderer.render(r.scene, o);
  hmEl.width = field.size; hmEl.height = field.size;
  const src = r.renderer.domElement;
  hmEl.getContext('2d')!.drawImage(src, 0, 0, src.width, src.height, 0, 0, field.size, field.size);
  if (skyMesh) { skyMesh.visible = true; }
  u.fogStart.value = fs; u.fogEnd.value = fe;
  r.renderer.setSize(480, 360, false); // restore the VIEW viewport
}

export interface LiveMapThumb {
  el: HTMLDivElement;
  show(name: string): void;
}

export function liveMapThumb(): LiveMapThumb {
  const el = document.createElement('div');
  el.style.cssText = 'display:none;min-width:0;';
  // VIEW = live 3D render, HEIGHTMAP = the hillshade relief the picker
  // used to show baked — both painted per selection, toggle picks one.
  const btnRow = document.createElement('div');
  btnRow.className = 'lb-quick';
  btnRow.style.cssText = 'margin-top:4px;';
  const glEl = document.createElement('canvas');
  glEl.style.cssText = 'display:block;width:100%;height:auto;aspect-ratio:4/3;border-radius:4px;';
  // The relief is field.size² — square, not the 4:3 the GL view uses.
  const hmEl = document.createElement('canvas');
  hmEl.style.cssText = 'display:none;width:100%;height:auto;aspect-ratio:1/1;border-radius:4px;';
  const hmCtx = hmEl.getContext('2d')!;
  const viewBtn = document.createElement('button');
  const hmBtn = document.createElement('button');
  viewBtn.className = 'lb-btn'; hmBtn.className = 'lb-btn';
  viewBtn.textContent = 'VIEW'; hmBtn.textContent = 'HEIGHTMAP';
  btnRow.append(viewBtn, hmBtn);
  el.append(btnRow, glEl, hmEl);
  let mode: 'view' | 'hm' = 'view';
  const applyMode = (): void => {
    glEl.style.display = mode === 'view' ? 'block' : 'none';
    hmEl.style.display = mode === 'hm' ? 'block' : 'none';
    viewBtn.classList.toggle('active', mode === 'view');
    hmBtn.classList.toggle('active', mode === 'hm');
  };
  viewBtn.addEventListener('click', (): void => { mode = 'view'; applyMode(); });
  hmBtn.addEventListener('click', (): void => {
    mode = 'hm';
    applyMode();
    if (last) { renderTopo(last.r, last.field, last.tile, hmEl); }
  });
  applyMode();
  let rig: Rig | null = null;
  let last: { r: Rig; field: Heightfield; tile: number } | null = null;
  let gen = 0;

  const show = async (name: string): Promise<void> => {
    gen += 1;
    const my = gen;
    const stale = (): boolean => my !== gen;
    try {
      const loaded = await loadSpec(name);
      if (stale() || !loaded) { return; }
      const { spec, field } = loaded;
      const hs = spec.heightScale ?? 1;
      // Heightmap relief paints immediately — pure 2D, no GL compile wait.
      hmEl.width = field.size; hmEl.height = field.size;
      hmCtx.putImageData(hillshadeImage(field, {
        ws: field.worldScale ?? HM_WORLD_SCALE,
        vmax: HM_HEIGHT_SCALE * hs,
      }), 0, 0);
      el.style.display = 'block';
      if (!rig) { rig = buildRig(glEl); }
      const r = rig;
      const tile = spec.tileSize ?? WS;
      displace(r.geo, field, tile);
      applySpec(r, spec, hs, tile);
      await applyAlbedo(r, spec);
      if (stale()) { return; }
      last = { r, field, tile };
      const v = vantage(spec);
      r.camera.position.set(v.vx, hmHeight(field, v.vx, v.vz) + v.lift, v.vz);
      r.camera.lookAt(v.aimX, hmHeight(field, v.aimX, v.aimZ), v.aimZ);
      el.style.display = 'block';
      r.renderer.render(r.scene, r.camera);
      if (mode === 'hm') { renderTopo(r, field, tile, hmEl); }
    } catch {
      if (!stale()) { el.style.display = 'none'; }
    }
  };

  return { el, show: (name): void => { show(name).catch(() => undefined); } };
}
