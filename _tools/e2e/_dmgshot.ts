import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { mkdirSync } from 'node:fs';

// Visual verify for the directional edge damage flash: fire showDamage
// from a bearing right-of-forward, screenshot mid-flash.
const stack = await upStack();
const c = await launchClient(stack.clientUrl('&room=dmgshot&map=crossfire&bots=0&mode=dm'));
await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
await new Promise((r) => setTimeout(r, 3000));
await c.page.evaluate(`(() => {
  const t = window.__test;
  const p = t.player.pos;
  // attacker ~40 deg right of facing: bearing rel = +0.7rad
  const yaw = t.player.yaw;
  const from = { x: p.x + Math.sin(yaw + 0.7) * 30, y: p.y, z: p.z + Math.cos(yaw + 0.7) * 30 };
  t.hud.showDamage(from, 55);
})()`);
await new Promise((r) => setTimeout(r, 180)); // catch the flash near peak
mkdirSync('_tools/e2e/shots', { recursive: true });
await c.page.screenshot({ path: '_tools/e2e/shots/dmg_edge.png' });
await closeClient(c); stack.down();
