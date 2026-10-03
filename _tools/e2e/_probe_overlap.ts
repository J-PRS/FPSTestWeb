import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=probe&bots=6'));
await client.page.setViewport({ width: 1600, height: 900 });
await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
await client.page.keyboard.press('Backquote');
await new Promise(r=>setTimeout(r,600));
const rects = await client.page.evaluate(`(() => {
  const sel = ['#ent-counts','#stats-0','#stats-1','#stats-2','#perf-hud','#log-panel','#shot-feed','#stale-badge','#killfeed'];
  const out = {};
  for (const s of sel) { const el = document.querySelector(s); if (!el) { out[s]=null; continue; }
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    out[s] = cs.display==='none' ? 'hidden' : { x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height), bottom: cs.bottom };
  }
  out.vw = innerWidth; out.vh = innerHeight;
  out.overlaps = window.__hudOverlap();
  return out; })()`);
console.log(JSON.stringify(rects, null, 1));
await closeClient(client); await stack.down();
