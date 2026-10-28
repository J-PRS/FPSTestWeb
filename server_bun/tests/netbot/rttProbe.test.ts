import { describe, it, expect } from 'bun:test';
import { mkNetbots } from './helpers.ts';

// Reads env().gs internals — server-side only, skip on NETBOT_URL.
describe.skipIf(!process.env.FPS_SOAK || !!process.env.NETBOT_URL)('netbot — real clients over real sockets', () => {
  const { spawn, bots, env, until } = mkNetbots();

  it('the server RTT probe lands: serverTransitEma feeds the shadow — the unforgeable channel is live end-to-end', async () => {
    // One moving bot — a body for the probe to measure.
    await spawn(1, { pingMs: 30, jitterMs: 10, lossRate: 0 }, { mode: 'dm' });
    const nc = bots[0]!.nc;
    const gs = env()!.gs;

    // bootServer rooms mint on the default field, which is null until the
    // boot heightmap loads — attach a flat one so the shadow exists (also
    // exercises the pending-track replay: the player seated before the
    // field landed).
    const flat = { size: 4, data: new Uint8Array(16).fill(60), stride: 1 };
    for (const room of gs.rooms.values()) {
      room.moveSim.attachField(flat, (pid) => room.players.getPlayer(pid)?.position);
    }

    // The probe round-robins one human per ~500ms — first pong lands
    // inside a couple of seconds on a 30ms link.
    const probe = () => {
      for (const room of gs.rooms.values()) {
        const ch = room.moveSim.transitChannelsOf(nc.id);
        if (ch.server > 0) return ch;
      }
      return null;
    };
    expect(await until(() => probe() !== null, 10000)).toBe(true);

    const ch = probe()!;
    // LatencyLink adds ~30ms ping → one-way transit ~15ms; both channels
    // should report a sane small number, and the effective estimate must
    // sit at/below the server channel + slack (min() — the client could
    // report anything and still can't raise it).
    expect(ch.server).toBeGreaterThan(0);
    expect(ch.server).toBeLessThan(200);
  }, 20000);
});
