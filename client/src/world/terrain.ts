import * as THREE from 'three';
import { getHeightmapData, getWorldScale, getHeightScale, sampleHeight, sampleNormal, sampleHeightVisual } from './heightmap.js';
import { TERRAIN_HEIGHT_SCALE, TERRAIN_WORLD_SCALE } from '../core/config.js';

// Heightmap loading/sampling + the shared Heightfield live in heightmap.ts —
// re-export so existing '../world/terrain.js' imports stay valid.
export { getHeightfield } from './heightmap.js';

const HSCALE = TERRAIN_HEIGHT_SCALE;
const DEFAULT_WORLD_SCALE = TERRAIN_WORLD_SCALE;

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
  gridOrigin: THREE.Vector2;
  innerGridOrigin: THREE.Vector2;
}

const CLIPMAP_LEVELS = [
  { spacing: 5,  divisions: 80, innerHalfSize: 0   },
  { spacing: 10, divisions: 80, innerHalfSize: 200 },
  { spacing: 20, divisions: 80, innerHalfSize: 400 },
  { spacing: 40, divisions: 80, innerHalfSize: 800 },
];


function createFlatGridGeometry(divisions: number, borderCells = 1): THREE.BufferGeometry {
  const total = divisions + 2 * borderCells;
  const n = total + 1;
  const positions = new Float32Array(n * n * 3);
  const indices = new Uint16Array(total * total * 6);

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const vi = iz * n + ix;
      // Interior [-0.5, 0.5] plus border overhang on each side
      positions[vi * 3 + 0] = (ix - borderCells) / divisions - 0.5;
      positions[vi * 3 + 1] = 0;
      positions[vi * 3 + 2] = (iz - borderCells) / divisions - 0.5;
    }
  }

  for (let iz = 0; iz < total; iz++) {
    for (let ix = 0; ix < total; ix++) {
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

import { terrainVert, terrainFrag } from './terrainShaders.js';

export class Terrain {
  private scene: THREE.Scene;
  private levels: ClipmapLevel[] = [];
  private heightTexture: THREE.DataTexture;
  /** Shared heightfield uniforms for anything else that needs to hug the
   *  terrain GPU-side (instanced blob shadows drape over slopes by
   *  sampling the same displacement). The OBJECTS are stable — reload/
   *  rescale mutate `.value` in place, so subscribers bind once. */
  readonly heightU = {
    heightMap: { value: null as THREE.DataTexture | null },
    hmWorldScale: { value: getWorldScale() },
    hScale: { value: HSCALE * getHeightScale() },
  };
  private gridGeo: THREE.BufferGeometry;
  // Shader-projected scorch decals: x, z, radius, intensity (16 slots)
  private scorchList: { x: number; z: number; r: number; intensity: number; ember: number }[] = [];
  private scorchArr = new Float32Array(16 * 4);
  private scorchEmberArr = new Float32Array(16);
  // Projected ichor stains — tinted cousin of scorch: creature hits and
  // deaths drop colored ground stains that linger far longer than char.
  private splatList: Splat[] = [];
  private splatArr = new Float32Array(24 * 4);
  private splatTintArr = new Float32Array(24 * 3);
  private splatDirArr = new Float32Array(24 * 3);
  // Projected deployable field rings (recharge pad envelope) — shader
  // decal slots like scorch; a mesh ring can't survive the clipmap's
  // 5m chord approximation.
  private fieldRingList: FieldRing[] = [];
  private fieldRingArr = new Float32Array(8 * 4);
  private fieldYArr = new Float32Array(8);
  private fieldTintArr = new Float32Array(8 * 3);

  constructor(scene: THREE.Scene, sunDir: THREE.Vector3) {
    this.scene = scene;

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
    const divisions = CLIPMAP_LEVELS[0].divisions;
    this.gridGeo = createFlatGridGeometry(divisions, 1);
    const gridGeo = this.gridGeo;
    const outerGeo = createFlatGridGeometry(divisions / 2, 1);

    for (let i = 0; i < CLIPMAP_LEVELS.length; i++) {
      const cfg = CLIPMAP_LEVELS[i];
      const levelScale = cfg.spacing * cfg.divisions;

      const material = new THREE.ShaderMaterial({
        vertexShader: terrainVert,
        fragmentShader: terrainFrag,
        lights: true, // binds sun shadow map/matrices — enables USE_SHADOWMAP
        // Outermost ring alpha-dissolves into the sky past ~80% of its
        // extent (edgeHalf) — transparent so the world edge has no seam.
        transparent: i === CLIPMAP_LEVELS.length - 1,
        polygonOffset: i > 0,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        uniforms: {
          // Required with lights:true — renderer writes light/shadow state here
          ...THREE.UniformsLib.lights,
          heightMap:       { value: this.heightTexture },
          albedoMap:       { value: null },
          useAlbedo:       { value: false },
          matTiles:        { value: null },
          matAlphaA:       { value: null },
          matAlphaB:       { value: null },
          useMats:         { value: false },
          tileMeters:      { value: 5.86 },
          tileMeans:       { value: new Float32Array(8).fill(0.5) },
          hmWorldScale:    { value: DEFAULT_WORLD_SCALE },
          hmWorldScaleFrag:{ value: DEFAULT_WORLD_SCALE },
          hScale:          { value: HSCALE },
          gridOrigin:      { value: new THREE.Vector2(0, 0) },
          levelScale:      { value: levelScale },
          gridSpacing:     { value: cfg.spacing },
          innerHalfSize:   { value: cfg.innerHalfSize },
          innerSpacing:    { value: i > 0 ? CLIPMAP_LEVELS[i - 1].spacing : 0.0 },
          innerGridOrigin: { value: new THREE.Vector2(0, 0) },
          // Outermost level dissolves into fog near its world edge — every
          // inner level's outer edge is covered by the next ring.
          edgeHalf:        { value: i === CLIPMAP_LEVELS.length - 1 ? levelScale * 0.5 : 0.0 },
          sunDir:          { value: sunDir.clone().normalize() },
          sunColor:        { value: new THREE.Color(1.0, 0.94, 0.8) },
          ambientColor:    { value: new THREE.Color(0.38, 0.45, 0.55) },
          hscale:          { value: HSCALE },
          terrainPreset:   { value: 1 },
          fogColor:        { value: new THREE.Color(0xbbd0e8) },
          fogStart:        { value: 80.0 },
          fogEnd:          { value: 400.0 },
          scorchData:      { value: this.scorchArr },
          scorchEmber:     { value: this.scorchEmberArr },
          splatData:       { value: this.splatArr },
          splatTint:       { value: this.splatTintArr },
          splatDir:        { value: this.splatDirArr },
          fieldRing:       { value: this.fieldRingArr },
          fieldTint:       { value: this.fieldTintArr },
          fieldY:          { value: this.fieldYArr },
        },
      });

      const mesh = new THREE.Mesh(i >= 2 ? outerGeo : gridGeo, material);
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // world-space extent is set via uniforms, not mesh transform
      // Clipmap levels never move — geometry does the panning in-shader.
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorldAutoUpdate = false;
      mesh.updateMatrixWorld(true);
      scene.add(mesh);

      this.levels.push({
        mesh,
        material,
        spacing: cfg.spacing,
        innerHalfSize: cfg.innerHalfSize,
        gridOrigin: new THREE.Vector2(0, 0),
        innerGridOrigin: new THREE.Vector2(0, 0),
      });
    }
  }

  /** Hot-swap the heightfield (map change via gameState): re-upload the
   *  displacement texture and point every level's material at it. Positions
   *  already in flight resolve against the new field on the next sample —
   *  callers reseat the player right after to avoid a frame under terrain. */
  reloadHeightmap(): void {
    const hm = getHeightmapData();
    if (!hm) return;
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

  /** Procedural palette (spec.terrainPreset: 0=mixed, 1=desert,
   *  2=grassland) — uniform-only, no texture state. */
  setPreset(p: number): void {
    for (const level of this.levels) {
      level.material.uniforms.terrainPreset.value = p;
    }
  }

  /** Per-map vertical gain (spec.heightScale): uniforms only — the
   *  displacement texture bytes are gain-agnostic, so no re-upload. */
  setHeightScale(worldScale: number): void {
    this.heightU.hScale.value = worldScale;
    for (const level of this.levels) {
      level.material.uniforms.hScale.value = worldScale;
      level.material.uniforms.hscale.value = worldScale;
    }
  }

  /** Per-map tile span (spec.tileSize): the heightmap/albedo UV stretch —
   *  uniforms only, same as the vertical gain. */
  setWorldScale(meters: number): void {
    this.heightU.hmWorldScale.value = meters;
    for (const level of this.levels) {
      level.material.uniforms.hmWorldScale.value = meters;
      level.material.uniforms.hmWorldScaleFrag.value = meters;
    }
  }

  /** Baked albedo (T2 ports carry terrainTex) replaces the procedural
   *  palette — the fragment shader samples it in heightmap UV space.
   *  Ownership: swap callers hand us fresh uploads; disposing the
   *  replaced texture here is what keeps map rotation off GPU memory. */
  private albedoTex: THREE.Texture | null = null;
  setAlbedo(tex: THREE.Texture | null): void {
    if (this.albedoTex && this.albedoTex !== tex) this.albedoTex.dispose();
    this.albedoTex = tex;
    for (const level of this.levels) {
      level.material.uniforms.albedoMap.value = tex;
      level.material.uniforms.useAlbedo.value = !!tex;
    }
  }

  /** T2 material blend layer — atlas of 256px tiles + packed alpha
   *  weights; the shader modulates the albedo by tile luminance near
   *  the camera (grain only — the bake keeps its color). Same ownership
   *  rule as setAlbedo: swap hands us fresh uploads, we retire the old. */
  private matsTex: THREE.Texture[] = [];
  setMaterialBlend(tiles: THREE.Texture | null, alphaA: THREE.Texture | null,
                   alphaB: THREE.Texture | null, tileMeters: number, means: number[] | null): void {
    const next = [tiles, alphaA, alphaB].filter((t): t is THREE.Texture => t !== null);
    for (const t of this.matsTex) if (!next.includes(t)) t.dispose();
    this.matsTex = next;
    for (const level of this.levels) {
      level.material.uniforms.matTiles.value = tiles;
      level.material.uniforms.matAlphaA.value = alphaA;
      level.material.uniforms.matAlphaB.value = alphaB;
      level.material.uniforms.tileMeters.value = tileMeters;
      if (means) level.material.uniforms.tileMeans.value.set(means);
      level.material.uniforms.useMats.value = !!tiles;
    }
  }

  update(px: number, pz: number): void {
    for (let i = 0; i < this.levels.length; i++) {
      const level = this.levels[i];
      // Snap grid origin to this level's spacing to prevent vertex swimming
      const ox = Math.round(px / level.spacing) * level.spacing;
      const oz = Math.round(pz / level.spacing) * level.spacing;
      level.gridOrigin.set(ox, oz);
      level.material.uniforms.gridOrigin.value.set(ox, oz);

      // Outer levels use the inner level's snapped origin for discard boundary
      if (i > 0) {
        const inner = this.levels[i - 1];
        level.innerGridOrigin.copy(inner.gridOrigin);
        level.material.uniforms.innerGridOrigin.value.copy(inner.gridOrigin);
      }
    }

    // Upload scorch decal slots (shared Float32Array across all level materials)
    this.scorchArr.fill(0);
    this.scorchEmberArr.fill(0);
    for (let i = 0; i < this.scorchList.length; i++) {
      const s = this.scorchList[i];
      const o = i * 4;
      this.scorchArr[o] = s.x;
      this.scorchArr[o + 1] = s.z;
      this.scorchArr[o + 2] = s.r;
      this.scorchArr[o + 3] = s.intensity;
      this.scorchEmberArr[i] = s.ember;
    }

    // Upload field-ring decal slots
    this.fieldRingArr.fill(0);
    this.fieldTintArr.fill(0);
    for (let i = 0; i < this.fieldRingList.length; i++) {
      const s = this.fieldRingList[i];
      const o = i * 4;
      this.fieldRingArr[o] = s.x;
      this.fieldRingArr[o + 1] = s.z;
      // Sign on r selects the shader mode: + flat annulus, − dome contour.
      this.fieldRingArr[o + 2] = s.domeY !== undefined ? -s.r : s.r;
      this.fieldRingArr[o + 3] = s.intensity;
      this.fieldYArr[i] = s.domeY ?? 0;
      this.fieldTintArr[i * 3] = s.tint[0];
      this.fieldTintArr[i * 3 + 1] = s.tint[1];
      this.fieldTintArr[i * 3 + 2] = s.tint[2];
    }

    this.splatArr.fill(0);
    this.splatTintArr.fill(0);
    this.splatDirArr.fill(0);
    for (let i = 0; i < this.splatList.length; i++) {
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
  }

  // Register a projected scorch decal. Returns a handle whose `intensity`
  // and `ember` the caller animates; pass it back to removeScorch when done.
  addScorch(x: number, z: number, r: number) {
    const entry = { x, z, r, intensity: 0.5, ember: 0 };
    if (this.scorchList.length >= 16) this.scorchList.shift();
    this.scorchList.push(entry);
    return entry;
  }

  removeScorch(entry: { x: number; z: number; r: number; intensity: number; ember: number }): void {
    const i = this.scorchList.indexOf(entry);
    if (i >= 0) this.scorchList.splice(i, 1);
  }

  // Projected ichor stain — same handle contract as addScorch. 24 slots,
  // FIFO evict: in a sustained fight the oldest dried stains vanish first.
  // dx/dz/stretch smear the stain along a landing direction (0 = round pool).
  addSplat(x: number, z: number, r: number, cr: number, cg: number, cb: number, dx = 0, dz = 0, stretch = 0): Splat {
    const entry: Splat = { x, z, r, intensity: 0, cr, cg, cb, dx, dz, stretch };
    if (this.splatList.length >= 24) this.splatList.shift();
    this.splatList.push(entry);
    return entry;
  }

  removeSplat(entry: Splat): void {
    const i = this.splatList.indexOf(entry);
    if (i >= 0) this.splatList.splice(i, 1);
  }

  // Projected field-ring decal — same contract as addScorch: mutate the
  // returned handle's intensity/tint to animate, pass it back to release.
  addFieldRing(x: number, z: number, r: number, tint: readonly [number, number, number], domeY?: number): FieldRing {
    const entry: FieldRing = { x, z, r, intensity: 0.5, tint };
    if (domeY !== undefined) entry.domeY = domeY;
    if (this.fieldRingList.length >= 8) this.fieldRingList.shift();
    this.fieldRingList.push(entry);
    return entry;
  }

  removeFieldRing(entry: FieldRing): void {
    const i = this.fieldRingList.indexOf(entry);
    if (i >= 0) this.fieldRingList.splice(i, 1);
  }

  updateFog(color: THREE.Color, start: number, end: number): void {
    for (const level of this.levels) {
      level.material.uniforms.fogColor.value.copy(color);
      level.material.uniforms.fogStart.value = start;
      level.material.uniforms.fogEnd.value = end;
    }
  }

  dispose(): void {
    for (const level of this.levels) {
      this.scene.remove(level.mesh);
      level.material.dispose();
    }
    this.levels = [];
    this.gridGeo.dispose();
    this.heightTexture.dispose();
    this.albedoTex?.dispose();
    for (const t of this.matsTex) t.dispose();
    this.matsTex = [];
  }

  getHeight(wx: number, wz: number): number {
    return sampleHeight(wx, wz);
  }

  // Visual callers only (debris, dust, birds): 1m-cell memo of the same
  // bilinear — decoration can't afford exactness but can afford reuse.
  getHeightVisual(wx: number, wz: number): number {
    return sampleHeightVisual(wx, wz);
  }

  getNormal(wx: number, wz: number): THREE.Vector3 {
    return sampleNormal(wx, wz);
  }

  /** Height of the RENDERED level-0 surface chord at (wx,wz) — the
   *  clipmap's flat triangles, not the smooth heightfield. A decal that
   *  conforms to getHeight still gets occluded where the heightfield
   *  dips mid-cell (a gully the 5m mesh bridges over), so conforming
   *  decals must also clear this chord. Only valid near the player —
   *  level 0 always surrounds the camera. */
  getRenderedHeight(wx: number, wz: number): number {
    const s = CLIPMAP_LEVELS[0].spacing;
    const x0 = Math.floor(wx / s) * s, z0 = Math.floor(wz / s) * s;
    const h00 = this.getHeight(x0, z0), h10 = this.getHeight(x0 + s, z0);
    const h01 = this.getHeight(x0, z0 + s), h11 = this.getHeight(x0 + s, z0 + s);
    const tx = (wx - x0) / s, tz = (wz - z0) / s;
    // The quad renders as two flat triangles split on the (x0+s,z0)↔
    // (x0,z0+s) diagonal — a bilinear patch sags below that surface
    // across the diagonal, so decals conforming to a bilinear estimate
    // still get clipped there. Barycentric on the actual triangle.
    return tx + tz <= 1
      ? h00 + (h10 - h00) * tx + (h01 - h00) * tz
      : h11 + (h10 - h11) * (1 - tz) + (h01 - h11) * (1 - tx);
  }
}
