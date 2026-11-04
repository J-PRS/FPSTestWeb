import { describe, it, expect } from 'bun:test';
import { GameServer } from '../src/GameServer.ts';
import type { Room } from '../src/Room.ts';
import { iterBatch, decodeWireJson } from '../../shared/wire.ts';

// The zombie-seat regression: a room minted for a terrain map defers
// seat() on terrainReady (async Bun.file load). During the deferral the
// room reads `empty` (no players yet), so the 50ms empty-room sweep
// disposed it BEFORE the joiner seated — the deferred finishJoin then
// registered the socket into a Room no longer in gs.rooms: join burst
// lands, then no ticks/events/keepalives ever reach the seat while the
// socket looks connected (the 75s inputSync-trickle soaks).
interface Peek {
  rooms: Map<string, Room>;
  tickLoop: { stop(): void; tickRoomGuarded(room: Room, now?: number): void };
}
const fakeWs = () => ({
  sent: [] as unknown[], data: {} as { playerId?: string }, remoteAddress: '127.0.0.1', readyState: 1,
  // uWS copies a sent frame synchronously — the mock must too: outbound
  // batches are VIEWS into connections' shared batchScratch arena, so a
  // retained reference silently rewrites to the NEXT tick's batch
  // (the firstSeat flake: ping batches morphed into pingless ones).
  send(m: string | Uint8Array) { this.sent.push(typeof m === 'string' ? m : m.slice()); return typeof m === 'string' ? m.length : m.byteLength; }, close() {},
// oxlint-disable-next-line no-explicit-any
} as any);
// Decode what a real client sees: live traffic arrives as WIRE_BATCH
// (tick-frame coalescing) whose reliable events ride WIRE_JSON subframes.
const types = (ws: { sent: unknown[] }): Set<string> => {
  const out = new Set<string>();
  const feed = (s: unknown): void => {
    if (typeof s === 'string') {out.add((JSON.parse(s) as { type: string }).type); return;}
    const u8 = s as Uint8Array;
    if (u8[0] !== 0x54) {return;}
    if (u8[1] === 0x0D) {for (const sub of iterBatch(u8)) {feed(sub);} return;}
    if (u8[1] === 0x09) {const t = decodeWireJson(u8); if (t) {feed(t);}}
  };
  for (const s of ws.sent) {feed(s);}
  return out;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('first-seat wire vitality', () => {
  it('the minting seat receives the same keepalives/broadcasts as later seats', async () => {
    const gs = new GameServer();
    const peek = gs as unknown as Peek;
    try {
      const ws1 = fakeWs();
      const ws2 = fakeWs();
      gs.onMessage(ws1, JSON.stringify({ type: 'join', playerId: 'seat1', room: 'mintme', mode: 'headhunt', map: 'rimrock', bots: 4 }));
      gs.onMessage(ws2, JSON.stringify({ type: 'join', playerId: 'seat2', room: 'mintme', mode: 'headhunt', map: 'rimrock' }));
      const room = peek.rooms.get('mintme');
      expect(room).toBeTruthy();
      // finishJoin waits on terrainReady (async map-file load) — await it
      // for real or the seats never register.
      await room!.terrainReady;
      // Registration rides a deferred continuation past the file load —
      // a fixed flush count races it (~25% flake): pings pushed to an
      // unregistered pid queue then silently drop at flushOutboxes
      // (q cleared even with no ws). joinDone exposes the real settle.
      await Promise.all([room!.joinDone.get('seat1'), room!.joinDone.get('seat2')]);
      console.log(`conns=${room!.connections.getConnectionCount()} players=${room!.playerCount()} s1=${room!.players.getPlayer('seat1') ? 'in' : 'MISSING'} s2=${room!.players.getPlayer('seat2') ? 'in' : 'MISSING'}`);
      ws1.sent.length = 0;
      ws2.sent.length = 0; // drop the join bursts — measure live traffic only
      for (let i = 0; i < 60; i += 1) {peek.tickLoop.tickRoomGuarded(room!);}
      const t1 = types(ws1);
      const t2 = types(ws2);
      console.log(`seat1 types: ${[...t1].sort().join(',')} | seat2 types: ${[...t2].sort().join(',')}`);
      expect(t1.has('ping')).toBe(true);
      if (t2.has('projectileCreated')) {expect(t1.has('projectileCreated')).toBe(true);}
    } finally {
      peek.tickLoop.stop();
    }
  });

  it('a terrain-map room survives the empty sweep while its first join waits on terrainReady', async () => {
    const gs = new GameServer();
    const peek = gs as unknown as Peek;
    try {
      const ws = fakeWs();
      gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'terra', mode: 'headhunt', map: 'rimrock', bots: 4 }));
      const room = peek.rooms.get('terra');
      expect(room).toBeTruthy();
      // The seat is deferred on terrainReady — the room is empty RIGHT
      // NOW. The sweep must not dispose it (this is the whole bug).
      if (room!.terrainReady) {expect(room!.empty).toBe(false);}
      // Give the real 50ms tick loop + the async terrain load time to run.
      // pingTick is ~500ms per human — seat lands mid-window, so budget
      // past one full cadence instead of racing it.
      await sleep(1500);
      expect(peek.rooms.has('terra')).toBe(true);
      const t = types(ws);
      expect(t.has('gameState')).toBe(true);
      // Post-join keepalives must flow — a seat that only ever got the
      // burst is the zombie signature.
      expect(t.has('ping') || t.has('stateHash') || t.has('srvPing')).toBe(true);
    } finally {
      peek.tickLoop.stop();
    }
  });

  it('a room hop mid-terrain-load seats the NEWER room only — deferred join is stale-checked', async () => {
    const gs = new GameServer();
    const peek = gs as unknown as Peek;
    try {
      const ws = fakeWs();
      // Join A: mints the room, finishJoin defers on terrainReady.
      gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'hopper', room: 'hopA', mode: 'headhunt', map: 'rimrock', bots: 1 }));
      // Hop to B before A's terrain resolves — begin() re-points the
      // session at hopB; A's deferred seat must NOT fire (it would
      // register the socket into the corpse room = the zombie seat).
      gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'hopper', room: 'hopB', mode: 'headhunt', map: 'rimrock', bots: 1 }));
      await sleep(1500);
      const a = peek.rooms.get('hopA');
      const b = peek.rooms.get('hopB');
      const dbg = `a=${a ? `players:${a.playerCount()}` : 'gone'} b=${b ? `players:${b.playerCount()}` : 'gone'}`;
      expect(dbg, dbg).toContain('b=players:1');
      expect(a?.playerCount() ?? 0).toBe(0);
      const t = types(ws);
      expect(t.has('gameState')).toBe(true);
      expect(t.has('ping') || t.has('stateHash') || t.has('srvPing')).toBe(true);
    } finally {
      peek.tickLoop.stop();
    }
  });
});
