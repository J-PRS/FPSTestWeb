// Boot bastion with ?shadererrors=1 — three's checkShaderErrors now
// reports the real failing program (name + infoLog).
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const stack = await upStack();
try {
  const c = await launchClient(stack.clientUrl('&room=sherr&map=bastion&bots=0&net=ws&shadererrors=1'),
    { preload: "localStorage.setItem('fps-autoq','false')" });
  await c.waitFor('window.__test && window.__test.networkManager && window.__test.networkManager.isConnected()', 90000);
  await c.waitFor('window.__test.terrain && isFinite(window.__test.terrain.getHeight(0,0))', 60000);
  await new Promise(r => setTimeout(r, 15000));
  await closeClient(c);
} finally { await stack.down(); }
