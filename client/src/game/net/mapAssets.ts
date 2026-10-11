// Map asset loading — heightfield swap serialization, skybox faces,
// baked-albedo material blending, and T2 interior GLB instancing.
// Split from net/world.ts: that file owns "what the server told us",
// this one owns "fetch and build the world it describes".

import * as THREE from 'three';
import { mkGltfLoader } from '../../gltfLoad';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { StructureSpec, InteriorSpec } from '../../../../shared/mapSpec.js';
import { Ball } from '../../entities/balls.js';
import { urlParams } from '../../core/params.js';
import type { NetCtx } from './ctx.js';
import { loadHeightfieldBin, setHeightScale, setWorldScale } from '../../world/heightmap.js';
import { TERRAIN_HEIGHT_SCALE, TERRAIN_WORLD_SCALE, FOG_COLOR, FOG_START, FOG_END } from '../../core/config.js';
import { setFogBase, setFogHorizon } from '../../world/directionalFog.js';
import { resolveServerEndpoints } from '../../networking/endpoints.js';
import { loadLastRoomMap, pingServer } from './lastRoom.js';

export type MapSnapshot = { structures?: StructureSpec[]; arena?: { x: number; z: number; radius: number } | null; ambient?: Record<string, number>; terrain?: string; heightScale?: number; tileSize?: number; fog?: { color: [number, number, number]; distance?: number; visible?: number; horizon?: [number, number, number] }; terrainTex?: string; terrainPreset?: number; sky?: string; interiors?: InteriorSpec[] };

/** Mission haze — spec.fog re-tints the whole atmosphere. distance → fog
 *  near, visible → fog far (T2's authored range for the terrain). Absent
 *  resets to the engine haze, same semantics as the other map fields. */
const _fogColor = new THREE.Color();
const _horizonColor = new THREE.Color();
export function applyMapFog(ctx: NetCtx, fog?: MapSnapshot['fog']): void {
  const sceneFog = ctx.deps.lazyScene().fog;
  if (!(sceneFog instanceof THREE.Fog)) {return;}
  if (fog?.color) {
    _fogColor.setRGB(fog.color[0], fog.color[1], fog.color[2], THREE.SRGBColorSpace);
  } else {
    _fogColor.set(FOG_COLOR);
  }
  setFogBase(_fogColor);
  setFogHorizon(fog?.horizon ? _horizonColor.setRGB(fog.horizon[0], fog.horizon[1], fog.horizon[2], THREE.SRGBColorSpace) : null);
  sceneFog.color.copy(_fogColor);
  sceneFog.near = fog?.distance ?? FOG_START;
  sceneFog.far = Math.max(fog?.visible ?? FOG_END, sceneFog.near + 1);
}

/** Fetch the room's heightfield and swap the live terrain over to it.
 *  Serializes concurrent loads — a mapUpdate racing a re-join can't
 *  finish out of order and leave the older field resident. */
let terrainSwap: Promise<void> = Promise.resolve();
let terrainActive: string | null = null;
/** Latest requested spec key — a queued swap that ran late (the boot's
 *  saved-map prime trailing a reconnect) must not commit after a newer
 *  gameState already picked the room's real terrain. */
let terrainWanted: string | null = null;
/** Heightfield currently resident — null = the boot PNG. Tracked apart
 *  from terrainActive so a boot-primed saved map skips the refetch +
 *  mesh rebuild while still taking the albedo/sky passes. */
let fieldLoaded: string | null = null;
/** Resolves when the first terrain decision lands — a room's map spec
 *  or confirmation that the boot field stays. Offline bot fill waits on
 *  this so it never seeds a roster on the wrong heightmap. */
