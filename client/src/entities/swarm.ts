import * as THREE from 'three';
import type { Terrain } from '../world/terrain.js';
import { UNGRADE_GLSL } from '../core/gradeGlsl.js';
import { markProbe } from '../core/fxDiag.js';
import { CapGovernor } from '../core/poolPolicy.js';

/**
 * Instanced swarm renderer — the draw-call fix for massive enemy counts.
 *
 * One InstancedMesh per (species, body-part). An enemy owns a slot index, not
 * a mesh: each frame it writes part matrices into its slots. Draw calls stay
 * constant (parts per species) no matter how many enemies are alive.
 *
 * Slots are swap-removed: freeing slot i moves the last live owner into i so
 * `count` always covers [0, liveCount). Owners must expose `swarmSlot` so the
 * relocation can update their handle.
 */
export interface SwarmSlotOwner {
  swarmSlot: number;
  /** Handle into the shared instanced blob-shadow pass (-1 = none). */
  shadowSlot: number;
  /** Species key this owner allocated under — set by allocSlots, lets the
   *  death path gib the body without knowing the concrete class. */
  swarmSpecies?: string;
}

const _m = new THREE.Matrix4();

export interface SwarmPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Instances per owner — e.g. 6 for a crawler's legs. Default 1. */
  per?: number;
  /** Terrain quads etc. that must sort after opaque geometry. */
  renderOrder?: number;
  castShadow?: boolean;
}

export class SpeciesSwarm {
  readonly meshes: THREE.InstancedMesh[] = [];
  private owners: (SwarmSlotOwner | undefined)[];
  private pers: number[] = [];
  private live = 0;

  private readonly initCap: number;
  private capGov = new CapGovernor();

