import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, firstPlayer, seat } from './harness.ts';
import { decodeTickFrame, type WireTickPlayer, type TickDecodePool } from '../../../shared/wire.ts';
import { TickFanout, type FanoutMetrics } from '../../src/tickRecords.ts';
import { wallNow } from '../../src/wallClock.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

// End-to-end pin for the held-jet wire bit: a player claiming jet through
// inputMove must arrive on the binary tick frame with jet=1 — this is the
// seam class that left the transit EMA dead (wired, never fed).
describe('scenario: held jet rides the tick frame', () => {
  it('inputMove jet=1 reaches the decoded tick record; jet=0 clears it', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    seat(room, p.id);
    pin(room, p.id, { x: 0, y: 31, z: 0 });
    room.moveSim.track(p.id, p.position, 0, p.perk);

    // Mount the production fanout as a sim and capture the spectator's
    // binary frame (same path replica() uses — wireIds roster + v3 ticks).
    const roster = new Map<number, string>();
    const pool: TickDecodePool = { slots: [] as WireTickPlayer[], byId: new Map(), resolveId: (w) => roster.get(w) };
    const metrics: FanoutMetrics = {
      recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0,
      recordsSent: 0, recordsTierSkipped: 0, recordsStopped: 0, bytesSent: 0, tickFramesDropped: 0, tickFramesHeld: 0, recordsCapped: 0, recordsScanned: 0, scanNs: 0, frameNs: 0,
    };
    const fanout = new TickFanout(metrics, (r, pid, reason) => r.removePlayerCompletely(pid, reason, () => {}));
    room.sims.push({ name: 'fanout', tick: () => {
      room.tickSeq++;
      const players = room.players.getAllPlayers();
      fanout.fanoutRecords(room, players, fanout.buildRecords(room, players, wallNow()));
    } });
    const prevBroadcast = room.connections.broadcast;
    let lastJet: number | undefined;
    room.connections.broadcast = (m: ServerMessage, exclude?: string) => {
      if (m.type === 'wireIds') {
        const w = m as { add?: Record<number, string> };
        for (const [wid, id] of Object.entries(w.add ?? {})) {roster.set(Number(wid), id);}
      }
      return prevBroadcast.call(room.connections, m, exclude);
    };
    room.connections.sendBinaryToPlayer = () => 'gone';

    const jetInput = (seq: number, jet: number) => room.messages.handleMessage(p.id, {
      type: 'inputMove', seq,
      input: { forward: 0, right: 0, jump: 0, ski: 0, jet, status: 0 }, rotation: { yaw: 0, pitch: 0 },
    });

    jetInput(1, 1);
    expect(p.jetting).toBe(1);

    // Decode the frame a real client would get. Drive the fanout directly
    // — a step() would tick botDrive first and let the bot seat overwrite
    // jetting; the fanout alone is the wire path under test.
    const prevSend = room.connections.sendBinaryToPlayer;
    room.connections.sendBinaryToPlayer = (_pid: string, data: Uint8Array) => {
      const f = decodeTickFrame(data, pool);
      if (f) {
        for (let i = 0; i < f.count; i++) {
          if (f.updates[i]!.playerId === p.id) {lastJet = f.updates[i]!.jet;}
        }
      }
      return 'sent';
    };
    room.spectators.add('__probe__');
    room.tickSeq++;
    const players = room.players.getAllPlayers();
    fanout.fanoutRecords(room, players, fanout.buildRecords(room, players, wallNow()));
    expect(lastJet).toBe(1);

    jetInput(2, 0);
    expect(p.jetting).toBe(0);
    lastJet = undefined;
    room.tickSeq++;
    fanout.fanoutRecords(room, players, fanout.buildRecords(room, players, wallNow()));
    expect<number | undefined>(lastJet).toBe(0);

    room.spectators.delete('__probe__');
    room.connections.sendBinaryToPlayer = prevSend;
    room.connections.broadcast = prevBroadcast;
  });
});
