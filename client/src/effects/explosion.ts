import * as THREE from 'three';
import { Terrain } from '../world/terrain.js';
import { ExplosionSparks } from './explosionSparks.js';
import { ExplosionLayers } from './explosionLayers.js';

// Explosion = the blast's identity (pos for bot blast-hearing, age, dead
// flag) + the ctor math that sizes it. The layer recipes live in
// explosionLayers.ts; the batched trail-spark system in explosionSparks.ts.
export class Explosion {
  dead = false;
  private sparks: ExplosionSparks | null = null;
  private layers: ExplosionLayers | null = null;
  private scene!: THREE.Scene;
  private elapsed = 0;
  /** Immobile after construction — the blast's hearing surface for
   *  bot senses (mirrors the server's noise events). */
  readonly pos!: THREE.Vector3;
  get age(): number { return this.elapsed; }
  private ox!: number; private oy!: number; private oz!: number;
  // Per-weapon energy tint — lerped into glow particles, shock dome and
  // ground ring so a teal plasma bolt doesn't pop orange.
  private readonly tint = new THREE.Color();
  private hasTint = false;


  // sizeScale normalizes blast size to weapon radius (rocket = 1.0):
  // a mortar's 14m blast shouldn't render like a 6m rocket.
  constructor(scene: THREE.Scene, pos: THREE.Vector3, directHit: boolean = false, age: number = 0, ...opts: [terrain?: Terrain, sizeScale?: number, tint?: string | number, vfx?: 'splash' | 'punch' | 'energy' | 'kinetic' | 'concussion' | 'arc' | 'bolt' | 'flak']) {
    const [terrain, sizeScale = 1.0, tint, vfx] = opts;
    // pos/scene must always bind — bot senses read .pos for blast
    // hearing even on a dead-at-birth shell.
    this.scene = scene;
    this.ox = pos.x; this.oy = pos.y; this.oz = pos.z;
    this.pos = pos.clone();
    // Hidden tabs decay ~1 frame/sec — spawning full VFX there stacks
    // hundreds of live particles into the frame you tab back to.
    if (typeof document !== 'undefined' && document.hidden) { this.dead = true; return; }
    if (tint !== undefined) {
      this.tint.set(tint);
      this.hasTint = true;
    }

    // Scale factor based on projectile flight time: 50% at 0s, 100% at 1s (linear, clamped)
    const timeScale = (directHit ? Math.min(0.5 + age * 0.5, 1.0) : 1.0) * sizeScale;
    // Multipliers for direct hit enhancement (base 1.8, scaled by time)
    const mult = (directHit ? 1.8 * timeScale : sizeScale);

    this.sparks = new ExplosionSparks(scene);
    this.layers = new ExplosionLayers(scene, this.sparks, this.tint, this.hasTint);
    this.layers.spawn(vfx, pos, mult, directHit, timeScale, terrain);
    this.sparks.finalize();
  }

  update(dt: number): void {
    this.elapsed += dt;
    const alive = (this.layers?.update(dt) ?? 0) + (this.sparks?.update(dt) ?? 0);
    if (alive === 0) this.dead = true;
  }

  /** Distance-gated tick — far blasts age so they retire on schedule but
   *  skip the layer/spark buffer writes nobody can see. */
  tickAge(dt: number): void {
    this.elapsed += dt;
    if (this.elapsed > 6) this.dead = true;
  }

  dispose(): void {
    this.layers?.dispose();
    this.sparks?.dispose();
    this.layers = null;
    this.sparks = null;
  }
}
