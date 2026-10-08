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
 * Sim-clock paced: the loop steps 1ms of sim time per iteration and
 * setWallNow() binds wallNow() to that clock for the run, so the
 * wall-windowed gates (correction throttle, report grace, journal TTL)
 * elapse with production semantics while the run stays deterministic.
 * Pure lockstep chaos is the detTrace suite; this bridge measures what
 * a real link does to prediction.
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
import { setWallNow } from '../../src/wallClock.ts';
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
   *  must restore every durable frame it missed. `dropEveryMs` repeats
   *  the cycle for the whole run (long-session soak: journal eviction
   *  under sustained reclaim traffic). */
  dropMs?: number;
  outageMs?: number;
  dropEveryMs?: number;
  /** gameState-snapshot reseed: at reseedAtMs the authority's live sim
   *  state is staged and applied to the client's prediction
   *  reseedLagMs later (default 200 — the snapshot's delivery lag).
   *  The reseedResidual sample is how wrong prediction was at the
   *  moment the seed landed; post-reseed drift is what the tests gate. */
  reseedAtMs?: number;
  reseedLagMs?: number;
  /** Authority-side degradation. `hz` lowers the tick loop below its
   *  30Hz cadence (sustained overload); `stalls` freeze it outright for
   *  a window then let it resume (a GC pause / event-loop block — the
   *  queued inputs must drain, not pile up or reset). */
  tick?: { hz?: number; stalls?: { atMs: number; ms: number }[] };
  /** Client clock dishonesty: multiplier on the client's frame dt —
   *  a skewed rAF/performance.now makes the prediction integrate the
   *  wrong elapsed time (0.8 = clock runs 20% slow). Nothing else on
   *  the wire stamps the client's clock, so this is the only channel
   *  skew can leak through — corrections must eat the drift. */
  clockSkew?: number;
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
  /** Reconnect cycles the profile asked for (dropEveryMs soak). */
  drops: number;
  /** Sim-ms each dead socket came back — lets callers separate
   *  unavoidable outage drift from post-reconnect heal error. */
  reconnectAt: number[];
  /** Per-reclaim audit: {fromSeq, seqs replayed} — soak gap forensics. */
  replays: { fromSeq: number; seqs: number[] }[];
  /** Reseed cycles (reseedAtMs) — gameState-snapshot convergence audit. */
  reseeds: number;
  /** Client sim position the instant each reseed applied vs the
   *  authority state it was seeded from — 0 is a perfect seed. */
  reseedResidual: number[];
};

export type BridgeScript = (tMs: number) => { input: WireInput; yaw: number };

const PID = 'p';

