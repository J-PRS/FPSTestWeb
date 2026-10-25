import { describe, it, expect } from 'bun:test';
import { GameServer } from '../src/GameServer.ts';
import type { Room } from '../src/Room.ts';

interface Peek {
  factory: { roomFor(name: string): Room | null };
  rooms: Map<string, Room>;
  tickLoop: { stop(): void; tickRoomGuarded(room: Room, now?: number): void };
}
const fakeWs = () => ({
  sent: [] as string[], data: {} as { playerId?: string }, remoteAddress: '127.0.0.1', readyState: 1,
  send(m: string) { this.sent.push(m); return m.length; }, close() {},
// oxlint-disable-next-line no-explicit-any
} as any);

// An audience-less room must freeze — bots alone don't count as watchers,
// and a bot-only 'default' would sim creatures/balls forever. A joining
// human wakes it on the very next tick.
describe('room hibernation', () => {
  it('a room with no humans goes dormant; a joining human wakes it', async () => {
    const gs = new GameServer();
    const peek = gs as unknown as Peek;
    try {
      const room = peek.factory.roomFor('sleepy')!;
      peek.tickLoop.tickRoomGuarded(room);
      expect(room.creatureSim.dormant).toBe(true);
      expect(room.ballSim.dormant).toBe(true);

      const ws = fakeWs();
      // mode mints 'sleepy' (a bare join would quickRoom elsewhere); the
      // seat then defers on terrainReady before the human wakes the room.
      gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'sleepy', mode: 'dm' }));
      await room.terrainReady;
      peek.tickLoop.tickRoomGuarded(room);
      expect(room.creatureSim.dormant).toBe(false);
      expect(room.ballSim.dormant).toBe(false);
    } finally {
      peek.tickLoop.stop();
    }
  });
});
