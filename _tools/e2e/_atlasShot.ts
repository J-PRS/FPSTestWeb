// Visual verify: merged atlas bodies render like before + draw count.
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/?mode=headhunt&map=rimrock&bots=16');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 12000));
  await client.page.screenshot({ path: '_atlas_shot.png' });
  const info = await client.page.evaluate(`(() => { const i = (window.__renderer && window.__renderer.info) || {}; return JSON.stringify(i.render || {}); })()`);
  console.log('render:', info);
} finally { await closeClient(client); }