let firstTerrainResolve!: () => void;
export const firstTerrain = new Promise<void>((r) => { firstTerrainResolve = r; });
// Rooms without a spec terrain reset to the boot field — the SAME bin
// the server sims (server_bun/heightmap.bin mirrored under assets), so
// prediction and authority sample one file instead of PNG-vs-bin drift.
const BOOT_HEIGHTMAP = '/assets/heightmaps/heightmap.bin';
export async function applyTerrain(ctx: NetCtx, file: string | null, texPath?: string, skyDir?: string, heightScale?: number, tileSize?: number, terrainPreset?: number): Promise<void> {
  const mult = heightScale ?? 1;
  const wscale = tileSize ?? TERRAIN_WORLD_SCALE;
  const key = `${file}@${mult}@${wscale}|${texPath}|${skyDir}`;
  terrainWanted = key;
  if (terrainActive === key) {return;}
  const { deps } = ctx;
  terrainSwap = terrainSwap.then(async () => {
    if (terrainActive === key || terrainWanted !== key) {return;}
    Ball.terrainSwapping = true;
    try {
      // Scale applies to whichever field is resident — a scale-only map
      // change still needs CPU samples + shader uniforms re-keyed.
      setHeightScale(mult);
      setWorldScale(wscale);
      deps.lazyTerrain().setHeightScale(TERRAIN_HEIGHT_SCALE * mult);
      deps.lazyTerrain().setWorldScale(wscale);
      deps.lazyTerrain().setPreset(terrainPreset ?? 1);
      interiorHscale.value = TERRAIN_HEIGHT_SCALE * mult;
      const { httpUrl } = await resolveServerEndpoints();
      const fieldKey = `${file}@${mult}`;
      let swappedBin = false;
      if (fieldKey !== fieldLoaded) {
        if (file) {
          await loadHeightfieldBin(`${httpUrl}/maps/${file}`);
        } else {
          await loadHeightfieldBin(BOOT_HEIGHTMAP);
        }
        deps.lazyTerrain().reloadHeightmap();
        // Ball.field captured the previous heightfield OBJECT — hmData is
        // swapped, not mutated, so the sim would keep predicting bounces on
        // the old terrain. Re-read it now that the new field is resident.
        Ball.initNetMode(true);
        fieldLoaded = fieldKey;
        swappedBin = true;
      }
      // The bin/tex/sky fetches awaited above gave newer requests time to
      // supersede this one (reconnect gameState beats a boot-primed saved
      // map). Commit only if still wanted — otherwise this task's only
      // footprint is the hmData the newer task's own reload overwrites.
      // If we did swap the bin, un-mark it so the newer task refetches:
      // its dedupe check must not skip reloading over our stale data.
      if (terrainWanted !== key) {if (swappedBin) {fieldLoaded = null;} return;}

      // Baked albedo (T2 ports) replaces the procedural palette entirely.
      // Isolated from the terrain swap: a missing texture shouldn't leave
      // the old heightfield-resident-but-unbuilt state behind.
      try {
        await applyTerrainTex(deps, httpUrl, texPath);
      } catch (error) {
        const src = (error as ProgressEvent)?.target as { src?: string } | undefined;
        deps.logger.warn(`Albedo load failed for ${texPath}: ${src?.src ?? String(error)}`);
      }
      // Cube skybox faces extracted as px/nx/py/ny/pz/nz.png; maps
      // without one fall back to the procedural atmosphere.
      await applySky(deps, httpUrl, skyDir);

      terrainActive = key;
      deps.world.onTerrainApplied?.(file);
      deps.logger.info(`Terrain swapped to maps/${file}`);
    } catch (error) {
      // THREE loaders reject with ProgressEvent (no .message) — log
      // whichever URL failed via the event target, plus Error message.
      const ev = error as ProgressEvent & { target?: { src?: string } };
      const detail = error instanceof Error ? error.message
        : ev?.target?.src ?? String(error);
      deps.logger.warn(`Terrain load failed for ${file ?? BOOT_HEIGHTMAP}: ${detail}`);
    } finally {
      Ball.terrainSwapping = false;
      firstTerrainResolve();
    }
  });
  return terrainSwap;
}

// Exports are GL-layout (verified by _tools/tershot/seamcheck.py: py's
// four edges match all four side tops, side ring pairs at ~1 error).
// The authentic T2 faces (sky_lush_blue.dml -> desert/skies/d?2.png) are
// already GL-convention; SKY_VFLIP stays as the escape hatch for exports
// that ship a face upside-down.
const SKY_FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const;
const SKY_VFLIP = new Set<string>();

// ── Sky seam solver ────────────────────────────────────────────────────
// T2 sky exports have shipped faces in wrong slots / orientations for
// whole map families (same source DML, same breakage). Trusting the file
// names produced wedge-seamed skies. Instead of a per-map fix table the
// loader verifies the claimed cube: downsample faces to 32px, score the
// 12 shared edges, and when the named assembly is clearly broken, search
// slot permutations x orientations for the assembly the pixels actually
// describe. A coherent cube wins over the label — port of
// _tools/tershot/skysolve/skyperm.
const SKY_SOLVE_PX = 32;
type SkyEdge = Uint16Array; // per-texel r+g+b, one edge of a 32px face
// GL cube adjacency (mirrors seamcheck.py ADJA): slot, edge, neighbor
// slot, neighbor edge, whether the neighbor edge runs reversed.
const SKY_PAIRS: [number, number, number, number, boolean][] = (() => {
  const s = { px: 0, nx: 1, py: 2, ny: 3, pz: 4, nz: 5 } as const;
  const e = { T: 0, R: 1, B: 2, L: 3 } as const;
  const adj: [keyof typeof s, keyof typeof e, keyof typeof s, keyof typeof e, boolean][] = [
    ['px','T','py','R',true],['px','R','nz','T',false],['px','B','ny','R',true],['px','L','pz','T',false],
    ['nx','T','py','L',true],['nx','R','pz','T',false],['nx','B','ny','L',true],['nx','L','nz','T',false],
    ['py','T','nz','L',true],['py','R','px','T',false],['py','B','pz','L',true],['py','L','nx','T',false],
    ['ny','T','pz','B',false],['ny','R','px','B',false],['ny','B','nz','B',false],['ny','L','nx','B',false],
    ['pz','T','py','B',false],['pz','R','px','L',false],['pz','B','ny','T',false],['pz','L','nx','R',false],
    ['nz','T','py','T',false],['nz','R','nx','L',false],['nz','B','ny','B',false],['nz','L','px','R',false],
  ];
  const seen = new Set<string>();
  return adj.filter(([f, fe, g, ge]) => {
    const k = [f + fe, g + ge].toSorted().join('|');
    return seen.has(k) ? false : (seen.add(k), true);
  }).map(([f, fe, g, ge, fl]) => [s[f], e[fe], s[g], e[ge], fl]);
})();

/** 8 orientations per face: k<4 = pure quarter-turns, k>=4 = mirrored
 *  first. Returns edges[k][edge] sampled as r+g+b per texel. */
