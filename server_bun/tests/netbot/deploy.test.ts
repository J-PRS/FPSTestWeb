import { describe, it, expect } from 'bun:test';
import { mkNetbots } from './helpers.ts';

describe.skipIf(!process.env.FPS_SOAK)('netbot — real clients over real sockets', () => {
  const { spawn, bots, sleep } = mkNetbots();

  it('a deploy claim lands on every observer — deploySpawn/deployables wire coverage', async () => {
    await spawn(3, { pingMs: 20, jitterMs: 120, lossRate: 0 });
    await sleep(1500); // joined + field loaded
    const planter = bots[0]!.nc;
    planter.send({ type: 'deploy', kind: 'mine', position: { ...planter.self.pos } });
    await sleep(800);
    // Every client — planter included — should see the same deployable
    // set; a dropped deploySpawn leaves the world permanently forked.
    for (const b of bots) {
      const owned = [...b.nc.deployables.values()].filter((d) => d.owner === planter.id && d.kind === 'mine');
      expect(owned.length).toBe(1);
    }
  }, 30000);
});
