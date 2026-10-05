/**
 * Headless prediction bridge — a real RoomMoveSim authority server and a
 * real client MoveSim talking through ChaosLinks, replicating the
 * production predict/correct/replay loop:
 *
 *   client: input edge → journal + inputMove ──up──> server.queueInput
 *   client: 20Hz position report ──up──> server.reconcile → correction ──down──> client
 *   client: on correction, snap sim to server truth (yaw stays ours) and
 *           replay journaled inputs past inputSeq — the players.ts path.
 *
 * Wall-paced on purpose: reconcile's correction throttle and report
 * grace are wallNow()-windowed, so a fast-forwarded run would starve
 * corrections that production would have sent. Sim-clocked chaos is for
 * the pure lockstep suite (detTrace); this bridge measures what a real
 * link does to prediction.
 */

import { MoveSim, ENERGY, type MoveState, type Vec3Like } from '../../../shared/movement.ts';

/** Wire-shaped client input — the inputMove payload's fields. The sim
 *  boundary translates these to jumpHeld/skiHeld/jetHeld exactly like
 *  the production setInput path does. */
export type WireInput = { forward: number; right: number; jump: number; ski: number; jet?: number };
import { FieldSurface } from '../../../shared/fieldSurface.ts';
import type { Heightfield } from '../../../shared/heightfield.ts';
import { RoomMoveSim } from '../../src/RoomMoveSim.ts';
import { ChaosLink, type ChaosSpec } from './chaos.ts';

/** Client-side input journal — InputStream semantics with an injectable
 *  clock (the real one stamps performance.now; identical rules: bounded
 *  128, edge-only sends, inputsAfter prunes consumed). */
class Journal {
  seq = 0;
  private entries: { seq: number; t: number; input: WireInput }[] = [];
  private lastKey = '';
  private lastInput: WireInput | null = null;

  push(input: WireInput, now: number): number | null {
    const key = `${input.forward},${input.right},${input.jump},${input.ski},${input.jet ?? 0}`;
    if (key === this.lastKey) return null;
    this.lastKey = key;
    const seq = ++this.seq;
    this.entries.push({ seq, t: now, input: { ...input } });
    if (this.entries.length > 128) this.entries.shift();
    this.lastInput = { ...input };
    return seq;
  }
  resend(now: number): { seq: number; input: WireInput } | null {
    if (!this.lastInput) return null;
    const seq = ++this.seq;
    this.entries.push({ seq, t: now, input: { ...this.lastInput } });
    return { seq, input: this.lastInput };
  }
  inputsAfter(after: number): { t: number; input: WireInput }[] {
    while (this.entries.length && this.entries[0]!.seq <= after) this.entries.shift();
    return this.entries;
  }
}

export type BridgeProfile = {
  up?: ChaosSpec;   // client → server
  down?: ChaosSpec; // server → client
};

export type BridgeResult = {
  /** Prediction error measured at each correction, before the snap — the
   *  drift the link let accumulate between authority echoes. */
  preErr: number[];
  /** Residual error right after snap+replay vs LIVE authority (not the
   *  stale echo — replay legitimately moves past the anchor). */
  postErr: number[];
  corrections: number;
  snaps: number;          // corrections that passed the 0.5m snap gate
  reportsSent: number;
  inputsSent: number;
  inputsResent: number;
  maxSteadyErr: number;   // largest |client - server| sampled mid-run
  errSeries: number[];    // per-client-frame error samples (post-warmup)
};

export type BridgeScript = (tMs: number) => { input: WireInput; yaw: number };

const PID = 'p';

