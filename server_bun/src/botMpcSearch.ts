/**
 * botMpcSearch — the beam search itself, isolated so it can run on the
 * room's tick thread (fallback) or inside botMpcWorker (normal path).
 * Pure function: one scratch sim, snapshot nodes, projection scoring.
 */
import { MoveSim, type MoveSurface, type SimSnapshot, type MoveState } from '../../shared/movement.ts';
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import type { BotVec } from '../../shared/botVec.ts';

export const MPC_STEP_S = 0.15;
const TICKS = 9;
const DYAWS = [-0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1];

export interface MpcEcon { drain: number; regen: number; emax: number; elock: number }
export interface MpcPlan { act: { yaw: number; jet: boolean }[]; exp: { x: number; z: number; y: number }[]; hit: boolean }
export interface MpcJob {
  snap: SimSnapshot;
  mass: number; eyeHeight: number; bodyRadius: number; speedScale: number;
  /** Sea surface the search must swim in — mirrors the shadow's level so
   *  plans don't walk through water the sim would float them out of. */
  waterLevel?: number;
  e0: number; ec: MpcEcon; tgt: BotVec; beamW: number; horizon: number;
}

interface Node {
  snap: SimSnapshot; e: number; parent: number;
  act: { yaw: number; jet: boolean };
  sample: { x: number; z: number; y: number };
  proj: number;
}

const q = (n: number, s: number) => Math.round(n / s);
function key(s: SimSnapshot['st'], e: number): number {
  return ((q(s.pos.x, 4) * 73_856_093) ^ (q(s.pos.z, 4) * 19_349_663) ^ (q(s.pos.y, 4) * 83_492_791)
    ^ (q(s.vel.x, 4) * 297_121_507) ^ (q(s.vel.z, 4) * 433) ^ (q(s.vel.y, 4) * 16_127)
    ^ (q(e, 5) * 991) ^ (s.onGround ? 1 : 0)) | 0;
}

/** Projected arrival speed at the stand — the beam's currency. Blend
 *  with closing rate: pure proj rewards high-altitude states past the
 *  stand; pure closing kills descent lines. */
function proj(field: Heightfield, px: number, pz: number, py: number, vx: number, vz: number, e0: number, B: BotVec): number {
  let v = Math.max(6, Math.sqrt(vx * vx + vz * vz)), e = e0, time = 0, hPrev = py;
  const len = Math.hypot(B.x - px, B.z - pz) || 1;
  const steps = Math.min(20, Math.max(2, Math.ceil(len / 50)));
  const ds = len / steps;
  for (let s = 1; s <= steps; s += 1) {
    const h = hmHeight(field, px + (B.x - px) * (s / steps), pz + (B.z - pz) * (s / steps));
    v = Math.sqrt(Math.max(16, v * v + 56 * (hPrev - h)));
    v = Math.max(4, v - ds * 0.06);
    time += ds / Math.max(v, 8);
    if (e > 4 && v < 50) {const dv = Math.min(10 * ds / Math.max(v, 8), 50 - v); v += dv; e -= dv * 1.5;}
    hPrev = h;
  }
  const vClose = ((B.x - px) * vx + (B.z - pz) * vz) / len;
  return (v - time * 0.1) + vClose * 0.5;
}

