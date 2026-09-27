import * as THREE from 'three';

/**
 * Screen shake — trauma model: blasts add trauma, the camera gets smooth
 * per-frame jitter proportional to trauma² (small shakes are gentle, big
 * hits feel big), decaying linearly. Deliberately subtle — max ~1.6° of
 * rotational jitter at full trauma.
 */
class ScreenShake {
  private trauma = 0;
  private t = 0;

  /** Add shake. `amount` ~0.2 = nearby small pop, 0.5 = point-blank rocket. */
  add(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Explosion at world pos — shake scales with blast radius and proximity. */
  blast(pos: THREE.Vector3, radius: number, listenerPos: THREE.Vector3): void {
    const reach = Math.max(radius * 5, 15); // shake falls off beyond ~5× radius
    const dist = pos.distanceTo(listenerPos);
    const proximity = Math.max(0, 1 - dist / reach);
    this.add(proximity * Math.min(0.3, radius * 0.045)); // 6m blast ≈ 0.27 point-blank
  }

  /** Apply jitter to the camera AFTER its look/quaternion is set for the frame. */
  update(dt: number, camera: THREE.Camera): void {
    if (this.trauma <= 0) return;
    this.t += dt;
    const shake = this.trauma * this.trauma;
    const MAX_RAD = 0.028; // ~1.6° — readable, never nauseating
    // Layered sines at incommensurate freqs ≈ smooth noise, no allocs
    camera.rotateX(Math.sin(this.t * 61.7) * MAX_RAD * shake);
    camera.rotateY(Math.sin(this.t * 53.3 + 1.7) * MAX_RAD * shake);
    camera.rotateZ(Math.sin(this.t * 47.1 + 3.4) * MAX_RAD * shake * 0.6); // roll is the nausea driver — damp it
    this.trauma = Math.max(0, this.trauma - dt * 1.8); // ~0.55s tail
  }
}

export const screenShake = new ScreenShake();
