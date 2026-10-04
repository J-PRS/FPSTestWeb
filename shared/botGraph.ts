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
  private readonly fields = new Map<number, Int32Array>();

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
  private fieldFor(goal: number): Int32Array {
    let parent = this.fields.get(goal);
    if (parent) return parent;
    const n2 = this.n * this.n;
    parent = new Int32Array(n2).fill(-1);
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
            const pu = parent[u]!;
            // Descending INTO the goal is sustained by definition — the
            // last dive onto the stand is the grab, not a trap.
            const keepsFalling = u === goal || (pu !== -1 && this.h[pu]! < this.h[u]!);
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
    this.fields.set(goal, parent);
    if (this.fields.size > T.graph.fieldCache) {
      // Goals are stable (stands); bound the cache so a wander-bot's
      // random cells can't grow it without limit — evict oldest.
      const oldest = this.fields.keys().next().value!;
      this.fields.delete(oldest);
    }
    return parent;
  }

  /** The next waypoint on the cheapest route `to`, about `ahead` meters
   *  along the flow from `from`. Null when the start cell can't reach
   *  the goal (only when the caller's height fn differs from the
   *  grid's). The steerer stays authoritative under ~9m. */
  route(fx: number, fz: number, tx: number, tz: number, ahead: number): BotVec | null {
    const goal = this.cellOf(tx, tz);
    const parent = this.fieldFor(goal);
    let c = this.cellOf(fx, fz);
    if (parent[c] === -1 && c !== goal) return null;
    let walked = 0, prev = c;
    while (c !== goal) {
      const p = parent[c]!;
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
}
