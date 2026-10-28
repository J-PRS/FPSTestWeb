import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { mkdirSync } from 'node:fs';

// Worker-GLB real-path verify: ?dummylineup pins light/medium/heavy
// RemotePlayers (worker-rebuilt scenes) in front of the camera.
// --glbnw runs the same shot through the main-thread loader (A/B).
const nw = process.argv.includes('--glbnw');
const stack = await upStack();
const c = await launchClient(stack.clientUrl(`&room=dummylineup&map=crossfire&bots=0&mode=dm&dummylineup${nw ? '&glbnw=1' : ''}`));
await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
await new Promise((r) => setTimeout(r, 15000));
mkdirSync('_tools/e2e/shots', { recursive: true });
const skinned = await c.page.evaluate(`(() => { let n = 0; window.__scene.traverse(o => { if (o.isSkinnedMesh) n++; }); return n; })()`);
console.log('SKINNED-COUNT', skinned);
await c.page.screenshot({ path: `_tools/e2e/shots/dummylineup_${nw ? 'main' : 'worker'}.png` });
await closeClient(c); stack.down();
