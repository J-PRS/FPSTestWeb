/**
 * cloudshot.ts — look up, screenshot the cloud layer.
 *   bun _tools/e2e/cloudshot.ts [pitch] [yaw]
 * Writes _tools/e2e/shots/clouds.png
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const pitch = Number(process.argv[2] ?? 0.9);
const yaw = Number(process.argv[3] ?? 0.6);
const OUT = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'shots');

const stack = await upStack();
const extra = process.argv[4] ?? ''; // extra URL args, e.g. "&postpro=on&bloom=on"
const client = await launchClient(stack.clientUrl(`&room=cloudshot&bots=0${extra}`));
try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  await client.page.evaluate(`(() => {
    const p = window.__test.player;
    p.pitch = ${pitch}; p.yaw = ${yaw};
  })()`);
  // SwiftShader runs ~7x slow — give it wall time to draw a few frames.
  await new Promise(r => setTimeout(r, 6000));
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, 'clouds.png');
  await client.page.screenshot({ path: file });
  console.log('wrote', file);
} finally {
  await closeClient(client);
  stack.down();
}
