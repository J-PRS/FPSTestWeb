// Prediction/shadow convergence fuzz — the client↔server movement
// contract under chaos. Per player the fuzz runs TWO sims: a client-side
// MoveSim oracle (the honest predictor, input applied instantly) and the
// server's RoomMoveSim shadow (input via queueInput → tick drain). The
// op stream mixes honest edges, stale/dup/unsent seqs, honest and forged
// position reports, resyncs, impulses, transit feeds, track/untrack —
// then checks the invariants every step:
//
//   * shadow state always finite — no input poisons the integrator
//   * inputSeqOf monotone; stale/dup edges are refused
//   * a forged report never moves the shadow's position (the judge
//     banks divergences; the sim keeps its own trajectory)
//   * resync = declared discontinuity: divergences reset, stale-epoch
//     reports can't bank strikes against the new trajectory
//   * honest streams never flag the cheat counter and stay inside the
//     divergence band — no correction spirals
//   * deterministic: same seed → identical physics twice
import { describe, it, expect } from 'bun:test';
import { mkRoom, lcg, flat } from './harness.ts';
import { FieldSurface } from '../../src/moveJudge.ts';
import { MoveSim, ENERGY, type MoveInput, type MoveState } from '../../../shared/movement.ts';
import type { Vec3 } from '../../../shared/protocol.ts';

const DT = 0.05; // room tick quantum (20Hz) — harness step() convention

interface ClientSim {
  sim: MoveSim;
  seq: number;
  forged: boolean; // this player has submitted forged reports
  // The honest client models its own jet tank — the shadow refuses
  // jets on modeled-empty, so a client that never ran dry would read
  // as a permanent divergence. Same rules, both ends.
  energy: number;
  jetLockT: number;
  jetHeld: boolean;
}

function clientState(pos: Vec3, yaw: number): MoveState {
  return { pos: { x: pos.x, y: pos.y, z: pos.z }, vel: { x: 0, y: 0, z: 0 }, yaw, pitch: 0, onGround: true };
}

