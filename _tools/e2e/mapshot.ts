/**
 * mapshot.ts — join a named map room, teleport to a vantage point, shoot.
 *   bun _tools/e2e/mapshot.ts <map> [x z] [yaw pitch]
 * Defaults frame escalade's alpha base. Writes _tools/e2e/shots/map_<n>.png
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const map = process.argv[2] ?? 'escalade';
const [vx, vz] = (process.argv[3] ?? '126 40').split(' ').map(Number);
const [yaw, pitch] = (process.argv[4] ?? '0 -0.15').split(' ').map(Number);
const OUT = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'shots');

const stack = await upStack();
const url = stack.clientUrl(`&room=${map}&bots=0`);
console.log('stack server', stack.serverPort, 'client', stack.clientPort, url);
const client = await launchClient(url);
try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  // Wait a beat for the terrain swap + interiors to land.
  await new Promise(r => setTimeout(r, 4000));
  await client.page.evaluate(`(() => {
    const p = window.__test.player;
    const h = window.__test.terrain?.heightAt ? window.__test.terrain.heightAt(${vx}, ${vz}) : 60;
    p.pos.set(${vx}, h + 55, ${vz});
    p.vel.set(0, 0, 0);
    p.yaw = ${yaw}; p.pitch = ${pitch};
    p.syncMovement && p.syncMovement();
    p.markTeleport && p.markTeleport();
  })()`);
  await new Promise(r => setTimeout(r, 3000));
  const diag = await client.page.evaluate(`(() => {
    const s = window.__test.scene;
    const g = s && s.getObjectByName('__t2interiors');
    const nm = window.__test.networkManager;
    return {
      interiors: g ? g.children.length : 0,
      connected: nm && nm.connected,
      mapFetches: performance.getEntriesByType('resource')
        .map(e => e.name).filter(n => n.includes('/maps/')).slice(0, 12),
    };
  })()`);
  console.log('diag', JSON.stringify(diag));
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `map_${map}.png`);
  await client.page.screenshot({ path: file });
  console.log('wrote', file);
} finally {
  await closeClient(client);
  stack.down();
}
