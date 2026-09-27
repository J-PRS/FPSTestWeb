import * as THREE from 'three';

import { Terrain } from '../world/terrain.js';

/**
 * Fake blob shadow — a soft radial circle pinned to terrain height that
 * fades with altitude. The terrain is a custom ShaderMaterial that can't
 * receive shadow maps, so this is what grounds objects visually.
 * (Same shader as the ball/player blob shadows — now the shared version.)
 */
export class BlobShadow {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene, radius: number, baseOpacity = 0.3) {
    this.scene = scene;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        color: { value: new THREE.Color(0x000000) },
        opacity: { value: baseOpacity },
        baseOpacity: { value: baseOpacity },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 color;
        uniform float opacity;
        varying vec2 vUv;
        void main() {
          float dist = distance(vUv, vec2(0.5));
          float alpha = smoothstep(0.5, 0.2, dist) * opacity;
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      // depthTest ON — a blob behind a ridge must be occluded by it.
      // The +0.05 lift in update() prevents z-fighting where it's visible.
      depthTest: true,
    });
    this.mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 32), this.mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.renderOrder = 999;
    scene.add(this.mesh);
  }

  /** Pin to terrain under `pos`; fade as height above ground grows. */
  update(pos: THREE.Vector3, terrain: Terrain): void {
    const groundY = terrain.getHeight(pos.x, pos.z);
    this.mesh.position.set(pos.x, groundY + 0.05, pos.z);
    const airHeight = pos.y - groundY;
    const base = this.mat.uniforms.baseOpacity.value as number;
    this.mat.uniforms.opacity.value = airHeight > 3.0
      ? Math.max(0, base * (1 - (airHeight - 3.0) / 7.0))
      : base;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mat.dispose();
    this.mesh.geometry.dispose();
  }
}