  constructor(scene: THREE.Scene, parts: SwarmPart[], capacity: number) {
    this.initCap = capacity;
    this.owners = Array.from<SwarmSlotOwner | undefined>({ length: capacity });
    for (const p of parts) {
      const per = p.per ?? 1;
      const mesh = new THREE.InstancedMesh(p.geometry, p.material, capacity * per);
    mesh.matrixWorldAutoUpdate = false;
      mesh.count = 0;
      mesh.frustumCulled = false; // instances span the map — whole-mesh bounds are meaningless
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(capacity * per * 3).fill(1), 3,
      );
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      if (p.renderOrder !== undefined) {mesh.renderOrder = p.renderOrder;}
      // Instanced castShadow is disabled: the generated depth program for
      // instanced custom materials mismatches its sampler binding
      // (GL_INVALID_OPERATION per draw — the driver dropped those shadow
      // draws anyway, so they never actually cast). Same visuals, and it
      // kills a per-draw validation error in the console.
      mesh.castShadow = false;
      scene.add(mesh);
      this.meshes.push(mesh);
      this.pers.push(per);
    }
  }

  get capacity(): number { return this.owners.length; }
  get liveCount(): number { return this.live; }

  /** Aim probe: the owner an instance index belongs to — each owner owns
   *  `per` consecutive instances inside a part mesh. */
  ownerAt(meshIdx: number, instanceId: number): SwarmSlotOwner | undefined {
    const per = this.pers[meshIdx] ?? 1;
    return this.owners[Math.floor(instanceId / per)];
  }

  /** Realloc every per-part instance buffer + owners table at `cap`.
   *  Live data is copied into the head of the new buffers; slots stay
   *  dense, so the count bound needs no remapping either direction. */
  private resize(cap: number): void {
    this.owners.length = cap;
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i]!;
      const per = this.pers[i]!;
      const mat = new THREE.InstancedBufferAttribute(new Float32Array(cap * per * 16), 16);
      mat.array.set(m.instanceMatrix.array.subarray(0, cap * per * 16)); // subarray — set() throws when the source outlives the target
      mat.setUsage(THREE.DynamicDrawUsage);
      m.instanceMatrix = mat;
      const col = new THREE.InstancedBufferAttribute(new Float32Array(cap * per * 3).fill(1), 3);
      col.array.set(m.instanceColor!.array.subarray(0, cap * per * 3));
      col.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = col;
    }
    this.dirty = true;
    this.flagDirty();
  }

  private grow(): void { this.resize(this.owners.length * 2); }

  /** Halve back toward the initial capacity once occupancy has held
   *  under a quarter for IDLE_SHRINK_MS — a wave spike shouldn't pin
   *  peak memory forever. Dense slots make truncation lossless. */
  checkShrink(now: number): void {
    const cap = this.capGov.shrinkTarget(this.live, this.owners.length, this.initCap, now);
    if (cap === null) {return;}
    this.resize(cap);
    this.capGov.shrunk(now);
  }

  /** Returns a slot index; grows the swarm instead of ever returning -1. */
  alloc(owner: SwarmSlotOwner): number {
    if (this.live >= this.owners.length) {this.grow();}
    const slot = this.live++;
    this.owners[slot] = owner;
    owner.swarmSlot = slot;
    for (let i = 0; i < this.meshes.length; i++) {this.meshes[i]!.count = this.live * this.pers[i]!;}
    return slot;
  }

  /** Swap-remove a slot: the last live owner's data moves into it. */
  free(slot: number): void {
    const last = this.live - 1;
    if (slot < 0 || slot > last) {return;}
    if (slot !== last) {
      const moved = this.owners[last]!;
      this.owners[slot] = moved;
      moved.swarmSlot = slot;
      for (let i = 0; i < this.meshes.length; i++) {
        const m = this.meshes[i]!;
        const per = this.pers[i]!;
        const c = m.instanceColor!;
        for (let k = 0; k < per; k++) {
          m.getMatrixAt(last * per + k, _m);
          m.setMatrixAt(slot * per + k, _m);
          c.setXYZ(slot * per + k, c.getX(last * per + k), c.getY(last * per + k), c.getZ(last * per + k));
        }
      }
    }
    this.owners[last] = undefined;
    this.live--;
    for (let i = 0; i < this.meshes.length; i++) {this.meshes[i]!.count = this.live * this.pers[i]!;}
    this.dirty = true;
    this.flagDirty();
  }

  /** slot is the raw instance index — for `per` parts pass owner.slot*per+i. */
  setMatrix(part: number, slot: number, matrix: THREE.Matrix4): void {
    if (slot < 0) {return;} // slot already freed (gib burst) — a dying owner may still tick once
    const m = this.meshes[part]!;
    m.setMatrixAt(slot, matrix);
    m.instanceMatrix.addUpdateRange(slot * 16, 16);
    m.instanceMatrix.needsUpdate = true;
    this.dirty = true;
  }

  setColor(part: number, slot: number, r: number, g: number, b: number): void {
    if (slot < 0) {return;}
    const m = this.meshes[part]!;
    m.instanceColor!.setXYZ(slot, r, g, b);
    m.instanceColor!.addUpdateRange(slot * 3, 3);
    m.instanceColor!.needsUpdate = true;
  }

  /** Instances per owner for a part index — exposed for gib snapshots. */
  perFor(part: number): number { return this.pers[part]!; }
  get partCount(): number { return this.meshes.length; }

  /** Per-frame upload flag — call once after all species have updated.
   *  Slots are dense [0, live), so the upload can stop at live*per
   *  instances instead of the full capacity, and skip entirely when
   *  nothing moved (setMatrix/setColor flag `dirty`). */
  private dirty = false;
  flagDirty(): void {
    if (!this.dirty) {return;}
    this.dirty = false;
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i]!;
      m.instanceMatrix.addUpdateRange(0, this.live * this.pers[i]! * 16);
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) {
        m.instanceColor.addUpdateRange(0, this.live * this.pers[i]! * 3);
        m.instanceColor.needsUpdate = true;
      }
    }
  }
}

/**
 * Instanced blob shadows shared across every species — replaces the
 * per-enemy BlobShadow meshes (one draw call for ALL enemy shadows).
 * Per-instance altitude fade is carried in a float attribute the shader reads.
 */
const SHADOW_CAPACITY = 1024; // initial size — grows on demand
// Held under quarter-occupancy this long → capacity contracts to the
// nearest initCap multiple covering 2× live. Same contract as the
// quarks pool keep-alive window.


