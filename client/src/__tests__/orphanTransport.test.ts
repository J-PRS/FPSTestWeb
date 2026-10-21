import { describe, it, expect, vi, afterEach } from 'vitest';
import { NetworkManager } from '../networking/NetworkManager.js';

/* oxlint-disable typescript/no-explicit-any -- driving private lifecycle for a regression test */

// Regression: the stall watchdog's outer-reconnect path did `ws = null`
// WITHOUT disconnect() — an abandoned transport's inner auto-reconnect
// loop kept reopening sockets with callbacks still bound, so phantom
// joins fought the live session for the seat and phantom closes tore
// down roster/ledger state (observed: join-timeout flap every ~18s).
describe('checkStall outer reconnect', (): void => {
  afterEach((): void => { vi.useRealTimers(); });

  it('disconnects the dead transport before replacing it', (): void => {
    vi.useFakeTimers();
    const transports: { disconnect: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }[] = [];
    const factory = (cfg: Record<string, unknown>): unknown => {
      const t = {
        cfg,
        tier: 'ws',
        ownsPing: false,
        probe: { lastRxAt: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
        connected: (): boolean => false, // dead lane — never fires onConnect
        send: vi.fn(),
      };
      transports.push(t);
      return t;
    };

    const nm = new NetworkManager();
    nm.setPlayerId('tester-local');
    // connect() resolves only inside onConnect — never fires here, which is
    // the point: the transport looks dead, the watchdog must still kill it.
    void nm.connect('ws://x', factory as never).catch((): void => { return; });

    // ~11s of watchdog ticks — deadSince arms on the first, outer
    // reconnect fires at the 10s mark.
    vi.advanceTimersByTime(11_000);

    expect(transports.length).toBe(2);
    expect(transports[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(transports[1]!.connect).toHaveBeenCalledTimes(1);
    nm.disconnect();
  });
});
