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
const DEFAULT_WORLD = HM_WORLD_SCALE; // the map is a square wrap of this size
const DECAY = 0.5 ** (0.1 / 30); // ~30s half-life per 0.1s tick
const SPLAT_RADIUS = 2; // cells each way — a splat covers ~160m across
export type IMapLayer = 'dangerA' | 'dangerB' | 'opportunity' | 'traffic';

export class InfluenceMap {
  private layers: Record<IMapLayer, Float32Array>;
  private world: number;
  private grid: number;
  /** Cheap spread: a splat writes the center at full strength, the ring
   *  at half — distance falloff without BFS. `world` is the map's tile
   *  span (spec.tileSize; default 1500) — a 2048m T2 field gets a wider grid. */
  constructor(world = DEFAULT_WORLD) {
    this.world = world;
    this.grid = Math.ceil(world / IMAP_CELL);
    this.layers = this.freshLayers();
  }

  /** Map rotation onto a different tile span — fresh layers, stale
   *  scent doesn't translate anyway. */
  resize(world: number): void {
    if (world === this.world) {return;}
    this.world = world;
    this.grid = Math.ceil(world / IMAP_CELL);
    this.layers = this.freshLayers();
  }

  private freshLayers(): Record<IMapLayer, Float32Array> {
    return {
      dangerA: new Float32Array(this.grid * this.grid),
      dangerB: new Float32Array(this.grid * this.grid),
      opportunity: new Float32Array(this.grid * this.grid),
      traffic: new Float32Array(this.grid * this.grid),
    };
  }

  private idx(x: number, z: number): number {
    const cx = Math.max(0, Math.min(this.grid - 1, Math.floor((x + this.world / 2) / IMAP_CELL)));
    const cz = Math.max(0, Math.min(this.grid - 1, Math.floor((z + this.world / 2) / IMAP_CELL)));
    return cz * this.grid + cx;
  }

  /** Deposit influence at a world position. strength ~1 for a contact,
   *  ~2 for a death, scaled by callers — reads as "how loud the event". */
  splat(pos: Vec3, layer: IMapLayer, strength = 1): void {
    const g = this.layers[layer];
    const cx = Math.floor((pos.x + this.world / 2) / IMAP_CELL);
    const cz = Math.floor((pos.z + this.world / 2) / IMAP_CELL);
    for (let dz = -SPLAT_RADIUS; dz <= SPLAT_RADIUS; dz++) {
      for (let dx = -SPLAT_RADIUS; dx <= SPLAT_RADIUS; dx++) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nx >= this.grid || nz < 0 || nz >= this.grid) {continue;}
        const ring = Math.max(Math.abs(dx), Math.abs(dz));
        g[nz * this.grid + nx]! += strength * (ring === 0 ? 1 : 0.5 / ring);
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
    const cx = Math.floor((pos.x + this.world / 2) / IMAP_CELL);
    const cz = Math.floor((pos.z + this.world / 2) / IMAP_CELL);
    let best = g[this.idx(pos.x, pos.z)]!;
    let bx = 0, bz = 0;
    for (let dz = -cells; dz <= cells; dz += cells) { // only the ring edge
      for (let dx = -cells; dx <= cells; dx++) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nx >= this.grid || nz < 0 || nz >= this.grid) {continue;}
        const v = g[nz * this.grid + nx]!;
        if (v < best) { best = v; bx = dx; bz = dz; }
      }
    }
    if (bx === 0 && bz === 0) {
      for (let dx = -cells; dx <= cells; dx++) {
        for (const dz of [-cells, cells]) {
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nx >= this.grid || nz < 0 || nz >= this.grid) {continue;}
          const v = g[nz * this.grid + nx]!;
          if (v < best) { best = v; bx = dx; bz = dz; }
        }
      }
    }
    const len = Math.hypot(bx, bz) || 1;
    return { x: bx / len, z: bz / len };
  }

  /** Threat-aware approach: instead of the straight line to `home`,
   *  return a ring point off it whose corridor from `pos` is quietest
   *  on `layer`. Used for long exposed runs (flag carrier's home run —
   *  the direct line is the map's most predictable corridor). `ringR`
   *  is how far off the target the waypoint orbits; the distance
   *  wobble keeps unscented runs on the near side instead of picking
   *  an arbitrary detour. */
  quietApproach(pos: Vec3, home: Vec3, layer: IMapLayer, ringR: number): { x: number; y: number; z: number } {
    let best = home, bestScore = Infinity;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const cand = { x: home.x + Math.cos(a) * ringR, y: home.y, z: home.z + Math.sin(a) * ringR };
      const mid = { x: (cand.x + pos.x) / 2, y: 0, z: (cand.z + pos.z) / 2 };
      const score = this.value(mid, layer)
        + 0.5 * this.value(cand, layer)
        + Math.hypot(cand.x - pos.x, cand.z - pos.z) * 0.001;
      if (score < bestScore) { bestScore = score; best = cand; }
    }
    return best;
  }

  /** Hottest opportunity cell within `cells` of `pos` — the "drift
   *  toward the action" read. Returns null when nothing is scented. */
  hottestNear(pos: Vec3, layer: IMapLayer, cells = 6): { x: number; z: number; v: number } | null {
    const g = this.layers[layer];
    const cx = Math.floor((pos.x + this.world / 2) / IMAP_CELL);
    const cz = Math.floor((pos.z + this.world / 2) / IMAP_CELL);
    let best = 0, bx = 0, bz = 0;
    for (let dz = -cells; dz <= cells; dz++) {
      for (let dx = -cells; dx <= cells; dx++) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nx >= this.grid || nz < 0 || nz >= this.grid) {continue;}
        const v = g[nz * this.grid + nx]!;
        if (v > best) { best = v; bx = nx; bz = nz; }
      }
    }
    if (best <= 0) {return null;}
    return { x: bx * IMAP_CELL - this.world / 2 + IMAP_CELL / 2, z: bz * IMAP_CELL - this.world / 2 + IMAP_CELL / 2, v: best };
  }

  /** One decay pass per room tick — sim clock, so warps stay honest. */
  tick(_dt: number): void {
    for (const g of Object.values(this.layers)) {
      for (let i = 0; i < g.length; i++) {g[i]! *= DECAY;}
    }
  }
}
