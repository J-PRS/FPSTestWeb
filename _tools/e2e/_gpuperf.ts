// Per-pass composer GPU cost — boots a solo match with ?gpuperf=1,
// reads __gpuPass() after frames settle. E2E_GPU=1 for real GPU.
//   set E2E_GPU=1& bun _tools/e2e/_gpuperf.ts
import { launchClient, closeClient } from './browser.ts';

const client = await launchClient('http://localhost:5400/?mode=ctf&bots=8&gpuperf=1');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 10000)); // settle into real gameplay
  const report = await client.page.evaluate('window.__gpuPass ? JSON.stringify(window.__gpuPass()) : "no __gpuPass"');
  console.log(report);
} finally { await closeClient(client); }
