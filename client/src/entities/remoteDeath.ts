import * as THREE from 'three';

import { GRAVITY, BOUNCE_Y, FRICTION_XZ } from '../core/config.js';
import type { Terrain } from '../world/terrain.js';

// Dead-body rigidbody: gravity + tumble + terrain bounce + shrink-to-nothing.
// Runs every frame at real dt (kicked off by playDeath) so corpses fall
// smoothly — under 20Hz update() cadence they fell at ~32% speed.
export interface CorpseState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  rotation: { yaw: number; pitch: number; roll: number };
  landed: boolean;
  landedAt: number;
  scale: number;
}

export function resetCorpse(s: CorpseState): void {
  s.landed = false;
  s.landedAt = 0;
  s.scale = 1;
}

export function launchCorpse(s: CorpseState, explosionPos?: THREE.Vector3, explosionForce?: number): void {
  if (explosionPos && explosionForce) {
    const toPlayer = new THREE.Vector3().subVectors(s.position, explosionPos);
    const distance = toPlayer.length();
    const direction = toPlayer.normalize();

    const falloff = Math.max(0, 1 - distance / (explosionForce * 2.5));
    const speed = explosionForce * falloff * 0.8; // 80% of explosion force

    s.velocity.set(
      direction.x * speed,
      direction.y * speed + 3, // Add upward kick
      direction.z * speed
    );

    const tumble = explosionForce * 0.5;
    s.angularVelocity.set(
      (Math.random() - 0.5) * 2 * tumble,
      (Math.random() - 0.5) * 2 * tumble,
      (Math.random() - 0.5) * 2 * tumble
    );
  } else {
    // Fallback: random velocity (for deaths without explosion)
    const speed = 8 + Math.random() * 6;
    const angle = Math.random() * Math.PI * 2;
    const elevation = Math.random() * Math.PI * 0.5;
    s.velocity.set(
      Math.cos(elevation) * Math.cos(angle) * speed,
      Math.sin(elevation) * speed + 3,
      Math.cos(elevation) * Math.sin(angle) * speed
    );

    const tumble = 5 + Math.random() * 10;
    s.angularVelocity.set(
      (Math.random() - 0.5) * 2 * tumble,
      (Math.random() - 0.5) * 2 * tumble,
      (Math.random() - 0.5) * 2 * tumble
    );
  }
}

const SHRINK_DURATION = 0.5;

/** Advance corpse physics one frame. Returns the current shrink scale. */
export function stepCorpse(s: CorpseState, dt: number, terrain: Terrain | null): void {
  s.velocity.y += GRAVITY * dt;
  s.position.addScaledVector(s.velocity, dt);

  // Apply angular velocity (tumbling on all axes)
  s.rotation.yaw += s.angularVelocity.x * dt;
  s.rotation.pitch += s.angularVelocity.y * dt;
  s.rotation.roll += s.angularVelocity.z * dt;

  // Ground collision with bounce (flat 0 fallback without terrain). A
  // NaN floor isn't a floor — skip the bounce or the corpse falls forever.
  const groundY = terrain ? terrain.getHeight(s.position.x, s.position.z) : 0;
  if (Number.isFinite(groundY) && s.position.y < groundY) {
    s.position.y = groundY;
    s.velocity.y = -s.velocity.y * BOUNCE_Y;
    s.velocity.x *= FRICTION_XZ;
    s.velocity.z *= FRICTION_XZ;
    s.angularVelocity.multiplyScalar(0.3); // Dampen rotation on bounce
    if (!s.landed) {
      s.landed = true;
      s.landedAt = 0;
    }
  }

  // Shrink after landing
  if (s.landed) {
    s.landedAt += dt;
    s.scale = Math.max(0, 1 - s.landedAt / SHRINK_DURATION);
  }
}
