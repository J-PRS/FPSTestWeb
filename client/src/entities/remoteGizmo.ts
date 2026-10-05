import * as THREE from 'three';
import { acquireBatch, retireBatch, type BatchMap } from '../core/batchPool.js';
import { markProbe } from '../core/fxDiag.js';

// Team-tintable ring hovering above a remote player's head — the "alive"
// marker. Every remote used to own a Mesh: ~18 head rings = ~18 draw
// calls of a 64-tri ring. Now all gizmos share one InstancedMesh —
// one draw total; follow/setColor/hide write per-instance data.
const MAX_GIZMOS = 64; // slots per batch — overflow spawns a sibling mesh
const _ringGeo = new THREE.RingGeometry(0.3, 0.4, 32);
const _flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _one = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Vector3(0, 0, 0);
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _c = new THREE.Color();
const _ringMat = new THREE.MeshBasicMaterial({ color: 0xFFFFFF, side: THREE.DoubleSide, transparent: true, opacity: 0.7 });

interface GizmoPool {
  mesh: THREE.InstancedMesh;
  free: number[];
  scene: THREE.Scene;
}

// Dynamic batching, same contract as the trail/dot batches: overflow
// gizmos spawn a sibling InstancedMesh, an emptied overflow batch retires
// — pools[0] is the floor. count++ past capacity was a silent no-op
// (out-of-bounds instance writes are ignored), starving remote rings.
const pools: BatchMap<THREE.Scene, GizmoPool> = new Map();

function makePool(scene: THREE.Scene): GizmoPool {
  const mesh = new THREE.InstancedMesh(_ringGeo, _ringMat, MAX_GIZMOS);
  mesh.matrixWorldAutoUpdate = false;
  mesh.frustumCulled = false; // rings scatter map-wide; single bounds can't cover them
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(mesh);
  markProbe(mesh, { kind: 'fxMesh', label: 'remoteGizmo' });
  return { mesh, free: [], scene };
}

export class RemoteGizmo {
  private slot = -1;
  private pool: GizmoPool;
  private pos = new THREE.Vector3();
  private shown = true;

  constructor(scene: THREE.Scene, startPos: { x: number; y: number; z: number }) {
    this.pool = acquireBatch(pools, scene, makePool,
      p => p.free.length > 0 || p.mesh.count < MAX_GIZMOS);
    this.slot = this.pool.free.length > 0 ? this.pool.free.pop()! : this.pool.mesh.count++;
    this.setColor(0x00FF00);
    this.follow(startPos);
    this.attach();
  }

  private write(): void {
    _p.copy(this.pos);
    _m.compose(_p, _flat, this.shown ? _one : _zero);
    this.pool.mesh.setMatrixAt(this.slot, _m);
    this.pool.mesh.instanceMatrix.needsUpdate = true;
  }

  follow(pos: { x: number; y: number; z: number }): void {
    this.pos.set(pos.x, pos.y + 0.7, pos.z); // head top is ~0.6 above eye
    if (this.slot >= 0) {this.write();}
  }

  setColor(hex: number): void {
    this.pool.mesh.setColorAt(this.slot, _c.setHex(hex));
    if (this.pool.mesh.instanceColor) {this.pool.mesh.instanceColor.needsUpdate = true;}
  }

  attach(): void {
    this.shown = true;
    if (this.slot >= 0) {this.write();}
  }

  detach(): void {
    this.shown = false;
    if (this.slot >= 0) {this.write();}
  }

  hide(): void { this.detach(); }

  dispose(): void {
    if (this.slot < 0) {return;}
    this.shown = false;
    this.write();
    this.pool.free.push(this.slot);
    const {scene} = this.pool;
    this.slot = -1;
    retireBatch(pools, scene, this.pool,
      p => p.free.length === p.mesh.count,
      p => { p.scene.remove(p.mesh); p.mesh.dispose(); });
  }
}