export function runBridge(field: Heightfield, profile: BridgeProfile, script: BridgeScript, seconds: number, seed = 7): BridgeResult {
  const surface = new FieldSurface(field);
  const spawn: MoveState = {
    pos: { x: 0, y: surface.getHeight(0, 0) + 1.8, z: 0 },
    vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true,
  };
  const server = new RoomMoveSim(field, true);
  server.track(PID, spawn.pos, spawn.yaw);
  // Production path: 3 reports stamped past the consumed watermark →
  // server asks the client to re-emit its current edge (inputSync).
  server.onInputGap = (_pid, lastSeq) => {
    down.send(JSON.stringify({ type: 'inputSync', lastSeq }), Date.now());
  };
  const client = new MoveSim(surface, { pos: { ...spawn.pos }, vel: { ...spawn.vel }, yaw: 0, pitch: 0, onGround: true });

  const up = new ChaosLink(profile.up ?? {}, seed * 2 + 1);
  const down = new ChaosLink(profile.down ?? {}, seed * 2 + 2);
  const journal = new Journal();

  // Client-side energy economy — mirrors the server shadow's rules
  // (shared/movement ENERGY): drain while thrusting, regen grounded.
  let tank: number = ENERGY.max;
  let jetLock = 0;
  const clientEnergy = (inp: WireInput, dt: number, grounded: boolean) => {
    if (jetLock > 0) jetLock -= dt;
    const burning = !!inp.jet && tank > 0 && jetLock <= 0;
    if (burning) tank -= ENERGY.jetDrain * dt;
    else if (grounded) tank = Math.min(ENERGY.max as number, tank + ENERGY.jetCharge * dt);
    if (tank <= 0) { tank = 0; jetLock = ENERGY.jetLockout; }
    return burning;
  };

  const r: BridgeResult = {
    preErr: [], postErr: [], corrections: 0, snaps: 0,
    reportsSent: 0, inputsSent: 0, inputsResent: 0, maxSteadyErr: 0, errSeries: [],
  };

  const start = Date.now();
  const endAt = start + seconds * 1000;
  let lastClient = start, lastServer = start, lastReport = start;
  let posSeq = 0;

  while (Date.now() < endAt) {
    const now = Date.now();
    const tMs = now - start;
    const { input, yaw } = script(tMs);

    // ---- client frame (step at real elapsed dt, like rAF) ----
    const cdt = Math.min(0.25, Math.max(0, (now - lastClient) / 1000));
    if (cdt > 0) {
      lastClient = now;
      const burning = clientEnergy(input, cdt, client.state.onGround);
      client.state.yaw = yaw;
      client.setInput({
        forward: input.forward, right: input.right,
        jumpPressed: !!input.jump, jumpHeld: !!input.jump,
        skiHeld: !!input.ski, jetHeld: burning,
      });
      client.update(cdt);
    }

    // input edge → journal + uplink
    const iseq = journal.push(input, now);
    if (iseq !== null) {
      r.inputsSent++;
      up.send(JSON.stringify({ type: 'inputMove', seq: iseq, input }), now);
    }

    // 20Hz position reports — the correction trigger, with our input watermark
    if (now - lastReport >= 50) {
      lastReport = now;
      r.reportsSent++;
      const s = client.state;
      up.send(JSON.stringify({
        type: 'position', seq: ++posSeq, inputSeq: journal.seq,
        position: { ...s.pos }, velocity: { ...s.vel }, rotation: { yaw, pitch: 0 },
      }), now);
    }

    // ---- uplink delivery → server ----
    for (const raw of up.deliver(now)) {
      const m = JSON.parse(raw as string) as {
        type: string; seq: number; input?: WireInput; inputSeq?: number;
        position?: Vec3Like; velocity?: Vec3Like; rotation?: { yaw: number };
      };
      if (m.type === 'inputMove') {
        server.queueInput(PID, m.input!, 0, m.seq);
      } else if (m.type === 'position') {
        const truth = server.reconcile(PID, m.position!, m.rotation!.yaw, m.velocity, m.inputSeq);
        if (truth) {
          down.send(JSON.stringify({
            type: 'correction', seq: m.seq, inputSeq: truth.inputSeq,
            grounded: truth.onGround, position: truth.pos, velocity: truth.vel,
          }), now);
        }
      }
    }

    // ---- downlink delivery → client correction handler (players.ts) ----
    for (const raw of down.deliver(now)) {
      const m = JSON.parse(raw as string) as {
        type: string; inputSeq?: number; grounded?: boolean; lastSeq?: number;
        position: Vec3Like; velocity: Vec3Like;
      };
      if (m.type === 'inputSync') {
        // Server noticed a watermark gap — re-emit the current edge.
        const rs = journal.resend(now);
        if (rs) { r.inputsResent++; up.send(JSON.stringify({ type: 'inputMove', seq: rs.seq, input: rs.input }), now); }
        continue;
      }
      if (m.type !== 'correction') continue;
      r.corrections++;
      const s = client.state;
      const err = Math.hypot(s.pos.x - m.position.x, s.pos.y - m.position.y, s.pos.z - m.position.z);
      r.preErr.push(err);
      if (err < 0.5) continue; // below snap threshold — production ignores
      r.snaps++;
      const entries = m.inputSeq !== undefined ? journal.inputsAfter(m.inputSeq) : [];
      client.setState({
        pos: { ...m.position }, vel: { ...m.velocity },
        yaw: s.yaw, pitch: s.pitch, // aim is client-authoritative
        onGround: m.grounded ?? true,
      });
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        const nextT = i + 1 < entries.length ? entries[i + 1]!.t : now;
        client.setInput({
          forward: e.input.forward, right: e.input.right,
          jumpPressed: !!e.input.jump, jumpHeld: !!e.input.jump,
          skiHeld: !!e.input.ski, jetHeld: !!e.input.jet,
        });
        client.update(Math.min(0.25, Math.max(0, (nextT - e.t) / 1000)));
      }
      // Residual vs live authority — the echo is already behind the
      // server's tick, so comparing against it measures replay travel,
      // not convergence error.
      const s2 = client.state, live = server.simState(PID);
      if (live) r.postErr.push(Math.hypot(s2.pos.x - live.pos.x, s2.pos.y - live.pos.y, s2.pos.z - live.pos.z));
    }

    // ---- server tick at 30Hz ----
    if (now - lastServer >= 1000 / 30) {
      const sdt = (now - lastServer) / 1000;
      lastServer = now;
      server.tick(sdt);
    }

    // steady-state error sample (skip the first second's join transient)
    if (tMs > 1000) {
      const cs = client.state;
      const ss = server.simState(PID);
      if (ss) {
        const e = Math.hypot(cs.pos.x - ss.pos.x, cs.pos.y - ss.pos.y, cs.pos.z - ss.pos.z);
        r.errSeries.push(e);
        if (e > r.maxSteadyErr) r.maxSteadyErr = e;
      }
    }

    // ~1ms sleep granularity is the tightest honest frame pacing on win32
    const until = now + 1;
    while (Date.now() < until) { /* spin — Atomics.sleep is coarser */ }
  }
  return r;
}
