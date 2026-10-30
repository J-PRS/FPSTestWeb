// Phase table under throttle on the live room — where the frame sits now.
import { launchClient, closeClient } from './browser.ts';
const throttle = Number(process.argv[2] ?? 5);
const client = await launchClient('http://localhost:5400/quickjoin?server=127.0.0.1:8000&mode=ctf&bots=16');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  const cdp = await client.page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await new Promise(r => setTimeout(r, 25000));
  const perf = await client.page.evaluate(`window.__perf ? JSON.stringify(window.__perf()) : 'no __perf'`);
  console.log(perf);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
} finally { await closeClient(client); }
