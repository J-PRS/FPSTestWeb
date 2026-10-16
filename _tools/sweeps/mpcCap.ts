// MPC capper pilot — a quieted bot driven by receding-horizon search
// over the real MoveSim (same BFS machinery as tasStand.ts, small and
// per-replan). Every ~1s (or on divergence) it searches a bounded beam
// forward ~5s of sim time, takes the input schedule of the first node
// to hit the grab capsule (or best-progress), and plays it back through
// the live shadow. No map knowledge, no baked route — the plan is
// recomputed from senses every window.
//
//   cd server_bun && bun ../_tools/sweeps/mpcCap.ts --map katabatic --seed 9002
//   env: MPC_HORIZON_S (5), MPC_BEAM (400), MPC_DYAW (0.05), MPC_REPLAN_S (1.0)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight, hmSurface } from '../../shared/heightfield.ts';
import { MoveSim } from '../../shared/movement.ts';
import { mkRoom, step } from '../../server_bun/tests/scenarios/harness.ts';

const arg = (n: string, d: string) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1]! : d; };
const MAP = arg('map', 'katabatic');
const SEED = Number(arg('seed', '9002'));
const BUDGET_S = Number(arg('budget', '60'));
const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${MAP}.json`), 'utf8'));
const f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${spec.terrain}`))));
const surface = hmSurface(f) as any;
const at = (x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });
const bases = { alpha: at(spec.bases.alpha.x, spec.bases.alpha.z), bravo: at(spec.bases.bravo.x, spec.bases.bravo.z) };

// featherjets economy: drain 15*0.8=12, regen 8, max 60 (perks.ts)
const DRAIN = 12, REGEN = 8, EMAX = 60, ELOCK = 6;
const STEP_S = 0.15, TICKS = 9;
const DYAW = Number(process.env.MPC_DYAW ?? 0.05);
// Yaw ladder: 0.02 threads a 6m capsule at 60 m/s, 0.10 carves a flank.
const DYAWS = [-(DYAW * 2), -DYAW, -DYAW * 0.4, 0, DYAW * 0.4, DYAW, DYAW * 2];
const HORIZON = Number(process.env.MPC_HORIZON_S ?? 5);
const BEAM = Number(process.env.MPC_BEAM ?? 400);
// Asymmetric budget: inside the committed run-in the needle is narrow —
// dive-pump sequences die in a shallow beam. Spend the deep search
// only where it pays (transit stays cheap).
const DEEP_BEAM = Number(process.env.MPC_DEEP_BEAM ?? 1200);
const DEEP_HORIZON = Number(process.env.MPC_DEEP_HORIZON_S ?? 7);
const DEEP_M = Number(process.env.MPC_DEEP_M ?? 250);
const REPLAN_S = Number(process.env.MPC_REPLAN_S ?? 1.0);
const DIVERGE_M = 14;

interface Node {
  sim: MoveSim | null; e: number; parent: number;
  act: { yaw: number; jet: boolean };
  sample: { x: number; z: number; y: number; v: number };
  proj: number;
}
const q = (n: number, s: number) => Math.round(n / s);
function key(n: Node): number {
  const s = n.sim!.state;
  let h = (q(s.pos.x, 4) * 73856093) ^ (q(s.pos.z, 4) * 19349663) ^ (q(s.pos.y, 4) * 83492791)
    ^ (q(s.vel.x, 4) * 297121507) ^ (q(s.vel.z, 4) * 433) ^ (q(s.vel.y, 4) * 16127)
    ^ (q(n.e, 5) * 991) ^ (s.onGround ? 1 : 0);
  return h | 0;
}
function cloneSim(m: MoveSim): MoveSim {
  const s = new MoveSim(surface, JSON.parse(JSON.stringify(m.state)));
  (s as any).acc = 0;
  return s;
}

/** Projected arrival speed at the stand from a mid-trajectory state:
 *  the same point-mass-on-terrain integration electHead scores with.
 *  The beam ranks by this — "slow now, 60 m/s in 4s" beats "fast now,
 *  flat" — which is the descent trade a closing-rate score can't see. */