export function runBridge(field: Heightfield, profile: BridgeProfile, script: BridgeScript, seconds: number, seed = 7): BridgeResult {
  const surface = FieldSurface.fromField(field);
  const spawn: MoveState = {
    pos: { x: 0, y: surface.getHeight(0, 0) + 1.8, z: 0 },
    vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true,
  };
  const server = new RoomMoveSim(field, true);
  server.track(PID, spawn.pos, spawn.yaw);
  const cm = new ConnectionManager();
  let sws = new FakeWs(PID, undefined, () => simNow);
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
    durableEvs: [], drops: 0, reconnectAt: [], replays: [], reseeds: 0, reseedResidual: [],
  };
  let lastEv = 0;
  let dead = false, dropped = false;
  let dropAt = profile.dropMs ?? profile.dropEveryMs ?? Infinity;
  const dropCycle = profile.dropEveryMs ?? Infinity;
  const outageMs = profile.outageMs ?? 1500;
  let deadSince = 0;
  let dropCount = 0;
  let staged: MoveState | null = null;
  let stagedAt = 0;

  // Sim clock, never wall time: a loaded CI runner stretched every timed
  // threshold (cadence, outage windows, convergence bounds) and produced
  // the probabilistic flakes this suite exists to catch. 1ms steps keep
  // the ~1ms frame pacing the busy-spin used to fake. wallNow() binds to
  // the same clock so reconcile's correction throttle, grace windows and
  // the journal's volatile TTL elapse on sim time — a plain fast-forward
  // would freeze those gates and starve corrections production sends.
  let simNow = 0;
  setWallNow(() => simNow);
  const endAt = seconds * 1000;
  let lastClient = simNow, lastServer = simNow, lastReport = simNow, lastEventAt = 0;
  let posSeq = 0;

  try {
  while (simNow < endAt) {
    simNow += 1;
    const now = simNow;
    const tMs = simNow;
    const { input, yaw } = script(tMs);

    // ---- client frame (step at real elapsed dt, like rAF) ----
    const cdt = Math.min(0.25, Math.max(0, (now - lastClient) / 1000)) * (profile.clockSkew ?? 1);
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
        // Production rides the client's own RTT measure on the frame — the
        // bridge knows its link's latency, so report it the same way.
        ping: (profile.up?.latencyMs ?? 0) + (profile.down?.latencyMs ?? 0),
        position: { ...s.pos }, velocity: { ...s.vel }, rotation: { yaw, pitch: 0 },
      }), now);
    }

    // ---- uplink delivery → server (dead sockets can't) ----
    if (!dead) for (const raw of up.deliver(now)) {
      const m = JSON.parse(raw as string) as {
        type: string; seq: number; input?: WireInput; inputSeq?: number;
        position?: Vec3Like; velocity?: Vec3Like; rotation?: { yaw: number };
        ping?: number;
      };
      if (m.type === 'inputMove') {
        server.queueInput(PID, m.input!, 0, m.seq);
      } else if (m.type === 'position') {
        const truth = server.reconcile(PID, m.position!, m.rotation!.yaw, m.velocity, m.inputSeq, m.ping);
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
    // socket replays from the client's last processed ev. With
    // dropEveryMs the cycle repeats for the run's whole span.
    if (dropped || dropAt !== Infinity) {
      if (!dead && tMs >= dropAt) {
        dropped = true; dead = true; deadSince = tMs; dropCount++;
        cm.unregister(PID);
      } else if (dead && tMs >= deadSince + outageMs) {
        dead = false; dropped = false;
        r.reconnectAt.push(tMs);
        sws = new FakeWs(PID, undefined, () => simNow);
        cm.register(PID, asWs(sws));
        // Frames aimed at the dead socket are still in the journal —
        // replay delivers exactly what the outage skipped.
        cm.replayTo(PID, asWs(sws), lastEv);
        r.replays.push({ fromSeq: lastEv, seqs: sws.sentRaw.map((f) => { try { return (JSON.parse(typeof f === 'string' ? f : new TextDecoder().decode(f)) as { ev?: number }).ev ?? -1; } catch { return -1; } }) });
        for (const raw of sws.sentRaw.splice(0)) down.send(raw, now);
        dropAt = dropCycle !== Infinity ? tMs + dropCycle : Infinity;
      }
    }

    // ---- gameState reseed (joiner/reclaim path): the authority's live
    // sim state, staged at reseedAtMs and applied to the client's
    // prediction after reseedLagMs — the snapshot's real delivery lag.
    if (profile.reseedAtMs !== undefined && tMs >= profile.reseedAtMs && !staged && r.reseeds === 0) {
      const s = server.simState(PID);
      if (s) staged = {
        pos: { ...s.pos }, vel: { ...s.vel },
        yaw: s.yaw, pitch: s.pitch, onGround: s.onGround,
      };
      stagedAt = tMs;
    }
    if (staged && tMs >= stagedAt + (profile.reseedLagMs ?? 200)) {
      const before = client.state;
      const err = Math.hypot(before.pos.x - staged.pos.x, before.pos.y - staged.pos.y, before.pos.z - staged.pos.z);
      client.setState({ pos: { ...staged.pos }, vel: { ...staged.vel }, yaw: staged.yaw, pitch: staged.pitch, onGround: staged.onGround });
      r.reseeds++;
      r.reseedResidual.push(err);
      staged = null;
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
        // Every reliable frame — corrections and chats share one ev
        // sequence, so contiguity is over all of them, not chat alone.
        r.durableEvs.push(m.ev);
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
        // The broadcast leads the raw sim by the uplink transit — the
        // honest comparison is client-vs-led-truth, what an observer
        // (and the client's own shadow of itself) actually renders.
        const lead = Math.min(server.transitOf(PID) / 2000, 0.3);
        const lx = ss.pos.x + ss.vel.x * lead, ly = ss.pos.y + ss.vel.y * lead, lz = ss.pos.z + ss.vel.z * lead;
        const e = Math.hypot(cs.pos.x - lx, cs.pos.y - ly, cs.pos.z - lz);
        r.errSeries.push(e);
        r.errT.push(tMs);
        if (e > r.maxSteadyErr) r.maxSteadyErr = e;
      }
    }

  }
  } finally {
    setWallNow();
  }
  r.drops = dropCount;
  return r;
}