function skyOrientEdges(d: Uint8ClampedArray): SkyEdge[][] {
  const S = SKY_SOLVE_PX;
  const out: SkyEdge[][] = [];
  const sum = (x: number, y: number) => {
    const i = (y * S + x) * 4;
    return d[i]! + d[i + 1]! + d[i + 2]!;
  };
  for (let k = 0; k < 8; k++) {
    const flip = k >= 4, rot = k % 4;
    // Oriented sample coords for each output edge. For a square face:
    // rotate CCW k quarter-turns after an optional horizontal mirror.
    const at = (x: number, y: number): number => {
      let sx = flip ? S - 1 - x : x, sy = y;
      for (let r = 0; r < rot; r++) { const t = sx; sx = sy; sy = S - 1 - t; }
      return sum(sx, sy);
    };
    const edges: SkyEdge[] = [new Uint16Array(S), new Uint16Array(S), new Uint16Array(S), new Uint16Array(S)];
    for (let i = 0; i < S; i++) {
      edges[0]![i] = at(i, 0);          // T
      edges[1]![i] = at(S - 1, i);      // R
      edges[2]![i] = at(i, S - 1);      // B
      edges[3]![i] = at(0, i);          // L
    }
    out.push(edges);
  }
  return out;
}

/** Total seam error for an assembly: assign[slot] -> face index,
 *  orient[slot] -> orientation key. */
function skySeamErr(E: SkyEdge[][][], assign: number[], orient: number[]): number {
  let tot = 0;
  for (const [f, fe, g, ge, flip] of SKY_PAIRS) {
    const a = E[assign[f]!]![orient[f]!]![fe]!;
    const b = E[assign[g]!]![orient[g]!]![ge]!;
    if (flip) {for (let i = 0; i < SKY_SOLVE_PX; i++) {tot += Math.abs(a[i]! - b[SKY_SOLVE_PX - 1 - i]!);}}
    else {for (let i = 0; i < SKY_SOLVE_PX; i++) {tot += Math.abs(a[i]! - b[i]!);}}
  }
  return tot;
}

interface SkyCand { s: number; assign: number[]; orient: number[] }

/** Keep the best-K assemblies — the seam score can't tell a right-side-up
 *  cube from a rotated one, so near-ties get re-picked by the up-prior. */
function skyCandPush(list: SkyCand[], s: number, assign: number[], orient: number[], cap = 64): void {
  if (list.length >= cap && s >= list[list.length - 1]!.s) {return;}
  list.push({ s, assign: assign.slice(), orient: orient.slice() });
  list.sort((a, b) => a.s - b.s);
  if (list.length > cap) {list.length = cap;}
}

/** Cap faces (sky dome, ground haze) are flat in both directions; side
 *  faces carry the horizon, so they have a strong gradient along some
 *  axis. capScore = max directional gradient — the two lowest-scoring
 *  faces are structurally ineligible for anything but py/ny, which is
 *  the hard constraint that stops a seamless-but-sideways cube. */
/** Signed third-vs-third gradient down one axis of one face. */
function skyAxisGrad(d: Uint8ClampedArray, horizontal: boolean): number {
  const S = SKY_SOLVE_PX, T = Math.trunc((S / 3));
  let g = 0;
  for (let u = 0; u < S; u++) {
    let band = 0;
    for (let v = 0; v < S; v++) {
      const i = (horizontal ? v * S + u : u * S + v) * 4;
      band += d[i]! + d[i + 1]! + d[i + 2]!;
    }
    if (u < T) {g += band;} else if (u >= S - T) {g -= band;}
  }
  return g;
}

function skyCapFaces(data: Uint8ClampedArray[]): { up: number; dn: number } {
  const scores: number[] = [], lum: number[] = [];
  for (const d of data) {
    let l = 0;
    for (let i = 0; i < d.length; i += 4) {l += d[i]! + d[i + 1]! + d[i + 2]!;}
    scores.push(Math.max(Math.abs(skyAxisGrad(d, false)), Math.abs(skyAxisGrad(d, true))));
    lum.push(l);
  }
  const ranked = [0, 1, 2, 3, 4, 5].toSorted((a, b) => scores[a]! - scores[b]!);
  const [a, b] = ranked;
  return lum[a!]! > lum[b!]! ? { up: a!, dn: b! } : { up: b!, dn: a! };
}

/** Pick the best-seamed assembly that is also structurally upright:
 *  the cap faces must sit in py/ny (brightest up) — seam score alone
 *  can't tell a sideways cube from a correct one, and luminance alone
 *  can't tell a horizon face from a cap. */
function skyPickUpright(cands: SkyCand[], caps: { up: number; dn: number }): SkyCand | undefined {
  for (const c of cands) {
    if (c.assign[2] === caps.up && c.assign[3] === caps.dn) {return c;}
  }
  return undefined;
}

/** Rotation-only pass (4^6) — cheap first try; fixes upside-down faces. */
function skySolveRots(E: SkyEdge[][][]): SkyCand[] {
  const assign = [0, 1, 2, 3, 4, 5];
  const cands: SkyCand[] = [];
  const o = [0, 0, 0, 0, 0, 0];
  for (let n = 0; n < 4096; n++) {
    let m = n;
    for (let i = 0; i < 6; i++) { o[i] = m & 3; m >>= 2; }
    skyCandPush(cands, skySeamErr(E, assign, o), assign, o);
  }
  return cands;
}

/** Full search: 720 slot assignments x coordinate-descent over the 8
 *  orientations per slot. The one to reach for when the names are just
 *  wrong — finds the cube the pixels describe, labels be damned. */
