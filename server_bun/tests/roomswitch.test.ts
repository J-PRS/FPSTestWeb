import { describe, it, expect, afterEach } from 'bun:test';
import { GameServer } from '../src/GameServer.ts';
import { CONFIG } from '../src/config.ts';

/** Minimal ServerWebSocket stand-in — captures every send so the test
 *  can assert the new room's gameState actually reached the wire. */
function fakeWs() {
  const sent: string[] = [];
  return {
    sent,
    data: {} as { playerId?: string },
    remoteAddress: '127.0.0.1',
    readyState: 1,
    send(m: string) { sent.push(m); return m.length; },
    close() { /* test double */ },
    // oxlint-disable-next-line no-explicit-any
  } as any;
}

const gameStates = (ws: ReturnType<typeof fakeWs>) =>
  ws.sent.map((s: string) => JSON.parse(s) as { type: string; room?: string })
    .filter((m: { type: string; room?: string }) => m.type === 'gameState');

describe('switchRoom', () => {
  let gs: GameServer;
  afterEach(() => gs.stop());

  it('moves the session to the target room and answers with a fresh gameState', () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'ctf-room' }));
    const rooms = (gs as unknown as { rooms: Map<string, { players: { getPlayer(id: string): unknown } }> }).rooms;
    expect(rooms.get('ctf-room')?.players.getPlayer('p1')).toBeTruthy();
    expect(gameStates(ws).at(-1)?.room).toBe('ctf-room');

    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'dm-room' }));

    expect(rooms.get('ctf-room')?.players.getPlayer('p1')).toBeUndefined();
    expect(rooms.get('dm-room')?.players.getPlayer('p1')).toBeTruthy();
    const gs2 = gameStates(ws).at(-1)!;
    expect(gs2.room).toBe('dm-room');
  });

  it('dead players cannot hop — that would dodge the respawn delay', () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'a' }));
    const rooms = (gs as unknown as { rooms: Map<string, { players: { getPlayer(id: string): { isDead: boolean } | undefined } }> }).rooms;
    rooms.get('a')!.players.getPlayer('p1')!.isDead = true;
    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'b' }));
    expect(rooms.get('a')?.players.getPlayer('p1')).toBeTruthy();
    expect(rooms.get('b')?.players.getPlayer('p1')).toBeUndefined();
    expect(ws.sent.some((s: string) => s.includes('matchNotice'))).toBe(true);
  });

  it('is a no-op for the current room', () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1' }));
    const before = gameStates(ws).length;
    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'default' }));
    expect(gameStates(ws).length).toBe(before);
  });

  it('the hop cooldown refuses a second hop inside the window', () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'a' }));
    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'b' }));
    // Second hop lands inside 1500ms — denied. Name-spam at message rate
    // must not mint/churn rooms via roomFor.
    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'c' }));
    const rooms = (gs as unknown as { rooms: Map<string, { players: { getPlayer(id: string): unknown } }> }).rooms;
    expect(rooms.get('b')?.players.getPlayer('p1')).toBeTruthy();
    expect(rooms.get('c')?.players.getPlayer('p1')).toBeUndefined();

    // The cooldown is per-player — someone else hops freely.
    const ws2 = fakeWs();
    gs.onMessage(ws2, JSON.stringify({ type: 'join', playerId: 'p2', room: 'a' }));
    gs.onMessage(ws2, JSON.stringify({ type: 'switchRoom', room: 'c' }));
    expect(rooms.get('c')?.players.getPlayer('p2')).toBeTruthy();
  });

  it('refuses a hop when spectators fill the global budget', () => {
    // Spectators draw the same tick stream as players — a watcher fleet
    // must not leave headroom the per-room caps claim is free.
    (CONFIG as unknown as { globalMaxPlayers: number }).globalMaxPlayers = 2;
    try {
      gs = new GameServer();
      const spec = fakeWs();
      gs.onMessage(spec, JSON.stringify({ type: 'join', playerId: 'w1', room: 'watch', spectate: true }));
      const ws = fakeWs();
      gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'a' }));
      // budget: 1 player + 1 spectator = 2, at cap — the hop must deny.
      gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'b' }));
      const rooms = (gs as unknown as { rooms: Map<string, { players: { getPlayer(id: string): unknown } }> }).rooms;
      expect(rooms.get('a')?.players.getPlayer('p1')).toBeTruthy();
      expect(rooms.get('b')?.players.getPlayer('p1')).toBeUndefined();
      expect(ws.sent.some((s: string) => s.includes('is full'))).toBe(true);
    } finally {
      (CONFIG as unknown as { globalMaxPlayers: number }).globalMaxPlayers = 128;
    }
  });

  it('reconnect tokens survive the hop — reclaim works in the new room', () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'a' }));
    const tok = (gameStates(ws).at(-1) as unknown as { sessionToken?: string }).sessionToken;
    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'b' }));
    // Simulated socket death: the new room must accept a reclaim with the
    // same identity token it re-issued at hop time.
    (gs as unknown as { registry: { disconnect(id: string, reason: string, ms: number, cb: () => void): boolean } })
      .registry.disconnect('p1', 'simulated socket death', 60000, () => {});
    const ws2 = fakeWs();
    gs.onMessage(ws2, JSON.stringify({ type: 'join', playerId: 'p1', token: tok }));
    expect(ws2.data.playerId).toBe('p1');
    expect(gameStates(ws2).length).toBeGreaterThan(0);
  });

  it('a bot-only room adopts a new joiner\'s sim gates instead of warning', () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'r', bots: 2 }));
    const rooms = (gs as unknown as { rooms: Map<string, {
      noBalls: boolean;
      ballSim: { population: { base: number }; balls: Map<number, unknown> };
      players: { getHumanCount(): number };
    }> }).rooms;
    const room = rooms.get('r')!;
    expect(room.noBalls).toBe(false);

    // p1 hops away — 'r' keeps its bots but has no humans left.
    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'other' }));
    expect(room.players.getHumanCount()).toBe(0);

    const ws2 = fakeWs();
    gs.onMessage(ws2, JSON.stringify({ type: 'join', playerId: 'p2', room: 'r', noBalls: true }));
    expect(room.noBalls).toBe(true);
    expect(room.ballSim.population.base).toBe(0);
    expect(room.ballSim.balls.size).toBe(0);
    expect(ws2.sent.some((s: string) => s.includes('serverWarn'))).toBe(false);
  });

  it('a human-occupied room keeps its gates and warns the mismatched joiner', () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'r' }));
    const rooms = (gs as unknown as { rooms: Map<string, { noBalls: boolean }> }).rooms;

    const ws2 = fakeWs();
    gs.onMessage(ws2, JSON.stringify({ type: 'join', playerId: 'p2', room: 'r', noBalls: true }));
    expect(rooms.get('r')!.noBalls).toBe(false);
    expect(ws2.sent.some((s: string) => s.includes('serverWarn'))).toBe(true);
  });
});
