// CDLOD terrain (?terrainlod=cdlod): error-refined CDLOD (Strugar 2010,
// source/BasicCDLOD). The world is a quadtree of 32x32 grid nodes;
// each node's level comes from its NEAREST distance to the camera vs
// doubled range bands (canonical rule), PLUS one deviation: a node also
// refines while its geometric error bound (heightmap.ts cdlodNodeError)
// exceeds TAU of that distance - rough ground keeps detail past the
// band edge, which is what fixes the old min-pool ridge-sink.
//
// Transitions are the canonical per-vertex distance morph: the shader
// eases each vertex onto the parent chord through the last slice of the
// node's range band (uniform morphRange), so a level swap happens after
// the surfaces already coincide - no chunk pop in either direction.
// Per-side weld masks keep unequal-level boundaries watertight, and the
// min-pool invariant is unchanged: every sample is a conservative
// channel, so the drawn surface can never hang above the collider.
import * as THREE from 'three';

import { setSurfaceCamera, type ClipmapSurfaceLevel } from './clipmapSurface.js';
import {
  CDLOD_NODE_DIVS, CDLOD_SPACINGS_M, cdlodNodeError, getWorldScale, sampleHeight, sampleHeightLod,
} from './heightmap.js';
import { terrainVert } from './terrainShaders.js';

const LEVEL_COUNT = CDLOD_SPACINGS_M.length;
const EXTENTS = CDLOD_SPACINGS_M.map((s): number => s * CDLOD_NODE_DIVS); // 160/320/640/1280m
// LOD band edges [m]: level L owns nearest-distance band [E_L, E_{L+1})
// (canonical CDLOD selection: a node drawn at the level whose band its
// closest corner sits in). E_4 only bounds the outermost morph range.
const BAND_EDGES = [0, 200, 400, 800, 1600];
// Extra (non-canonical) rule: split while bound/dist > TAU - keeps
// ridges honest past the distance bands where the old rings sank.
const TAU = 0.02;
const MORPH_START_RATIO = 0.7; // morph over the last 30% of the band
const COVER = 2560;      // half-extent of terrain covered around the camera
const MAX_NODES = 160;   // mesh pool; overflow retries selection at looser TAU
const RESELECT_STEP = 8; // re-run selection after this much camera travel

interface Leaf { level: number; ix: number; iz: number; cx: number; cz: number }

interface NodeEntry {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  leaf: Leaf | null;
  surf: ClipmapSurfaceLevel;
}

const keyOf = (level: number, ix: number, iz: number): string => `${level}:${ix}:${iz}`;

/** Morph range (start, end) for a leaf - vertex eye-distance eases 0->1
 *  across it. End = the distance where the node's parent genuinely
 *  replaces it: the band edge for distance-driven leaves, extended to
 *  the parent's own error threshold for error-refined leaves (without
 *  this, a refined far node would morph away entirely and the extra
 *  detail would never show). L3's end is synthetic (no parent). */
function morphRangeOf(leaf: Leaf, level: number, tau: number): [number, number] {
  if (level >= LEVEL_COUNT - 1) {
    const end = BAND_EDGES[LEVEL_COUNT - 1]! * 2;
    return [BAND_EDGES[level]! + (end - BAND_EDGES[level]!) * MORPH_START_RATIO, end];
  }
  const end = Math.max(BAND_EDGES[level + 1]!, cdlodNodeError(level + 1, leaf.cx, leaf.cz) / tau);
  const start = BAND_EDGES[level]! + (end - BAND_EDGES[level]!) * MORPH_START_RATIO;
  return [start, end];
}

export class TerrainCdlod {
  private scene: THREE.Scene;
  private baseUniforms: Record<string, THREE.IUniform>;
  private baseFrag: string;
  private baseDefines: Record<string, unknown> | undefined;
  private geo: THREE.BufferGeometry;
  private entries: NodeEntry[] = [];
  readonly surfaceNodes: ClipmapSurfaceLevel[] = [];
  private leaves: Leaf[] = [];
  private leafMap = new Map<string, Leaf>();
  private lastSelectX = Number.NaN;
  private lastSelectZ = Number.NaN;
  private selTau = TAU;
  /** Bumped when the leaf set changes - remote detail patches rebuild. */
  surfaceVersion = 0;
  stats = { leaves: 0, drawCalls: 0 };

