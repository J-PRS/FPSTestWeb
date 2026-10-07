import { describe, it, expect, afterEach } from 'bun:test';
import { GameServer } from '../src/GameServer.ts';
import { CONFIG } from '../src/config.ts';
import type { Room } from '../src/Room.ts';

function fakeWs() {
  return {
    data: {} as { playerId?: string },
    sent: [] as string[],
    closed: [] as number[],
    send(d: string | ArrayBuffer) { this.sent.push(typeof d === 'string' ? d : new TextDecoder().decode(d)); },
    close(code?: number) { if (code !== undefined) this.closed.push(code); },
    readyState: 1,
  };
}

interface GamePeek {
  specRooms: Map<string, { name: string; spectators: Set<string>; connections: { isConnected(id: string): boolean } }>;
  rooms: Map<string, Room>;
  registry: { state(id: string): string | undefined };
  departSpectator(id: string, reason: string, closeCode?: number): boolean;
}

// Spectator exit must collapse every seat in one move — roster,
// connection, specRooms index, registry record — the same way
// removePlayerCompletely does for players. A store missed here
// resurrects a ghost seat the room keeps counting.
describe('departSpectator', () => {
  let gs: GameServer;
  afterEach(() => gs.stop());

  it('purges all four stores in one call', () => {
    gs = new GameServer();
    (gs as unknown as { tickLoop: { stop(): void } }).tickLoop.stop();
    const peek = gs as unknown as GamePeek;

    const ws = fakeWs();
    gs.onOpen(ws as never);
    gs.onMessage(ws as never, JSON.stringify({ type: 'join', playerId: 'watcher', room: 'default', spectate: true }));

    expect(peek.specRooms.has('watcher')).toBe(true);
    const room = peek.specRooms.get('watcher')!;
    expect(room.spectators.has('watcher')).toBe(true);
    expect(room.connections.isConnected('watcher')).toBe(true);

    expect(peek.departSpectator('watcher', 'test')).toBe(true);

    expect(peek.specRooms.has('watcher')).toBe(false);
    expect(room.spectators.has('watcher')).toBe(false);
    expect(room.connections.isConnected('watcher')).toBe(false);
    expect(peek.registry.state('watcher')).toBeUndefined();
  });

  it('is a no-op for a player seat — the player funnel owns those', () => {
    gs = new GameServer();
    (gs as unknown as { tickLoop: { stop(): void } }).tickLoop.stop();
    const peek = gs as unknown as GamePeek;

    const ws = fakeWs();
    gs.onOpen(ws as never);
    gs.onMessage(ws as never, JSON.stringify({ type: 'join', playerId: 'p1', room: 'default' }));

    // A playing seat is not in specRooms — departing it through the
    // spectator funnel must refuse rather than half-tear it down.
    expect(peek.departSpectator('p1', 'test')).toBe(false);
  });

  it('rejects a spectate join past the per-room spectator cap', () => {
    gs = new GameServer();
    (gs as unknown as { tickLoop: { stop(): void } }).tickLoop.stop();
    const peek = gs as unknown as GamePeek;

    // Fill the room's spectator seats to the cap — each seat is a socket,
    // a connection entry and a tick-fanout target, so the bound matters.
    const ws1 = fakeWs();
    gs.onOpen(ws1 as never);
    gs.onMessage(ws1 as never, JSON.stringify({ type: 'join', playerId: 'w1', room: 'default', spectate: true }));
    const room = peek.rooms.get('default')!;
    for (let i = 2; i <= CONFIG.maxPlayers; i++) room.spectators.add(`w${i}`);
    expect(room.spectators.size).toBe(CONFIG.maxPlayers);

    const ws2 = fakeWs();
    gs.onOpen(ws2 as never);
    gs.onMessage(ws2 as never, JSON.stringify({ type: 'join', playerId: 'over', room: 'default', spectate: true }));

    expect(ws2.closed).toContain(1013);
    expect(room.spectators.has('over')).toBe(false);
    expect(peek.specRooms.has('over')).toBe(false);
    expect(peek.registry.state('over')).toBeUndefined();
  });
});
