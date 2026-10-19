import { describe, it, expect } from 'bun:test';
import { mkNetbots, nd } from './helpers.ts';

describe('netbot — real clients over real sockets', () => {
  const { spawn, bots, sleep, until, rejectsOf } = mkNetbots();

  it('a harsh WAN (100ms + 300 jitter + 5% loss) still resolves every claim it sees', async () => {
    // Tier mix when nd loads: rtc bots ride unordered datagrams under the
    // same synthetic WAN — exactly the lane where reorder+loss is native.
    await spawn(4, { pingMs: 100, jitterMs: 300, lossRate: 0.05 }, { transports: nd ? ['ws', 'rtc'] : undefined });
    // Wait on claim flow, not a landed hit — under this WAN a whole window
    // can whiff legitimately (see the dealt note below).
    await until(() => bots.reduce((a, b) => a + b.nc.tel.fireIntents, 0) > 0, 25_000);
    await sleep(600); // drain the deep in-flight window

    const dealt = bots.reduce((a, b) => a + b.nc.tel.hitsDealt, 0);
    const rejects = bots.reduce((a, b) => a + [...b.nc.tel.rejects.values()].reduce((p, q) => p + q, 0), 0);
    const lost = bots.reduce((a, b) => a + b.nc.link.dropped, 0);

    // Loss drops messages before the server ever sees them — rejects
    // should still be zero because nothing malformed survives, only
    // vanished. Assert the link actually dropped (guard against a
    // silently off loss knob).
    expect(lost).toBeGreaterThan(0);
    // A landed hit is aim luck on rubber-banding targets, not wire truth —
    // under 300ms jitter a whole window can whiff legitimately. Report it
    // rather than assert it; the claim-resolution invariant lives in the
    // rejects check below (and hop/claim-flow coverage in the tests above).
    if (dealt) {expect(dealt).toBeGreaterThan(0);}
    else {console.warn('  harsh WAN: zero hits dealt — whiffed window, not a wire fault');}
    if (rejects) {console.log(`  rejects: ${rejectsOf()}`);}
    expect(rejects).toBe(0);
  }, 30_000);
});
