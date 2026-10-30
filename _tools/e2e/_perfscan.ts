// __perf() + __renderScan() — live phase budget + staged render breakdown.
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/?mode=headhunt&map=rimrock&bots=16');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 12000));
  console.log('PERF:', await client.page.evaluate('JSON.stringify(window.__perf && window.__perf())'));
  const scan = await client.page.evaluate('window.__renderScan ? window.__renderScan() : "no renderScan"');
  console.log('SCAN:', typeof scan === 'string' ? scan : JSON.stringify(scan));
} finally { await closeClient(client); }
