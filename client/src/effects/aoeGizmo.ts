import * as THREE from 'three';
import { markProbe } from '../core/fxDiag.js';

/** Debug wireframe sphere — shows the TRUE gameplay blast radius at the
 *  detonation point (vs the Explosion dome, which is only 80% of it).
 *  Spawned from processProjectileExplosion when ?debug is set. */
export class AoeGizmo {
  readonly mesh: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private scene: THREE.Scene;
  private life = 0;
  private static readonly MAX_LIFE = 1.5;
  dead = false;

  constructor(scene: THREE.Scene, pos: THREE.Vector3, radius: number) {
    this.scene = scene;
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xFFFF00, wireframe: true, transparent: true, opacity: 0.7,
      depthTest: true,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), this.mat);
    this.mesh.position.copy(pos);
    this.mesh.scale.setScalar(radius);
    markProbe(this.mesh, { kind: 'fxMesh', label: 'aoeGizmo' });
    scene.add(this.mesh);
  }

  update(dt: number): void {
    this.life += dt;
    if (this.life >= AoeGizmo.MAX_LIFE) { this.dead = true; return; }
    this.mat.opacity = 0.7 * (1 - this.life / AoeGizmo.MAX_LIFE);
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mat.dispose();
    this.mesh.geometry.dispose();
  }
}
