import * as THREE from 'three';
import type { Terrain} from '../world/terrain.js';
import { type Splat } from '../world/terrain.js';

const LIFETIME = 45;
const HOLD = 8;            // stains stay wet-bright for 8s, then dry out
const GROW = 0.14;           // wet splash expands to full radius fast, not pop-in
const DRY_T = 12;          // tint darkens over ~12s as the stain dries
const PEAK_INTENSITY = 0.75; // capped under 1 so terrain reads through
const DRY_MUL = 0.55;        // dried ichor — darker, desaturated cousin

const _c = new THREE.Color();

/**
 * Ichor splat decal: projected in the terrain fragment shader (see
 * splatStain in terrainShaders.ts) — this class only owns the lifetime:
 * radius grows in like a wet splash, then the tint darkens as it dries.
 * Longer-lived than ScorchDecal: a stain dries slowly rather than
 * cooling off. dx/dz/stretch smear the stain along a landing direction.
 */
export class SplatDecal {
  dead = false;
  private entry: Splat | null = null;
  private terrain!: Terrain;
  private age = 0;
  private peak = PEAK_INTENSITY;
  private fullR = 0;
  private baseR = 0; private baseG = 0; private baseB = 0;
  private dryMul = 1;

  constructor(_scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, radius: number, hex: number, intensity = PEAK_INTENSITY, dx = 0, dz = 0, stretch = 0) {
    if (typeof document !== 'undefined' && document.hidden) { this.dead = true; return; }
    this.terrain = terrain;
    this.peak = intensity;
    this.fullR = radius;
    _c.setHex(hex);
    this.baseR = _c.r; this.baseG = _c.g; this.baseB = _c.b;
    this.entry = terrain.addSplat(pos.x, pos.z, 0.001, _c.r, _c.g, _c.b, dx, dz, stretch);
    if (!this.entry) { this.dead = true; return; } // headless/stub terrain
    this.entry.intensity = this.peak;
  }

  update(dt: number): void {
    if (!this.entry) { this.dead = true; return; }
    this.age += dt;
    if (this.age >= LIFETIME) { this.dead = true; return; }
    // Grow-in: the splash lands and blooms over ~0.14s (ease-out), so
    // droplet impacts read as wet contact instead of decal pop-in.
    const g = Math.min(this.age / GROW, 1);
    this.entry.r = this.fullR * (0.35 + 0.65 * (1 - (1 - g) * (1 - g)));
    this.entry.intensity = this.age < HOLD
      ? this.peak
      : this.peak * (1 - (this.age - HOLD) / (LIFETIME - HOLD));
    // Dry-out: fresh ichor is bright, dried ichor darkens — ease the
    // tint multiplier over the first DRY_T seconds of the stain's life.
    const dry = Math.max(0, Math.min(this.age / DRY_T, 1));
    const m = 1 - (1 - DRY_MUL) * dry;
    if (m !== this.dryMul) {
      this.dryMul = m;
      this.entry.cr = this.baseR * m; this.entry.cg = this.baseG * m; this.entry.cb = this.baseB * m;
    }
  }

  dispose(): void {
    if (this.entry) {this.terrain.removeSplat(this.entry);}
  }
}
