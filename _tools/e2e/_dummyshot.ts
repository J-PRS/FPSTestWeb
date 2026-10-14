import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { mkdirSync } from 'node:fs';

// Visual verify for the skinned-part merge: ?dummylineup pins
// light/medium/heavy RemotePlayers in front of the camera.
const stack = await upStack();
const c = await launchClient(stack.clientUrl('&room=dummyshot&map=crossfire&bots=0&mode=dm&dummy'));
await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
await new Promise((r) => setTimeout(r, 15000)); // models + anims settle
mkdirSync('_tools/e2e/shots', { recursive: true });
await c.page.screenshot({ path: '_tools/e2e/shots/dummylineup.png' });
const skinned = await c.page.evaluate(`(() => { let n = 0; window.__scene.traverse(o => { if (o.isSkinnedMesh) n++; }); return n; })()`);
console.log('SKINNED-COUNT', skinned);
await closeClient(c); stack.down();