  constructor(scene: THREE.Scene, baseMaterial: THREE.ShaderMaterial, geo: THREE.BufferGeometry) {
    this.scene = scene;
    this.geo = geo;
    this.baseUniforms = baseMaterial.uniforms;
    this.baseFrag = baseMaterial.fragmentShader;
    this.baseDefines = baseMaterial.defines;
  }

  private makeEntry(): NodeEntry {
    // Shared uniform OBJECTS (same refs as the ring materials) for every
    // global slot - fog/water/decal/palette setters mutate .value in place
    // and reach node materials for free. Only per-node slots get fresh
    // uniforms: origin/extent/channel selectors/morph.
    const perNode = {
      gridOrigin: { value: new THREE.Vector2(0, 0) },
      levelScale: { value: 0 },
      gridSpacing: { value: 0 },
      innerHalfSize: { value: 0 },
      innerGridOrigin: { value: new THREE.Vector2(0, 0) },
      parentSpacing: { value: 0 },
      parentOrigin: { value: new THREE.Vector2(0, 0) },
      heightSel: { value: new THREE.Vector4(1, 0, 0, 0) },
      parentSel: { value: new THREE.Vector4(0, 1, 0, 0) },
      morphRange: { value: new THREE.Vector2(0, 0) },
      morphSides: { value: new THREE.Vector4(1, 1, 1, 1) },
      edgeHalf: { value: 0 },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader: terrainVert,
      fragmentShader: this.baseFrag,
      lights: true,
      transparent: true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      defines: this.baseDefines,
      uniforms: Object.assign({}, THREE.UniformsLib.lights, this.baseUniforms, perNode),
    });
    const mesh = new THREE.Mesh(this.geo, material);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.renderOrder = -2;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.updateMatrixWorld(true);
    mesh.visible = false;
    this.scene.add(mesh);
    const surf: ClipmapSurfaceLevel = {
      originX: 0, originZ: 0, halfSize: 0, levelScale: 0,
      spacing: 1, parentSpacing: 0, parentOriginX: 0, parentOriginZ: 0,
    };
    const entry: NodeEntry = { mesh, material, leaf: null, surf };
    this.entries.push(entry);
    return entry;
  }

  private nodeOrigin(): number { return -getWorldScale() * 0.5; }

  // Canonical CDLOD selection: a node refines while its NEAREST corner
  // reaches inside the next-finer band edge. Deviation: also refines
  // while its error bound exceeds TAU of that distance.
  private shouldSplit(level: number, cx: number, cz: number, ns: number, sel: { px: number; pz: number; tau: number }): boolean {
    if (level <= 0) {return false;}
    const minD = Math.max(Math.max(Math.abs(cx - sel.px), Math.abs(cz - sel.pz)) - ns * 0.5, 0);
    if (minD < BAND_EDGES[level]!) {return true;}
    return cdlodNodeError(level, cx, cz) / Math.max(minD, 1) > sel.tau;
  }

  private descend(level: number, ix: number, iz: number, sel: { px: number; pz: number; tau: number }, out: Leaf[]): void {
    const ns = EXTENTS[level]!;
    const cx = this.nodeOrigin() + ix * ns + ns * 0.5;
    const cz = this.nodeOrigin() + iz * ns + ns * 0.5;
    if (level > 0 && this.shouldSplit(level, cx, cz, ns, sel)) {
      const c = level - 1;
      this.descend(c, ix * 2, iz * 2, sel, out);
      this.descend(c, ix * 2 + 1, iz * 2, sel, out);
      this.descend(c, ix * 2, iz * 2 + 1, sel, out);
      this.descend(c, ix * 2 + 1, iz * 2 + 1, sel, out);
      return;
    }
    out.push({ level, ix, iz, cx, cz });
  }

  // Level of the leaf covering world point p (first map hit = finest).
  private probeLevel(x: number, z: number): number {
    for (let l = 0; l < LEVEL_COUNT; l += 1) {
      const ns = EXTENTS[l]!;
      const ix = Math.floor((x - this.nodeOrigin()) / ns);
      const iz = Math.floor((z - this.nodeOrigin()) / ns);
      if (this.leafMap.has(keyOf(l, ix, iz))) {return l;}
    }
    return LEVEL_COUNT - 1;
  }

  // Watertight constraint: neighbouring leaves may differ by at most one
  // level (the finer side's weld band lands on the coarser chord).
  // Splits the too-coarse leaf; rechecks until stable.
  private relaxNeighbours(): void {
    const eps = 0.5;
    for (let pass = 0; pass < 6; pass += 1) {
      let changed = false;
      for (const leaf of this.leaves.slice()) {
        const ns = EXTENTS[leaf.level]!;
        const x0 = this.nodeOrigin() + leaf.ix * ns;
        const z0 = this.nodeOrigin() + leaf.iz * ns;
        const probes: [number, number][] = [
          [x0 - eps, z0 + ns * 0.5], [x0 + ns + eps, z0 + ns * 0.5],
          [x0 + ns * 0.5, z0 - eps], [x0 + ns * 0.5, z0 + ns + eps],
          [x0 - eps, z0 - eps], [x0 + ns + eps, z0 - eps],
          [x0 - eps, z0 + ns + eps], [x0 + ns + eps, z0 + ns + eps],
        ];
        let tooCoarse = false;
        for (const [qx, qz] of probes) {
          if (this.probeLevel(qx, qz) > leaf.level + 1) {tooCoarse = true; break;}
        }
        if (!tooCoarse || leaf.level <= 0) {continue;}
        this.leafMap.delete(keyOf(leaf.level, leaf.ix, leaf.iz));
        this.leaves.splice(this.leaves.indexOf(leaf), 1);
        const c = leaf.level - 1;
        for (const [ax, az] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const nix = leaf.ix * 2 + ax!, niz = leaf.iz * 2 + az!;
          const nns = EXTENTS[c]!;
          const child: Leaf = {
            level: c, ix: nix, iz: niz,
            cx: this.nodeOrigin() + nix * nns + nns * 0.5,
            cz: this.nodeOrigin() + niz * nns + nns * 0.5,
          };
          this.leaves.push(child);
          this.leafMap.set(keyOf(c, nix, niz), child);
        }
        changed = true;
      }
      if (!changed) {return;}
    }
  }

  private select(px: number, pz: number): void {
    const root = LEVEL_COUNT - 1;
    const ns = EXTENTS[root]!;
    const loX = Math.floor((px - COVER - this.nodeOrigin()) / ns);
    const hiX = Math.floor((px + COVER - this.nodeOrigin()) / ns);
    const loZ = Math.floor((pz - COVER - this.nodeOrigin()) / ns);
    const hiZ = Math.floor((pz + COVER - this.nodeOrigin()) / ns);
    // Rough maps can over-refine past the mesh pool - loosen TAU until
    // the leaf count fits rather than dropping coverage.
    for (let tau = TAU; ; tau *= 2) {
      this.leaves = [];
      this.leafMap.clear();
      const sel = { px, pz, tau };
      for (let iz = loZ; iz <= hiZ; iz += 1) {
        for (let ix = loX; ix <= hiX; ix += 1) {
          this.descend(root, ix, iz, sel, this.leaves);
        }
      }
      for (const l of this.leaves) {this.leafMap.set(keyOf(l.level, l.ix, l.iz), l);}
      this.relaxNeighbours();
      this.selTau = tau;
      if (this.leaves.length <= MAX_NODES || tau > TAU * 8) {break;}
    }
  }

  /** Reselect on camera steps; morph itself is per-vertex in the shader
   *  so no per-frame node work is needed between reselections. */
  update(px: number, pz: number): void {
    setSurfaceCamera(px, sampleHeight(px, pz) + 1.7, pz);
    if (!Number.isFinite(this.lastSelectX)
      || Math.abs(px - this.lastSelectX) > RESELECT_STEP
      || Math.abs(pz - this.lastSelectZ) > RESELECT_STEP) {
      this.lastSelectX = px;
      this.lastSelectZ = pz;
      this.select(px, pz);
      this.bind();
      this.surfaceVersion += 1;
    }
  }

  // 1 = the leaf across this edge is strictly coarser, so this side's
  // outer band welds onto the parent chord; 0 = equal/finer neighbours
  // weld onto OUR lattice, leave the edge on its own samples.
  private weldSide(x: number, z: number, level: number): number {
    return this.probeLevel(x, z) > level ? 1 : 0;
  }

  private bindLeaf(entry: NodeEntry, leaf: Leaf): void {
    entry.leaf = leaf;
    const u = entry.material.uniforms;
    const ns = EXTENTS[leaf.level]!;
    const spacing = CDLOD_SPACINGS_M[leaf.level]!;
    u.gridOrigin.value.set(leaf.cx, leaf.cz);
    u.levelScale.value = ns;
    u.gridSpacing.value = spacing;
    u.heightSel.value.setScalar(0).setComponent(leaf.level, 1);
    const pl = Math.min(leaf.level + 1, LEVEL_COUNT - 1);
    u.parentSel.value.setScalar(0).setComponent(pl, 1);
    u.parentSpacing.value = leaf.level + 1 < LEVEL_COUNT ? CDLOD_SPACINGS_M[leaf.level + 1]! : 80;
    // A point on the parent level's global lattice (-W/2 + k*spacing).
    const ps = u.parentSpacing.value;
    u.parentOrigin.value.set(
      this.nodeOrigin() + Math.floor((leaf.cx - this.nodeOrigin()) / ps) * ps,
      this.nodeOrigin() + Math.floor((leaf.cz - this.nodeOrigin()) / ps) * ps);
    const eps = 0.5, half = ns * 0.5;
    u.morphSides.value.set(
      this.weldSide(leaf.cx - half - eps, leaf.cz, leaf.level),
      this.weldSide(leaf.cx + half + eps, leaf.cz, leaf.level),
      this.weldSide(leaf.cx, leaf.cz - half - eps, leaf.level),
      this.weldSide(leaf.cx, leaf.cz + half + eps, leaf.level));
    const [mStart, mEnd] = morphRangeOf(leaf, leaf.level, this.selTau);
    u.morphRange.value.set(mStart, mEnd);
    // Outermost nodes keep the horizon dissolve the old L3 ring had.
    u.edgeHalf.value = leaf.level === LEVEL_COUNT - 1 ? COVER * 0.9 : 0;
    entry.material.polygonOffsetFactor = -(LEVEL_COUNT - leaf.level);
    entry.material.polygonOffsetUnits = -(LEVEL_COUNT - leaf.level);
    entry.mesh.visible = true;

    const {surf} = entry;
    surf.originX = leaf.cx;
    surf.originZ = leaf.cz;
    surf.halfSize = ns * 0.5;
    surf.levelScale = ns;
    surf.spacing = spacing;
    surf.parentSpacing = u.parentSpacing.value;
    surf.parentOriginX = u.parentOrigin.value.x;
    surf.parentOriginZ = u.parentOrigin.value.y;
    const sv = u.morphSides.value;
    surf.morphSides = [sv.x, sv.y, sv.z, sv.w];
    surf.morphRange = [mStart, mEnd];
    surf.sample = leaf.level === 0 ? undefined
      : (x: number, z: number): number => sampleHeightLod(leaf.level, x, z);
    surf.parentSample = (x: number, z: number): number => sampleHeightLod(pl, x, z);
  }

  private bind(): void {
    this.surfaceNodes.length = 0;
    let used = 0;
    for (const leaf of this.leaves) {
      if (used >= MAX_NODES) {break;}
      const entry = this.entries[used] ?? this.makeEntry();
      used += 1;
      this.bindLeaf(entry, leaf);
      this.surfaceNodes.push(entry.surf);
    }
    for (let i = used; i < this.entries.length; i += 1) {
      this.entries[i]!.mesh.visible = false;
      this.entries[i]!.leaf = null;
    }
    this.stats.leaves = this.leaves.length;
    this.stats.drawCalls = used;
  }

  /** Node materials share the base material's defines object - a preset
   *  change already landed there; each program still needs its own
   *  needsUpdate to recompile. */
  markForRecompile(): void {
    for (const entry of this.entries) {entry.material.needsUpdate = true;}
  }

  dispose(): void {
    for (const entry of this.entries) {
      this.scene.remove(entry.mesh);
      entry.material.dispose();
    }
    this.entries = [];
    this.leaves = [];
    this.leafMap.clear();
    this.surfaceNodes.length = 0;
  }
}
