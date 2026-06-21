import * as THREE from 'three';

export class Sky {
  private sky: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.SphereGeometry(2000, 16, 8);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x87ceeb,
      side: THREE.BackSide,
    });
    this.sky = new THREE.Mesh(geo, mat);
    scene.add(this.sky);
  }

  update(camera: THREE.Camera) {
    this.sky.position.copy(camera.position);
  }
}
