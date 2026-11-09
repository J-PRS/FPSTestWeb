// Which room/map did the client actually land in?
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
const map = process.argv[2] ?? 'oacmpdm5';
const stack = await upStack();
const client = await launchClient(stack.clientUrl(`&room=q3v-${map}&map=${map}&bots=6&net=ws&debug`));
try {
  await client.page.waitForFunction('window.__test && window.__test.player && window.__test.networkManager?.isConnected?.()', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 8000));
  const info = await client.page.evaluate(`(() => {
    const t = window.__test;
    const nm = t.networkManager;
    const p = t.player;
    const solid = p.movement?.surface?.solid;
    return JSON.stringify({
      room: nm.netRoom ?? null,
      keys: Object.keys(nm).filter(k => /room|map/i.test(k)),
      pos: p.pos ? [+p.pos.x.toFixed(1), +p.pos.y.toFixed(1), +p.pos.z.toFixed(1)] : null,
      cols: solid ? solid.cols.length : -1,
      remotes: t.world.remotePlayers.entities.size,
      mapName: t.world.mapName,
    });
  })()`);
  console.log(info);
  console.log('--- server log tail ---');
  console.log(stack.serverLog().split('\n').slice(-40).join('\n'));
} finally { await closeClient(client); stack.down(); }
