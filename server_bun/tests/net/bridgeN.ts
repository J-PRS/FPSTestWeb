/**
 * Multi-client prediction bridge — N real client MoveSims against one
 * RoomMoveSim authority through per-client ChaosLinks, sharing ONE
 * ConnectionManager (production's fanout/journal/only-exclude machinery).
 * Same sim-clock predict/correct/replay loop as bridge.ts; the point is
 * contention: corrections, journals and gap heals for every client
 * multiplexed over its own link while the authority integrates them all.
 */

import { MoveSim, ENERGY, type MoveState, type Vec3Like } from '../../../shared/movement.ts';
import { FieldSurface } from '../../../shared/fieldSurface.ts';
import type { Heightfield } from '../../../shared/heightfield.ts';
import { RoomMoveSim } from '../../src/RoomMoveSim.ts';
import { ConnectionManager } from '../../src/ConnectionManager.ts';
import { ChaosLink, FakeWs } from './chaos.ts';
import { setWallNow } from '../../src/wallClock.ts';
import type { ServerWebSocket } from 'bun';
import type { ServerMessage, WebSocketData } from '../../src/types.ts';
import type { BridgeProfile, BridgeScript, WireInput } from './bridge.ts';

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

export type ClientSpec = {
  id: string;
  script: BridgeScript;
  profile?: BridgeProfile;
  seed?: number;
  spawn?: { x: number; z: number };
};

export type ClientResult = {
  preErr: number[];
  postErr: number[];
  corrections: number;
  snaps: number;
  reportsSent: number;
  inputsSent: number;
  inputsResent: number;
  maxSteadyErr: number;
  errSeries: number[];
  durableEvs: number[];
};

export type BridgeNResult = {
  clients: Map<string, ClientResult>;
  /** Broadcast frames emitted during the run — each live client's
   *  durableEvs count must equal this (exactly-once fanout). */
  broadcasts: number;
};

