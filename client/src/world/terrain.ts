import * as THREE from 'three';
import { getHeightmapData, sampleHeight, sampleNormal } from './heightmap.js';
import { TERRAIN_HEIGHT_SCALE, TERRAIN_WORLD_SCALE } from '../core/config.js';

// Heightmap loading/sampling + the shared Heightfield live in heightmap.ts —
// re-export so existing '../world/terrain.js' imports stay valid.
export { loadHeightmap, getHeightfield } from './heightmap.js';

const HSCALE = TERRAIN_HEIGHT_SCALE;
const HM_WORLD_SCALE = TERRAIN_WORLD_SCALE;

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
  private gridGeo: THREE.BufferGeometry;
  // Shader-projected scorch decals: x, z, radius, intensity (16 slots)
  private scorchList: { x: number; z: number; r: number; intensity: number; ember: number }[] = [];
  private scorchArr = new Float32Array(16 * 4);
  private scorchEmberArr = new Float32Array(16);

  constructor(scene: THREE.Scene, sunDir: THREE.Vector3) {
    this.scene = scene;

    const hm = getHeightmapData();
    if (!hm) {
      throw new Error('Terrain constructor called before loadHeightmap() completed');
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

    // Shared flat grid geometry (normalised [-0.5, 0.5] plus one-cell overlap border)
    const divisions = CLIPMAP_LEVELS[0].divisions;
    this.gridGeo = createFlatGridGeometry(divisions, 1);
    const gridGeo = this.gridGeo;

    for (let i = 0; i < CLIPMAP_LEVELS.length; i++) {
      const cfg = CLIPMAP_LEVELS[i];
      const levelScale = cfg.spacing * cfg.divisions;

      const material = new THREE.ShaderMaterial({
        vertexShader: terrainVert,
        fragmentShader: terrainFrag,
        lights: true, // binds sun shadow map/matrices — enables USE_SHADOWMAP
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
          hmWorldScale:    { value: HM_WORLD_SCALE },
          hmWorldScaleFrag:{ value: HM_WORLD_SCALE },
          hScale:          { value: HSCALE },
          gridOrigin:      { value: new THREE.Vector2(0, 0) },
          levelScale:      { value: levelScale },
          gridSpacing:     { value: cfg.spacing },
          innerHalfSize:   { value: cfg.innerHalfSize },
          innerSpacing:    { value: i > 0 ? CLIPMAP_LEVELS[i - 1].spacing : 0.0 },
          innerGridOrigin: { value: new THREE.Vector2(0, 0) },
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
        },
      });

      const mesh = new THREE.Mesh(gridGeo, material);
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // world-space extent is set via uniforms, not mesh transform
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
    for (const level of this.levels) {
      level.material.uniforms.heightMap.value = this.heightTexture;
    }
  }

  /** Baked albedo (T2 ports carry terrainTex) replaces the procedural
   *  palette — the fragment shader samples it in heightmap UV space. */
  private albedoTex: THREE.Texture | null = null;
  setAlbedo(tex: THREE.Texture | null): void {
    this.albedoTex = tex;
    for (const level of this.levels) {
      level.material.uniforms.albedoMap.value = tex;
      level.material.uniforms.useAlbedo.value = !!tex;
    }
  }

  /** T2 material blend layer — atlas of 256px tiles + packed alpha
   *  weights; the shader blends them over the albedo near the camera. */
  setMaterialBlend(tiles: THREE.Texture | null, alphaA: THREE.Texture | null,
                   alphaB: THREE.Texture | null, tileMeters: number): void {
    for (const level of this.levels) {
      level.material.uniforms.matTiles.value = tiles;
      level.material.uniforms.matAlphaA.value = alphaA;
      level.material.uniforms.matAlphaB.value = alphaB;
      level.material.uniforms.tileMeters.value = tileMeters;
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
  }

  getHeight(wx: number, wz: number): number {
    return sampleHeight(wx, wz);
  }

  getNormal(wx: number, wz: number): THREE.Vector3 {
    return sampleNormal(wx, wz);
  }
}
