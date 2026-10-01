import * as THREE from 'three';

// Team-tintable ring hovering above a remote player's head — the "alive"
// marker. Every remote used to own a Mesh: ~18 head rings = ~18 draw
// calls of a 64-tri ring. Now all gizmos share one InstancedMesh —
// one draw total; follow/setColor/hide write per-instance data.
const MAX_GIZMOS = 64;
const _ringGeo = new THREE.RingGeometry(0.3, 0.4, 32);
const _flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _one = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Vector3(0, 0, 0);
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _c = new THREE.Color();
const _ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.7 });

// The pool is per-scene singleton — remotes all share one scene, and a
// second scene (demo teardown/rebuild) gets its own bucket keyed by it.
const pools = new Map<THREE.Scene, { mesh: THREE.InstancedMesh; free: number[] }>();

function poolFor(scene: THREE.Scene) {
  let p = pools.get(scene);
  if (!p) {
    const mesh = new THREE.InstancedMesh(_ringGeo, _ringMat, MAX_GIZMOS);
    mesh.frustumCulled = false; // rings scatter map-wide; single bounds can't cover them
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(mesh);
    p = { mesh, free: [] };
    pools.set(scene, p);
  }
  return p;
}

export class RemoteGizmo {
  private slot = -1;
  private pool: { mesh: THREE.InstancedMesh; free: number[] };
  private pos = new THREE.Vector3();
  private shown = true;

  constructor(scene: THREE.Scene, startPos: { x: number; y: number; z: number }) {
    this.pool = poolFor(scene);
    this.slot = this.pool.free.length ? this.pool.free.pop()! : this.pool.mesh.count++;
    this.setColor(0x00ff00);
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
    if (this.slot >= 0) this.write();
  }

  setColor(hex: number): void {
    this.pool.mesh.setColorAt(this.slot, _c.setHex(hex));
    if (this.pool.mesh.instanceColor) this.pool.mesh.instanceColor.needsUpdate = true;
  }

  attach(): void {
    this.shown = true;
    if (this.slot >= 0) this.write();
  }

  detach(): void {
    this.shown = false;
    if (this.slot >= 0) this.write();
  }

  hide(): void { this.detach(); }

  dispose(): void {
    if (this.slot < 0) return;
    this.shown = false;
    this.write();
    this.pool.free.push(this.slot);
    this.slot = -1;
  }
}
