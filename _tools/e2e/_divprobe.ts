// _divprobe.ts — teleport to spots, scan a fine grid for drawn-vs-collider
// divergence (catches intra-cell chord bulges the 5m-lattice probe misses).
//   bun _tools/e2e/_divprobe.ts <map> [extra-url-params] [spots "x,z;x,z"]
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const map = process.argv[2] ?? 'escalade_test';
const extra = process.argv[3] ?? '';
const spots = (process.argv[4] ?? '300,100;583,1;200,-50')
  .split(';').map(s => s.split(',').map(Number));
const stack = await upStack();
const url = stack.clientUrl(`&room=${map}&bots=0&net=ws${extra}`);
const client = await launchClient(url);
try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  await new Promise(r => setTimeout(r, 3000));
  for (const [x, z] of spots) {
    const out = await client.page.evaluate(`(async () => {
      const t = window.__test.terrain;
      const p = window.__test.player;
      const h = t.getHeight(${x}, ${z});
      p.pos.set(${x}, h + 2, ${z}); p.vel.set(0,0,0);
      p.markTeleport && p.markTeleport();
      await new Promise(r => setTimeout(r, 800));
      let worst = { d: -1e9 };
      for (let dz = -12; dz <= 12; dz += 1) {
        for (let dx = -12; dx <= 12; dx += 1) {
          const d = t.getRenderedHeight(${x} + dx, ${z} + dz) - t.getHeight(${x} + dx, ${z} + dz);
          if (d > worst.d) { worst = { d: +d.toFixed(2), dx, dz }; }
        }
      }
      return { x: ${x}, z: ${z}, worstPositive: worst };
    })()`);
    console.log(JSON.stringify(out));
  }
} finally {
  await closeClient(client);
  await stack.down();
}
