/**
 * _bloomshot.ts — mapshot with bloom ON, to catch terrain pixels that
 * clear the 1.3 luminance gate.
 *   bun _tools/e2e/_bloomshot.ts <map> [x z] [alt] [tag]
 * Writes _tools/e2e/shots/bloom<tag>_<map>_yaw<n>.png
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const map = process.argv[2] ?? 'dunes';
const [vx, vz] = (process.argv[3] ?? '0 0').split(' ').map(Number);
const alt = Number(process.argv[4] ?? 60);
const tag = process.argv[5] ?? '';
const OUT = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'shots');

const stack = await upStack();
const url = stack.clientUrl(`&room=${map}&bots=0&net=ws&bloom=on&postpro=on&nocreatures`);
console.log('stack server', stack.serverPort, 'client', stack.clientPort, url);

const client = await launchClient(url);
try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  await new Promise(r => setTimeout(r, 4000));
  mkdirSync(OUT, { recursive: true });
  for (let i = 0; i < 4; i++) {
    await client.page.evaluate(`(() => {
      const p = window.__test.player;
      const h = window.__test.terrain?.heightAt ? window.__test.terrain.heightAt(${vx}, ${vz}) : 60;
      p.pos.set(${vx}, h + ${alt}, ${vz});
      p.vel.set(0, 0, 0);
      p.yaw = ${i} * Math.PI / 2; p.pitch = 0.25;
      p.markTeleport && p.markTeleport();
    })()`);
    await new Promise(r => setTimeout(r, 1200));
    const f = join(OUT, `bloom${tag}_${map}_yaw${i}.png`);
    await client.page.screenshot({ path: f });
    console.log('wrote', f);
  }
} finally {
  await closeClient(client);
  stack.down();
}