export function runSearch(surface: MoveSurface, field: Heightfield, job: MpcJob): MpcPlan {
  // One scratch sim replays every child — nodes carry plain snapshots
  // so the arena is memory, not live sims (the old JSON round-trip per
  // child was the dominant replan cost by an order of magnitude).
  const scratch = new MoveSim(surface,
    {pos: {x: 0, y: 0, z: 0}, vel: {x: 0, y: 0, z: 0}, yaw: 0, pitch: 0, onGround: false} as MoveState);
  scratch.mass = job.mass; scratch.eyeHeight = job.eyeHeight; scratch.bodyRadius = job.bodyRadius;
  scratch.speedScale = job.speedScale;
  scratch.waterLevel = job.waterLevel;
  // Cold ground edges: warm bookkeeping carried a phantom touchdown into
  // every branch and the beam lost its descent lines (measured 60→18).
  const cold = (s: SimSnapshot): void => {
    scratch.restore(s);
    const x = scratch as unknown as { wishJump: boolean; allowNextJump: boolean; groundedBuffered: boolean; groundGraceT: number; acc: number; bandDist: number; impulseT: number; lastJumpableNormal: {x: number; y: number; z: number} };
    x.wishJump = false; x.allowNextJump = false; x.groundedBuffered = false;
    x.groundGraceT = 0; x.acc = 0; x.bandDist = Infinity; x.impulseT = 0; x.lastJumpableNormal.x = 0; x.lastJumpableNormal.y = 1; x.lastJumpableNormal.z = 0;
  };
  const arena: Node[] = [{
    snap: job.snap, e: job.e0, parent: -1,
    act: { yaw: job.snap.st.yaw, jet: false },
    sample: { x: job.snap.st.pos.x, z: job.snap.st.pos.z, y: job.snap.st.pos.y },
    proj: -Infinity,
  }];
  let frontier = [0];
  const seen = new Set([key(arena[0]!.snap.st, job.e0)]);
  let bestIdx = -1;
  const steps = Math.round(job.horizon / MPC_STEP_S);
  const B = job.tgt, {ec} = job;
  for (let sIdx = 0; sIdx < steps; sIdx++) {
    const next: number[] = [];
    for (const ni of frontier) {
      const n = arena[ni]!;
      for (const dOff of DYAWS) {
        for (const jet of [false, true]) {
          if (jet && n.e < ec.elock) {continue;}
          cold(n.snap);
          scratch.state.yaw += dOff;
          scratch.setInput({ forward: 1, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: true, jetHeld: jet });
          let hit = false;
          for (let t = 0; t < TICKS; t++) {
            scratch.update(1 / 60);
            const sp = scratch.state.pos;
            // Squared test, not Math.hypot: this runs 9x per child
            // (~500k times a search) and hypot's overflow-safe scaling
            // costs several times a multiply — it was 3.7% of the whole
            // process profile. Same comparison, no root.
            const dx = B.x - sp.x, dz = B.z - sp.z;
            if (dx * dx + dz * dz <= 36 && Math.abs(sp.y - B.y) <= 6) {hit = true; break;}
          }
          const e = Math.min(ec.emax, n.e + (jet ? -ec.drain * MPC_STEP_S : ec.regen * MPC_STEP_S));
          const s = scratch.state;
          const child: Node = {
            snap: scratch.snapshot(), e, parent: ni, act: { yaw: s.yaw, jet },
            sample: { x: s.pos.x, z: s.pos.z, y: s.pos.y },
            proj: -Infinity,
          };
          arena.push(child);
          if (hit) {return unwind(arena, arena.length - 1, true);}
          const k = key(child.snap.st, e);
          if (seen.has(k)) {continue;}
          seen.add(k);
          child.proj = proj(field, s.pos.x, s.pos.z, s.pos.y, s.vel.x, s.vel.z, e, B);
          next.push(arena.length - 1);
        }
      }
    }
    if (next.length > job.beamW) {
      next.sort((a, b) => arena[b]!.proj - arena[a]!.proj);
      next.length = job.beamW;
    }
    frontier = next;
    if (frontier.length === 0) {break;}
    // Best node IN THIS LAYER only — same elapsed time across the row,
    // so projections compare. A cross-layer max picked 1-act winners
    // that exhausted in 3 ticks -> replan 6.7x/s at ~0.5s a solve.
    let bi = -1, bs = -Infinity;
    for (const ix of frontier) {
      const p = arena[ix]!.proj;
      if (p > bs) {bs = p; bi = ix;}
    }
    bestIdx = bi;
  }
  return bestIdx < 0 ? { act: [], exp: [], hit: false } : unwind(arena, bestIdx, false);
}

function unwind(arena: Node[], idx: number, hit: boolean): MpcPlan {
  const act: { yaw: number; jet: boolean }[] = [];
  const exp: { x: number; z: number; y: number }[] = [];
  for (let cur = idx; cur > 0; cur = arena[cur]!.parent) {
    const n = arena[cur]!;
    act.unshift(n.act);
    exp.unshift(n.sample);
  }
  return { act, exp, hit };
}
