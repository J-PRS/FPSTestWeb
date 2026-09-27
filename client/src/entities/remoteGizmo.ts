import * as THREE from 'three';

// Team-tintable ring hovering above a remote player's head — the "alive"
// marker. Death pulls it from the scene; respawn re-attaches via attach().
// Color persists across frames (was reset to green every tick — that
// clobbered the team tint bots set via setColor).
export class RemoteGizmo {
  private mesh: THREE.Mesh;
  private inScene = false;

  constructor(private scene: THREE.Scene, startPos: { x: number; y: number; z: number }) {
    this.mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.4, 32),
      new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.DoubleSide, transparent: true, opacity: 0.7 }),
    );
    this.mesh.rotation.x = -Math.PI / 2; // lay flat
    this.follow(startPos);
    this.attach();
  }

  follow(pos: { x: number; y: number; z: number }): void {
    this.mesh.position.set(pos.x, pos.y + 0.7, pos.z); // head top is ~0.6 above eye
  }

  setColor(hex: number): void {
    (this.mesh.material as THREE.MeshBasicMaterial).color.setHex(hex);
  }

  attach(): void {
    if (!this.inScene) { this.scene.add(this.mesh); this.inScene = true; }
    this.mesh.visible = true;
  }

  detach(): void {
    if (this.inScene) { this.scene.remove(this.mesh); this.inScene = false; }
  }

  hide(): void { this.mesh.visible = false; }

  dispose(): void {
    this.detach();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
