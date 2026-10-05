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
import { ConnectionManager } from '../../src/ConnectionManager.ts';
import { ChaosLink, FakeWs, type ChaosSpec } from './chaos.ts';
import type { ServerWebSocket } from 'bun';
import type { ServerMessage, WebSocketData } from '../../src/types.ts';

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
  /** Mid-run socket death: at `dropMs` the client's socket dies; after
   *  `outageMs` it reclaims with its last-processed ev — the journal
   *  must restore every durable frame it missed. */
  dropMs?: number;
  outageMs?: number;
  /** Authority-side degradation. `hz` lowers the tick loop below its
   *  30Hz cadence (sustained overload); `stalls` freeze it outright for
   *  a window then let it resume (a GC pause / event-loop block — the
   *  queued inputs must drain, not pile up or reset). */
  tick?: { hz?: number; stalls?: { atMs: number; ms: number }[] };
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
  errT: number[];         // tMs stamps parallel to errSeries (convergence timing)
  /** ev seqs of durable (chat) frames the client actually processed —
   *  contiguous coverage after a reconnect means reclaim lost nothing. */
  durableEvs: number[];
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
  const cm = new ConnectionManager();
  let sws = new FakeWs(PID, undefined, () => Date.now());
  const asWs = (w: FakeWs) => w as unknown as ServerWebSocket<WebSocketData>;
  cm.register(PID, asWs(sws));
  // Production path: 3 reports stamped past the consumed watermark →
  // server asks the client to re-emit its current edge (inputSync).
  server.onInputGap = (_pid, lastSeq) => {
    cm.sendToPlayer(PID, { type: 'inputSync', lastSeq } as ServerMessage);
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
    reportsSent: 0, inputsSent: 0, inputsResent: 0, maxSteadyErr: 0, errSeries: [], errT: [],
    durableEvs: [],
  };
  let lastEv = 0;
  let dead = false, dropped = false, reconnected = false;

  const start = Date.now();
  const endAt = start + seconds * 1000;
  let lastClient = start, lastServer = start, lastReport = start, lastEventAt = 0;
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
    if (iseq !== null && !dead) {
      r.inputsSent++;
      up.send(JSON.stringify({ type: 'inputMove', seq: iseq, input }), now);
    }

    // 20Hz position reports — the correction trigger, with our input watermark
    if (!dead && now - lastReport >= 50) {
      lastReport = now;
      r.reportsSent++;
      const s = client.state;
      up.send(JSON.stringify({
        type: 'position', seq: ++posSeq, inputSeq: journal.seq,
        position: { ...s.pos }, velocity: { ...s.vel }, rotation: { yaw, pitch: 0 },
      }), now);
    }

    // ---- uplink delivery → server (dead sockets can't) ----
    if (!dead) for (const raw of up.deliver(now)) {
      const m = JSON.parse(raw as string) as {
        type: string; seq: number; input?: WireInput; inputSeq?: number;
        position?: Vec3Like; velocity?: Vec3Like; rotation?: { yaw: number };
      };
      if (m.type === 'inputMove') {
        server.queueInput(PID, m.input!, 0, m.seq);
      } else if (m.type === 'position') {
        const truth = server.reconcile(PID, m.position!, m.rotation!.yaw, m.velocity, m.inputSeq);
        if (truth) {
          cm.sendToPlayer(PID, {
            type: 'correction', seq: m.seq, inputSeq: truth.inputSeq,
            grounded: truth.onGround, position: truth.pos, velocity: truth.vel,
          } as ServerMessage);
        }
      }
    }

    // Durable world event on the downlink every ~600ms — the thing a
    // reclaim MUST NOT lose (kill feed / flag edges / chat in prod).
    if (tMs - lastEventAt >= 600) {
      lastEventAt = tMs;
      cm.sendToPlayer(PID, { type: 'chat', playerId: 'world', text: `ev@${tMs | 0}` } as ServerMessage);
    }

    // Socket death + reclaim — the dead socket keeps accepting sends
    // (they journal; the chaos queue just never drains), then a fresh
    // socket replays from the client's last processed ev.
    if (profile.dropMs !== undefined && !reconnected) {
      if (!dropped && tMs >= profile.dropMs) {
        dropped = true; dead = true;
        cm.unregister(PID);
      } else if (dead && tMs >= profile.dropMs + (profile.outageMs ?? 1500)) {
        dead = false; reconnected = true;
        sws = new FakeWs(PID, undefined, () => Date.now());
        cm.register(PID, asWs(sws));
        // Frames aimed at the dead socket are still in the journal —
        // replay delivers exactly what the outage skipped.
        cm.replayTo(PID, asWs(sws), lastEv);
        for (const raw of sws.sentRaw.splice(0)) down.send(raw, now);
      }
    }

    // Live socket traffic rides the downlink too.
    for (const raw of sws.sentRaw.splice(0)) down.send(raw, now);

    // ---- downlink delivery → client correction handler (players.ts) ----
    if (!dead) for (const raw of down.deliver(now)) {
      const m = JSON.parse(raw as string) as {
        type: string; inputSeq?: number; grounded?: boolean; lastSeq?: number;
        position: Vec3Like; velocity: Vec3Like; ev?: number;
      };
      if (m.ev !== undefined) {
        // Reordered/duplicated lane — a replayed journal frame and its
        // queued original can BOTH arrive; dedupe by the offset cursor.
        if (m.ev <= lastEv) continue;
        lastEv = m.ev;
        if (m.type === 'chat') r.durableEvs.push(m.ev);
      }
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

    // ---- server tick at its profile cadence (30Hz healthy) ----
    const stalled = profile.tick?.stalls?.some((s) => tMs >= s.atMs && tMs < s.atMs + s.ms) ?? false;
    if (!stalled && now - lastServer >= 1000 / (profile.tick?.hz ?? 30)) {
      // A stall resumes with one big dt (production clamps inside the
      // sim); clamping here keeps the catch-up honest instead of
      // teleporting through a multi-second step.
      const sdt = Math.min(0.25, (now - lastServer) / 1000);
      lastServer = now;
      server.tick(sdt);
    }
    if (stalled) lastServer = now; // freeze the clock so resume isn't one giant step

    // steady-state error sample (skip the first second's join transient)
    if (tMs > 1000) {
      const cs = client.state;
      const ss = server.simState(PID);
      if (ss) {
        const e = Math.hypot(cs.pos.x - ss.pos.x, cs.pos.y - ss.pos.y, cs.pos.z - ss.pos.z);
        r.errSeries.push(e);
        r.errT.push(tMs);
        if (e > r.maxSteadyErr) r.maxSteadyErr = e;
      }
    }

    // ~1ms sleep granularity is the tightest honest frame pacing on win32
    const until = now + 1;
    while (Date.now() < until) { /* spin — Atomics.sleep is coarser */ }
  }
  return r;
}
