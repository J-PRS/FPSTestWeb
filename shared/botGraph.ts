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
import type { StructureCollider } from './ballSim.ts';
import { ColliderIndex, segSolidHit } from './solidWorld.ts';
import { BOT_TUNING as T } from './botTuning.ts';

export class TerrainFlow {
  private readonly n: number;
  private readonly h: Float32Array;
  private readonly fields = new Map<number, { parent: Int32Array; dist: Float32Array }>();

  /** `height` must be terrain-only (structure heights live in `solids`). */
  constructor(height: (x: number, z: number) => number, extent = T.graph.extent, cell = T.graph.cell,
    solids?: readonly StructureCollider[]) {
    this.solids = solids;
    this.solidIndex = solids?.length ? new ColliderIndex(solids) : null;
    this.n = Math.max(8, Math.round(extent / cell));
    this.cell = cell;
    this.h = new Float32Array(this.n * this.n);
    for (let j = 0; j < this.n; j += 1) {
      const z = this.w(j);
      for (let i = 0; i < this.n; i += 1) {this.h[j * this.n + i] = height(this.w(i), z);}
    }
  }

  private readonly cell: number;
  private readonly solids?: readonly StructureCollider[];
  private readonly solidIndex: ColliderIndex | null;

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
   *  yields the path to the goal. Cached per (goal cell × team) — gate
   *  shields are air to their own team, so each side floods its own
   *  base differently. */
  private fieldFor(goal: number, team?: string): { parent: Int32Array; dist: Float32Array } {
    const ti = team === 'alpha' ? 0 : team === 'bravo' ? 1 : 2;
    const key = goal * 3 + ti;
    const hit = this.fields.get(key);
    if (hit) {return hit;}
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
        if (!less(heap[i]!, heap[p]!)) {break;}
        [heap[i], heap[p]] = [heap[p]!, heap[i]!];
        i = p;
      }
    };
    const pop = (): number => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < heap.length && less(heap[l]!, heap[m]!)) {m = l;}
          if (r < heap.length && less(heap[r]!, heap[m]!)) {m = r;}
          if (m === i) {break;}
          [heap[i], heap[m]] = [heap[m]!, heap[i]!];
          i = m;
        }
      }
      return top;
    };
    while (heap.length > 0) {
      const u = pop();
      const ux = u % this.n, uz = Math.trunc((u / this.n));
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dz) {continue;}
          const vx = ux + dx, vz = uz + dz;
          if (vx < 0 || vz < 0 || vx >= this.n || vz >= this.n) {continue;}
          const v = vz * this.n + vx;
          // Traveller moves v → u (flood runs goal-outward, so the
          // climb paid is toward the goal, i.e. h[u] - h[v]).
          const d = Math.hypot(dx, dz) * this.cell;
          const rise = this.h[u]! - this.h[v]!;
          let k = 1;
          if (rise > 0) {k += rise * T.graph.climbTax;}
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
              for (let s = 0; s < 3; s += 1) {
                const p = parent[cur]!;
                if (p === -1 || this.h[p]! >= this.h[cur]!) {break;}
falling += 1;
                cur = p;
              }
              keepsFalling = falling >= 2;
            }
            if (keepsFalling) {k += rise * T.graph.diveCredit;}
            else {k -= rise * T.graph.dipTax;}
          }
          const slope = rise / d;
          if (slope > T.graph.wallSlope) {k += (slope - T.graph.wallSlope) * T.graph.wallTax;}
          if (this.solidIndex) {
            // Does the traveller's leg actually cross a structure? The
            // probe runs at chest height over the higher endpoint — a
            // wall slab registers, a door gap doesn't. Shields with a
            // matching passTeam are air to this flood.
            const y = Math.max(this.h[u]!, this.h[v]!) + 1.2;
            if (segSolidHit(
              { x: this.w(vx), y, z: this.w(vz) },
              { x: this.w(ux), y, z: this.w(uz) },
              this.solids!, this.solidIndex, team)) {k += T.graph.solidTax;}
          }
          const nd = dist[u]! + d * k;
          if (nd < dist[v]!) {
            dist[v] = nd;
            parent[v] = u;
            push(v);
          }
        }
      }
    }
    this.fields.set(key, { parent, dist: Float32Array.from(dist) });
    if (this.fields.size > T.graph.fieldCache) {
      // Goals are stable (stands); bound the cache so a wander-bot's
      // random cells can't grow it without limit — evict oldest.
      const oldest = this.fields.keys().next().value!;
      this.fields.delete(oldest);
    }
    return this.fields.get(key)!;
  }

  /** The next waypoint on the cheapest route `to`, about `ahead` meters
   *  along the flow from `from`. Null when the start cell can't reach
   *  the goal (only when the caller's height fn differs from the
   *  grid's). The steerer stays authoritative under ~9m. */
  route(fx: number, fz: number, tx: number, tz: number, ahead: number, danger?: (x: number, z: number) => number, team?: string): BotVec | null {
    // Bucket the goal to a coarse cell: a flood is n² work, and live
    // targets (a carrier at 30m/s) cross a 15m cell every half second —
    // without bucketing every think re-floods the whole grid and churns
    // the cache into a storm. The waypoint only needs the flow's
    // direction; the exact goal still lands the final leg below, and a
    // ~90m-shifted flood goal shares the same mid-field basin anyway.
    const qb = this.cell * 12;
    const goal = this.cellOf(Math.round(tx / qb) * qb, Math.round(tz / qb) * qb);
    const field = this.fieldFor(goal, team);
    const {parent} = field;
    const c0 = this.cellOf(fx, fz);
    if (parent[c0] === -1 && c0 !== goal) {return null;}
    let c = c0;
    let walked = 0, prev = c;
    // Cells the chain actually walked, so a goal inside the horizon can
    // still emit the path's middle instead of the goal itself — a beeline
    // to a cell the flood reached through a doorway just grinds the wall
    // the door was threaded around (bastion genhouse: the goal cell is
    // inside the vault, the door is 15m off-axis).
    const chain: number[] = [];
    while (c !== goal) {
      // Danger deflection: among strictly-descending neighbors pick the
      // least costly by dist + live danger. Descent-only keeps the walk
      // convergent (a danger-only gradient could orbit a hot blob
      // forever); the flood's parent stays the safe fallback.
      let p = parent[c]!;
      if (danger) {
        const cx = c % this.n, cz = Math.trunc((c / this.n));
        let best = Infinity;
        for (let dz = -1; dz <= 1; dz += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (!dx && !dz) {continue;}
            const nx = cx + dx, nz = cz + dz;
            if (nx < 0 || nz < 0 || nx >= this.n || nz >= this.n) {continue;}
            const v = nz * this.n + nx;
            if (field.dist[v]! >= field.dist[c]!) {continue;}
            const score = field.dist[v]! + danger(this.w(nx), this.w(nz)) * this.cell * T.graph.dangerTax;
            if (score < best) { best = score; p = v; }
          }
        }
      }
      if (p === -1) {return null;}
      const dx = (p % this.n) - (c % this.n), dz = (Math.trunc((p / this.n))) - (Math.trunc((c / this.n)));
      walked += Math.hypot(dx, dz) * this.cell;
      prev = c;
      c = p;
      chain.push(c);
      if (walked >= ahead) {break;}
    }
    let target = 0;
    if (walked >= ahead) {target = c;}
    else if (c === goal && chain.length > 1 && this.solidIndex
      // Goal inside the horizon AND a wall on the beeline: emit the
      // chain's midpoint — on a bent path it's the doorway/funnel the
      // flood actually used. A clear line still gets the raw goal.
      && segSolidHit(
        { x: fx, y: this.h[c0]! + 1.2, z: fz },
        { x: tx, y: this.h[c0]! + 1.2, z: tz },
        this.solids!, this.solidIndex, team)) {
      // len 2 wants the cell before the goal (index 0 is the penultimate
      // hop); longer chains emit their middle — the doorway the flood
      // threaded, not a beeline at the wall face.
      target = chain[chain.length > 2 ? chain.length >> 1 : chain.length - 2]!;
    } else {target = c === goal ? goal : prev;}
    const tx2 = target === goal ? tx : this.w(target % this.n);
    const tz2 = target === goal ? tz : this.w(Math.trunc((target / this.n)));
    return { x: tx2, y: this.h[target]!, z: tz2 };
  }

  /** The point on the flood route `backM` meters BEFORE the goal — the
   *  flow-sourced stand entry: the saddle the cheapest path funnels
   *  through instead of a myopic ring candidate. Null when unrouted. */
  routeNearGoal(fx: number, fz: number, tx: number, tz: number, backM: number, team?: string): BotVec | null {
    const goal = this.cellOf(tx, tz);
    const {parent} = this.fieldFor(goal, team);
    const start = this.cellOf(fx, fz);
    if (parent[start] === -1 && start !== goal) {return null;}
    // Measure the whole chain once, then re-walk to total-backM.
    let total = 0;
    for (let c = start; c !== goal;) {
      const p = parent[c]!;
      if (p === -1) {return null;}
      const dx = (p % this.n) - (c % this.n), dz = (Math.trunc((p / this.n))) - (Math.trunc((c / this.n)));
      total += Math.hypot(dx, dz) * this.cell;
      c = p;
    }
    let walked = 0, c = start;
    while (c !== goal && total - walked > backM) {
      const p = parent[c]!;
      if (p === -1) {return null;}
      const dx = (p % this.n) - (c % this.n), dz = (Math.trunc((p / this.n))) - (Math.trunc((c / this.n)));
      walked += Math.hypot(dx, dz) * this.cell;
      c = p;
    }
    return { x: this.w(c % this.n), y: this.h[c]!, z: this.w(Math.trunc((c / this.n))) };
  }
}
