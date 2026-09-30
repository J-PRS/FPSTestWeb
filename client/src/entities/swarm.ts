import * as THREE from 'three';
import type { Terrain } from '../world/terrain.js';
import { UNGRADE_GLSL } from '../core/gradeGlsl.js';

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

  constructor(scene: THREE.Scene, parts: SwarmPart[], capacity: number) {
    this.owners = Array.from<SwarmSlotOwner | undefined>({ length: capacity });
    for (const p of parts) {
      const per = p.per ?? 1;
      const mesh = new THREE.InstancedMesh(p.geometry, p.material, capacity * per);
      mesh.count = 0;
      mesh.frustumCulled = false; // instances span the map — whole-mesh bounds are meaningless
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(capacity * per * 3).fill(1), 3,
      );
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      if (p.renderOrder !== undefined) mesh.renderOrder = p.renderOrder;
      mesh.castShadow = p.castShadow ?? false;
      scene.add(mesh);
      this.meshes.push(mesh);
      this.pers.push(per);
    }
  }

  get capacity(): number { return this.owners.length; }
  get liveCount(): number { return this.live; }

  /** Returns a slot index, or -1 when the swarm is full. */
  alloc(owner: SwarmSlotOwner): number {
    if (this.live >= this.owners.length) return -1;
    const slot = this.live++;
    this.owners[slot] = owner;
    owner.swarmSlot = slot;
    for (let i = 0; i < this.meshes.length; i++) this.meshes[i]!.count = this.live * this.pers[i]!;
    return slot;
  }

  /** Swap-remove a slot: the last live owner's data moves into it. */
  free(slot: number): void {
    const last = this.live - 1;
    if (slot < 0 || slot > last) return;
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
    for (let i = 0; i < this.meshes.length; i++) this.meshes[i]!.count = this.live * this.pers[i]!;
    this.flagDirty();
  }

  /** slot is the raw instance index — for `per` parts pass owner.slot*per+i. */
  setMatrix(part: number, slot: number, matrix: THREE.Matrix4): void {
    if (slot < 0) return; // slot already freed (gib burst) — a dying owner may still tick once
    const m = this.meshes[part]!;
    m.setMatrixAt(slot, matrix);
    m.instanceMatrix.needsUpdate = true;
  }

  setColor(part: number, slot: number, r: number, g: number, b: number): void {
    if (slot < 0) return;
    const m = this.meshes[part]!;
    m.instanceColor!.setXYZ(slot, r, g, b);
    m.instanceColor!.needsUpdate = true;
  }

  /** Instances per owner for a part index — exposed for gib snapshots. */
  perFor(part: number): number { return this.pers[part]!; }
  get partCount(): number { return this.meshes.length; }

  /** Per-frame upload flag — call once after all species have updated. */
  flagDirty(): void {
    for (const m of this.meshes) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }
}

/**
 * Instanced blob shadows shared across every species — replaces the
 * per-enemy BlobShadow meshes (one draw call for ALL enemy shadows).
 * Per-instance altitude fade is carried in a float attribute the shader reads.
 */
const SHADOW_CAPACITY = 1024;

const shadowVert = /* glsl */ `
  attribute float aOpacity;
  varying vec2 vUv;
  varying float vOpacity;
  void main() {
    vUv = uv;
    vOpacity = aOpacity;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
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
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, SHADOW_CAPACITY);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 999;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    this.owners = Array.from<SwarmSlotOwner | undefined>({ length: SHADOW_CAPACITY });
  }

  alloc(owner: SwarmSlotOwner): number {
    if (this.live >= SHADOW_CAPACITY) return -1;
    const slot = this.live++;
    this.owners[slot] = owner;
    this.mesh.count = this.live;
    return slot;
  }

  free(owner: SwarmSlotOwner): void {
    const slot = owner.shadowSlot;
    if (slot < 0 || slot > this.live - 1) return;
    const last = this.live - 1;
    if (slot !== last) {
      const moved = this.owners[last]!;
      moved.shadowSlot = slot;
      this.owners[slot] = moved;
      this.mesh.getMatrixAt(last, _m);
      this.mesh.setMatrixAt(slot, _m);
      this.opacity.setX(slot, this.opacity.getX(last));
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
    if (slot < 0 || slot >= this.live) return;
    const groundY = this.terrain.getHeight(pos.x, pos.z);
    const airHeight = pos.y - groundY;
    const o = airHeight > 3.0 ? Math.max(0, baseOpacity * (1 - (airHeight - 3.0) / 7.0)) : baseOpacity;
    this._v.set(pos.x, groundY + 0.05, pos.z);
    this._s.setScalar(radius);
    _m.compose(this._v, this._q.identity(), this._s);
    this.mesh.setMatrixAt(slot, _m);
    this.opacity.setX(slot, o);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.opacity.needsUpdate = true;
  }
}

