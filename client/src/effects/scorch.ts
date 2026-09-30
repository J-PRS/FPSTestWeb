import * as THREE from 'three';
import { Terrain } from '../world/terrain.js';

const LIFETIME = 5.0;
const HOLD = 2.0;            // full intensity for the first 2s, then fades
const PEAK_INTENSITY = 0.5;  // shader: col *= 1 - mask*intensity
const EMBER_LIFE = 0.8;      // seconds the rim glows after impact
const EMBER_PEAK = 0.9;

/**
 * Scorch decal: projected in the terrain fragment shader (see
 * scorchMask/scorchEmberGlow in terrain.ts) — this class only owns the
 * decal's lifetime, animating `intensity` (char mark) and `ember`
 * (brief glowing rim) on its registered slot.
 */
export class ScorchDecal {
  dead = false;
  private entry: { x: number; z: number; r: number; intensity: number; ember: number } | null = null;
  private terrain!: Terrain;
  private age = 0;

  constructor(_scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, radius: number) {
    // See Explosion — hidden-tab spawns die at birth.
    if (typeof document !== 'undefined' && document.hidden) { this.dead = true; return; }
    this.terrain = terrain;
    this.entry = terrain.addScorch(pos.x, pos.z, radius);
    this.entry.ember = EMBER_PEAK;
  }

  update(dt: number): void {
    if (!this.entry) { this.dead = true; return; }
    this.age += dt;
    const t = this.age / LIFETIME;
    if (t >= 1) {
      this.dead = true;
      return;
    }
    this.entry.intensity = this.age < HOLD
      ? PEAK_INTENSITY
      : PEAK_INTENSITY * (1 - (this.age - HOLD) / (LIFETIME - HOLD));
    this.entry.ember = EMBER_PEAK * Math.max(0, 1 - this.age / EMBER_LIFE);
  }

  dispose(): void {
    if (this.entry) this.terrain.removeScorch(this.entry);
  }
}
