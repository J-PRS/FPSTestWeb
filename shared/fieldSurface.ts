/** FieldSurface — terrain heightfield + map-structure solids as ONE
 *  move surface. getHeight reports structure top faces as floor,
 *  resolveBody pushes capsules out of walls/ceilings. Shared because
 *  every side that integrates movement must collide against the same
 *  world: the server shadow, the browser prediction sim, and the
 *  netbot harness all build the identical surface, or their shadows
 *  diverge by exactly the walls only one side saw. */
import { hmHeight, hmNormal, type Heightfield } from './heightfield.ts';
import { SolidWorld } from './solidWorld.ts';
import type { MoveState, Vec3Like } from './movement.ts';

export class FieldSurface {
  solid: SolidWorld | null = null;

  constructor(private f: Heightfield) {}
  getHeight(x: number, z: number): number {
    const g = hmHeight(this.f, x, z);
    const t = this.solid?.topAt(x, z) ?? -Infinity;
    return t > g ? t : g;
  }
  getNormal(x: number, z: number, out: Vec3Like): Vec3Like {
    const t = this.solid?.topAt(x, z) ?? -Infinity;
    if (t > hmHeight(this.f, x, z)) { out.x = 0; out.y = 1; out.z = 0; return out; }
    hmNormal(this.f, x, z, out as { x: number; y: number; z: number });
    return out;
  }
  resolveBody(s: MoveState, height: number): void { this.solid?.resolveBody(s, height); }
}
