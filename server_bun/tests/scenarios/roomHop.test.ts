import { describe, expect, it } from 'bun:test';
import { GameServer } from '../../src/GameServer.ts';

// Room-hop contract: same socket, new membership — the kit and any banked
// respawn edits ride along, dead players can't dodge the respawn delay by
// hopping, and hop spam is throttled. Drives the real onMessage dispatch,
// not internals, so the leave/seat wiring is what's under test.

function fakeWs() {
  return {
    remoteAddress: '10.0.0.1',
    readyState: 1,
    data: {} as { playerId?: string },
    closed: [] as { code: number; reason: string }[],
    sent: [] as unknown[],
    send(d: string | ArrayBuffer | Uint8Array) {
      this.sent.push(typeof d === 'string' ? JSON.parse(d) : d);
    },
    close(code: number, reason: string) { this.closed.push({ code, reason }); },
  };
}
type FakeWs = ReturnType<typeof fakeWs>;

const asWs = (f: FakeWs) => f as never;

function mkServer() {
  const gs = new GameServer();
  // The suite owns timing — don't let the real 20Hz loop race assertions.
  (gs as unknown as { tickLoop: { stop(): void } }).tickLoop.stop();
  return gs;
}

const send = (gs: GameServer, ws: FakeWs, msg: object) =>
  gs.onMessage(asWs(ws), JSON.stringify(msg));

function join(gs: GameServer, ws: FakeWs, id: string, room: string) {
  send(gs, ws, { type: 'join', playerId: id, room, mode: 'nuggets', perk: 'pathfinder', armorClass: 'light' });
}

// Minted rooms defer seating on terrainReady — poll it out. A cold field
// cache makes the first room's load outlive a bare microtask flush, so
// setTimeout(0) alone races the first assertion.
const settle = async (gs: GameServer, room: string, id: string) => {
  const r = rooms(gs).get(room);
  for (let i = 0; i < 200 && !(r?.players.getPlayer(id)); i++) {
    await new Promise(res => setTimeout(res, 1));
  }
};

const rooms = (gs: GameServer) => (gs as unknown as { rooms: Map<string, { players: { getPlayer(id: string): unknown } }> }).rooms;

describe('scenario: room hop', () => {
  it('moves the player — kit, team seat, and pending loadout ride along', async () => {
    const gs = mkServer();
    const ws = fakeWs();
    gs.onOpen(asWs(ws));
    join(gs, ws, 'p1', 'r1');
    await settle(gs, 'r1', 'p1');
    const from = rooms(gs).get('r1')!;
    const p1 = from.players.getPlayer('p1') as { pendingPerk?: string; armorClass?: string };
    p1.pendingPerk = 'sentinel';

    send(gs, ws, { type: 'switchRoom', room: 'r2' });
    await settle(gs, 'r2', 'p1');

    expect(from.players.getPlayer('p1')).toBeUndefined();
    const to = rooms(gs).get('r2')!;
    const reseated = to.players.getPlayer('p1') as { armorClass: string; pendingPerk?: string };
    expect(reseated.armorClass).toBe('light');
    expect(reseated.pendingPerk).toBe('sentinel');
    // New seat streams a fresh gameState so the client rebuilds.
    expect(ws.sent.some(m => (m as { type?: string }).type === 'gameState')).toBe(true);
  });

  it('denies a hop while dead — respawn delay is not skippable', async () => {
    const gs = mkServer();
    const ws = fakeWs();
    gs.onOpen(asWs(ws));
    join(gs, ws, 'p1', 'r1');
    await settle(gs, 'r1', 'p1');
    const from = rooms(gs).get('r1')!;
    (from.players.getPlayer('p1') as { isDead: boolean }).isDead = true;

    send(gs, ws, { type: 'switchRoom', room: 'r2' });
    await new Promise(r => setTimeout(r, 0)); // denied hop needs no re-seat — just the Respawning warn
    expect(from.players.getPlayer('p1')).toBeDefined();
    expect(ws.sent.some(m => (m as { text?: string }).text?.includes('Respawning'))).toBe(true);
  });

  it('throttles hop spam — second switch inside the cooldown is ignored', async () => {
    const gs = mkServer();
    const ws = fakeWs();
    gs.onOpen(asWs(ws));
    join(gs, ws, 'p1', 'r1');
    await settle(gs, 'r1', 'p1');

    send(gs, ws, { type: 'switchRoom', room: 'r2' });
    send(gs, ws, { type: 'switchRoom', room: 'r3' }); // inside 1.5s cooldown
    await settle(gs, 'r2', 'p1');
    expect(rooms(gs).get('r2')!.players.getPlayer('p1')).toBeDefined();
    expect(rooms(gs).get('r3')).toBeUndefined();
  });
});
