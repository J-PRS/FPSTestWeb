import * as THREE from 'three';
import { getHeightmapData, getHeightfield, getWorldScale, getHeightScale, sampleHeight, sampleNormal, sampleHeightVisual } from './heightmap.js';
import { registerDiag } from '../core/fxDiag.js';
import { terrainVert, terrainFrag } from './terrainShaders.js';
import { mkTerrainOccluder } from './terrainWire.js';
import { urlParams } from '../core/params.js';
import { TERRAIN_HEIGHT_SCALE, TERRAIN_WORLD_SCALE } from '../core/config.js';
import { clipmapSurfaceHeight, type ClipmapSurfaceLevel } from './clipmapSurface.js';

// Heightmap loading/sampling + the shared Heightfield live in heightmap.ts -
// re-export so existing '../world/terrain.js' imports stay valid.
export { getHeightfield } from './heightmap.js';

const HSCALE = TERRAIN_HEIGHT_SCALE;
const DEFAULT_WORLD_SCALE = TERRAIN_WORLD_SCALE;

// F1 overlay for the DRAWN clipmap - flat cyan lines, no shading, so a
// divergent visual surface reads at a glance. Must mirror the solid
// frag's two visibility cuts or every ring's coarse interior sheet
// renders over the finer levels: the inner-hole discard (finer ring
// owns that region) and the outermost level's world-edge dissolve.
// Wire verts ride the SAME displacement - depthTest is off on the wire
// material, so no lift hack is needed; lines sit exactly on the surface.
const TERRAIN_WIRE_VERT = terrainVert;
const TERRAIN_WIRE_FRAG = /* glsl */`
  varying vec3 vWorldPos;
  varying vec3 vCameraPos;
  uniform float innerHalfSize;
  uniform vec2 innerGridOrigin;
  uniform float edgeHalf;
  void main() {
    if (innerHalfSize > 0.0) {
      vec2 d = abs(vWorldPos.xz - innerGridOrigin);
      if (max(d.x, d.y) < innerHalfSize) discard;
    }
    if (edgeHalf > 0.5 &&
        length(vWorldPos - vCameraPos) > edgeHalf * 0.55) discard;
    gl_FragColor = vec4(0.0, 0.9, 1.0, 1.0);
  }
`;

export interface FieldRing {
  x: number; z: number; r: number;
  intensity: number;
  tint: readonly [number, number, number];
  /** Set = dome-contact mode: this is the sphere center's Y and the ring
   *  traces the true sphere∩terrain contour, not a circle. */
  domeY?: number;
}

export interface Splat {
  x: number; z: number; r: number;
  intensity: number;
  cr: number; cg: number; cb: number;
  // Unit smear direction + elongation (0 = round pool): a droplet's
  // landing velocity smears the stain along its travel, like Source
  // engine blood painting behind the victim along the shot line.
  dx: number; dz: number; stretch: number;
}

interface ClipmapLevel {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  spacing: number;
  innerHalfSize: number;
  halfSize: number;
  gridOrigin: THREE.Vector2;
  innerGridOrigin: THREE.Vector2;
}

const CLIPMAP_LEVELS = [
  { spacing: 5,  divisions: 80, innerHalfSize: 0   },
  { spacing: 10, divisions: 80, innerHalfSize: 200 },
  { spacing: 20, divisions: 80, innerHalfSize: 400 },
  { spacing: 40, divisions: 80, innerHalfSize: 800 },
];
const REMOTE_PATCH_DIVS = 8;
const REMOTE_PATCH_SIZE = 40;
const REMOTE_PATCH_MAX = 64;

const REMOTE_PATCH_VERT = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vCameraPos;
  #include <shadowmap_pars_vertex>
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix) * normal);
    vWorldPos = worldPos.xyz;
    vCameraPos = cameraPosition;
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
        vec4 shadowWorldPosition = worldPos + vec4(vNormal * directionalLightShadows[ i ].shadowNormalBias, 0.0);
        vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * shadowWorldPosition;
      }
    #endif
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;


