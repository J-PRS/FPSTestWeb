// _corpsehunt.ts — join a bot DM room, poll world.remotePlayers for
// corpses that outlive the shrink window (dead + scale>0 for >4s).
//   E2E_GPU=1 bun _tools/e2e/_corpsehunt.ts [map] [secs]
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const map = process.argv[2] ?? 'rimrock';
const secs = Number(process.argv[3] ?? 90);

const stack = await upStack();
const url = stack.clientUrl(`&room=${map}&bots=10&net=ws`);
console.log('stack', stack.serverPort, stack.clientPort, url);
const client = await launchClient(url);
try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  await new Promise(r => setTimeout(r, 3000));
  const seen = new Map<string, number>();
  const t0 = Date.now();
  while (Date.now() - t0 < secs * 1000) {
    const rows = await client.page.evaluate(`(() => {
      const out = [];
      const rp = window.__test.world?.remotePlayers;
      if (!rp) return out;
      for (const [id, e] of rp) {
        out.push({ id, dead: e.isDead, scale: e.scale, stale: e.staleHidden,
          frustum: e.frustumHidden, pos: [e.position.x|0, e.position.y|0, e.position.z|0] });
      }
      return out;
    })()`);
    const now = Date.now();
    for (const r of rows) {
      const key = `${r.id}@${r.pos}`;
      if (r.dead && r.scale > 0.01) {
        const first = seen.get(key) ?? now;
        seen.set(key, first);
        const age = (now - first) / 1000;
        if (age > 4) {
          console.log(`STUCK CORPSE ${JSON.stringify(r)} age=${age.toFixed(1)}s`);
        }
      }
    }
    const dead = rows.filter(r => r.dead);
    console.log(`t=${((now - t0) / 1000).toFixed(0)}s remotes=${rows.length} dead=${dead.length}`,
      dead.map(r => `${r.id.split('-').pop()}:s${r.scale.toFixed(2)}${r.stale ? ':stale' : ''}`).join(' '));
    await new Promise(r => setTimeout(r, 2000));
  }
} finally {
  await closeClient(client);
  await stack.down();
}