function skySolvePerm(E: SkyEdge[][][]): SkyCand[] {
  const perm = [0, 1, 2, 3, 4, 5];
  const cands: SkyCand[] = [];
  const o = [0, 0, 0, 0, 0, 0];
  const next = (): boolean => {
    // Iterative lexicographic next_permutation.
    let i = 4;
    while (i >= 0 && perm[i]! > perm[i + 1]!) {i--;}
    if (i < 0) {return false;}
    let j = 5;
    while (perm[j]! < perm[i]!) {j--;}
    [perm[i], perm[j]] = [perm[j]!, perm[i]!];
    for (let a = i + 1, b = 5; a < b; a++, b--) {[perm[a], perm[b]] = [perm[b]!, perm[a]!];}
    return true;
  };
  // One coordinate-descent polish per permutation: each slot takes the
  // orientation that minimises total seam error, three rounds.
  const polish = (): number => {
    o.fill(0);
    for (let round = 0; round < 3; round++) {
      for (let slot = 0; slot < 6; slot++) {
        let bs = Infinity, bk = 0;
        for (let k = 0; k < 8; k++) {
          o[slot] = k;
          const s = skySeamErr(E, perm, o);
          if (s < bs) { bs = s; bk = k; }
        }
        o[slot] = bk;
      }
    }
    return skySeamErr(E, perm, o);
  };
  do { skyCandPush(cands, polish(), perm, o); } while (next());
  return cands;
}

/** Downsample faces and decide whether the file-named assembly holds.
 *  Returns slot-ordered full-res canvases/images ready for CubeTexture. */
function skyAssemble(faces: (HTMLImageElement | HTMLCanvasElement)[]): typeof faces | HTMLCanvasElement[] {
  const S = SKY_SOLVE_PX;
  const small = document.createElement('canvas');
  small.height = S;
  small.width = small.height;
  const sctx = small.getContext('2d', { willReadFrequently: true })!;
  const data: Uint8ClampedArray[] = [];
  const E = faces.map((img, fi) => {
    sctx.drawImage(img, 0, 0, S, S);
    const d = sctx.getImageData(0, 0, S, S).data;
    data[fi] = d;
    return skyOrientEdges(d);
  });
  const caps = skyCapFaces(data);
  const ident = skySeamErr(E, [0, 1, 2, 3, 4, 5], [0, 0, 0, 0, 0, 0]);
  const cands = skySolveRots(E);
  // Only rebuild the cube when the named assembly loses decisively —
  // a near-tie means authentic T2 edge discontinuity, not misassembly.
  if (cands[0]!.s > ident * 0.7) {
    const perm = skySolvePerm(E);
    if (perm.length > 0 && perm[0]!.s < Math.min(ident, cands[0]!.s) * 0.75) {
      cands.push(...perm);
      cands.sort((a, b) => a.s - b.s);
    }
  }
  const pick = skyPickUpright(cands, caps);
  if (!pick || pick.s >= ident) {return faces;} // names were fine
  const { assign, orient } = pick;
  const out: HTMLCanvasElement[] = [];
  for (let slot = 0; slot < 6; slot++) {
    const src = faces[assign[slot]!]!;
    const k = orient[slot]!;
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const g = c.getContext('2d')!;
    g.translate(c.width / 2, c.height / 2);
    if (k >= 4) {g.scale(-1, 1);}
    g.rotate((k % 4) * Math.PI / 2);
    g.drawImage(src, -src.width / 2, -src.height / 2);
    out.push(c);
  }
  return out;
}

// Cube-sky horizon band: scene.background can't tint toward the haze, so
// a cube sky rides a camera-locked dome whose shader melts the horizon
// into the live fog color — saturated-fog terrain then dissolves into
// sky instead of cutting a hard silhouette (the T2 look). uFog is fed
// the sun-tinted scene.fog.color every frame via updateCubeSky.
let cubeDome: THREE.Mesh | null = null;

