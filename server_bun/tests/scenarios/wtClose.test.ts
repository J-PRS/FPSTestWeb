import { describe, it, expect } from 'bun:test';
import { WtSocketAdapter } from '../../src/WtServer.ts';

// Locally-initiated close() can't assume the session re-enters through
// session.closed — without die() in close(), kicks and idle reaps never
// reach onClose and the player stays registered as a zombie forever.
describe('scenario: WT socket teardown', () => {
  function mockSession() {
    let closeCalls = 0;
    const session = {
      ready: new Promise<void>(() => {}),
      closed: new Promise<{ closeCode?: number }>(() => {}),
      close() { closeCalls++; },
      async sendDatagram() {},
      incomingDatagrams() {
        return (async function* () { await new Promise(() => {}); })() as AsyncIterable<Uint8Array>;
      },
      incomingBidirectionalStreams: new ReadableStream({ start() {} }),
      async createBidirectionalStream() { throw new Error('unimplemented'); },
    };
    return { session, closeCalls: () => closeCalls };
  }

  it('close() dies locally and reaches onClose', async () => {
    const { session, closeCalls } = mockSession();
    let closed = 0;
    const game = { onClose: () => closed++, onMessage: () => {} };
    const adapter = new WtSocketAdapter(session as never, game as never);
    adapter.close(1000, 'kick');
    expect(closeCalls()).toBe(1);
    expect(closed).toBe(1);
    expect(adapter.readyState).toBe(3);
    adapter.close(); // idempotent — die() guards on open
    expect(closed).toBe(1);
  });
});
