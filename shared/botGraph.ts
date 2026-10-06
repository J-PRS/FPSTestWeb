/**
 * TerrainFlow — leg-scale routing for bots. The local ray-fan roller
 * sees ~60-130m; on a 600m transit the leg is a chain of myopic hops
 * where a saddle 200m off the beeline never enters the fan (sweep
 * evidence: capper grab times swung 23→137s purely on line genes).
 *
 * This is the classic flow field: ONE Dijkstra flood per goal, spread
 * over a coarse heightfield grid, shared by every bot. CTF has ~two
 * real destinations (the stands), so a whole match costs ~2 floods —
 * each ~10k cells, a few ms — and every bot then reads its route for
 * free. Reversed expansion from the goal means stored "uphill" is the
 * climb a traveller actually pays toward the goal.
 *
 * Still live terrain data — the grid is sampled from the same height
 * function the sim uses, not a baked nav asset. Climbing prices rise;
 * sheer faces are routed around but never forbidden (jets can cross
 * them when nothing else reaches).
 */
import type { BotVec } from './botBrain.ts';
import { BOT_TUNING as T } from './botTuning.ts';

export class TerrainFlow {
  private readonly n: number;
  private readonly h: Float32Array;
  private readonly fields = new Map<number, { parent: Int32Array; dist: Float32Array }>();

  /** `height` must be terrain-only (structures move; routes shouldn't). */
  constructor(height: (x: number, z: number) => number, extent = T.graph.extent, cell = T.graph.cell) {
    this.n = Math.max(8, Math.round(extent / cell));
    this.cell = cell;
    this.h = new Float32Array(this.n * this.n);
    for (let j = 0; j < this.n; j++) {
      const z = this.w(j);
      for (let i = 0; i < this.n; i++) this.h[j * this.n + i] = height(this.w(i), z);
    }
  }

  private readonly cell: number;

  /** World coord of grid index i (grid centered on the origin). */
  private w(i: number): number {
    return (i + 0.5 - this.n / 2) * this.cell;
  }

  private cellOf(x: number, z: number): number {
    const i = Math.max(0, Math.min(this.n - 1, Math.round(x / this.cell + this.n / 2 - 0.5)));
    const j = Math.max(0, Math.min(this.n - 1, Math.round(z / this.cell + this.n / 2 - 0.5)));
    return j * this.n + i;
  }