export function runBridgeN(field: Heightfield, specs: ClientSpec[], seconds: number): BridgeNResult {
  const surface = new FieldSurface(field);
  const server = new RoomMoveSim(field, true);
  const cm = new ConnectionManager();
  const asWs = (w: FakeWs) => w as unknown as ServerWebSocket<WebSocketData>;

  type Client = {
    spec: ClientSpec;
    sim: MoveSim;
    journal: Journal;
    up: ChaosLink;
    down: ChaosLink;
    sws: FakeWs;
    tank: number;
    jetLock: number;
    r: ClientResult;
    lastEv: number;
    dead: boolean;
    dropped: boolean;
    reconnected: boolean;
    lastReport: number;
    posSeq: number;
    lastClient: number;
  };

  const clients: Client[] = specs.map((spec, i) => {
    const seed = spec.seed ?? (i + 1) * 31;
    const sx = spec.spawn?.x ?? (i - specs.length / 2) * 30;
    const sz = spec.spawn?.z ?? (i % 2 ? -40 : 40);
    const spawn: MoveState = {
      pos: { x: sx, y: surface.getHeight(sx, sz) + 1.8, z: sz },
      vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true,
    };
    server.track(spec.id, spawn.pos, spawn.yaw);
    const sws = new FakeWs(spec.id, undefined, () => simNow);
    cm.register(spec.id, asWs(sws));
    server.onInputGap = (pid, lastSeq) => {
      cm.sendToPlayer(pid, { type: 'inputSync', lastSeq } as ServerMessage);
    };
    return {
      spec,
      sim: new MoveSim(surface, { pos: { ...spawn.pos }, vel: { ...spawn.vel }, yaw: 0, pitch: 0, onGround: true }),
      journal: new Journal(),
      up: new ChaosLink(spec.profile?.up ?? {}, seed * 2 + 1),
      down: new ChaosLink(spec.profile?.down ?? {}, seed * 2 + 2),
      sws,
      tank: ENERGY.max,
      jetLock: 0,
      r: { preErr: [], postErr: [], corrections: 0, snaps: 0, reportsSent: 0, inputsSent: 0, inputsResent: 0, maxSteadyErr: 0, errSeries: [], durableEvs: [] },
      lastEv: 0, dead: false, dropped: false, reconnected: false,
      lastReport: 0, posSeq: 0, lastClient: 0,
    };
  });

  let broadcasts = 0;
  // Sim clock, never wall time (see runBridge): wall-paced loops made
  // every timed bound probabilistic — the flakes this suite exists to kill.
  let simNow = 0;
  setWallNow(() => simNow); // wall-windowed gates elapse on sim time
  const endAt = seconds * 1000;
  let lastServer = simNow, lastEventAt = 0;

  const clientEnergy = (c: Client, inp: WireInput, dt: number, grounded: boolean) => {
    if (c.jetLock > 0) c.jetLock -= dt;
    const burning = !!inp.jet && c.tank > 0 && c.jetLock <= 0;
    if (burning) c.tank -= ENERGY.jetDrain * dt;
    else if (grounded) c.tank = Math.min(ENERGY.max as number, c.tank + ENERGY.jetCharge * dt);
    if (c.tank <= 0) { c.tank = 0; c.jetLock = ENERGY.jetLockout; }
    return burning;
  };

  try {
  while (simNow < endAt) {
    simNow += 1;
    const now = simNow;
    const tMs = simNow;

    for (const c of clients) {
      const { input, yaw } = c.spec.script(tMs);

      const cdt = Math.min(0.25, Math.max(0, (now - c.lastClient) / 1000));
      if (cdt > 0) {
        c.lastClient = now;
        const burning = clientEnergy(c, input, cdt, c.sim.state.onGround);
        c.sim.state.yaw = yaw;
        c.sim.setInput({
          forward: input.forward, right: input.right,
          jumpPressed: !!input.jump, jumpHeld: !!input.jump,
          skiHeld: !!input.ski, jetHeld: burning,
        });
        c.sim.update(cdt);
      }

      const iseq = c.journal.push(input, now);
      if (iseq !== null && !c.dead) {
        c.r.inputsSent++;
        c.up.send(JSON.stringify({ type: 'inputMove', seq: iseq, input }), now);
      }

      if (!c.dead && now - c.lastReport >= 50) {
        c.lastReport = now;
        c.r.reportsSent++;
        const s = c.sim.state;
        c.up.send(JSON.stringify({
          type: 'position', seq: ++c.posSeq, inputSeq: c.journal.seq,
          position: { ...s.pos }, velocity: { ...s.vel }, rotation: { yaw, pitch: 0 },
        }), now);
      }

      if (!c.dead) for (const raw of c.up.deliver(now)) {
        const m = JSON.parse(raw as string) as {
          type: string; seq: number; input?: WireInput; inputSeq?: number;
          position?: Vec3Like; velocity?: Vec3Like; rotation?: { yaw: number };
        };
        if (m.type === 'inputMove') {
          server.queueInput(c.spec.id, m.input!, 0, m.seq);
        } else if (m.type === 'position') {
          const truth = server.reconcile(c.spec.id, m.position!, m.rotation!.yaw, m.velocity, m.inputSeq);
          if (truth) {
            cm.sendToPlayer(c.spec.id, {
              type: 'correction', seq: m.seq, inputSeq: truth.inputSeq,
              grounded: truth.onGround, position: truth.pos, velocity: truth.vel,
            } as ServerMessage);
          }
        }
      }

      // Durable broadcast frames — emitted for ALL live clients like
      // production's room fanout; each socket must deliver it exactly once.
      const profile = c.spec.profile;
      if (profile?.dropMs !== undefined && !c.reconnected) {
        if (!c.dropped && tMs >= profile.dropMs) {
          c.dropped = true; c.dead = true;
          cm.unregister(c.spec.id);
        } else if (c.dead && tMs >= profile.dropMs + (profile.outageMs ?? 1500)) {
          c.dead = false; c.reconnected = true;
          c.sws = new FakeWs(c.spec.id, undefined, () => simNow);
          cm.register(c.spec.id, asWs(c.sws));
          cm.replayTo(c.spec.id, asWs(c.sws), c.lastEv);
          for (const raw of c.sws.sentRaw.splice(0)) c.down.send(raw, now);
        }
      }
      for (const raw of c.sws.sentRaw.splice(0)) c.down.send(raw, now);

      if (!c.dead) for (const raw of c.down.deliver(now)) {
        const m = JSON.parse(raw as string) as {
          type: string; inputSeq?: number; grounded?: boolean; lastSeq?: number;
          position: Vec3Like; velocity: Vec3Like; ev?: number;
        };
        if (m.ev !== undefined) {
          if (m.ev <= c.lastEv) continue;
          c.lastEv = m.ev;
          if (m.type === 'chat') c.r.durableEvs.push(m.ev);
        }
        if (m.type === 'inputSync') {
          const rs = c.journal.resend(now);
          if (rs) { c.r.inputsResent++; c.up.send(JSON.stringify({ type: 'inputMove', seq: rs.seq, input: rs.input }), now); }
          continue;
        }
        if (m.type !== 'correction') continue;
        c.r.corrections++;
        const s = c.sim.state;
        const err = Math.hypot(s.pos.x - m.position.x, s.pos.y - m.position.y, s.pos.z - m.position.z);
        c.r.preErr.push(err);
        if (err < 0.5) continue;
        c.r.snaps++;
        const entries = m.inputSeq !== undefined ? c.journal.inputsAfter(m.inputSeq) : [];
        c.sim.setState({
          pos: { ...m.position }, vel: { ...m.velocity },
          yaw: s.yaw, pitch: s.pitch,
          onGround: m.grounded ?? true,
        });
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i]!;
          const nextT = i + 1 < entries.length ? entries[i + 1]!.t : now;
          c.sim.setInput({
            forward: e.input.forward, right: e.input.right,
            jumpPressed: !!e.input.jump, jumpHeld: !!e.input.jump,
            skiHeld: !!e.input.ski, jetHeld: !!e.input.jet,
          });
          c.sim.update(Math.min(0.25, Math.max(0, (nextT - e.t) / 1000)));
        }
        const s2 = c.sim.state, live = server.simState(c.spec.id);
        if (live) c.r.postErr.push(Math.hypot(s2.pos.x - live.pos.x, s2.pos.y - live.pos.y, s2.pos.z - live.pos.z));
      }

      if (tMs > 1000) {
        const cs = c.sim.state;
        const ss = server.simState(c.spec.id);
        if (ss) {
          const e = Math.hypot(cs.pos.x - ss.pos.x, cs.pos.y - ss.pos.y, cs.pos.z - ss.pos.z);
          c.r.errSeries.push(e);
          if (e > c.r.maxSteadyErr) c.r.maxSteadyErr = e;
        }
      }
    }

    // One broadcast per interval — fanned out through cm like a real
    // room event; the per-client replay/dedup logic above proves each
    // socket sees it exactly once.
    if (tMs - lastEventAt >= 600) {
      lastEventAt = tMs;
      for (const c of clients) {
        cm.sendToPlayer(c.spec.id, { type: 'chat', playerId: 'world', text: `ev@${tMs | 0}` } as ServerMessage);
      }
      broadcasts++;
    }

    if (now - lastServer >= 1000 / 30) {
      const sdt = (now - lastServer) / 1000;
      lastServer = now;
      server.tick(sdt);
    }

  }
  } finally {
    setWallNow();
  }

  const clientsOut = new Map<string, ClientResult>();
  for (const c of clients) clientsOut.set(c.spec.id, c.r);
  return { clients: clientsOut, broadcasts };
}
