import { describe, it, expect } from 'bun:test';
import { GameServer } from '../src/GameServer.ts';

function fakeWs(ip: string) {
  return {
    data: { clientIp: ip } as { playerId?: string; clientIp?: string; connectedAt: number },
    sent: [] as string[],
    send(m: unknown) { this.sent.push(JSON.stringify(m)); },
    close() { this.readyState = 3; },
    readyState: 1,
    remoteAddress: ip,
  };
}

interface Peek { tickLoop: { stop(): void } }

// The unseated-join cap is per source IP. A flat 8 locks out school/cafe
// NATs at a join spike; proven egress (IPs that completed joins) earns
// headroom up to 64. Drive seats through onOpen + a post-join message —
// the ping early-return in onJsonText is what actually calls leavePending.
describe('unseated-join cap', () => {
  it('proven egress earns pending headroom; fresh IPs keep the flood cap', () => {
    const gs = new GameServer();
    const peek = gs as unknown as Peek;
    try {
      // Fill the flat cap from a fresh IP — the 9th unseated socket 429s.
      const seats = Array.from({ length: 8 }, () => fakeWs('nat'));
      for (const ws of seats) { gs.onOpen(ws as never); }
      expect(gs.unseatAllow('nat')).toBe(false);

      // Seat all eight: the ledger drains and the IP proves itself.
      for (const ws of seats) {
        ws.data.playerId = `p${seats.indexOf(ws)}`;
        gs.onMessage(ws as never, '{"type":"ping"}');
      }
      expect(gs.unseatAllow('nat')).toBe(true);

      // Headroom is earned, not infinite: 8 proven + 8 base = 16 pending.
      for (let i = 0; i < 16; i += 1) { gs.onOpen(fakeWs('nat') as never); }
      expect(gs.unseatAllow('nat')).toBe(false);

      // A stranger IP is still on the flood cap.
      for (let i = 0; i < 8; i += 1) { gs.onOpen(fakeWs('stranger') as never); }
      expect(gs.unseatAllow('stranger')).toBe(false);
    } finally {
      peek.tickLoop.stop();
    }
  });
});
