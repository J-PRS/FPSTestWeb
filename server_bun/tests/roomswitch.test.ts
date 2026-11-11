import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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
  ws.sent.filter((s: unknown): s is string => typeof s === 'string')
    .map((s: string) => JSON.parse(s) as { type: string; room?: string })
    .filter((m: { type: string; room?: string }) => m.type === 'gameState');

describe('switchRoom', () => {
  let gs: GameServer;
  // Gate-adoption tests exercise balls, which the server disables by default.
  const cfg = CONFIG as unknown as { allowBalls: boolean; allowCreatures: boolean };
  const prevGates = { balls: cfg.allowBalls, creatures: cfg.allowCreatures };
  beforeEach(() => { cfg.allowBalls = true; cfg.allowCreatures = true; });
  afterEach(() => { cfg.allowBalls = prevGates.balls; cfg.allowCreatures = prevGates.creatures; gs.stop(); });

  // Join + hop both defer the seat on terrainReady (async map load) —
  // assertions need the room's ready promise first. The room itself is
  // minted lazily by the deferred hop, so `rooms.get` can still miss when
  // this runs — poll for its existence before awaiting readiness, or the
  // settle check resolves against a room that was never created (the
  // reclaim flake: disconnect raced the hop).
  const awaitSeat = async (rooms: Map<string, { terrainReady?: Promise<unknown> }>, name: string): Promise<void> => {
    for (let i = 0; i < 200 && !rooms.has(name); i++) {await new Promise((r): NodeJS.Timeout => setTimeout(r, 10));}
    await rooms.get(name)?.terrainReady;
  };

  it('moves the session to the target room and answers with a fresh gameState', async () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'ctf-room', mode: 'ctf' }));
    const {rooms} = (gs as unknown as { rooms: Map<string, { terrainReady?: Promise<unknown>; players: { getPlayer(id: string): unknown } }> });
    await awaitSeat(rooms, 'ctf-room');
    expect(rooms.get('ctf-room')?.players.getPlayer('p1')).toBeTruthy();
    expect(gameStates(ws).at(-1)?.room).toBe('ctf-room');

    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'dm-room' }));
    await awaitSeat(rooms, 'dm-room');

    expect(rooms.get('ctf-room')?.players.getPlayer('p1')).toBeUndefined();
    expect(rooms.get('dm-room')?.players.getPlayer('p1')).toBeTruthy();
    const gs2 = gameStates(ws).at(-1)!;
    expect(gs2.room).toBe('dm-room');
  });

  it('dead players cannot hop — that would dodge the respawn delay', async () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'a', mode: 'dm' }));
    const {rooms} = (gs as unknown as { rooms: Map<string, { terrainReady?: Promise<unknown>; players: { getPlayer(id: string): { isDead: boolean } | undefined } }> });
    await awaitSeat(rooms, 'a');
    rooms.get('a')!.players.getPlayer('p1')!.isDead = true;
    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'b' }));
    expect(rooms.get('a')?.players.getPlayer('p1')).toBeTruthy();
    expect(rooms.get('b')?.players.getPlayer('p1')).toBeUndefined();
    expect(ws.sent.some((s: string) => s.includes('matchNotice'))).toBe(true);
  });

  it('is a no-op for the current room', async () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'default', mode: 'dm' }));
    const {rooms} = (gs as unknown as { rooms: Map<string, { terrainReady?: Promise<unknown> }> });
    await awaitSeat(rooms, 'default');
    const before = gameStates(ws).length;
    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'default' }));
    expect(gameStates(ws).length).toBe(before);
  });

  it('the hop cooldown refuses a second hop inside the window', async () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'a', mode: 'dm' }));
    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'b' }));
    // Second hop lands inside 1500ms — denied. Name-spam at message rate
    // must not mint/churn rooms via roomFor.
    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'c' }));
    const {rooms} = (gs as unknown as { rooms: Map<string, { terrainReady?: Promise<unknown>; players: { getPlayer(id: string): unknown } }> });
    await awaitSeat(rooms, 'b');
    expect(rooms.get('b')?.players.getPlayer('p1')).toBeTruthy();
    expect(rooms.get('c')?.players.getPlayer('p1')).toBeUndefined();

    // The cooldown is per-player — someone else hops freely.
    const ws2 = fakeWs();
    gs.onMessage(ws2, JSON.stringify({ type: 'join', playerId: 'p2', room: 'a', mode: 'dm' }));
    await awaitSeat(rooms, 'a');
    gs.onMessage(ws2, JSON.stringify({ type: 'switchRoom', room: 'c' }));
    await awaitSeat(rooms, 'c');
    expect(rooms.get('c')?.players.getPlayer('p2')).toBeTruthy();
  });

  it('refuses a hop when spectators fill the global budget', async () => {
    // Spectators draw the same tick stream as players — a watcher fleet
    // must not leave headroom the per-room caps claim is free.
    (CONFIG as unknown as { globalMaxPlayers: number }).globalMaxPlayers = 2;
    try {
      gs = new GameServer();
      const spec = fakeWs();
      gs.onMessage(spec, JSON.stringify({ type: 'join', playerId: 'w1', room: 'watch', spectate: true, mode: 'dm' }));
      const ws = fakeWs();
      gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'a', mode: 'dm' }));
      const {rooms} = (gs as unknown as { rooms: Map<string, { terrainReady?: Promise<unknown>; players: { getPlayer(id: string): unknown } }> });
      await awaitSeat(rooms, 'a');
      // budget: 1 player + 1 spectator = 2, at cap — the hop must deny.
      gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'b' }));
      expect(rooms.get('a')?.players.getPlayer('p1')).toBeTruthy();
      expect(rooms.get('b')?.players.getPlayer('p1')).toBeUndefined();
      expect(ws.sent.some((s: string) => s.includes('is full'))).toBe(true);
    } finally {
      (CONFIG as unknown as { globalMaxPlayers: number }).globalMaxPlayers = 128;
    }
  });

  it('reconnect tokens survive the hop — reclaim works in the new room', async () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'a', mode: 'dm' }));
    const {rooms} = (gs as unknown as { rooms: Map<string, { terrainReady?: Promise<unknown> }> });
    await awaitSeat(rooms, 'a');
    const tok = (gameStates(ws).at(-1) as unknown as { sessionToken?: string }).sessionToken;
    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'b' }));
    await awaitSeat(rooms, 'b');
    // Simulated socket death: the new room must accept a reclaim with the
    // same identity token it re-issued at hop time.
    (gs as unknown as { registry: { disconnect(id: string, reason: string, ms: number, cb: () => void): boolean } })
      .registry.disconnect('p1', 'simulated socket death', 60_000, () => {});
    const ws2 = fakeWs();
    gs.onMessage(ws2, JSON.stringify({ type: 'join', playerId: 'p1', token: tok }));
    expect(ws2.data.playerId).toBe('p1');
    // The reclaim can take the different-room path (join carries no room →
    // 'default' while the grace seat is in 'b'): the retired seat falls
    // through to a normal join, which defers on terrainReady — under suite
    // load the gameState lands after this line, so poll for it.
    for (let i = 0; i < 200 && gameStates(ws2).length === 0; i++) {await new Promise((r): NodeJS.Timeout => setTimeout(r, 10));}
    expect(gameStates(ws2).length).toBeGreaterThan(0);
  });

  it('a bot-only room adopts a new joiner\'s sim gates instead of warning', async () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'r', bots: 2 }));
    const {rooms} = (gs as unknown as { rooms: Map<string, {
      terrainReady?: Promise<unknown>;
      mods: { noBalls?: boolean };
      ballSim: { population: { base: number }; balls: Map<number, unknown> };
      players: { getHumanCount(): number };
    }> });
    await awaitSeat(rooms, 'r');
    const room = rooms.get('r')!;
    expect(room.mods.noBalls).toBeUndefined();

    // p1 hops away — 'r' keeps its bots but has no humans left.
    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'other' }));
    expect(room.players.getHumanCount()).toBe(0);

    const ws2 = fakeWs();
    gs.onMessage(ws2, JSON.stringify({ type: 'join', playerId: 'p2', room: 'r', noBalls: true }));
    await awaitSeat(rooms, 'r');
    expect(room.mods.noBalls).toBe(true);
    expect(room.ballSim.population.base).toBe(0);
    expect(room.ballSim.balls.size).toBe(0);
    expect(ws2.sent.some((s: string) => s.includes('serverWarn'))).toBe(false);
  });

  it('a bot-only room remints under a hosted mode mismatch', async () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'r', mode: 'nuggets', bots: 2 }));
    const {rooms} = (gs as unknown as { rooms: Map<string, {
      terrainReady?: Promise<unknown>;
      mode: string;
      players: { getHumanCount(): number };
    }> });
    await awaitSeat(rooms, 'r');
    const stale = rooms.get('r')!;
    expect(stale.mode).toBe('nuggets');

    // p1 hops away — 'r' is bot-only residue, nothing's being played.
    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'other' }));
    expect(stale.players.getHumanCount()).toBe(0);

    const ws2 = fakeWs();
    gs.onMessage(ws2, JSON.stringify({ type: 'join', playerId: 'p2', room: 'r', mode: 'ctf' }));
    await awaitSeat(rooms, 'r');
    expect(rooms.get('r')).not.toBe(stale); // reminted, not absorbed
    expect(rooms.get('r')!.mode).toBe('ctf');
    expect(ws2.sent.some((s: string) => s.includes('settings overridden'))).toBe(false);
  });

  it('a human-occupied room keeps its mode and warns the mismatched joiner', async () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'r', mode: 'nuggets' }));
    const {rooms} = (gs as unknown as { rooms: Map<string, { terrainReady?: Promise<unknown>; mode: string }> });
    await awaitSeat(rooms, 'r');

    const ws2 = fakeWs();
    gs.onMessage(ws2, JSON.stringify({ type: 'join', playerId: 'p2', room: 'r', mode: 'ctf' }));
    await awaitSeat(rooms, 'r');
    expect(rooms.get('r')!.mode).toBe('nuggets');
    expect(ws2.sent.some((s: string) => s.includes('serverWarn'))).toBe(true);
  });

  it('a human-occupied room keeps its gates and warns the mismatched joiner', async () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'r', mode: 'dm' }));
    const {rooms} = (gs as unknown as { rooms: Map<string, { terrainReady?: Promise<unknown>; mods: { noBalls?: boolean } }> });
    await awaitSeat(rooms, 'r');

    const ws2 = fakeWs();
    gs.onMessage(ws2, JSON.stringify({ type: 'join', playerId: 'p2', room: 'r', noBalls: true }));
    await awaitSeat(rooms, 'r');
    expect(rooms.get('r')!.mods.noBalls).toBeUndefined();
    expect(ws2.sent.some((s: string) => s.includes('serverWarn'))).toBe(true);
  });
});
