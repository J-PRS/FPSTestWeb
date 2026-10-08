// blitprobe — is the render canvas readable via 2d blit under headless?
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=e2eblit&bots=2'));
try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  await new Promise(r => setTimeout(r, 5000));
  const res = await client.page.evaluate(`(() => {
    const cs = [...document.querySelectorAll('canvas')].sort((a,b) => b.width*b.height - a.width*a.height);
    const src = cs[0];
    const off = document.createElement('canvas');
    off.width = 64; off.height = 36;
    const ctx = off.getContext('2d');
    ctx.drawImage(src, 0, 0, 64, 36);
    const d = ctx.getImageData(0, 0, 64, 36).data;
    let lit = 0, sum = 0;
    for (let i = 0; i < d.length; i += 4) { const v = d[i]+d[i+1]+d[i+2]; sum += v; if (v > 30) lit++; }
    return { w: src.width, h: src.height, lit, sum, n: cs.length };
  })()`);
  console.log(JSON.stringify(res));
} finally {
  await closeClient(client);
  stack.down();
}
