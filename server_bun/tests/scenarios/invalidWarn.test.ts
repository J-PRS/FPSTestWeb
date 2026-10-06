import { describe, expect, it } from 'bun:test';
import { GameServer } from '../../src/GameServer.ts';
import { logger } from '../../src/logger.ts';

// Malformed frames before a seat have no playerId — they share the
// 'prejoin' throttle key, so a flood of garbage sockets collapses to a
// single warn instead of one line per socket.
function fakeWs() {
  return {
    remoteAddress: '10.0.0.1',
    readyState: 1,
    data: {} as { playerId?: string },
    sent: [] as unknown[],
    send(d: string | ArrayBuffer | Uint8Array) {
      this.sent.push(typeof d === 'string' ? JSON.parse(d) : d);
    },
    close() { /* no-op */ },
  };
}
type FakeWs = ReturnType<typeof fakeWs>;
const asWs = (f: FakeWs) => f as never;

describe('scenario: pre-join malformed frames share the throttle', () => {
  it('junk from many sockets collapses to one warn', () => {
    const gs = new GameServer();
    (gs as unknown as { tickLoop: { stop(): void } }).tickLoop.stop();

    const warns: string[] = [];
    const orig = logger.warn;
    (logger as unknown as { warn: (m: string, d?: unknown) => void }).warn =
      (m: string) => { warns.push(m); };
    try {
      const ws1 = fakeWs(), ws2 = fakeWs(), ws3 = fakeWs();
      gs.onOpen(asWs(ws1)); gs.onOpen(asWs(ws2)); gs.onOpen(asWs(ws3));
      // Three different sockets, all pre-seat, all garbage JSON.
      gs.onMessage(asWs(ws1), 'not json at all');
      gs.onMessage(asWs(ws2), 'also not json');
      gs.onMessage(asWs(ws3), 'still garbage {');
      expect(warns.length).toBe(1);
    } finally {
      (logger as unknown as { warn: typeof orig }).warn = orig;
    }
  });

  it('onClose evicts the playerId throttle entry', () => {
    const gs = new GameServer();
    (gs as unknown as { tickLoop: { stop(): void } }).tickLoop.stop();
    const map = (gs as unknown as { invalidWarnAt: Map<string, number> }).invalidWarnAt;

    const ws = fakeWs();
    ws.data.playerId = 'p-leaver';
    gs.onOpen(asWs(ws));
    gs.onMessage(asWs(ws), 'garbage {');
    expect(map.has('p-leaver')).toBe(true);

    gs.onClose(asWs(ws));
    expect(map.has('p-leaver')).toBe(false);
  });
});
