import { describe, it, expect } from 'bun:test';
import { mkNetbots } from './helpers.ts';

describe.skipIf(!process.env.FPS_SOAK)('netbot — real clients over real sockets', () => {
  const { spawn, bots, until } = mkNetbots();

  it('a mid-match room hop keeps hits flowing (per-room seq reset)', async () => {
    await spawn(4, { pingMs: 20, jitterMs: 60, lossRate: 0 }, { hopEveryMs: 4000 });
    // Hop transitions gate gameplay sends until each room's gameState —
    // wait on a hop + first claim rather than a fixed window.
    await until(() => bots.some((b) => b.nc.tel.hops > 0) && bots.reduce((a, b) => a + b.nc.tel.fireIntents, 0) > 0, 25000);

    const hopped = bots.some((b) => b.nc.tel.hops > 0);
    const claims = bots.reduce((a, b) => a + b.nc.tel.fireIntents, 0);
    const rejects = bots.reduce((a, b) => a + [...b.nc.tel.rejects.values()].reduce((p, q) => p + q, 0), 0);
    const dedupStorms = bots.reduce((a, b) => a + b.nc.tel.dedupDrops, 0);

    expect(hopped).toBe(true);
    // Claims resolve or whiff — both count as resolved. Re-hop scatter
    // makes a landed hit luck, so pin claim flow + zero rejects instead.
    expect(claims).toBeGreaterThan(0);
    expect(rejects).toBe(0);
    // Stale-seq drops across a hop mean the watermark never reset — the
    // session-long damage blackout this suite exists to prevent.
    expect(dedupStorms).toBeLessThan(4);
  }, 30000);
});
