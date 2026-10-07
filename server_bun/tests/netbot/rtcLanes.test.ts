import { describe, it, expect } from 'bun:test';
import { mkNetbots, nd } from './helpers.ts';

describe('netbot — real clients over real sockets', () => {
  const { spawn, bots, sleep, until, rejectsOf, totalRejects } = mkNetbots();

  it('ws and rtc clients fight in the same room — SCTP lanes resolve claims too', async () => {
    if (!nd) return; // native addon unavailable in this environment
    // 'dm' (FFA) — every other player is an enemy, so a same-team rtc
    // pairing or a scattered respawn can't park both rtc bots out of
    // claim range for the whole window. The lane is what's under test.
    await spawn(4, { pingMs: 20, jitterMs: 80, lossRate: 0 }, { transports: ['ws', 'rtc'], mode: 'dm' });
    // 35s of the 45s budget — the SCTP handshake is the variable: under
    // suite CPU contention it alone has eaten the old 25s window while
    // the same lane resolves in ~7s isolated.
    await until(() => bots.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b.nc.tel.fireIntents, 0) > 0, 35000);
    await sleep(400);

    for (const b of bots) expect(b.nc.tel.gameStates).toBeGreaterThan(0);
    const rtcBots = bots.filter((_, i) => i % 2 === 1);
    const rtcClaims = rtcBots.reduce((a, b) => a + b.nc.tel.fireIntents, 0);
    const rejects = totalRejects();
    if (rejects) console.log(`  rejects: ${rejectsOf()}`);

    expect(rtcBots.length).toBe(2);
    expect(rtcClaims).toBeGreaterThan(0); // the SCTP lane issued claims
    expect(rejects).toBe(0);
  }, 45000); // RTC handshake + engagement-wait needs more than 30s worst case
});
