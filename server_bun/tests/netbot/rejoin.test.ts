import { describe, it, expect } from 'bun:test';
import { mkNetbots } from './helpers.ts';

describe.skipIf(!process.env.FPS_SOAK)('netbot — real clients over real sockets', () => {
  const { spawn, bots, sleep, until, rejectsOf, totalRejects } = mkNetbots();

  it('a dropped socket rejoins cleanly — post-reconnect claims resolve', async () => {
    // 'dm' + four bots — two CTF bots can sit corners hunting different
    // flags and blow the 20s engagement window; four FFA hunters engage
    // near-instantly, and the property under test is rejoin, not
    // marksmanship.
    await spawn(4, { pingMs: 20, jitterMs: 60, lossRate: 0 }, { mode: 'dm' });
    await sleep(3500);

    const victim = bots[0]!;
    const gsBefore = victim.nc.tel.gameStates;
    victim.nc.ws?.close();
    await sleep(300);
    await victim.nc.connect();
    await until(() => bots.reduce((a, b) => a + b.nc.tel.shots, 0) > 0, 20000);
    await sleep(300);

    const rejects = totalRejects();
    if (rejects) console.log(`  rejects: ${rejectsOf()}`);
    expect(victim.nc.tel.gameStates).toBeGreaterThan(gsBefore);
    expect(victim.nc.closed).toBe(false);
    // Two bots on a large map can go a whole window without landing —
    // the property under test is rejoin + engagement, not marksmanship.
    expect(bots.reduce((a, b) => a + b.nc.tel.shots, 0)).toBeGreaterThan(0);
    // The bug this pins: a stale gameStates>0 used to un-gate gameplay
    // before the new handshake — the server would 1008 the socket and
    // rejects would never even arrive to count.
    expect(rejects).toBe(0);
  }, 30000);
});
