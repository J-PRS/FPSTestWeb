import { describe, it, expect, afterEach } from 'bun:test';
import { GameServer } from '../src/GameServer.ts';
import { CONFIG } from '../src/config.ts';
import type { Room } from '../src/Room.ts';

function fakeWs() {
  return {
    data: {} as { playerId?: string },
    sent: [] as string[],
    send(d: string | ArrayBuffer) { this.sent.push(typeof d === 'string' ? d : new TextDecoder().decode(d)); },
    close() { /* no-op */ },
    readyState: 1,
  };
}

interface Peek {
  factory: { roomFor(name: string, mode?: string, map?: string, bots?: number, unlisted?: boolean): Room | null };
  rooms: Map<string, Room>;
  tickLoop: { stop(): void; tickErrStreak: Map<string, number>; tickQuarantined: Set<string> };
  playerRoom: Map<string, Room>;
  removePlayerCompletely(room: Room, playerId: string, reason: string): void;
}

// Room minting is join-driven — an attacker cycling fresh names grows
// `rooms` forever without the cap. The recycle keeps named-room
// semantics (an evicted room remints on next join) while bounding the
// map; only a roster of genuinely live rooms refuses new mints.
describe('room cap', () => {
  let gs: GameServer;
  const prevMax = CONFIG.maxRooms;
  afterEach(() => { ;(CONFIG as unknown as { maxRooms: number }).maxRooms = prevMax; gs?.stop(); });

  const mkServer = () => {
    gs = new GameServer();
    (gs as unknown as Peek).tickLoop.stop();
    return gs as unknown as Peek;
  };

  it('minting past the cap recycles the eldest audience-less room', () => {
    ;(CONFIG as unknown as { maxRooms: number }).maxRooms = 3;
    const peek = mkServer();
    // Boot-seeded standing lobbies share the rooms map but sit outside
    // the join-driven cap — count only join-driven rooms.
    const joinRooms = () => [...peek.rooms.values()].filter((r) => !r.standing).length;
    peek.factory.roomFor('a'); peek.factory.roomFor('b'); peek.factory.roomFor('c');
    expect(joinRooms()).toBe(3);

    const d = peek.factory.roomFor('d');
    expect(d).not.toBeNull();
    expect(peek.rooms.has('a')).toBe(false); // eldest empty room recycled
    expect(peek.rooms.has('d')).toBe(true);
    expect(joinRooms()).toBe(3);
  });

  it('a recycled room name remints fresh on the next join', () => {
    ;(CONFIG as unknown as { maxRooms: number }).maxRooms = 2;
    const peek = mkServer();
    peek.factory.roomFor('a'); peek.factory.roomFor('b'); peek.factory.roomFor('c');
    expect(peek.rooms.has('a')).toBe(false);

    // The name is free again — a later joiner gets a live room, not a
    // tombstone; nothing was lost by the eviction.
    expect(peek.factory.roomFor('a')).not.toBeNull();
    expect(peek.rooms.has('a')).toBe(true);
  });

  it('refuses a mint when every room has a live human audience', () => {
    ;(CONFIG as unknown as { maxRooms: number }).maxRooms = 2;
    const peek = mkServer();
    const a = peek.factory.roomFor('a')!;
    const b = peek.factory.roomFor('b')!;
    a.players.addPlayer('h1');
    b.players.addPlayer('h2');

    expect(peek.factory.roomFor('c')).toBeNull();
    // Live rooms are never evicted to make space.
    expect(peek.rooms.has('a')).toBe(true);
    expect(peek.rooms.has('b')).toBe(true);
  });

  it('recycling a room drains its respawn wall-timers', () => {
    ;(CONFIG as unknown as { maxRooms: number }).maxRooms = 2;
    const peek = mkServer();
    const a = peek.factory.roomFor('a')!;
    // A dead player in a room-forever-living world keeps a real
    // setTimeout armed; recycling without draining it fires playerRespawn
    // into a room nobody can reach.
    // Bot corpse — a human would keep 'a' live and correctly unrecyclable.
    a.players.addPlayer('b1', undefined, 'none', 'medium', true);
    a.players.getPlayer('b1')!.isDead = true;
    const resp = a.messages.combat.respawner as unknown as {
      schedule(id: string): void;
      timers: Map<string, unknown>;
    };
    resp.schedule('b1');
    expect(resp.timers.size).toBe(1);

    peek.factory.roomFor('b');
    peek.factory.roomFor('c'); // recycles 'a'
    expect(resp.timers.size).toBe(0);
  });

  it('player departure purges the playerRoom index too', async () => {
    // playerRoom lives on GameServer, above the room-level funnel §2.91
    // pins — a missed delete leaves roomOfPlayer answering a ghost id
    // with a stale room for the server's life.
    const peek = mkServer();
    const ws = fakeWs();
    gs.onOpen(ws as never);
    gs.onMessage(ws as never, JSON.stringify({ type: 'join', playerId: 'p1', room: 'default' }));
    // The seat defers on the joined room's map load — 'default' may
    // resolve to a different mint (preferHumans), so await all rooms.
    await Promise.all([...peek.rooms.values()].map((r) => r.terrainReady));
    const room = peek.playerRoom.get('p1')!;
    expect(room).toBeDefined();

    peek.removePlayerCompletely(room, 'p1', 'test');
    expect(peek.playerRoom.has('p1')).toBe(false);
  });

  it('a recycled name does not inherit the corpse\'s tick fault streak', () => {
    ;(CONFIG as unknown as { maxRooms: number }).maxRooms = 2;
    const peek = mkServer();
    peek.factory.roomFor('a');
    // Fault history is keyed by name — left over a recycle, the remint
    // starts one error away from quarantine (or born quarantined).
    peek.tickLoop.tickErrStreak.set('a', 4);
    peek.tickLoop.tickQuarantined.add('a');

    peek.factory.roomFor('b');
    peek.factory.roomFor('c'); // recycles 'a'

    expect(peek.tickLoop.tickErrStreak.has('a')).toBe(false);
    expect(peek.tickLoop.tickQuarantined.has('a')).toBe(false);
  });

  it('spectators count as audience — a watched room is not recyclable', () => {
    ;(CONFIG as unknown as { maxRooms: number }).maxRooms = 2;
    const peek = mkServer();
    const a = peek.factory.roomFor('a')!;
    a.spectators.add('watcher');
    peek.factory.roomFor('b');

    // 'b' (empty, no audience) recycles instead of watched 'a'.
    const c = peek.factory.roomFor('c');
    expect(c).not.toBeNull();
    expect(peek.rooms.has('a')).toBe(true);
    expect(peek.rooms.has('b')).toBe(false);
  });
});