  /** Dijkstra flood from a goal cell — parent[] points downhill along
   *  the cheapest-cost route, so walking parents from any start cell
   *  yields the path to the goal. Cached per goal cell. */
  private fieldFor(goal: number): { parent: Int32Array; dist: Float32Array } {
    const hit = this.fields.get(goal);
    if (hit) return hit;
    const n2 = this.n * this.n;
    const parent = new Int32Array(n2).fill(-1);
    const dist = new Float64Array(n2).fill(Infinity);
    dist[goal] = 0;
    // Binary heap of cell indices ordered by dist — no library needed
    // for 10k nodes; a push-down/pop-up two-function heap.
    const heap: number[] = [goal];
    const less = (a: number, b: number) => dist[a]! < dist[b]!;
    const push = (c: number) => {
      heap.push(c);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!less(heap[i]!, heap[p]!)) break;
        [heap[i], heap[p]] = [heap[p]!, heap[i]!];
        i = p;
      }
    };
    const pop = (): number => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
          if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
          if (m === i) break;
          [heap[i], heap[m]] = [heap[m]!, heap[i]!];
          i = m;
        }
      }
      return top;
    };
    while (heap.length) {
      const u = pop();
      const ux = u % this.n, uz = (u / this.n) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const vx = ux + dx, vz = uz + dz;
          if (vx < 0 || vz < 0 || vx >= this.n || vz >= this.n) continue;
          const v = vz * this.n + vx;
          // Traveller moves v → u (flood runs goal-outward, so the
          // climb paid is toward the goal, i.e. h[u] - h[v]).
          const d = Math.hypot(dx, dz) * this.cell;
          const rise = this.h[u]! - this.h[v]!;
          let k = 1;
          if (rise > 0) k += rise * T.graph.climbTax;
          else {
            // Sustained-descent credit only: a dive earns speed only
            // when the route keeps falling toward the goal — a lone
            // dip into a bowl gets priced as a trap, not a discount,
            // because the exit climb is where the "earned" speed dies
            // (capper air-steer lessons: descent-chasing into craters
            // is how routes strand). Fall-through past the next cell
            // is the human "land ON the downslope" read at leg scale.
            // Descending INTO the goal is sustained by definition — the
            // last dive onto the stand is the grab, not a trap. Elsewhere
            // a dive pays only when the fall keeps compounding ~3 cells
            // deep (a ski run worth chaining), not a lone dip — that's
            // the "land ON the downslope" read at route scale.
            let keepsFalling = u === goal;
            if (!keepsFalling) {
              let cur = u, falling = 0;
              for (let s = 0; s < 3; s++) {
                const p = parent[cur]!;
                if (p === -1 || this.h[p]! >= this.h[cur]!) break;
                falling++;
                cur = p;
              }
              keepsFalling = falling >= 2;
            }
            if (keepsFalling) k += rise * T.graph.diveCredit;
            else k -= rise * T.graph.dipTax;
          }
          const slope = rise / d;
          if (slope > T.graph.wallSlope) k += (slope - T.graph.wallSlope) * T.graph.wallTax;
          const nd = dist[u]! + d * k;
          if (nd < dist[v]!) {
            dist[v] = nd;
            parent[v] = u;
            push(v);
          }
        }
      }
    }
    this.fields.set(goal, { parent, dist: Float32Array.from(dist) });
    if (this.fields.size > T.graph.fieldCache) {
      // Goals are stable (stands); bound the cache so a wander-bot's
      // random cells can't grow it without limit — evict oldest.
      const oldest = this.fields.keys().next().value!;
      this.fields.delete(oldest);
    }
    return this.fields.get(goal)!;
  }

  /** The next waypoint on the cheapest route `to`, about `ahead` meters
   *  along the flow from `from`. Null when the start cell can't reach
   *  the goal (only when the caller's height fn differs from the
   *  grid's). The steerer stays authoritative under ~9m. */
  route(fx: number, fz: number, tx: number, tz: number, ahead: number, danger?: (x: number, z: number) => number): BotVec | null {
    // Bucket the goal to a coarse cell: a flood is n² work, and live
    // targets (a carrier at 30m/s) cross a 15m cell every half second —
    // without bucketing every think re-floods the whole grid and churns
    // the cache into a storm. The waypoint only needs the flow's
    // direction; the exact goal still lands the final leg below, and a
    // ~90m-shifted flood goal shares the same mid-field basin anyway.
    const qb = this.cell * 12;
    const goal = this.cellOf(Math.round(tx / qb) * qb, Math.round(tz / qb) * qb);
    const field = this.fieldFor(goal);
    const parent = field.parent;
    let c = this.cellOf(fx, fz);
    if (parent[c] === -1 && c !== goal) return null;
    let walked = 0, prev = c;
    while (c !== goal) {
      // Danger deflection: among strictly-descending neighbors pick the
      // least costly by dist + live danger. Descent-only keeps the walk
      // convergent (a danger-only gradient could orbit a hot blob
      // forever); the flood's parent stays the safe fallback.
      let p = parent[c]!;
      if (danger) {
        const cx = c % this.n, cz = (c / this.n) | 0;
        let best = Infinity;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dz) continue;
            const nx = cx + dx, nz = cz + dz;
            if (nx < 0 || nz < 0 || nx >= this.n || nz >= this.n) continue;
            const v = nz * this.n + nx;
            if (field.dist[v]! >= field.dist[c]!) continue;
            const score = field.dist[v]! + danger(this.w(nx), this.w(nz)) * this.cell * T.graph.dangerTax;
            if (score < best) { best = score; p = v; }
          }
        }
      }
      if (p === -1) return null;
      const dx = (p % this.n) - (c % this.n), dz = ((p / this.n) | 0) - ((c / this.n) | 0);
      walked += Math.hypot(dx, dz) * this.cell;
      prev = c;
      c = p;
      if (walked >= ahead) break;
    }
    const target = walked >= ahead ? c : goal === c ? goal : prev;
    const tx2 = target === goal ? tx : this.w(target % this.n);
    const tz2 = target === goal ? tz : this.w((target / this.n) | 0);
    return { x: tx2, y: this.h[target]!, z: tz2 };
  }

  /** The point on the flood route `backM` meters BEFORE the goal — the
   *  flow-sourced stand entry: the saddle the cheapest path funnels
   *  through instead of a myopic ring candidate. Null when unrouted. */
  routeNearGoal(fx: number, fz: number, tx: number, tz: number, backM: number): BotVec | null {
    const goal = this.cellOf(tx, tz);
    const parent = this.fieldFor(goal).parent;
    const start = this.cellOf(fx, fz);
    if (parent[start] === -1 && start !== goal) return null;
    // Measure the whole chain once, then re-walk to total-backM.
    let total = 0;
    for (let c = start; c !== goal;) {
      const p = parent[c]!;
      if (p === -1) return null;
      const dx = (p % this.n) - (c % this.n), dz = ((p / this.n) | 0) - ((c / this.n) | 0);
      total += Math.hypot(dx, dz) * this.cell;
      c = p;
    }
    let walked = 0, c = start;
    while (c !== goal && total - walked > backM) {
      const p = parent[c]!;
      if (p === -1) return null;
      const dx = (p % this.n) - (c % this.n), dz = ((p / this.n) | 0) - ((c / this.n) | 0);
      walked += Math.hypot(dx, dz) * this.cell;
      c = p;
    }
    return { x: this.w(c % this.n), y: this.h[c]!, z: this.w((c / this.n) | 0) };
  }
}