function applyCubeDome(scene: THREE.Scene, cube: THREE.CubeTexture): void {
  if (cubeDome) {
    (cubeDome.material as THREE.ShaderMaterial).uniforms.tCube.value = cube;
  } else {
    cubeDome = new THREE.Mesh(
      new THREE.SphereGeometry(60, 48, 24),
      new THREE.ShaderMaterial({
        uniforms: { tCube: { value: cube }, uFog: { value: new THREE.Color(FOG_COLOR) } },
        vertexShader: `varying vec3 vWorld;
          void main() {
            vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `uniform samplerCube tCube;
          uniform vec3 uFog;
          varying vec3 vWorld;
          void main() {
            vec3 dir = normalize(vWorld - cameraPosition);
            // SRGBColorSpace uploads as SRGB8_ALPHA8 — the sample is
            // already linear here, matching scene.fog.color's space.
            vec3 sky = textureCube(tCube, dir).rgb;
            // The melt must stay thin: fully-fogged terrain meets the sky
            // right AT the horizon, so only the few degrees straddling it
            // get fog — wider bands drown the sky's own painted haze and
            // darken the whole low sky.
            float band = smoothstep(0.09, -0.02, dir.y);
            gl_FragColor = vec4(mix(sky, uFog, band), 1.0);
          }`,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
      }));
    cubeDome.name = '__cubeDome';
    cubeDome.frustumCulled = false;
    cubeDome.renderOrder = -100;
  }
  cubeDome.visible = true;
  scene.add(cubeDome);
}

/** Per-frame: keep the dome glued to the camera and its haze band on the
 *  live (sun-tinted) fog color. */
export function updateCubeSky(camera: THREE.Camera, fogColor: THREE.Color): void {
  if (!cubeDome || !cubeDome.visible) {return;}
  cubeDome.position.copy(camera.position);
  ((cubeDome.material as THREE.ShaderMaterial).uniforms.uFog.value as THREE.Color).copy(fogColor);
}

/** A missing face must not kill the terrain swap — loader rejections
 *  are ProgressEvents, which used to surface as "undefined" here. */
async function applySky(deps: NetCtx['deps'], httpUrl: string, skyDir: string | undefined): Promise<void> {
  const skyMesh = deps.lazyScene().getObjectByName('__sky');
  if (!skyDir) {
    deps.lazyScene().background = null;
    if (cubeDome) {cubeDome.visible = false;}
    if (skyMesh) {skyMesh.visible = true;}
    return;
  }
  // Baked ports ship .webp faces; .png is the fallback for a sky
  // dropped in by hand without the converter.
  const base = (f: string) => `${httpUrl}/maps/${skyDir}/${f}`;
  try {
    const loader = new THREE.ImageLoader();
    const faces = await Promise.all(SKY_FACES.map(async (f, i) => {
      const img = await loader.loadAsync(`${base(f)}.webp`)
        .catch(() => loader.loadAsync(`${base(f)}.png`));
      if (!SKY_VFLIP.has(SKY_FACES[i]!)) {return img;}
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.translate(0, img.height);
      ctx.scale(1, -1);
      ctx.drawImage(img, 0, 0);
      return c;
    }));
    let assembled: typeof faces | HTMLCanvasElement[] = faces;
    try {
      assembled = skyAssemble(faces);
      if (assembled !== faces) {deps.logger.info(`Sky ${skyDir}: faces misassembled — seam solver rebuilt the cube`);}
    } catch { /* canvas taint/security — keep the named assembly */ }
    const cube = new THREE.CubeTexture(assembled);
    cube.colorSpace = THREE.SRGBColorSpace;
    cube.needsUpdate = true;
    applyCubeDome(deps.lazyScene(), cube);
    deps.lazyScene().background = null;
    if (skyMesh) {skyMesh.visible = false;}
  } catch (error) {
    const src = (error as ProgressEvent)?.target as { src?: string } | undefined;
    deps.logger.warn(`Sky load failed for ${skyDir}: ${src?.src ?? String(error)}`);
  }
}

/** Baked albedo + optional full-fidelity material layer (mats.json next
 *  to it on T2 ports). Missing mats just keeps the baked look. */
async function applyTerrainTex(deps: NetCtx['deps'], httpUrl: string, texPath: string | undefined): Promise<void> {
  const terrain = deps.lazyTerrain();
  if (!texPath) {
    terrain.setAlbedo(null);
    terrain.setMaterialBlend(null, null, null, 0, null);
    return;
  }
  const tex = await new THREE.TextureLoader().loadAsync(`${httpUrl}/maps/${texPath}`);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapS = tex.wrapT;
  terrain.setAlbedo(tex);
  try {
    const mats = urlParams.has('mats')
      ? await loadMats(`${httpUrl}/maps/${texPath.slice(0, texPath.lastIndexOf('/'))}`)
      : null;
    if (mats) {terrain.setMaterialBlend(mats.tiles, mats.alphaA, mats.alphaB, mats.tileMeters, mats.means);}
  } catch {
    terrain.setMaterialBlend(null, null, null, 0, null);
  }
}

// The shader compares sampled (linear-decoded) luminance against each
// tile's mean — compute that mean in linear space too or dark tiles
// divide by an sRGB mean ~2.4× too high and the blend reads as black grime.
function srgb2lin(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** T2 material-blend manifest beside albedo.png: alphas.bin is
 *  grid²×count u8 weights packed into two RGBA DataTextures (8 max);
 *  the 256px tiles are drawn into a 4×2 atlas so a plain sampler2D can
 *  reach all layers. Returns null when no mats.json exists. */
async function loadMats(dirUrl: string): Promise<{
  tiles: THREE.Texture; alphaA: THREE.Texture; alphaB: THREE.Texture; tileMeters: number;
  means: number[];
} | null> {
  const res = await fetch(`${dirUrl}/mats.json`);
  if (!res.ok) {return null;}
  const man = await res.json() as { grid: number; count: number; tiles: string[]; alphas: string; tileMeters: number };
  const raw = new Uint8Array(await (await fetch(`${dirUrl}/${man.alphas}`)).arrayBuffer());
  const {grid} = man, {count} = man;
  // alphas.bin is cell-major: weights packed [cell*count + layer], not
  // [layer*grid² + cell]. Reading planar spreads every layer at ~0.25
  // over the whole map — the tiled detail covered the entire terrain.
  const pack = (offset: number) => {
    const rgba = new Uint8Array(grid * grid * 4);
    for (let c = 0; c < 4; c++) {
      const layer = offset + c;
      if (layer >= count) {break;}
      for (let i = 0; i < grid * grid; i++) {rgba[i * 4 + c] = raw[i * count + layer];}
    }
    const t = new THREE.DataTexture(rgba, grid, grid, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  };
  // Tile atlas: 4×2 cells of 256px on one canvas — atlas UVs in the
  // shader do the layer select, no texture arrays needed.
  const atlas = document.createElement('canvas');
  atlas.width = 1024; atlas.height = 512;
  const g = atlas.getContext('2d')!;
  const means = Array.from({ length: 8 }, () => 0.5);
  await Promise.all(man.tiles.slice(0, 8).map(async (path, k) => {
    const img = new Image();
    // Cross-origin atlas bake — without this the canvas taints and
    // CanvasTexture's upload throws SecurityError (silent grey terrain).
    img.crossOrigin = 'anonymous';
    img.src = `${dirUrl}/${path}`;
    await img.decode();
    const cx = (k % 4) * 256, cy = Math.floor(k / 4) * 256;
    g.drawImage(img, cx, cy, 256, 256);
    // Per-tile mean luminance — the shader divides the blended detail by
    // the weighted mean so tiles modulate the albedo around their own
    // brightness instead of replacing its color (dark rock tiles used to
    // erase the grass bake outright).
    const d = g.getImageData(cx, cy, 256, 256).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) {s += 0.299 * srgb2lin(d[i]) + 0.587 * srgb2lin(d[i + 1]) + 0.114 * srgb2lin(d[i + 2]);}
    means[k] = Math.max(s / (d.length / 4), 1e-3);
  }));
  const tilesTex = new THREE.CanvasTexture(atlas);
  tilesTex.colorSpace = THREE.SRGBColorSpace;
  tilesTex.generateMipmaps = true;
  tilesTex.minFilter = THREE.LinearMipmapLinearFilter;
  return { tiles: tilesTex, alphaA: pack(0), alphaB: pack(4), tileMeters: man.tileMeters, means };
}

// ── T2 interiors ────────────────────────────────────────────────────────
// .dif files were converted to glb offline (io_dif → Blender 5.2 → glTF);
// the spec carries our-space pos + pre-squashed scale + the raw T2
// axis-angle. The transform composes:
//   M = T(pos) · D(scaleOurs) · SwapYZ · R(axis-angle, T2 space) · G
// G = rotX(+90°) undoes Blender's Z-up→Y-up export (glb verts are
// (u,w,-v) in T2 coords); SwapYZ maps T2 (u,v,w)→ours (u,w,v); R is the
// mission rotation in T2 axes. SwapYZ is a reflection — DoubleSide on
// every material keeps the mirrored winding renderable.
const SWAP_YZ = new THREE.Matrix4().set(
  1, 0, 0, 0,
  0, 0, 1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1);
const G_GLB_TO_T2 = new THREE.Matrix4().makeRotationX(Math.PI / 2);

let interiorGroup: THREE.Group | null = null;
let interiorGeos: THREE.BufferGeometry[] = []; // merged geos — owned, must dispose on swap
// Bumped every applyInteriors — consumers that cache scene queries over
// the group (e.g. the shadow-caster gate) must re-census on change: a map
// swap disposes the old group, so a stale cache would gate dead meshes.
let interiorsEpoch = 0;
export function getInteriorsEpoch(): number { return interiorsEpoch; }
const glbCache = new Map<string, Promise<THREE.Group | null>>();
const glbLoader = mkGltfLoader();

// Canonical interior materials — dedup by stripped name (per-GLB `.NNN`
// suffixes removed) + the shading params that actually differ.
const _canonMats = new Map<string, { key: string; mat: THREE.Material }>();

// Interiors ride the same fog model as the terrain shader — THREE.Fog
// alone leaves mesh hulls crisp inside dissolved lowlands, so the
// valley-mist term is injected into their Lambert's fog chunk. hscale
// tracks the active field's heightScale so the mist layer pools right.
const interiorHscale = { value: 125 };
const INTERIOR_FOG_GLSL = `
  const float IHF_FLOOR = 18.0;
  const float IHF_K = 0.024;
  const float IHF_D0 = 0.0024;
  const float IHF_CAP = 0.80;
  float interiorMist(vec3 ro, vec3 delta, float dist) {
    if (dist < 1.0) return 0.0;
    float rdy = delta.y / dist;
    float a = IHF_D0 * exp(-IHF_K * max(ro.y - IHF_FLOOR, 0.0));
    float od = abs(rdy) < 1e-3
      ? a * dist
      : a * (1.0 - exp(-IHF_K * rdy * dist)) / (IHF_K * rdy);
    return min(1.0 - exp(-max(od, 0.0)), IHF_CAP);
  }`;

function canonInteriorMat(mat: THREE.Material): { key: string; mat: THREE.Material } {
  const std = mat as THREE.MeshStandardMaterial;
  const key = [
    std.color ? std.color.getHexString() : '-',
    // Texture identity comes from the map's own name — two materials that
    // differ only in .name (the exporter's per-file .NNN suffixes already
    // stripped) render identically and can share one draw call.
    std.map ? std.map.name || 'tex' : '-',
    std.emissiveMap ? std.emissiveMap.name || 'em' : '-',
    String(std.roughness ?? ''), String(std.metalness ?? ''),
    std.emissive ? std.emissive.getHexString() : '-',
    String(std.emissiveIntensity ?? ''),
    String(std.flatShading ?? ''), String(std.side ?? ''),
    std.transparent ? 't' : 'o',
  ].join('|');
  const hit = _canonMats.get(key);
  if (hit) {return hit;}
  // GLTFLoader gives every DIF interior MeshStandardMaterial — PBR shading
  // on ~85k tris while the whole rest of the world runs Lambert. Downgrade
  // here: interiors are static, unmapped geometry; Lambert keeps the same
  // maps/emissive/AO for a fraction of the fragment cost.
  let useMat: THREE.Material = mat;
  if (std.isMeshStandardMaterial) {
    // DIF interiors ship TWO textures: baseColor (the wall albedo) and a
    // zero-strength emissive on channel 1 — the interior's baked T2
    // lightmap. Lambert can consume it as lightMap, so the hulls carry
    // their authored shading instead of flat sun-lighting.
    const lam = new THREE.MeshLambertMaterial({
      color: std.color,
      map: std.map ?? std.emissiveMap,
      lightMap: std.emissiveMap,
      lightMapIntensity: 1,
      normalMap: std.normalMap,
      aoMap: std.aoMap,
      aoMapIntensity: std.aoMapIntensity,
      transparent: std.transparent,
      opacity: std.opacity,
      side: std.side,
      alphaTest: std.alphaTest,
      depthWrite: std.depthWrite,
      flatShading: std.flatShading,
      vertexColors: std.vertexColors,
      fog: std.fog,
    });
    lam.name = std.name;
    lam.onBeforeCompile = (sh) => {
      sh.uniforms.uIntHscale = interiorHscale;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vIntWorld;\nvarying vec3 vIntDelta;')
        .replace('#include <fog_vertex>',
          '#include <fog_vertex>\n#ifdef USE_FOG\n  vIntWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vIntDelta = cameraPosition - vIntWorld;\n#endif');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vIntWorld;\nvarying vec3 vIntDelta;\nuniform float uIntHscale;\n${  INTERIOR_FOG_GLSL}`)
        .replace('#include <fog_fragment>', `#ifdef USE_FOG
  // Same curve as the terrain shader: linear haze + the exponential
  // valley mist, so interiors dissolve into the same air the ground does.
  float ifDist = length(vIntDelta);
  float ifog = smoothstep(fogNear, fogFar, ifDist);
  float ihf = smoothstep(fogNear * 0.6, fogFar * 0.7, ifDist)
            * smoothstep(0.3, 0.8, clamp(vIntWorld.y / uIntHscale, 0.0, 1.0));
  vec3 ifro = vec3(0.0, vIntWorld.y + vIntDelta.y, 0.0);
  float imist = interiorMist(ifro, -vIntDelta, ifDist);
  ifog = clamp(ifog + ihf + imist * (1.0 - ifog), 0.0, 1.0);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, ifog);
#endif`);
    };
    useMat = lam;
  }
  const entry = { key, mat: useMat };
  _canonMats.set(key, entry);
  return entry;
}

// Interior parts worth a cast shadow: sized like architecture, not trim.
// Radius over ~4m — towers, walls, ramps. Small greebles would cost a
// draw call each in the shadow pass for an unreadable sliver of shade.
// Per-mesh radius is stashed on userData so the loop can distance-gate
// casting (geometry is world-baked — boundingSphere.center is the mesh's
// true position).
function interiorCastRadius(g: THREE.BufferGeometry): number {
  if (!g.boundingSphere) {g.computeBoundingSphere();}
  const r = g.boundingSphere?.radius ?? 0;
  return r > 4 ? r : 0;
}

async function fetchGlb(httpUrl: string, file: string): Promise<THREE.Group | null> {
  const name = file.replace(/\.dif$/i, '.glb');
  let p = glbCache.get(name);
  if (!p) {
    p = glbLoader.loadAsync(`${httpUrl}/maps/t2/dif/${name}`)
      .then((g) => g.scene)
      .catch(() => null);
    glbCache.set(name, p);
  }
  const out = await p;
  // A cached miss is poison: a transient blip at first load would hide
  // the hull for the whole session. Drop the entry so the next map swap
  // or rejoin retries the fetch.
  if (!out) {glbCache.delete(name);}
  return out;
}

/** Instance a converted T2 interior. Clone shares geometry/materials —
 *  these are static hulls, no skeletons. */
export async function applyInteriors(ctx: NetCtx, list: InteriorSpec[] | undefined): Promise<void> {
  interiorsEpoch++;
  const { deps } = ctx;
  const scene = deps.lazyScene();
  if (interiorGroup) {
    scene.remove(interiorGroup);
    interiorGroup = null;
    for (const g of interiorGeos) {g.dispose();}
    interiorGeos = [];
  }
  if (!list?.length) {return;}
  const { httpUrl } = await resolveServerEndpoints();
  const group = new THREE.Group();
  group.name = '__t2interiors';
  group.matrixAutoUpdate = false; // static world container
  interiorGroup = group;
  scene.add(group);

  const missing = new Set<string>();
  // Static-merge buckets: every interior sub-mesh bakes its world transform
  // into a cloned geometry and merges per (material × attribute layout) —
  // 33 hulls × dozens of primitives was hundreds of draw calls at idle.
  // Multi-material meshes keep their original mesh (rare) instead of
  // splitting groups.
  const buckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
  const mergedGeo: THREE.BufferGeometry[] = interiorGeos;
  const kept: THREE.Mesh[] = [];
  await Promise.all(list.map(async (spec) => {
    const src = await fetchGlb(httpUrl, spec.file);
    if (!src) { missing.add(spec.file); return; }
    const inst = src.clone(true);
    const m = new THREE.Matrix4();
    const {pos} = spec;
    m.setPosition(pos.x, pos.y, pos.z);
    if (spec.scale) {m.multiply(new THREE.Matrix4().makeScale(spec.scale.x, spec.scale.y, spec.scale.z));}
    m.multiply(SWAP_YZ);
    if (spec.rot) {
      _axis.set(spec.rot[0], spec.rot[1], spec.rot[2]);
      if (_axis.lengthSq() > 1e-8) {
        // The SwapYZ reflection conjugates every mission rotation into its
        // negative — negating the angle here re-applies the intended yaw.
        // Chained pieces (Dangerous Crossing bridge) expose the flip.
        _q.setFromAxisAngle(_axis.normalize(), -spec.rot[3] * Math.PI / 180);
        m.multiply(new THREE.Matrix4().makeRotationFromQuaternion(_q));
      }
    }
    m.multiply(G_GLB_TO_T2);
    inst.matrixAutoUpdate = false;
    inst.matrix.copy(m);
    inst.updateMatrixWorld(true);
    inst.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) {return;}
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {if (mat) {mat.side = THREE.DoubleSide;}}
      if (mats.length !== 1) {
        // Rare path: keep the multi-material mesh but pin the baked world
        // transform — re-parenting to `group` drops the instance matrix.
        const clone = mesh.clone();
        clone.matrixAutoUpdate = false;
        clone.matrix.copy(mesh.matrixWorld);
        kept.push(clone); group.add(clone); return;
      }
      const mat = mats[0]!;
      // mergeGeometries refuses mismatched attribute sets — key on the
      // layout too or one odd primitive sinks a whole material bucket.
      // Region cell goes in the key: a single map-wide bucket would get a
      // map-wide bounding sphere and never frustum-cull, so every far
      // structure rasterized every frame.
      const e = mesh.matrixWorld.elements;
      // 2048m cells: T2 GLBs shatter into ~250 materials, and the old 512m
      // grid multiplied that by 4 → ~1000 draw calls. Bigger cells keep
      // frustum culling useful at range while quartering the mesh count.
      const cell = `${Math.trunc(e[12]! / 2048)},${Math.trunc(e[14]! / 2048)}`;
      // Material dedup: the DIF exporter emits the same Blender material
      // under a new `.NNN` name per GLB (BE_EWAL01B, .001…005) — ~360
      // distinct uuids for ~60 real materials. Canonicalize on the
      // stripped name + shading params or every sibling stays its own
      // draw call.
      const canon = canonInteriorMat(mat);
      const sig = `${canon.key}|${Object.keys(mesh.geometry.attributes).toSorted().join(',')}|${mesh.geometry.index ? 'i' : 'n'}|${cell}`;
      const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      const b = buckets.get(sig) ?? { mat: canon.mat, geos: [] };
      b.geos.push(geo);
      buckets.set(sig, b);
    });
  }));
  for (const { mat, geos } of buckets.values()) {
    const merged = mergeGeometries(geos, false);
    if (!merged) { // attribute/index quirk — fall back to the unmerged geos
      for (const g of geos) {
        const mesh = new THREE.Mesh(g, mat);
        mesh.matrixAutoUpdate = false; // baked world transform — static
        mesh.receiveShadow = true;
        mesh.userData.castR = interiorCastRadius(g);
        mesh.castShadow = mesh.userData.castR > 0;
        group.add(mesh);
        mergedGeo.push(g);
      }
      continue;
    }
    for (const g of geos) {g.dispose();} // baked clones — merged owns their data now
    mergedGeo.push(merged);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.matrixAutoUpdate = false; // baked world transform — static
    mesh.receiveShadow = true;
    // Caster census: ~1000 interior meshes were all casting → ~580 extra
    // draw calls in the shadow pass. Only chunky structures' shadows read
    // at a glance — debris-scale parts don't.
    mesh.userData.castR = interiorCastRadius(merged);
    mesh.castShadow = mesh.userData.castR > 0;
    group.add(mesh);
  }
  if (missing.size > 0) {deps.logger.warn(`Interiors missing glb: ${[...missing].join(', ')}`);}
  // Bake every world matrix once, then freeze the whole subtree — the
  // per-frame updateMatrixWorld walk skips it entirely instead of
  // re-multiplying hundreds of static nodes.
  group.updateMatrixWorld(true);
  group.matrixWorldAutoUpdate = false;
  deps.logger.info(`T2 interiors placed: ${list.length - missing.size}/${list.length} → ${buckets.size + kept.length} draws`);
}

const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** Boot-time probe: saved last-room map for the resolved host, only when
 *  the host still answers a cheap liveness ping. Started before the boot
 *  heightmap loads so a live saved map wins the field outright and the
 *  default terrain is never resident. */
export async function probeBootMap(): Promise<{ map: MapSnapshot; httpUrl: string } | null> {
  const { httpUrl } = await resolveServerEndpoints();
  const map = loadLastRoomMap(httpUrl);
  if (!map) {return null;}
  if (!(await pingServer(httpUrl))) {return null;}
  return { map, httpUrl };
}

/** Load the saved map's heightfield as the boot terrain (instead of the
 *  default PNG) and mark it resident so applyTerrain dedupes the swap. */
export async function bootPrimeTerrain(httpUrl: string, map: MapSnapshot): Promise<boolean> {
  if (!map.terrain) {return false;}
  setHeightScale(map.heightScale ?? 1);
  await loadHeightfieldBin(`${httpUrl}/maps/${map.terrain}`);
  fieldLoaded = `${map.terrain}@${map.heightScale ?? 1}`;
  return true;
}
