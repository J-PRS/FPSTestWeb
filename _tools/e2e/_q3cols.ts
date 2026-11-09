// Verify map structures reached client collision (wire → applyStructureSpecs → SolidWorld).
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/?room=q3col&map=oacmpdm5&bots=0&net=ws&debug');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 6000));
  const info = await client.page.evaluate(`(() => {
    const p = window.__test.player;
    const solid = p.movement && p.movement.surface && p.movement.surface.solid;
    return JSON.stringify({
      pos: p.pos ? { x:+p.pos.x.toFixed(1), y:+p.pos.y.toFixed(1), z:+p.pos.z.toFixed(1) } : null,
      solidCols: solid ? solid.cols.length : null,
      hasSolid: !!solid,
    });
  })()`);
  console.log(info);
} finally { await closeClient(client); }
