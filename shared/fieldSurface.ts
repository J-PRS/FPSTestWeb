/** FieldSurface — ground sampler + map-structure solids as ONE move
 *  surface. getHeight reports structure top faces as floor (bounded by
 *  the caller's step reach), resolveBody pushes capsules out of
 *  walls/ceilings. Shared because every side that integrates movement
 *  must collide against the same world: the server shadow, the browser
 *  prediction sim, and the netbot harness all build the identical
 *  surface, or their shadows diverge by exactly the walls only one side
 *  saw.
 *
 *  The compositing rules (reach-bounded tops, flat-up structure normals,
 *  wall push-out) live HERE and only here — callers supply a bare ground
 *  sampler and get the same solid overlay on both ends. A client once
 *  re-implemented this over its own terrain class and silently dropped
 *  the maxTop bound, teleporting walkers onto every roof; keep the
 *  forwarding non-negotiable by not letting it be re-written. */
import { hmHeight, hmNormal, type Heightfield } from './heightfield.ts';
import { SolidWorld } from './solidWorld.ts';
import type { MoveState, Vec3Like } from './movement.ts';

/** Bare ground under the solids — two reads, nothing else. The server
 *  wraps a Heightfield (fromField), the client wraps its Terrain. */
export interface GroundSampler {
  getHeight(x: number, z: number): number;
  getNormal(x: number, z: number, out: Vec3Like): Vec3Like;
}

export class FieldSurface {
  solid: SolidWorld | null = null;

  private constructor(private g: GroundSampler) {}

  static fromField(f: Heightfield): FieldSurface {
    return new FieldSurface({
      getHeight: (x, z) => hmHeight(f, x, z),
      getNormal: (x, z, out) => { hmNormal(f, x, z, out as { x: number; y: number; z: number }); return out; },
    });
  }

  static over(ground: GroundSampler): FieldSurface {
    return new FieldSurface(ground);
  }

  getHeight(x: number, z: number, maxTop?: number): number {
    const g = this.g.getHeight(x, z);
    const t = this.solid?.topAt(x, z, maxTop) ?? -Infinity;
    return t > g ? t : g;
  }
  getNormal(x: number, z: number, out: Vec3Like, maxTop?: number): Vec3Like {
    const t = this.solid?.topAt(x, z, maxTop) ?? -Infinity;
    if (t > this.g.getHeight(x, z)) { out.x = 0; out.y = 1; out.z = 0; return out; }
    this.g.getNormal(x, z, out);
    return out;
  }
  resolveBody(s: MoveState, height: number): void { this.solid?.resolveBody(s, height); }
}
