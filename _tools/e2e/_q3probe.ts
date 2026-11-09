// Collision verify: is the player standing on converted geometry?
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/?room=q3dm5b&map=oacmpdm5&bots=0&net=ws&debug');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 8000));
  const probe = `(() => {
    const p = window.__test.player;
    const m = p.movement || {};
    return JSON.stringify({
      pos: { x:+p.pos.x.toFixed(2), y:+p.pos.y.toFixed(2), z:+p.pos.z.toFixed(2) },
      vel: { x:+(p.vel?.x??0).toFixed(2), y:+(p.vel?.y??0).toFixed(2), z:+(p.vel?.z??0).toFixed(2) },
      onGround: m.onGround, grounded: m.grounded,
      keys: Object.keys(m).slice(0,40),
    });
  })()`;
  const a = await client.page.evaluate(probe);
  await new Promise(r => setTimeout(r, 3000));
  const b = await client.page.evaluate(probe);
  console.log('t0', a); console.log('t3', b);
} finally { await closeClient(client); }
