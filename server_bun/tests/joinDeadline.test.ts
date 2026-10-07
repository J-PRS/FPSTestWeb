import { describe, it, expect, afterEach } from 'bun:test';
import { GameServer } from '../src/GameServer.ts';
import { CONFIG } from '../src/config.ts';

function fakeWs() {
  return {
    data: {} as { playerId?: string },
    sent: [] as string[],
    closed: [] as (number | string)[],
    send(m: unknown) { this.sent.push(JSON.stringify(m)); },
    close(code?: number, reason?: string) { this.closed.push(code ?? 1000, reason ?? ''); this.readyState = 3; },
    readyState: 1,
    remoteAddress: 'test',
  };
}

interface Peek { tickLoop: { stop(): void } }

// A socket that connects but never joins must not sit forever — the
// onOpen deadline closes it. CONFIG.joinTimeoutMs is the same knob the
// prod path reads; the test just shrinks the window.
describe('join deadline', () => {
  const orig = CONFIG.joinTimeoutMs;
  afterEach(() => {
    (CONFIG as unknown as { joinTimeoutMs: number }).joinTimeoutMs = orig;
  });

  it('closes a socket that never completes the handshake', async () => {
    (CONFIG as unknown as { joinTimeoutMs: number }).joinTimeoutMs = 30;
    const gs = new GameServer();
    const peek = gs as unknown as Peek;
    try {
      const ws = fakeWs();
      gs.onOpen(ws as never);
      await new Promise(r => setTimeout(r, 60));
      expect(ws.closed).toEqual([1000, 'join timeout']);
    } finally {
      peek.tickLoop.stop();
    }
  });

  it('leaves a socket that joined in time alone', async () => {
    (CONFIG as unknown as { joinTimeoutMs: number }).joinTimeoutMs = 30;
    const gs = new GameServer();
    const peek = gs as unknown as Peek;
    try {
      const ws = fakeWs();
      gs.onOpen(ws as never);
      ws.data.playerId = 'p1';
      await new Promise(r => setTimeout(r, 60));
      expect(ws.closed.length).toBe(0);
    } finally {
      peek.tickLoop.stop();
    }
  });
});
