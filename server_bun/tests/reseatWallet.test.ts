import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { GameServer } from '../src/GameServer.ts';

/** Minimal ServerWebSocket stand-in — same shape as roomswitch.test.ts. */
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

/** Re-seat wallet: an F5 that lands on a still-live roster row must carry
 *  tokens/belt/score across the addPlayer swap — the wipe happens when
 *  reclaim fails and the seat path mints a fresh record over the old one. */
describe('reseatWallet', () => {
  let gs: GameServer;
  beforeEach(() => { gs = new GameServer(); });
  afterEach(() => { gs.stop(); });

  it('carries heldTokens/beltCharges/kills across a same-room re-seat', () => {
    const join = (): string => JSON.stringify({ type: 'join', playerId: 'p1', room: 'wallet-room', bots: 0 });
    gs.onMessage(fakeWs(), join());
    const {rooms} = (gs as unknown as { rooms: Map<string, { players: { getPlayer(id: string): { heldTokens: number; beltCharges: number; kills: number; deaths: number; streak: number; health: number; armor: number; charge: number } | undefined } }> });
    const room = rooms.get('wallet-room');
    expect(room).toBeTruthy();

    // Live the match a bit: tokens banked on body, belt partially spent,
    // a few frags in the ledger.
    const p = room!.players.getPlayer('p1')!;
    p.heldTokens = 7;
    p.beltCharges = 2;
    p.kills = 5;
    p.deaths = 3;
    p.streak = 4;
    p.health = 42;
    p.armor = 30;
    p.charge = 55;

    // F5: a fresh socket, same playerId, no token — the seat path, not
    // reclaim, so addPlayer runs over the live row.
    gs.onMessage(fakeWs(), join());

    const after = room!.players.getPlayer('p1')!;
    expect(after.heldTokens).toBe(7);
    expect(after.beltCharges).toBe(2);
    expect(after.kills).toBe(5);
    expect(after.deaths).toBe(3);
    expect(after.streak).toBe(4);
    expect(after.health).toBe(42);
    expect(after.armor).toBe(30);
    expect(after.charge).toBe(55);
  });
});