function projScore(px: number, pz: number, py: number, vx: number, vz: number, e0: number,
  B: { x: number; y: number; z: number }): number {
  let v = Math.max(6, Math.hypot(vx, vz)), e = e0, time = 0, hPrev = py;
  const len = Math.hypot(B.x - px, B.z - pz);
  const steps = Math.min(20, Math.max(2, Math.ceil(len / 50))); // ~50m probes, capped — runs per CHILD, so it must stay cheap
  const ds = len / steps;
  for (let s = 1; s <= steps; s += 1) {
    const h = hmHeight(f, px + (B.x - px) * (s / steps), pz + (B.z - pz) * (s / steps));
    v = Math.sqrt(Math.max(16, v * v + 56 * (hPrev - h)));
    v = Math.max(4, v - ds * 0.06);
    time += ds / Math.max(v, 8);
    if (e > 4 && v < 50) {const dv = Math.min(10 * ds / Math.max(v, 8), 50 - v); v += dv; e -= dv * 1.5;}
    hPrev = h;
  }
  return v - time * 0.1;
}

interface Plan { act: { yaw: number; jet: boolean }[]; exp: { x: number; z: number; y: number }[]; hit: boolean }
/** Bounded forward search from a live state. Returns the input schedule
 *  of the first node to reach the grab capsule, else best progress.
 *  `exp` is the expected state at each step — divergence from it is
 *  what makes a hit-plan stale. */
function search(rootSim: MoveSim, e0: number, B: { x: number; y: number; z: number },
  beamW = BEAM, horizon = HORIZON): Plan {
  const arena: Node[] = [];
  const root: Node = {
    sim: cloneSim(rootSim), e: e0, parent: -1,
    act: { yaw: rootSim.state.yaw, jet: false },
    sample: { x: rootSim.state.pos.x, z: rootSim.state.pos.z, y: rootSim.state.pos.y, v: 0 },
    proj: -Infinity,
  };
  arena.push(root);
  let frontier = [0];
  const seen = new Set([key(root)]);
  let bestIdx = -1, bestScore = -Infinity;
  const steps = Math.round(horizon / STEP_S);
  for (let sIdx = 0; sIdx < steps; sIdx++) {
    const next: number[] = [];
    for (const ni of frontier) {
      const n = arena[ni]!;
      for (const dOff of DYAWS) {
        for (const jet of [false, true]) {
          if (jet && n.e < ELOCK) { continue; }
          const sim = cloneSim(n.sim!);
          sim.state.yaw += dOff;
          sim.setInput({ forward: 1, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: true, jetHeld: jet });
          let hit = false;
          for (let t = 0; t < TICKS; t++) {
            sim.update(1 / 60);
            const sp = sim.state.pos;
            if (Math.hypot(B.x - sp.x, B.z - sp.z) <= 6 && Math.abs(sp.y - B.y) <= 6) { hit = true; break; }
          }
          const e = Math.min(EMAX, n.e + (jet ? -DRAIN * STEP_S : REGEN * STEP_S));
          const s = sim.state;
          // Blend: proj alone fills the beam with high-altitude states on
          // the far side of the stand (great potential, wrong place);
          // closing alone kills descent lines. Progress AND potential.
          const proj = projScore(s.pos.x, s.pos.z, s.pos.y, s.vel.x, s.vel.z, e, B);
          const d = Math.hypot(B.x - s.pos.x, B.z - s.pos.z) || 1;
          const vClose = ((B.x - s.pos.x) * s.vel.x + (B.z - s.pos.z) * s.vel.z) / d;
          const child: Node = {
            sim, e, parent: ni,
            act: { yaw: s.yaw, jet },
            sample: { x: s.pos.x, z: s.pos.z, y: s.pos.y, v: Math.hypot(s.vel.x, s.vel.z) },
            proj: proj + vClose * 0.5,
          };
          arena.push(child);
          if (hit) { return { act: unwind(arena, arena.length - 1).map((a) => a.act), exp: unwind(arena, arena.length - 1).map((a) => a.exp), hit: true }; }
          const k = key(child);
          if (seen.has(k)) { continue; }
          seen.add(k);
          next.push(arena.length - 1);
          if (child.proj > bestScore) { bestScore = child.proj; bestIdx = arena.length - 1; }
        }
      }
      n.sim = null;
    }
    if (next.length > beamW) {
      next.sort((a, b) => arena[b]!.proj - arena[a]!.proj);
      next.length = beamW;
    }
    frontier = next;
    if (!frontier.length) { break; }
  }
  if (bestIdx < 0) {return { act: [], exp: [], hit: false };}
  const w = unwind(arena, bestIdx);
  return { act: w.map((a) => a.act), exp: w.map((a) => a.exp), hit: false };
}
function unwind(arena: Node[], idx: number): { act: { yaw: number; jet: boolean }; exp: { x: number; z: number; y: number } }[] {
  const out: { act: { yaw: number; jet: boolean }; exp: { x: number; z: number; y: number } }[] = [];
  for (let cur = idx; cur > 0; cur = arena[cur]!.parent) {
    const n = arena[cur]!;
    out.unshift({ act: n.act, exp: n.sample });
  }
  return out;
}

