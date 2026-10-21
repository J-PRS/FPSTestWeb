import { describe, it, expect } from 'bun:test';
import { GameServer } from '../src/GameServer.ts';
import type { Room } from '../src/Room.ts';

// The zombie-seat repro: headless soaks showed the seat that MINTS a room
// goes blind (gameState lands, then nothing — no ping, no broadcasts)
// while every later joiner sees the full wire. Drive the real
// GameServer.onMessage + tickRoomGuarded path with two fake sockets —
// if seat 1's wire is dark after ticks while seat 2's isn't, the bug is
// in the mint path, not the transport.
interface Peek {
  rooms: Map<string, Room>;
  tickLoop: { stop(): void; tickRoomGuarded(room: Room, now?: number): void };
}
const fakeWs = () => ({
  sent: [] as unknown[], data: {} as { playerId?: string }, remoteAddress: '127.0.0.1', readyState: 1,
  send(m: string | Uint8Array) { this.sent.push(m); return typeof m === 'string' ? m.length : m.byteLength; }, close() {},
// oxlint-disable-next-line no-explicit-any
} as any);
const types = (ws: { sent: unknown[] }): Set<string> =>
  new Set(ws.sent.filter((s): s is string => typeof s === 'string').map((s): string => (JSON.parse(s) as { type: string }).type));

describe('first-seat wire vitality', () => {
  it('the minting seat receives the same keepalives/broadcasts as later seats', async () => {
    const gs = new GameServer();
    const peek = gs as unknown as Peek;
    try {
      const ws1 = fakeWs();
      const ws2 = fakeWs();
      gs.onMessage(ws1, JSON.stringify({ type: 'join', playerId: 'seat1', room: 'mintme', mode: 'headhunt', map: 'rimrock', bots: 4 }));
      // terrainReady defers seat() past a microtask — flush it.
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      gs.onMessage(ws2, JSON.stringify({ type: 'join', playerId: 'seat2', room: 'mintme', mode: 'headhunt', map: 'rimrock' }));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      const room = peek.rooms.get('mintme');
      expect(room).toBeTruthy();
      // finishJoin waits on terrainReady (async map-file load) — await it
      // for real or the seats never register.
      await room!.terrainReady;
      await Promise.resolve(); await Promise.resolve();
      console.log(`conns=${room!.connections.getConnectionCount()} players=${room!.playerCount()} s1=${room!.players.getPlayer('seat1') ? 'in' : 'MISSING'} s2=${room!.players.getPlayer('seat2') ? 'in' : 'MISSING'}`);
      ws1.sent.length = 0;
      ws2.sent.length = 0; // drop the join bursts — measure live traffic only
      for (let i = 0; i < 60; i += 1) {peek.tickLoop.tickRoomGuarded(room!);}
      const t1 = types(ws1);
      const t2 = types(ws2);
      console.log(`seat1 types: ${[...t1].sort().join(',')} | seat2 types: ${[...t2].sort().join(',')}`);
      expect(t1.has('ping')).toBe(true);
      expect(t1.has('projectileCreated') || t2.has('projectileCreated')).toBe(true);
      if (t2.has('projectileCreated')) {expect(t1.has('projectileCreated')).toBe(true);}
    } finally {
      peek.tickLoop.stop();
    }
  });
});