const shadowVert = /* glsl */ `
  uniform sampler2D heightMap;
  uniform float hmWorldScale;
  uniform float hScale;
  attribute float aOpacity;
  varying vec2 vUv;
  varying float vOpacity;
  void main() {
    vUv = uv;
    vOpacity = aOpacity;
    // Terrain-conforming blob: a flat disc sinks into uphill slopes, so
    // every vertex drops to the heightfield instead — same displacement
    // the clipmap vertex shader applies (fract() UV + hScale gain). The
    // instance matrix keeps owning XZ + radius; y is ground + epsilon.
    vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
    wp.y = texture2D(heightMap, fract(wp.xz / hmWorldScale)).r * hScale + 0.06;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const shadowFrag = /* glsl */ `
  varying vec2 vUv;
  varying float vOpacity;
  ${UNGRADE_GLSL}
  void main() {
    float dist = distance(vUv, vec2(0.5));
    float alpha = smoothstep(0.5, 0.2, dist) * vOpacity;
    gl_FragColor = vec4(ungradeColor(vec3(0.0)), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class InstancedBlobShadows {
  private mesh: THREE.InstancedMesh;
  private opacity: THREE.InstancedBufferAttribute;
  private owners: (SwarmSlotOwner | undefined)[];
  private live = 0;
  private terrain: Terrain;

  constructor(scene: THREE.Scene, terrain: Terrain) {
    this.terrain = terrain;
    // Unit disc — per-instance matrix carries radius via scale
    const geo = new THREE.CircleGeometry(1, 24);
    geo.rotateX(-Math.PI / 2);
    this.opacity = new THREE.InstancedBufferAttribute(new Float32Array(SHADOW_CAPACITY), 1);
    this.opacity.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aOpacity', this.opacity);
    const mat = new THREE.ShaderMaterial({
      vertexShader: shadowVert,
      fragmentShader: shadowFrag,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // Shared uniform objects — Terrain rewrites them on map swap so the
      // shadows track heightScale/tileSize without a rebind.
      uniforms: {
        heightMap: terrain.heightU.heightMap,
        hmWorldScale: terrain.heightU.hmWorldScale,
        hScale: terrain.heightU.hScale,
      },
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, SHADOW_CAPACITY);
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 999;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    markProbe(this.mesh, { kind: 'blobShadows', swarm: this });
    this.owners = Array.from<SwarmSlotOwner | undefined>({ length: SHADOW_CAPACITY });
  }

  /** Aim probe: which owner's blob a shadow instance is. */
  ownerAt(slot: number): SwarmSlotOwner | undefined { return this.owners[slot]; }

  private capGov = new CapGovernor();

  /** Realloc instance buffers at `cap` — the owners table is the source
   *  of truth for capacity, so a full pool grows instead of silently
   *  skipping the shadow. */
  private resize(cap: number): void {
    this.owners.length = cap;
    const mat = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    mat.array.set(this.mesh.instanceMatrix.array.subarray(0, cap * 16));
    mat.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceMatrix = mat;
    const op = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    op.array.set(this.opacity.array.subarray(0, cap));
    op.setUsage(THREE.DynamicDrawUsage);
    this.opacity = op;
    this.mesh.geometry.setAttribute('aOpacity', op);
  }

  private grow(): void { this.resize(this.owners.length * 2); }

  /** Same idle-shrink contract as SpeciesSwarm — dense slots, lossless. */
  checkShrink(now: number): void {
    const cap = this.capGov.shrinkTarget(this.live, this.owners.length, SHADOW_CAPACITY, now);
    if (cap === null) {return;}
    this.resize(cap);
    this.capGov.shrunk(now);
  }

  get liveCount(): number { return this.live; }

  alloc(owner: SwarmSlotOwner): number {
    if (this.live >= this.owners.length) {this.grow();}
    const slot = this.live++;
    this.owners[slot] = owner;
    this.mesh.count = this.live;
    return slot;
  }

  free(owner: SwarmSlotOwner): void {
    const slot = owner.shadowSlot;
    if (slot < 0 || slot > this.live - 1) {return;}
    const last = this.live - 1;
    if (slot !== last) {
      const moved = this.owners[last]!;
      moved.shadowSlot = slot;
      this.owners[slot] = moved;
      this.mesh.getMatrixAt(last, _m);
      this.mesh.setMatrixAt(slot, _m);
      this.opacity.setX(slot, this.opacity.getX(last));
      this.mesh.instanceMatrix.addUpdateRange(slot * 16, 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      this.opacity.addUpdateRange(slot, 1);
      this.opacity.needsUpdate = true;
    }
    this.owners[last] = undefined;
    this.live--;
    this.mesh.count = this.live;
    owner.shadowSlot = -1;
  }

  private _v = new THREE.Vector3();
  private _q = new THREE.Quaternion();
  private _s = new THREE.Vector3();

  /** Pin under pos; fade with altitude — same curve as BlobShadow. */
  set(owner: SwarmSlotOwner & { shadowSlot: number }, pos: THREE.Vector3, radius: number, baseOpacity: number): void {
    const slot = owner.shadowSlot;
    if (slot < 0 || slot >= this.live) {return;}
    const groundY = this.terrain.getHeight(pos.x, pos.z);
    const airHeight = pos.y - groundY;
    const o = airHeight > 3 ? Math.max(0, baseOpacity * (1 - (airHeight - 3) / 7)) : baseOpacity;
    this._v.set(pos.x, groundY + 0.05, pos.z);
    this._s.setScalar(radius);
    _m.compose(this._v, this._q.identity(), this._s);
    this.mesh.setMatrixAt(slot, _m);
    this.opacity.setX(slot, o);
    this.mesh.instanceMatrix.addUpdateRange(slot * 16, 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.opacity.addUpdateRange(slot, 1);
    this.opacity.needsUpdate = true;
  }
}

