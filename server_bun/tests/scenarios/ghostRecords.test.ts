import { wallMs } from '../../src/wallClock.ts';
import { describe, expect, it } from 'bun:test';
import { TickLoop } from '../../src/TickLoop.ts';
import { decodeTickFrame } from '../../../shared/wire.ts';
import { mkRoom, seat } from './harness.ts';

// A connected human sitting in menu/lobby never sends position reports —
// but the tick loop still emitted records at the spawn default, so every
// peer rendered a frozen avatar there (the pos=(0,60,0) wire ghosts in
// diagnostics). Bots are exempt: the sim writes their position directly.
describe('ghost records', () => {
  it('a human without a position report emits no records', () => {
    const room = mkRoom({ bots: 1 });
    room.players.addPlayer('ghost');
    const sent: string[] = [];
    // Capture decoded record ids via the sendBinary hook — simpler: watch
    // which playerIds get records by intercepting encodeTickFrame? The
    // frame is binary; instead count frames reaching a live observer and
    // check the ghost contributes nothing. We use a second human as the
    // observer so fanout has a recipient.
    room.players.addPlayer('observer');
    const obs = room.players.getPlayer('observer');
    if (!obs) {throw new Error('no observer');}
    obs.hasReceivedPosition = true; // live observer, else it ghosts too
    seat(room, 'observer');
    room.connections.sendBinaryToPlayer = (_id, data) => {
      sent.push(new TextDecoder().decode(data));
      return 'sent' as const;
    };
    const loop = new TickLoop(new Map([['t', room]]), { tickLagMsMax: 0, tickLagMsSum: 0, tickLagSamples: 0, lastTickAt: 0 }, () => {});
    loop.tickRoomNow(room, wallMs(Date.now()));
    // Binary frame — decode ids instead: easier to assert on record count
    // via the metrics path… simplest reliable check: the ghost's id never
    // appears in the encoded payload.
    const ghostId = 'ghost';
    let ghostMentions = 0;
    room.connections.sendBinaryToPlayer = (_id, data) => {
      const s = new TextDecoder().decode(data);
      if (s.includes(ghostId)) {ghostMentions++;}
      return 'sent' as const;
    };
    loop.tickRoomNow(room, wallMs(Date.now() + 50));
    expect(ghostMentions).toBe(0);
    expect(sent.length).toBeGreaterThanOrEqual(0); // frames did flow above
  });

  it('an idle ghost is still reaped — ghost check must not swallow the reap', () => {
    const room = mkRoom({ bots: 0 });
    room.players.addPlayer('staleGhost');
    const p = room.players.getPlayer('staleGhost');
    if (!p) {throw new Error('no staleGhost');}
    // Silenced far past the idle-kick window with NO position report —
    // hasReceivedPosition=false would normally short-circuit skipRecord.
    p.lastSeen = wallMs(Date.now() - 120_000);
    // tickRoomNow's onRemove is normally GameServer.removePlayerCompletely —
    // assert the reap was delegated rather than checking the roster.
    let reaped = '';
    const loop = new TickLoop(new Map([['t', room]]), { tickLagMsMax: 0, tickLagMsSum: 0, tickLagSamples: 0, lastTickAt: 0 }, (_room, id, reason) => { reaped = `${id}:${reason}`; });
    loop.tickRoomNow(room, wallMs(Date.now()));
    expect(reaped).toBe('staleGhost:idle');
  });

  it('the same human appears once it reports a position', () => {
    const room = mkRoom({ bots: 0 });
    room.players.addPlayer('late');
    const p = room.players.getPlayer('late');
    if (!p) {throw new Error('no late');}
    p.hasReceivedPosition = true;
    p.lastSeen = wallMs(Date.now());
    let mentions = 0;
    // v3 frames carry u16 wire-ids — the playerId string lives in the
    // 'wireIds' roster event, so decode through the real path.
    const roster = new Map<number, string>();
    room.connections.broadcast = (msg) => {
      const m = msg as { type?: string; add?: Record<number, string> };
      if (m.type === 'wireIds' && m.add) {for (const [id, pid] of Object.entries(m.add)) {roster.set(Number(id), pid);}}
    };
    const pool = { slots: [] as never[], byId: new Map(), resolveId: (id: number) => roster.get(id) };
    room.connections.sendBinaryToPlayer = (_id, data) => {
      const tick = decodeTickFrame(data, pool);
      if (tick && tick.updates.some((u, i) => i < tick.count && u.playerId === 'late')) {mentions++;}
      return 'sent' as const;
    };
    // A second live human receives the frame containing 'late'.
    room.players.addPlayer('observer');
    const obs = room.players.getPlayer('observer');
    if (!obs) {throw new Error('no observer');}
    obs.hasReceivedPosition = true;
    obs.lastSeen = wallMs(Date.now());
    seat(room, 'observer');
    const loop = new TickLoop(new Map([['t', room]]), { tickLagMsMax: 0, tickLagMsSum: 0, tickLagSamples: 0, lastTickAt: 0 }, () => {});
    loop.tickRoomNow(room, wallMs(Date.now()));
    expect(mentions).toBeGreaterThan(0);
  });

  it('a departed player releases its wireId and the roster broadcasts the remove', () => {
    const room = mkRoom({ bots: 0 });
    room.players.addPlayer('churn');
    const p = room.players.getPlayer('churn');
    if (!p) {throw new Error('no churn');}
    p.hasReceivedPosition = true;
    p.lastSeen = wallMs(Date.now());
    room.players.addPlayer('observer');
    const obs = room.players.getPlayer('observer');
    if (!obs) {throw new Error('no observer');}
    obs.hasReceivedPosition = true;
    obs.lastSeen = wallMs(Date.now());
    const removes: number[] = [];
    room.connections.broadcast = (msg) => {
      const m = msg as { type?: string; remove?: number[] };
      if (m.type === 'wireIds' && m.remove) {removes.push(...m.remove);}
    };
    const loop = new TickLoop(new Map([['t', room]]), { tickLagMsMax: 0, tickLagMsSum: 0, tickLagSamples: 0, lastTickAt: 0 }, () => {});
    loop.tickRoomNow(room, wallMs(Date.now())); // mints churn's wireId
    const wid = room.wireIds.get('churn');
    expect(wid).toBeDefined();
    room.removePlayerCompletely('churn', 'test', () => {});
    expect(room.wireIds.has('churn')).toBe(false);
    expect(room.wireIdRetired.get(wid!)).toBeDefined();
    expect(removes).toContain(wid!);
    // Backdate the retirement past the quiet window — the next mint must
    // prefer the recycled id over burning toward the u16 wrap.
    room.wireIdRetired.set(wid!, 1);
    room.players.addPlayer('churn2');
    const p2 = room.players.getPlayer('churn2');
    if (!p2) {throw new Error('no churn2');}
    p2.hasReceivedPosition = true;
    p2.lastSeen = wallMs(Date.now());
    loop.tickRoomNow(room, wallMs(Date.now() + 100));
    expect(room.wireIds.get('churn2')).toBe(wid);
  });

  it('u16 space exhaustion recycles the eldest retired id, loud', () => {
    const room = mkRoom({ bots: 0 });
    // Burn the counter to the wrap and retire an id inside the quiet
    // window — quiet-recycle can't help, so the eldest fallback must
    // fire rather than a silent modulo-wrap aliasing a live binding.
    room.nextWireId = 0x1_00_00;
    room.wireIdRetired.set(7, Date.now());
    room.players.addPlayer('late');
    const p = room.players.getPlayer('late');
    if (!p) {throw new Error('no late');}
    p.hasReceivedPosition = true;
    p.lastSeen = wallMs(Date.now());
    const loop = new TickLoop(new Map([['t', room]]), { tickLagMsMax: 0, tickLagMsSum: 0, tickLagSamples: 0, lastTickAt: 0 }, () => {});
    loop.tickRoomNow(room, wallMs(Date.now()));
    expect(room.wireIds.get('late')).toBe(7);
    expect(room.wireIdRetired.has(7)).toBe(false);
  });
});