/** Two-level: the descent-head sense elects an intermediate waypoint —
 *  the crest that starts the fastest projected route into the stand —
 *  and the MPC searches toward IT, not the far flag. Same scoring as
 *  botRouting's headGoal: projected arrival speed over pos->via->stand.
 *  Returns the head point while it's still ahead of the bot's run. */
function electHead(pos: { x: number; y: number; z: number }, vel: { x: number; z: number }, tank: number,
  stand: { x: number; y: number; z: number }): { x: number; y: number; z: number; crestD: number } | null {
  const dStand = Math.hypot(pos.x - stand.x, pos.z - stand.z);
  if (dStand < 45) {return null;}
  const v0 = Math.max(6, Math.hypot(vel.x, vel.z));
  const scoreLeg = (vx2: number, vz2: number): number => {
    let v = v0, e = tank, time = 0, hPrev = pos.y;
    const pts: [number, number][] = [[pos.x, pos.z], [vx2, vz2], [stand.x, stand.z]];
    for (let l = 1; l < pts.length; l += 1) {
      const a2 = pts[l - 1]!, b2 = pts[l]!;
      const len = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
      const steps = Math.max(2, Math.ceil(len / 20));
      const ds = len / steps;
      for (let s = 1; s <= steps; s += 1) {
        const h = hmHeight(f, a2[0] + (b2[0] - a2[0]) * (s / steps), a2[1] + (b2[1] - a2[1]) * (s / steps));
        v = Math.sqrt(Math.max(16, v * v + 56 * (hPrev - h)));
        v = Math.max(4, v - ds * 0.06);
        time += ds / Math.max(v, 8);
        if (e > 4 && v < 50) {const dv = Math.min(10 * ds / Math.max(v, 8), 50 - v); v += dv; e -= dv * 1.5;}
        hPrev = h;
      }
    }
    return v - time * 0.15;
  };
  const direct = scoreLeg(stand.x, stand.z);
  const baseA = Math.atan2(pos.z - stand.z, pos.x - stand.x);
  let bestScore = direct + 3, best: { x: number; y: number; z: number; crestD: number } | null = null;
  for (let o = -4; o <= 4; o += 1) {
    const a = baseA + o * 0.22;
    const bx = Math.cos(a), bz = Math.sin(a);
    let crestD = 0, crestH = -Infinity;
    for (let t = 10; t <= 250; t += 10) {
      const lh = hmHeight(f, stand.x + bx * t, stand.z + bz * t);
      if (lh > crestH) {crestH = lh; crestD = t;}
    }
    if (crestD < 40 || crestH - stand.y < 8) {continue;}
    if (Math.abs(o) <= 1 && crestD > dStand) {continue;}
    const hx = stand.x + bx * crestD, hz = stand.z + bz * crestD;
    const score = scoreLeg(hx, hz);
    if (score > bestScore) {bestScore = score; best = { x: hx, y: crestH + 1, z: hz, crestD };}
  }
  return best;
}

// --- the live drive -----------------------------------------------------
const room = mkRoom({ ...spec, mode: 'ctf', bots: 6, botFill: 6, bases }, 'ctf', SEED, false, f);
if (!room.flags) { throw new Error('no flags'); }
const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
const capper = bots.find((p) => p.team === 'alpha');
if (!capper) { throw new Error('no alpha bot'); }
for (const p of bots) { room.bots.quiet.add(p.id); }   // EVERY bot quiet — we drive the capper
capper.perk = 'featherjets';
room.moveSim.setPerk(capper.id, 'featherjets');
const flag = room.flags.flags.get('bravo')!;