// One fuzz run — returns the final per-player states for the
// determinism double-run pin.
function run(seed: number): { violations: string[]; final: Map<string, { pos: Vec3; vel: Vec3; energy: number | null; seq: number }>; cheats: string[] } {
  const rng = lcg(seed);
  const room = mkRoom({ bots: 0 }, '', seed);
  const surface = FieldSurface.fromField(flat);
  const violations: string[] = [];
  const cheats: string[] = [];
  room.moveSim.onCheat = (id) => cheats.push(id);
  const ctx = (op: number, desc: string) => `seed=${seed} op=${op} ${desc}`;

  const clients = new Map<string, ClientSim>();
  const lastSeq = new Map<string, number>();

  const spawn = (id: string) => {
    const pos = { x: (rng() - 0.5) * 40, y: 60, z: (rng() - 0.5) * 40 };
    room.moveSim.track(id, pos, 0);
    const c = { sim: new MoveSim(surface, clientState(pos, 0)), seq: 0, forged: false, energy: ENERGY.max, jetLockT: 0, jetHeld: false };
    clients.set(id, c);
    lastSeq.set(id, 0);
    // The 'seed' phase adopts ANY first report's position — that's the
    // landing-spot contract, honest by design. Forge immunity only
    // exists AFTER it, so every spawned shadow gets an honest seed.
    room.moveSim.reconcile(id, { ...pos }, 0, { x: 0, y: 0, z: 0 }, 0, 30);
  };
  for (const id of ['m1', 'm2', 'm3']) spawn(id);

  const OPS = 400;
  for (let op = 0; op < OPS; op++) {
    const ids = [...clients.keys()];
    const id = ids[Math.floor(rng() * ids.length)]!;
    const client = clients.get(id);
    const roll = rng();
    let desc = 'tick';

    if (roll < 0.06 && client) {
      // Honest input edge — client applies instantly, server queues for
      // the next tick drain. The skew is the honest drift this whole
      // machinery exists to absorb.
      const input: Partial<MoveInput> = {
        forward: rng() < 0.8 ? (rng() < 0.5 ? 1 : -1) : 0,
        right: rng() < 0.3 ? (rng() < 0.5 ? 1 : -1) : 0,
        jumpHeld: rng() < 0.2,
        skiHeld: rng() < 0.4,
        jetHeld: rng() < 0.5,
      };
      client.jetHeld = input.jetHeld === true;
      client.sim.setInput(input);
      client.seq++;
      lastSeq.set(id, client.seq);
      const accepted = room.moveSim.queueInput(id, input, 0, client.seq);
      if (!accepted) violations.push(`${ctx(op, `input seq=${client.seq}`)}: honest edge refused`);
      desc = `input ${id} seq=${client.seq}`;
    } else if (roll < 0.11 && client) {
      // Stale/dup input — out-of-order or repeated packets must be refused
      // and must not move the watermark backwards.
      const want = client.seq - (rng() < 0.5 ? 1 + Math.floor(rng() * 10) : 0);
      const before = room.moveSim.inputSeqOf(id);
      const accepted = room.moveSim.queueInput(id, { forward: 1 }, 0, want);
      if (accepted) violations.push(`${ctx(op, `stale input seq=${want} (last=${before})`)}: stale edge accepted`);
      if (room.moveSim.inputSeqOf(id) < before) violations.push(`${ctx(op, 'stale input')}: inputSeq regressed`);
      desc = `stale-input ${id} seq=${want}`;
    } else if (roll < 0.30 && client) {
      // Honest position report — the client's own state, its seq
      // watermark and a plausible RTT.
      const st = client.sim.state;
      const corr = room.moveSim.reconcile(id, { ...st.pos }, st.yaw, { ...st.vel }, client.seq, 10 + rng() * 250);
      if (corr) {
        // Honest client snaps to the correction (that's what it's FOR).
        client.sim.setState({ pos: corr.pos, vel: corr.vel, yaw: corr.yaw, pitch: corr.pitch, onGround: corr.onGround });
      }
      desc = `report ${id}`;
    } else if (roll < 0.36 && client) {
      // Forged teleport report — a cheat-shaped report must bank
      // divergences WITHOUT moving the shadow's own position.
      const before = room.moveSim.simPos(id);
      const forge = { x: (rng() - 0.5) * 600, y: 40 + rng() * 200, z: (rng() - 0.5) * 600 };
      client.forged = true;
      room.moveSim.reconcile(id, forge, 0, { x: 0, y: 0, z: 0 }, client.seq, 30);
      const after = room.moveSim.simPos(id);
      if (before && after) {
        const moved = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
        // The judge must not resync the sim onto a rejected report —
        // velocity may be adopted (it's a continuation hint), position may not.
        if (moved > 5) violations.push(`${ctx(op, `forge ${id}`)}: forged report moved shadow ${moved.toFixed(1)}m`);
      }
      desc = `forge ${id}`;
    } else if (roll < 0.42 && client) {
      // Declared discontinuity — both ends jump together (a real teleport
      // moves client AND server; the shadow resyncs without counting).
      const pos = { x: (rng() - 0.5) * 80, y: 60, z: (rng() - 0.5) * 80 };
      const refill = rng() < 0.5;
      room.moveSim.resync(id, pos, 0, refill);
      client.sim.setState(clientState(pos, 0));
      client.sim.setInput({ forward: 0, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: false, jetHeld: false });
      client.jetHeld = false;
      if (refill) client.energy = ENERGY.max; // the fullEnergy resync mirrors a respawn
      // A stale-epoch report (pre-resync seq) right after must bank nothing.
      const divergeBefore = room.health.get('diverge') ?? 0;
      room.moveSim.reconcile(id, { x: pos.x + 500, y: pos.y, z: pos.z }, 0, undefined, 0);
      if ((room.health.get('diverge') ?? 0) !== divergeBefore) {
        violations.push(`${ctx(op, `resync ${id}`)}: stale-epoch report banked a divergence`);
      }
      desc = `resync ${id}`;
    } else if (roll < 0.48 && client) {
      // Server-side impulse (knockback) — real physics both ends see.
      const dv = { x: (rng() - 0.5) * 30, y: rng() * 20, z: (rng() - 0.5) * 30 };
      room.moveSim.applyImpulse(id, dv);
      const v = client.sim.state.vel;
      client.sim.setState({ pos: client.sim.state.pos, vel: { x: v.x + dv.x, y: v.y + dv.y, z: v.z + dv.z }, yaw: client.sim.state.yaw, pitch: client.sim.state.pitch, onGround: false });
      desc = `impulse ${id}`;
    } else if (roll < 0.53 && client) {
      // Transit feed — client-reported + server-measured RTT channels.
      room.moveSim.feedTransit(id, 5 + rng() * 400);
      desc = `transit ${id}`;
    } else if (roll < 0.57 && client) {
      room.moveSim.markReseated(id);
      desc = `reseat ${id}`;
    } else if (roll < 0.62) {
      // Leave/join churn on the shadow set.
      const nid = `m${3 + Math.floor(rng() * 4)}`;
      if (clients.has(nid)) {
        room.moveSim.untrack(nid);
        clients.delete(nid);
        lastSeq.delete(nid);
        desc = `untrack ${nid}`;
      } else if (clients.size < 6) {
        spawn(nid);
        desc = `track ${nid}`;
      }
    } else if (roll < 0.68 && client) {
      // Input with NO seq (legacy fire-and-forget) — must always land.
      const input: Partial<MoveInput> = { forward: rng() < 0.5 ? 1 : 0, jetHeld: rng() < 0.4, skiHeld: rng() < 0.3 };
      client.jetHeld = input.jetHeld === true;
      client.sim.setInput(input);
      room.moveSim.queueInput(id, input, 0, undefined);
      desc = `unseq'd input ${id}`;
    }

    // One server tick + one client frame — the honest rate mismatch.
    // Client-side energy mirrors the shadow's gating: jets burn while
    // held-and-fueled, recharge while off, lock out on empty.
    room.moveSim.tick(DT);
    for (const [, c] of clients) {
      if (c.jetLockT > 0) c.jetLockT -= 1 / 60;
      const jetting = c.jetHeld && c.energy > 0 && c.jetLockT <= 0;
      if (jetting) c.energy -= ENERGY.jetDrain * (1 / 60);
      else c.energy = Math.min(ENERGY.max, c.energy + ENERGY.jetCharge * (1 / 60));
      if (c.energy <= 0) { c.energy = 0; c.jetLockT = ENERGY.jetLockout; }
      c.sim.setInput({ jetHeld: jetting });
      c.sim.update(1 / 60);
    }

    // Per-op invariants.
    for (const [pid] of clients) {
      const st = room.moveSim.simState(pid);
      if (!st) { violations.push(`${ctx(op, desc)}: ${pid} has no shadow`); continue; }
      if (!Number.isFinite(st.pos.x + st.pos.y + st.pos.z)) violations.push(`${ctx(op, desc)}: ${pid} NaN shadow pos`);
      if (!Number.isFinite(st.vel.x + st.vel.y + st.vel.z)) violations.push(`${ctx(op, desc)}: ${pid} NaN shadow vel`);
      const e = room.moveSim.energyOf(pid);
      if (e !== null && (e < 0 || !Number.isFinite(e))) violations.push(`${ctx(op, desc)}: ${pid} energy=${e}`);
      const seq = room.moveSim.inputSeqOf(pid);
      const last = lastSeq.get(pid) ?? -1;
      if (seq < last) violations.push(`${ctx(op, desc)}: ${pid} inputSeq regressed ${last}→${seq}`);
      if (seq > last) lastSeq.set(pid, seq);
    }
  }

  // Closing window — honest reports only for 60 ops. No honest stream
  // may ever trip the cheat counter, and shadow vs client truth must
  // stay inside the divergence band (60m = SEVERE_M; honest drift tops
  // ~15m by design).
  for (let op = 0; op < 60; op++) {
    for (const [pid, c] of clients) {
      // Forged players EARNED their divergence — the honest-window
      // convergence pin only covers streams that stayed legal.
      if (c.forged) continue;
      const st = c.sim.state;
      const corr = room.moveSim.reconcile(pid, { ...st.pos }, st.yaw, { ...st.vel }, c.seq, 60);
      if (corr) c.sim.setState({ pos: corr.pos, vel: corr.vel, yaw: corr.yaw, pitch: corr.pitch, onGround: corr.onGround });
      room.moveSim.tick(DT);
      c.sim.update(1 / 60);
      const sh = room.moveSim.simPos(pid);
      if (sh) {
        const gap = Math.hypot(st.pos.x - sh.x, st.pos.y - sh.y, st.pos.z - sh.z);
        if (gap > 60) violations.push(`seed=${seed} clean-close: ${pid} honest gap ${gap.toFixed(1)}m > 60m`);
      }
    }
  }
  for (const [pid, c] of clients) {
    if (!c.forged && cheats.includes(pid)) violations.push(`seed=${seed}: honest player ${pid} flagged as cheater`);
  }

  const final = new Map<string, { pos: Vec3; vel: Vec3; energy: number | null; seq: number }>();
  for (const [pid] of clients) {
    const st = room.moveSim.simState(pid)!;
    final.set(pid, { pos: { ...st.pos }, vel: { ...st.vel }, energy: room.moveSim.energyOf(pid), seq: room.moveSim.inputSeqOf(pid) });
  }
  return { violations, final, cheats };
}