function createFlatGridGeometry(divisions: number, borderCells = 1): THREE.BufferGeometry {
  const total = divisions + 2 * borderCells;
  const n = total + 1;
  const positions = new Float32Array(n * n * 3);
  const indices = new Uint16Array(total * total * 6);

  for (let iz = 0; iz < n; iz += 1) {
    for (let ix = 0; ix < n; ix += 1) {
      const vi = iz * n + ix;
      // Interior [-0.5, 0.5] plus border overhang on each side
      positions[vi * 3 + 0] = (ix - borderCells) / divisions - 0.5;
      positions[vi * 3 + 1] = 0;
      positions[vi * 3 + 2] = (iz - borderCells) / divisions - 0.5;
    }
  }

  for (let iz = 0; iz < total; iz += 1) {
    for (let ix = 0; ix < total; ix += 1) {
      const i = iz * n + ix;
      const ti = (iz * total + ix) * 6;
      indices[ti]     = i;
      indices[ti + 1] = i + n;
      indices[ti + 2] = i + 1;
      indices[ti + 3] = i + 1;
      indices[ti + 4] = i + n;
      indices[ti + 5] = i + n + 1;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

export class Terrain {
  /** Alt+Q terrainDiv probe target - set at construction. */
  static dbg: Terrain | null = null;
  private scene: THREE.Scene;
  private levels: ClipmapLevel[] = [];
  private surfaceLevels: ClipmapSurfaceLevel[] = [];
  private remotePatches: { mesh: THREE.Mesh; lastX: number; lastZ: number; surfaceVersion: number }[] = [];
  private remotePatchMaterial: THREE.ShaderMaterial | null = null;
  private remoteDetailEnabled = false;
  private remoteSurfaceVersion = 0;
  private remotePatchStats = { active: 0, vertices: 0, cpuMs: 0, maxCpuMs: 0 };
  private heightTexture: THREE.DataTexture;
  /** Shared heightfield uniforms for anything else that needs to hug the
   *  terrain GPU-side (instanced blob shadows drape over slopes by
   *  sampling the same displacement). The OBJECTS are stable - reload/
   *  rescale mutate `.value` in place, so subscribers bind once. */
  readonly heightU = {
    heightMap: { value: null as THREE.DataTexture | null },
    hmWorldScale: { value: getWorldScale() },
    hScale: { value: HSCALE * getHeightScale() },
  };
  private gridGeo: THREE.BufferGeometry;
  // Shader-projected scorch decals: x, z, radius, intensity (16 slots)
  private scorchList: { x: number; z: number; r: number; y: number; intensity: number; ember: number }[] = [];
  private scorchArr = new Float32Array(16 * 4);
  private scorchEmberArr = new Float32Array(16);
  private scorchYArr = new Float32Array(16);
  // Projected ichor stains - tinted cousin of scorch: creature hits and
  // deaths drop colored ground stains that linger far longer than char.
  private splatList: Splat[] = [];
  private splatArr = new Float32Array(24 * 4);
  private splatTintArr = new Float32Array(24 * 3);
  private splatDirArr = new Float32Array(24 * 3);
  // Projected deployable field rings (recharge pad envelope) - shader
  // decal slots like scorch; a mesh ring can't survive the clipmap's
  // 5m chord approximation.
  private fieldRingList: FieldRing[] = [];
  // 32 slots - 8 deployables was the old headroom; a conquest lattice
  // alone wants 25 (5×5 node rings as real terrain decals).
  private fieldRingArr = new Float32Array(32 * 4);
  private fieldYArr = new Float32Array(32);
  private fieldTintArr = new Float32Array(32 * 3);

  constructor(scene: THREE.Scene, sunDir: THREE.Vector3) {
    this.scene = scene;
    this.remoteDetailEnabled = urlParams.get('terrainRemoteDetail') === '1';

    const hm = getHeightmapData();
    if (!hm) {
      throw new Error('Terrain constructor called before heightmap bytes arrived');
    }

    // Upload heightmap as a GPU texture for vertex shader displacement
    this.heightTexture = new THREE.DataTexture(
      hm.data, hm.size, hm.size, THREE.RGBAFormat, THREE.UnsignedByteType
    );
    this.heightTexture.wrapS = THREE.RepeatWrapping;
    this.heightTexture.wrapT = THREE.RepeatWrapping;
    this.heightTexture.magFilter = THREE.LinearFilter;
    this.heightTexture.minFilter = THREE.LinearFilter;
    this.heightTexture.needsUpdate = true;
    this.heightU.heightMap.value = this.heightTexture;

    // Shared flat grid geometry (normalised [-0.5, 0.5] plus one-cell
    // overlap border). Outer rings get a coarser grid: at 800m+ a heightmap
    // texel is already tens of meters, so 80-div tessellation only buys
    // triangles nobody can see.
    const [{divisions}] = CLIPMAP_LEVELS;
    this.gridGeo = createFlatGridGeometry(divisions, 1);
    const {gridGeo} = this;
    const outerGeo = createFlatGridGeometry(divisions / 2, 1);
    // Wireframe as real LINES (same path as the yellow collider lattice)
    // - Mesh.wireframe still rasterizes triangles that co-planar-fight
    // their own fill; line primitives behave like the collider overlay.
    const gridWireGeo = new THREE.WireframeGeometry(gridGeo);
    const outerWireGeo = new THREE.WireframeGeometry(outerGeo);
    // Real vertex spacing per level - outer rings run the half-division
    // grid, so their lattice is coarser than cfg.spacing claims (20→40,
    // 40→80). The inner-morph shader and the origin snap must use THIS:
    // sampling the inner seam on a 20m grid that doesn't exist, or
    // snapping the origin to non-lattice steps, is what opened the
    // distant LOD holes.
    const geoDivs = (i: number): number => (i >= 2 ? divisions / 2 : divisions);
    const vertSpacing = (i: number): number =>
      CLIPMAP_LEVELS[i].spacing * CLIPMAP_LEVELS[i].divisions / geoDivs(i);

    for (let i = 0; i < CLIPMAP_LEVELS.length; i += 1) {
      const cfg = CLIPMAP_LEVELS[i];
      const levelScale = cfg.spacing * cfg.divisions;

      const material = new THREE.ShaderMaterial({
        vertexShader: terrainVert,
        // ?terrainstub=1 - debug escape hatch: flat palette + N·L + fog,
        // NO procedural stack. Verified 2026-10-17: swapping the ~73KB
        // procedural frag for this stub takes boot from a 40-70s sync
        // D3D compile stall to ~1.3s - the fast "is it the shader?" test.
        fragmentShader: urlParams.get('terrainstub')
          ? `varying vec3 vNormal; varying vec3 vWorldPos; varying vec3 vCameraPos;
             uniform vec3 sunDir; uniform vec3 sunColor; uniform vec3 ambientColor;
             uniform vec3 fogColor; uniform float fogStart; uniform float fogEnd;
             uniform float innerHalfSize; uniform vec2 innerGridOrigin; uniform float edgeHalf;
             void main() {
               if (innerHalfSize > 0.0) { vec2 d = abs(vWorldPos.xz - innerGridOrigin); if (max(d.x, d.y) < innerHalfSize) discard; }
               vec3 n = normalize(vNormal);
               vec3 col = vec3(0.62, 0.52, 0.34) * (ambientColor + sunColor * max(dot(n, normalize(sunDir)), 0.0));
               float f = smoothstep(fogStart, fogEnd, length(vWorldPos - vCameraPos));
               if (edgeHalf > 0.5) { f = max(f, smoothstep(edgeHalf * 0.8, edgeHalf, length(vWorldPos.xz - vCameraPos.xz))); }
               gl_FragColor = vec4(mix(col, fogColor, f), f >= 1.0 ? 0.0 : 1.0);
             }`
          : terrainFrag,
        lights: true, // binds sun shadow map/matrices - enables USE_SHADOWMAP
        // Outermost ring alpha-dissolves into the sky past ~80% of its
        // extent (edgeHalf). ALL levels are transparent: `opaque` is a
        // three program parameter, so mixing minted a SECOND ~83KB
        // program (~1s serial compile inside the veil) for a one-level
        // difference. alpha=1 fragments blend identically and
        // depthWrite stays on - the cost is transparent-pass sorting.
        transparent: true,
        // Overlap band (each level's border cell rides under its parent):
        // finer levels must win coincident depth or coarse rings paint
        // over the seam - graded offset per level, finest closest.
        polygonOffset: true,
        polygonOffsetFactor: -(CLIPMAP_LEVELS.length - 1 - i),
        polygonOffsetUnits: -(CLIPMAP_LEVELS.length - 1 - i),
        // TERRAIN_PRESET picks the palette at COMPILE time - a runtime
        // uniform meant every program compiled all six preset branches.
        defines: { TERRAIN_PRESET: 1 },
        uniforms: Object.assign({}, THREE.UniformsLib.lights, {heightMap:       { value: this.heightTexture },albedoMap:       { value: null },useAlbedo:       { value: false },matTiles:        { value: null },matAlphaA:       { value: null },matAlphaB:       { value: null },useMats:         { value: false },tileMeters:      { value: 5.86 },tileMeans:       { value: new Float32Array(8).fill(0.5) },hmWorldScale:    { value: DEFAULT_WORLD_SCALE },hmWorldScaleFrag:{ value: DEFAULT_WORLD_SCALE },hScale:          { value: HSCALE },gridOrigin:      { value: new THREE.Vector2(0, 0) },levelScale:      { value: levelScale },gridSpacing:     { value: vertSpacing(i) },innerHalfSize:   { value: cfg.innerHalfSize },innerGridOrigin: { value: new THREE.Vector2(0, 0) },parentSpacing:   { value: i + 1 < CLIPMAP_LEVELS.length ? vertSpacing(i + 1) : 0 },parentOrigin:    { value: new THREE.Vector2(0, 0) },edgeHalf:        { value: i === CLIPMAP_LEVELS.length - 1 ? levelScale * 0.5 : 0 },sunDir:          { value: sunDir.clone().normalize() },sunColor:        { value: new THREE.Color(1, 0.94, 0.8) },ambientColor:    { value: new THREE.Color(0.38, 0.45, 0.55) },hscale:          { value: HSCALE },fogColor:        { value: new THREE.Color(0xBB_D0_E8) },fogStart:        { value: 80 },fogEnd:          { value: 400 },fogDir:          { value: this.fogDirOn ? 1 : 0 },fogRamp:         { value: this.fogRampVecs },fogRampN:        { value: this.fogRampN },scorchData:      { value: this.scorchArr },scorchEmber:     { value: this.scorchEmberArr },scorchY:         { value: this.scorchYArr },splatData:       { value: this.splatArr },splatTint:       { value: this.splatTintArr },splatDir:        { value: this.splatDirArr },fieldRing:       { value: this.fieldRingArr },fieldTint:       { value: this.fieldTintArr },fieldY:          { value: this.fieldYArr },scorchCount:     { value: 0 },splatCount:      { value: 0 },fieldCount:      { value: 0 },waterLevel:      { value: -1e9 },waterTint:       { value: new THREE.Color(0.12, 0.4, 0.48) },waterTime:       { value: 0 },dbgStage:        { value: -1 },litKnee:         { value: 0.85 },litKeep:         { value: 0.2 },colCap:          { value: 0.99 }}),
      });

      const mesh = new THREE.Mesh(i >= 2 ? outerGeo : gridGeo, material);
      // F1 debug wireframe - same geometry + shared uniforms, so the
      // cyan lines trace the EXACT displaced surface. Solid fill stays.
      const wireMat = new THREE.ShaderMaterial({
        vertexShader: TERRAIN_WIRE_VERT,
        fragmentShader: TERRAIN_WIRE_FRAG,
        uniforms: material.uniforms,
        // Debug overlay: the solid fill occludes co-planar lines at
        // grazing angles no matter the lift - draw on top instead.
        depthTest: false,
      });
      const wire = new THREE.LineSegments(i >= 2 ? outerWireGeo : gridWireGeo, wireMat);
      wire.visible = false;
      wire.renderOrder = 900;
      wire.frustumCulled = false;
      wire.matrixAutoUpdate = false;
      wire.matrixWorldAutoUpdate = false;
      wire.updateMatrixWorld(true);
      scene.add(wire);
      this.wireMeshes.push(wire);
      // Depth-only clone of the displaced surface - F1's occluded
      // wireframe half (see terrainWire.ts for the why).
      const occl = mkTerrainOccluder(i >= 2 ? outerGeo : gridGeo, material.uniforms);
      scene.add(occl);
      this.occlMeshes.push(occl);
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // world-space extent is set via uniforms, not mesh transform
      // Terrain sits in the transparent pass (one shared program - only
      // the edge ring needs alpha) but its fragments are alpha≈1, so any
      // VFX drawn earlier gets OVERPAINTED where they overlap. Draw
      // before every VFX object instead - depthWrite is on, so
      // depth-tested VFX still occlude behind ridges correctly.
      mesh.renderOrder = -2;
      // Clipmap levels never move - geometry does the panning in-shader.
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorldAutoUpdate = false;
      mesh.updateMatrixWorld(true);
      scene.add(mesh);

      this.levels.push({
        mesh,
        material,
        spacing: vertSpacing(i),
        innerHalfSize: cfg.innerHalfSize,
        halfSize: levelScale * 0.5,
        gridOrigin: new THREE.Vector2(0, 0),
        innerGridOrigin: new THREE.Vector2(0, 0),
      });
    }
    this.surfaceLevels = this.levels.map((level, i): ClipmapSurfaceLevel => ({
      originX: 0,
      originZ: 0,
      halfSize: level.halfSize,
      levelScale: CLIPMAP_LEVELS[i]!.spacing * CLIPMAP_LEVELS[i]!.divisions,
      spacing: level.spacing,
      parentSpacing: this.levels[i + 1]?.spacing ?? 0,
      parentOriginX: 0,
      parentOriginZ: 0,
    }));

    Terrain.dbg = this;
    registerDiag('terrainDiv', (): { terrainDiv: Record<string, unknown>; } => ({ terrainDiv: this.divergenceStats() }));
    registerDiag('terrainRemoteDetail', (): { terrainRemoteDetail: Record<string, number> } => ({
      terrainRemoteDetail: Object.assign({}, this.remotePatchStats, { drawCalls: this.remotePatchStats.active }),
    }));
  }

  /** Re-aim the baked sun without a rebuild - per-map `atmosphere.timeOfDay`.
   *  The terrain bakes its own sunDir uniform (it never reads the scene
   *  light), so a sky that moves the sun has to reach it here. */
  setSunDirection(dir: THREE.Vector3): void {
    const d = dir.clone().normalize();
    for (const l of this.levels) {l.material.uniforms.sunDir.value.copy(d);}
  }

  /** Collider field (sampleHeight) vs the drawn chord surface around the
   *  last-seen player pos - Alt+Q's numeric version of the F1 overlay. */
  divergenceStats(): Record<string, unknown> {
    const px = this.dbgPx, pz = this.dbgPz;
    const r = 40, step = CLIPMAP_LEVELS[0].spacing;
    let n = 0, sum = 0, sumAbs = 0, maxAbs = 0, worstX = 0, worstZ = 0;
    for (let dz = -r; dz <= r; dz += step) {
      for (let dx = -r; dx <= r; dx += step) {
        const d = sampleHeight(px + dx, pz + dz) - this.getRenderedHeight(px + dx, pz + dz);
n += 1; sum += d; sumAbs += Math.abs(d);
        if (Math.abs(d) > maxAbs) { maxAbs = Math.abs(d); worstX = dx; worstZ = dz; }
      }
    }
    return {
      samples: n,
      meanSigned_m: Number((sum / n).toFixed(3)),   // + = collider above visual
      meanAbs_m: Number((sumAbs / n).toFixed(3)),
      maxAbs_m: Number(maxAbs.toFixed(3)),
      worstAt: `${worstX},${worstZ}m`,
    };
  }

  /** Hot-swap the heightfield (map change via gameState): re-upload the
   *  displacement texture and point every level's material at it. Positions
   *  already in flight resolve against the new field on the next sample -
   *  callers reseat the player right after to avoid a frame under terrain. */
  reloadHeightmap(): void {
    const hm = getHeightmapData();
    if (!hm) {return;}
    this.heightTexture.dispose();
    this.heightTexture = new THREE.DataTexture(
      hm.data, hm.size, hm.size, THREE.RGBAFormat, THREE.UnsignedByteType
    );
    this.heightTexture.wrapS = THREE.RepeatWrapping;
    this.heightTexture.wrapT = THREE.RepeatWrapping;
    this.heightTexture.magFilter = THREE.LinearFilter;
    this.heightTexture.minFilter = THREE.LinearFilter;
    this.heightTexture.needsUpdate = true;
    this.heightU.heightMap.value = this.heightTexture;
    for (const level of this.levels) {
      level.material.uniforms.heightMap.value = this.heightTexture;
    }
  }

  /** Procedural palette (spec.terrainPreset: 0=mixed, 1=desert, 2=grassland,
   *  3=snow, 4=volcanic, 5=badlands, 6=coast, 7=desert hard-sun, 8=canyon,
   *  9=arcane) - swaps the
   *  TERRAIN_PRESET
   *  define and rebuilds the program; a preset-pinned program is small,
   *  so the recompile is fast and happens once per map apply. */
  /** Active palette id - ground FX (ski dust) tint themselves to match. */
  preset = 1;
  setPreset(p: number): void {
    this.preset = p;
    for (const level of this.levels) {
      const m = level.material;
      if (m.defines.TERRAIN_PRESET !== p) {
        m.defines.TERRAIN_PRESET = p;
        m.needsUpdate = true;
      }
    }
  }

  /** Per-map vertical gain (spec.heightScale): uniforms only - the
   *  displacement texture bytes are gain-agnostic, so no re-upload. */
  setHeightScale(worldScale: number): void {
    this.heightU.hScale.value = worldScale;
    for (const level of this.levels) {
      level.material.uniforms.hScale.value = worldScale;
      level.material.uniforms.hscale.value = worldScale;
    }
  }

  /** Sea level in world m - the frag tints submerged ground toward
   *  waterTint and darkens the wet band above the line. undefined = dry
   *  map (sentinel keeps the shader branch-free). */
  setWaterLevel(level: number | undefined, tint?: [number, number, number]): void {
    for (const lvl of this.levels) {
      lvl.material.uniforms.waterLevel.value = level ?? -1e9;
      if (tint) {lvl.material.uniforms.waterTint.value.setRGB(tint[0], tint[1], tint[2], THREE.SRGBColorSpace);}
    }
  }

  /** Per-map tile span (spec.tileSize): the heightmap/albedo UV stretch -
   *  uniforms only, same as the vertical gain. */
  setWorldScale(meters: number): void {
    this.heightU.hmWorldScale.value = meters;
    for (const level of this.levels) {
      level.material.uniforms.hmWorldScale.value = meters;
      level.material.uniforms.hmWorldScaleFrag.value = meters;
    }
  }

  /** Baked albedo (T2 ports carry terrainTex) replaces the procedural
   *  palette - the fragment shader samples it in heightmap UV space.
   *  Ownership: swap callers hand us fresh uploads; disposing the
   *  replaced texture here is what keeps map rotation off GPU memory. */
  private albedoTex: THREE.Texture | null = null;
  setAlbedo(tex: THREE.Texture | null): void {
    if (this.albedoTex && this.albedoTex !== tex) {this.albedoTex.dispose();}
    this.albedoTex = tex;
    for (const level of this.levels) {
      level.material.uniforms.albedoMap.value = tex;
      level.material.uniforms.useAlbedo.value = Boolean(tex);
    }
  }

  /** T2 material blend layer - atlas of 256px tiles + packed alpha
   *  weights; the shader modulates the albedo by tile luminance near
   *  the camera (grain only - the bake keeps its color). Same ownership
   *  rule as setAlbedo: swap hands us fresh uploads, we retire the old. */
  private matsTex: THREE.Texture[] = [];
  setMaterialBlend(tiles: THREE.Texture | null, alphaA: THREE.Texture | null,
                   alphaB: THREE.Texture | null, tileMeters: number, means: number[] | null): void {
    const next = [tiles, alphaA, alphaB].filter((t): t is THREE.Texture => t !== null);
    for (const t of this.matsTex) {if (!next.includes(t)) {t.dispose();}}
    this.matsTex = next;
    for (const level of this.levels) {
      level.material.uniforms.matTiles.value = tiles;
      level.material.uniforms.matAlphaA.value = alphaA;
      level.material.uniforms.matAlphaB.value = alphaB;
      level.material.uniforms.tileMeters.value = tileMeters;
      if (means) {level.material.uniforms.tileMeans.value.set(means);}
      level.material.uniforms.useMats.value = Boolean(tiles);
    }
  }

  update(px: number, pz: number): void {
    const t = performance.now() * 0.001;
    for (let i = 0; i < this.levels.length; i += 1) {
      const level = this.levels[i];
      level.material.uniforms.waterTime.value = t; // caustic phase
      // Snap grid origin to the vertex lattice (not cfg.spacing - outer
      // rings are coarser than that) or verts swim through the heightmap
      const ox = Math.round(px / level.spacing) * level.spacing;
      const oz = Math.round(pz / level.spacing) * level.spacing;
      if (ox !== level.gridOrigin.x || oz !== level.gridOrigin.y) {this.remoteSurfaceVersion += 1;}
      level.gridOrigin.set(ox, oz);
      level.material.uniforms.gridOrigin.value.set(ox, oz);
      const surfaceLevel = this.surfaceLevels[i]!;
      surfaceLevel.originX = ox;
      surfaceLevel.originZ = oz;

      // Outer levels use the inner level's snapped origin for discard boundary
      if (i > 0) {
        const inner = this.levels[i - 1];
        level.innerGridOrigin.copy(inner.gridOrigin);
        level.material.uniforms.innerGridOrigin.value.copy(inner.gridOrigin);
      }

      // The seam-morph chord needs the PARENT's snapped origin - compute
      // it directly (same snap formula) rather than reading a value the
      // parent level won't write until its own iteration.
      if (i + 1 < this.levels.length) {
        const ps = this.levels[i + 1]!.spacing;
        const parentX = Math.round(px / ps) * ps, parentZ = Math.round(pz / ps) * ps;
        level.material.uniforms.parentOrigin.value.set(parentX, parentZ);
        surfaceLevel.parentOriginX = parentX;
        surfaceLevel.parentOriginZ = parentZ;
      }
    }

    // Upload scorch decal slots (shared Float32Array across all level materials)
    this.scorchArr.fill(0);
    this.scorchEmberArr.fill(0);
    for (let i = 0; i < this.scorchList.length; i += 1) {
      const s = this.scorchList[i];
      const o = i * 4;
      this.scorchArr[o] = s.x;
      this.scorchArr[o + 1] = s.z;
      this.scorchArr[o + 2] = s.r;
      this.scorchArr[o + 3] = s.intensity;
      this.scorchEmberArr[i] = s.ember;
      this.scorchYArr[i] = s.y;
    }

    // Upload field-ring decal slots
    this.fieldRingArr.fill(0);
    this.fieldTintArr.fill(0);
    for (let i = 0; i < this.fieldRingList.length; i += 1) {
      const s = this.fieldRingList[i];
      const o = i * 4;
      this.fieldRingArr[o] = s.x;
      this.fieldRingArr[o + 1] = s.z;
      // Sign on r selects the shader mode: + flat annulus, − dome contour.
      this.fieldRingArr[o + 2] = s.domeY === undefined ? s.r : -s.r;
      this.fieldRingArr[o + 3] = s.intensity;
      this.fieldYArr[i] = s.domeY ?? 0;
      const [tint0, tint1, tint2] = s.tint;
      this.fieldTintArr[i * 3] = tint0;
      this.fieldTintArr[i * 3 + 1] = tint1;
      this.fieldTintArr[i * 3 + 2] = tint2;
    }

    this.splatArr.fill(0);
    this.splatTintArr.fill(0);
    this.splatDirArr.fill(0);
    for (let i = 0; i < this.splatList.length; i += 1) {
      const s = this.splatList[i];
      const o = i * 4;
      this.splatArr[o] = s.x;
      this.splatArr[o + 1] = s.z;
      this.splatArr[o + 2] = s.r;
      this.splatArr[o + 3] = s.intensity;
      this.splatTintArr[i * 3] = s.cr;
      this.splatTintArr[i * 3 + 1] = s.cg;
      this.splatTintArr[i * 3 + 2] = s.cb;
      this.splatDirArr[i * 3] = s.dx;
      this.splatDirArr[i * 3 + 1] = s.dz;
      this.splatDirArr[i * 3 + 2] = s.stretch;
    }

    // Dynamic loop bounds keep the decal loops rolled in the compiled
    // shader - a constant bound invites full unroll even with an early
    // break (72 iterations of decal math = 33s of sync D3D compile).
    const u0 = this.levels[0]?.material.uniforms;
    if (u0) { // shared objects - all levels read the same .value slots
      u0.scorchCount.value = this.scorchList.length;
      u0.splatCount.value = this.splatList.length;
      u0.fieldCount.value = this.fieldRingList.length;
    }
  }

  /** Debug-only experiment: 40m L0 terrain patches around active remotes.
   *  ?terrainRemoteDetail=1 enables it; production/default remains untouched. */
  updateRemoteDetail(remotes: Iterable<{ position: { x: number; z: number }; isDead: boolean }>): void {
    if (!this.remoteDetailEnabled) {return;}
    const started = performance.now();
    let active = 0;
    for (const remote of remotes) {
      if (remote.isDead) {continue;}
      if (active >= REMOTE_PATCH_MAX) {break;}
      const patch = this.ensureRemotePatch(active);
      const x = Math.round(remote.position.x / 5) * 5;
      const z = Math.round(remote.position.z / 5) * 5;
      if (x !== patch.lastX || z !== patch.lastZ || patch.surfaceVersion !== this.remoteSurfaceVersion) {
        this.updateRemotePatch(patch.mesh.geometry, x, z);
        patch.mesh.position.set(x, 0, z);
        patch.lastX = x;
        patch.lastZ = z;
        patch.surfaceVersion = this.remoteSurfaceVersion;
      }
      patch.mesh.visible = true;
      active += 1;
    }
    for (let i = active; i < this.remotePatches.length; i += 1) {this.remotePatches[i]!.mesh.visible = false;}
    const cpuMs = performance.now() - started;
    this.remotePatchStats.active = active;
    this.remotePatchStats.vertices = active * (REMOTE_PATCH_DIVS + 1) ** 2;
    this.remotePatchStats.cpuMs = cpuMs;
    this.remotePatchStats.maxCpuMs = Math.max(this.remotePatchStats.maxCpuMs, cpuMs);
  }

  remoteDetailStats(): Readonly<typeof this.remotePatchStats> { return this.remotePatchStats; }

  setRemoteDetailEnabled(enabled: boolean): void {
    this.remoteDetailEnabled = enabled;
    if (!enabled) {
      for (const patch of this.remotePatches) {patch.mesh.visible = false;}
      this.remotePatchStats.active = 0;
      this.remotePatchStats.vertices = 0;
      this.remotePatchStats.cpuMs = 0;
    }
  }

  private ensureRemotePatch(index: number): { mesh: THREE.Mesh; lastX: number; lastZ: number; surfaceVersion: number } {
    const existing = this.remotePatches[index];
    if (existing) {return existing;}
    if (!this.remotePatchMaterial) {
      const base = this.levels[0]!.material;
      this.remotePatchMaterial = new THREE.ShaderMaterial({
        vertexShader: REMOTE_PATCH_VERT,
        fragmentShader: base.fragmentShader,
        uniforms: base.uniforms,
        defines: base.defines,
        lights: true,
        transparent: true,
        depthWrite: true,
        polygonOffset: true,
        polygonOffsetFactor: -5,
        polygonOffsetUnits: -5,
      });
    }
    const divisions = REMOTE_PATCH_DIVS, n = divisions + 1;
    const positions = new Float32Array(n * n * 3);
    const indices = new Uint16Array(divisions * divisions * 6);
    for (let iz = 0; iz <= divisions; iz += 1) {
      for (let ix = 0; ix <= divisions; ix += 1) {
        const v = (iz * n + ix) * 3;
        positions[v] = (ix / divisions - 0.5) * REMOTE_PATCH_SIZE;
        positions[v + 2] = (iz / divisions - 0.5) * REMOTE_PATCH_SIZE;
        if (ix < divisions && iz < divisions) {
          const i = iz * n + ix, t = (iz * divisions + ix) * 6;
          indices[t] = i; indices[t + 1] = i + n; indices[t + 2] = i + 1;
          indices[t + 3] = i + 1; indices[t + 4] = i + n; indices[t + 5] = i + n + 1;
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    const mesh = new THREE.Mesh(geometry, this.remotePatchMaterial);
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    // After the clipmap levels (-2) it overlays, before VFX (0+) - same
    // overpaint rule as the clipmaps: a transparent terrain drawn after
    // a glow paints it out instead of being occluded by depth.
    mesh.renderOrder = -1;
    this.scene.add(mesh);
    const patch = { mesh, lastX: Number.NaN, lastZ: Number.NaN, surfaceVersion: -1 };
    this.remotePatches.push(patch);
    return patch;
  }

  private updateRemotePatch(geometry: THREE.BufferGeometry, cx: number, cz: number): void {
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    const n = REMOTE_PATCH_DIVS + 1;
    for (let iz = 0; iz <= REMOTE_PATCH_DIVS; iz += 1) {
      for (let ix = 0; ix <= REMOTE_PATCH_DIVS; ix += 1) {
        const x = cx + (ix / REMOTE_PATCH_DIVS - 0.5) * REMOTE_PATCH_SIZE;
        const z = cz + (iz / REMOTE_PATCH_DIVS - 0.5) * REMOTE_PATCH_SIZE;
        const edge = Math.min(ix, iz, REMOTE_PATCH_DIVS - ix, REMOTE_PATCH_DIVS - iz);
        const t = Math.min(1, edge / 2);
        const blend = t * t * (3 - 2 * t);
        const fine = this.getHeight(x, z);
        const rendered = this.getRenderedHeight(x, z);
        pos.setY(iz * n + ix, rendered + (fine - rendered) * blend);
      }
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
  }

  // Register a projected scorch decal. Returns a handle whose `intensity`
  // and `ember` the caller animates; pass it back to removeScorch when done.
  addScorch(x: number, z: number, r: number, y = 0): { x: number; z: number; r: number; y: number; intensity: number; ember: number; } {
    const entry = { x, z, r, y, intensity: 0.5, ember: 0 };
    if (this.scorchList.length >= 16) {this.scorchList.shift();}
    this.scorchList.push(entry);
    return entry;
  }

  removeScorch(entry: { x: number; z: number; r: number; y: number; intensity: number; ember: number }): void {
    const i = this.scorchList.indexOf(entry);
    if (i !== -1) {this.scorchList.splice(i, 1);}
  }

  // Projected ichor stain - same handle contract as addScorch. 24 slots,
  // FIFO evict: in a sustained fight the oldest dried stains vanish first.
  // dx/dz/stretch smear the stain along a landing direction (0 = round pool).
  addSplat(x: number, z: number, r: number, cr: number, cg: number, cb: number, dx = 0, dz = 0, stretch = 0): Splat {
    const entry: Splat = { x, z, r, intensity: 0, cr, cg, cb, dx, dz, stretch };
    if (this.splatList.length >= 24) {this.splatList.shift();}
    this.splatList.push(entry);
    return entry;
  }

  removeSplat(entry: Splat): void {
    const i = this.splatList.indexOf(entry);
    if (i !== -1) {this.splatList.splice(i, 1);}
  }

  // Projected field-ring decal - same contract as addScorch: mutate the
  // returned handle's intensity/tint to animate, pass it back to release.
  addFieldRing(x: number, z: number, r: number, tint: readonly [number, number, number], domeY?: number): FieldRing {
    const entry: FieldRing = { x, z, r, intensity: 0.5, tint };
    if (domeY !== undefined) {entry.domeY = domeY;}
    if (this.fieldRingList.length >= 32) {this.fieldRingList.shift();}
    this.fieldRingList.push(entry);
    return entry;
  }

  removeFieldRing(entry: FieldRing): void {
    const i = this.fieldRingList.indexOf(entry);
    if (i !== -1) {this.fieldRingList.splice(i, 1);}
  }

  updateFog(color: THREE.Color, start: number, end: number): void {
    for (const level of this.levels) {
      level.material.uniforms.fogColor.value.copy(color);
      level.material.uniforms.fogStart.value = start;
      level.material.uniforms.fogEnd.value = end;
    }
  }

  private fogDirOn = false;
  // vec4 fogRamp[6] uploads all 6 slots — the array must always carry six
  // Vector4s or three's flatten() hits undefined.toArray. Slots past
  // fogRampN are never sampled.
  private fogRampVecs: THREE.Vector4[] = [0, 1, 2, 3, 4, 5].map((): THREE.Vector4 => new THREE.Vector4());
  private fogRampN = 0;

  setFogDir(on: boolean): void {
    this.fogDirOn = on;
    for (const level of this.levels) {level.material.uniforms.fogDir.value = on ? 1 : 0;}
  }

  // spec.fog.ramp stops: {t, color} sorted by t, max 6 — shared array is
  // fine across levels (uniforms upload per material, never mutated in place).
  setFogRamp(stops: { t: number; color: THREE.Color }[] | null): void {
    const n = Math.min(stops?.length ?? 0, 6);
    this.fogRampN = n;
    const last = stops && n > 0 ? stops[n - 1]! : null;
    this.fogRampVecs = [0, 1, 2, 3, 4, 5].map((i): THREE.Vector4 => {
      const s = i < n ? stops![i]! : last;
      return s ? new THREE.Vector4(s.color.r, s.color.g, s.color.b, THREE.MathUtils.clamp(s.t, 0, 1)) : new THREE.Vector4();
    });
    for (const level of this.levels) {
      level.material.uniforms.fogRamp.value = this.fogRampVecs;
      level.material.uniforms.fogRampN.value = n;
    }
  }

  dispose(): void {
    for (const patch of this.remotePatches) {
      this.scene.remove(patch.mesh);
      patch.mesh.geometry.dispose();
    }
    this.remotePatches = [];
    this.remotePatchMaterial?.dispose();
    this.remotePatchMaterial = null;
    for (const level of this.levels) {
      this.scene.remove(level.mesh);
      level.material.dispose();
    }
    this.levels = [];
    this.gridGeo.dispose();
    this.heightTexture.dispose();
    this.albedoTex?.dispose();
    for (const t of this.matsTex) {t.dispose();}
    this.matsTex = [];
  }

  getHeight(wx: number, wz: number): number {
    return sampleHeight(wx, wz);
  }

  // ---- F1 debug wireframes: visual clipmap lines + collider lattice ----
  private wireMeshes: THREE.LineSegments[] = [];
  private occlMeshes: THREE.Mesh[] = [];
  private colliderWire: THREE.LineSegments | null = null;
  private colliderWireCx = Number.NaN;
  private colliderWireCz = Number.NaN;
  private colliderWireField: object | null = null;
  private debugWireOn = false;
  // Last player pos seen via setDebugWire - feeds the Alt+Q divergence
  // census even when the overlay itself is off.
  private dbgPx = 0;
  private dbgPz = 0;

  /** F1 debug overlay: cyan lines on the DRAWN clipmap (shared uniforms,
   *  same displaced verts - the solid fill stays) plus a yellow wire
   *  patch of the COLLIDER surface - getHeight's bilinear field, the
   *  ground the sims actually stand on - around the player. Divergence
   *  between the two colors IS the visual-vs-physics gap. */
  setDebugWire(on: boolean, px = 0, pz = 0): void {
    this.dbgPx = px; this.dbgPz = pz;
    if (on !== this.debugWireOn) {
      this.debugWireOn = on;
      this.setDebugWireVisibility(on);
      if (on) { this.colliderWireCx = Number.NaN; } // force rebuild on enable
    }
    if (!on) { return; }
    const hf = getHeightfield();
    if (!hf || !Number.isFinite(px)) { return; }
    // The collider IS the 5m L0 chord now (heightmap.sampleHeight →
    // shared hmChord) - draw it at that lattice, not texel density:
    // finer cells would just re-triangulate the same flat facets.
    const step = CLIPMAP_LEVELS[0].spacing;
    // Rebuild on a few cells of travel OR a heightfield swap - a stale
    // patch would draw the previous map's collider (reads as the
    // "collider floating above the visual" ghost).
    if (Number.isFinite(this.colliderWireCx)
      && this.colliderWireField === hf.data
      && Math.abs(px - this.colliderWireCx) < step * 4
      && Math.abs(pz - this.colliderWireCz) < step * 4) { return; }
    this.colliderWireField = hf.data;
    this.colliderWireCx = Math.round(px / step) * step;
    this.colliderWireCz = Math.round(pz / step) * step;
    this.buildColliderWire(this.colliderWireCx, this.colliderWireCz, step);
  }

  // The fill goes wireframe (palette lines, occluded by the depth-only
  // clones) - that IS the drawn-surface wire now, so both x-ray
  // overlays are noise on top: the cyan clipmap wire AND the yellow
  // collider patch (its depthTest:false read-through is the whole
  // point of divergence work). Both still build live and come back
  // with ?xray.
  private setDebugWireVisibility(on: boolean): void {
    for (const w of this.wireMeshes) { w.visible = on && urlParams.has('xray'); }
    for (const l of this.levels) { l.material.wireframe = on; }
    for (const m of this.occlMeshes) { m.visible = on; }
    if (this.colliderWire) { this.colliderWire.visible = on && urlParams.has('xray'); }
  }

  private buildColliderWire(cx: number, cz: number, step: number): void {
    const half = 80; // meters of patch around the player
    const n = Math.ceil((half * 2) / step);
    const verts = new Float32Array((n + 1) * (n + 1) * 3);
    for (let iz = 0; iz <= n; iz += 1) {
      for (let ix = 0; ix <= n; ix += 1) {
        const wx = cx - half + ix * step;
        const wz = cz - half + iz * step;
        const o = (iz * (n + 1) + ix) * 3;
        verts[o] = wx;
        verts[o + 1] = this.getHeight(wx, wz); // depthTest is off - no lift needed; offset would fake divergence
        verts[o + 2] = wz;
      }
    }
    const segs = n * (n + 1) * 2;
    const pos = new Float32Array(segs * 6);
    let o = 0;
    const at = (ix: number, iz: number): number => (iz * (n + 1) + ix) * 3;
    for (let iz = 0; iz < n; iz += 1) {
      for (let ix = 0; ix < n; ix += 1) {
        for (const [a, b] of [[at(ix, iz), at(ix + 1, iz)], [at(ix, iz), at(ix, iz + 1)]]) {
          pos.set(verts.subarray(a!, a! + 3), o); pos.set(verts.subarray(b!, b! + 3), o + 3);
          o += 6;
        }
      }
    }
    if (this.colliderWire) {
      const attr = this.colliderWire.geometry.getAttribute('position') as THREE.BufferAttribute;
      if (attr.count === pos.length / 3) {
        attr.set(pos);
      } else {
        this.colliderWire.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      }
      this.colliderWire.geometry.getAttribute('position').needsUpdate = true;
    } else {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.colliderWire = new THREE.LineSegments(geo,
        new THREE.LineBasicMaterial({ color: 0xFF_CC_00, depthTest: false }));
      this.colliderWire.frustumCulled = false;
      this.colliderWire.renderOrder = 901; // above the cyan clipmap wires
      // The scene ref wasn't kept - borrow a mesh's parent.
      this.levels[0]?.mesh.parent?.add(this.colliderWire);
    }
    this.colliderWire.visible = this.debugWireOn && urlParams.has('xray');
  }

  // Visual callers only (debris, dust, birds): 1m-cell memo of the same
  // bilinear - decoration can't afford exactness but can afford reuse.
  getHeightVisual(wx: number, wz: number): number {
    return sampleHeightVisual(wx, wz);
  }

  getNormal(wx: number, wz: number): THREE.Vector3 {
    return sampleNormal(wx, wz);
  }

  /** Exact CPU height of the rendered clipmap triangles, including
   *  vertex morphing to the parent ring. Not authoritative gameplay
   *  ground: this surface varies with the viewer's snapped ring origins. */
  getRenderedHeight(wx: number, wz: number): number {
    return clipmapSurfaceHeight(this.surfaceLevels, wx, wz, this.getHeight);
  }
}

// Plain Alt+Q prints bespoke lines, not registerDiag sections - export
// the one-liner for diagDump.ts.
/** One-line form for the plain (non-verbose) Alt+Q dump. */
export function terrainDivLine(): string | null {
  const s = Terrain.dbg?.divergenceStats();
  if (!s) {return null;}
  return `terrainDiv: collider-vs-drawn over ${s['samples']} samples r=40m - signed=${s['meanSigned_m']}m meanAbs=${s['meanAbs_m']}m max=${s['maxAbs_m']}m @(${s['worstAt']}) (signed>0 = collider above visual)`;
}
