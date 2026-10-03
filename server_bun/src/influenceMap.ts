import { HM_WORLD_SCALE } from '../../shared/heightfield.ts';
import type { Vec3 } from './types.ts';
/** Spatial memory for the whole room: a coarse grid where events —
 *  contacts, deaths, gem drops, flag moves — deposit influence that
 *  spreads with distance and decays with time. Bots read it for free:
 *  where the fighting *was*, not just what's visible *now*. This is the
 *  pheromone-map idea (Yahyavi & Kemme): event scent beats line-of-sight
 *  for human-looking spatial behavior.
 *
 *  Layers:
 *   - dangerA / dangerB: hostile-presence scent PER TEAM — a cell is hot
 *     for the team that got hurt there. Deaths and contested shots write
 *     against the victim's team.
 *   - opportunity: things worth walking toward regardless of team —
 *     gem drops, flag moves, fight noises.
 *   - traffic: where everyone has been — supports "fresh route" bias.
 *
 *  Deterministic: decay is ticked on the sim clock, never wallNow(). */

export const IMAP_CELL = 32; // meters per cell — reads like "this area"
const WORLD = HM_WORLD_SCALE; // the map is a square wrap of this size
const GRID = Math.ceil(WORLD / IMAP_CELL); // 48 cells — 9KB per layer
const DECAY = Math.pow(0.5, 0.1 / 30); // ~30s half-life per 0.1s tick
const SPLAT_RADIUS = 2; // cells each way — a splat covers ~160m across

export type IMapLayer = 'dangerA' | 'dangerB' | 'opportunity' | 'traffic';

export class InfluenceMap {
  private layers: Record<IMapLayer, Float32Array>;
  /** Cheap spread: a splat writes the center at full strength, the ring
   *  at half — distance falloff without BFS. */
  constructor() {
    this.layers = {
      dangerA: new Float32Array(GRID * GRID),
      dangerB: new Float32Array(GRID * GRID),
      opportunity: new Float32Array(GRID * GRID),
      traffic: new Float32Array(GRID * GRID),
    };
  }

  private idx(x: number, z: number): number {
    const cx = Math.max(0, Math.min(GRID - 1, Math.floor((x + WORLD / 2) / IMAP_CELL)));
    const cz = Math.max(0, Math.min(GRID - 1, Math.floor((z + WORLD / 2) / IMAP_CELL)));
    return cz * GRID + cx;
  }

  /** Deposit influence at a world position. strength ~1 for a contact,
   *  ~2 for a death, scaled by callers — reads as "how loud the event". */
  splat(pos: Vec3, layer: IMapLayer, strength = 1): void {
    const g = this.layers[layer];
    const cx = Math.floor((pos.x + WORLD / 2) / IMAP_CELL);
    const cz = Math.floor((pos.z + WORLD / 2) / IMAP_CELL);
    for (let dz = -SPLAT_RADIUS; dz <= SPLAT_RADIUS; dz++) {
      for (let dx = -SPLAT_RADIUS; dx <= SPLAT_RADIUS; dx++) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nx >= GRID || nz < 0 || nz >= GRID) continue;
        const ring = Math.max(Math.abs(dx), Math.abs(dz));
        g[nz * GRID + nx]! += strength * (ring === 0 ? 1 : 0.5 / ring);
      }
    }
  }

  /** Raw read at a position — what a bot's feet tell it. */
  value(pos: Vec3, layer: IMapLayer): number {
    return this.layers[layer][this.idx(pos.x, pos.z)]!;
  }

  /** The team-relative danger layer: callers pass the bot's team so the
   *  "where MY side is getting hurt" read needs no enum mapping. */
  dangerLayer(team: string): IMapLayer {
    return team === 'alpha' ? 'dangerA' : 'dangerB';
  }

  /** Lowest-value cell in a ring around `pos` — the flee-direction
   *  query. Scans cells only (sub-µs), returns a direction vector. */
  quietestDir(pos: Vec3, layer: IMapLayer, cells = 5): { x: number; z: number } {
    const g = this.layers[layer];
    const cx = Math.floor((pos.x + WORLD / 2) / IMAP_CELL);
    const cz = Math.floor((pos.z + WORLD / 2) / IMAP_CELL);
    let best = g[this.idx(pos.x, pos.z)]!;
    let bx = 0, bz = 0;
    for (let dz = -cells; dz <= cells; dz += cells) { // only the ring edge
      for (let dx = -cells; dx <= cells; dx++) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nx >= GRID || nz < 0 || nz >= GRID) continue;
        const v = g[nz * GRID + nx]!;
        if (v < best) { best = v; bx = dx; bz = dz; }
      }
    }
    if (bx === 0 && bz === 0) {
      for (let dx = -cells; dx <= cells; dx++) {
        for (const dz of [-cells, cells]) {
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nx >= GRID || nz < 0 || nz >= GRID) continue;
          const v = g[nz * GRID + nx]!;
          if (v < best) { best = v; bx = dx; bz = dz; }
        }
      }
    }
    const len = Math.hypot(bx, bz) || 1;
    return { x: bx / len, z: bz / len };
  }

  /** Hottest opportunity cell within `cells` of `pos` — the "drift
   *  toward the action" read. Returns null when nothing is scented. */
  hottestNear(pos: Vec3, layer: IMapLayer, cells = 6): { x: number; z: number; v: number } | null {
    const g = this.layers[layer];
    const cx = Math.floor((pos.x + WORLD / 2) / IMAP_CELL);
    const cz = Math.floor((pos.z + WORLD / 2) / IMAP_CELL);
    let best = 0, bx = 0, bz = 0;
    for (let dz = -cells; dz <= cells; dz++) {
      for (let dx = -cells; dx <= cells; dx++) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nx >= GRID || nz < 0 || nz >= GRID) continue;
        const v = g[nz * GRID + nx]!;
        if (v > best) { best = v; bx = nx; bz = nz; }
      }
    }
    if (best <= 0) return null;
    return { x: bx * IMAP_CELL - WORLD / 2 + IMAP_CELL / 2, z: bz * IMAP_CELL - WORLD / 2 + IMAP_CELL / 2, v: best };
  }

  /** One decay pass per room tick — sim clock, so warps stay honest. */
  tick(_dt: number): void {
    for (const g of Object.values(this.layers)) {
      for (let i = 0; i < g.length; i++) g[i]! *= DECAY;
    }
  }
}