describe('movement shadow conformance fuzz', () => {
  it('honest streams converge, forges bank without moving truth, physics is deterministic', () => {
    const SEEDS = [13, 29, 53, 71];
    const runs = new Map<number, ReturnType<typeof run>>();
    for (const seed of SEEDS) {
      runs.set(seed, run(seed));
    }
    const allViolations: string[] = [];
    for (const seed of SEEDS) allViolations.push(...runs.get(seed)!.violations);

    // Deterministic replay: run seed 13 again — identical inputs must
    // produce identical physics (wall-time-free fields only).
    const replay = run(13);
    const orig = runs.get(13)!;
    for (const [pid, a] of orig.final) {
      const b = replay.final.get(pid);
      if (!b) { allViolations.push(`replay: ${pid} missing`); continue; }
      for (const k of ['x', 'y', 'z'] as const) {
        if (Math.abs(a.pos[k] - b.pos[k]) > 1e-9) allViolations.push(`replay: ${pid} pos.${k} diverged ${a.pos[k]} vs ${b.pos[k]}`);
        if (Math.abs(a.vel[k] - b.vel[k]) > 1e-9) allViolations.push(`replay: ${pid} vel.${k} diverged ${a.vel[k]} vs ${b.vel[k]}`);
      }
      if (a.seq !== b.seq) allViolations.push(`replay: ${pid} inputSeq ${a.seq} vs ${b.seq}`);
      if ((a.energy ?? -1) !== (b.energy ?? -1)) allViolations.push(`replay: ${pid} energy ${a.energy} vs ${b.energy}`);
    }
    allViolations.push(...replay.violations.map((v) => `replay-run: ${v}`));

    expect(allViolations).toEqual([]);
  });
});