const dt = 0.05;
let simT = 0, plan: Plan = { act: [], exp: [], hit: false }, planI = 0, lastReplan = -Infinity;
let replans = 0, searchesMs = 0, grabAt = -1, grabV = 0;
const st0 = room.moveSim.simState(capper.id);
const rootSim = new MoveSim(surface, st0 ? JSON.parse(JSON.stringify(st0)) : undefined);

for (let i = 0; i < BUDGET_S * 20; i++) {
  const st = room.moveSim.simState(capper.id);
  if (st && !capper.isDead) {
    // Replan when the schedule is exhausted, the timer lapsed — or a
    // HIT plan diverged from its expected path (blast knock, body bump,
    // searched-sim vs shadow drift). A hit plan is precious: don't
    // re-roll it on the timer.
    const exp = plan.exp[Math.floor(planI / 3)];
    const diverged = plan.hit && exp
      ? Math.hypot(st.pos.x - exp.x, st.pos.z - exp.z) > DIVERGE_M : false;
    const needReplan = Math.floor(planI / 3) >= plan.act.length || (!plan.hit && simT - lastReplan > REPLAN_S) || diverged;
    if (needReplan) {
      rootSim.state = JSON.parse(JSON.stringify(st));
      (rootSim as any).acc = 0;
      // Level split: search toward the elected descent head while it's
      // still beyond the stand-ring we're inside; inside the run the
      // capsule itself is the target.
      const tank = room.moveSim.energyOf(capper.id) ?? EMAX;
      const head = electHead(capper.position, st.vel, tank, flag.pos);
      const target = head && Math.hypot(head.x - st.pos.x, head.z - st.pos.z) > 25 ? head : flag.pos;
      const dTgt = Math.hypot(flag.pos.x - st.pos.x, flag.pos.z - st.pos.z);
      const deep = dTgt < DEEP_M;
      const t0 = Date.now();
      plan = search(rootSim, tank, target, deep ? DEEP_BEAM : BEAM, deep ? DEEP_HORIZON : HORIZON);
      searchesMs += Date.now() - t0;
      replans++;
      planI = 0; lastReplan = simT;
      if (plan.hit || replans <= 3 || replans % 20 === 0) {console.log(`replan#${replans} t=${simT.toFixed(1)} hit=${plan.hit} steps=${plan.act.length} tgt=${head ? 'HEAD' : 'flag'} div=${diverged}`);}
    }
    // The schedule is one entry per 0.15s search step; the tick is 0.05 —
    // each act must hold for 3 ticks or the plan plays back 3x fast.
    const a = plan.act[Math.floor(planI / 3)];
    planI += 1;
    if (a) {
      room.moveSim.faceYaw(capper.id, a.yaw);
      room.moveSim.setInput(capper.id, { forward: 1, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: true, jetHeld: a.jet });
    }
  }
  step(room, 1, dt);
  simT += dt;
  // The quiet bot's position commit is ours — driveMove normally does
  // this for live bots (botDrive.ts:104); without it the shadow moves
  // but the player record (and the flag touch) stays frozen.
  const stNow = room.moveSim.simState(capper.id);
  if (stNow) {
    capper.position = { x: stNow.pos.x, y: stNow.pos.y, z: stNow.pos.z };
    capper.velocity = { x: stNow.vel.x, y: stNow.vel.y, z: stNow.vel.z };
  }
  if (flag.state === 'carried' && flag.carrier === capper.id && grabAt < 0) {
    grabAt = simT; grabV = Math.hypot(capper.velocity.x, capper.velocity.z);
    console.log(`>>> GRAB t=${grabAt.toFixed(1)}s grabV=${grabV.toFixed(1)} m/s`);
    break;
  }
  if (i % 400 === 0 && st) {
    const d = Math.hypot(flag.pos.x - capper.position.x, flag.pos.z - capper.position.z);
    const v = Math.hypot(capper.velocity.x, capper.velocity.z);
    console.log(`t=${simT.toFixed(0)} od=${d.toFixed(0)} v=${v.toFixed(0)} E=${(room.moveSim.energyOf(capper.id) ?? 0).toFixed(0)} replans=${replans} ms/search=${(searchesMs / replans).toFixed(0)}`);
  }
}
console.log(`done: grab=${grabAt < 0 ? 'NONE' : grabAt.toFixed(1) + 's @ ' + grabV.toFixed(1) + ' m/s'} replans=${replans} avgSearch=${(searchesMs / Math.max(1, replans)).toFixed(0)}ms`);
