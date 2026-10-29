// Maplab verbs smoke test — apply rock+scree on a synth field, screenshot.
//   bun _tools/e2e/_verbshot.ts <out.png>
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const out = process.argv[2] ?? '_verbs.png';
const stack = await upStack();
const client = await launchClient(`http://localhost:${stack.clientPort}/maplab.html`);
try {
  await client.page.waitForFunction('window.__maplab !== undefined', { timeout: 30000 });
  await client.page.evaluate(() => {
    const lab = (window as unknown as { __maplab: { state: { verbs: string[]; seed: number; map: string; preset: number }; refresh(): void } }).__maplab;
    lab.state.map = '';
    lab.state.seed = 7;
    lab.state.preset = 5;
    lab.state.verbs = ['rock', 'scree'];
    lab.refresh();
  });
  await new Promise(r => setTimeout(r, 1500));
  await client.page.screenshot({ path: out });
  console.log(JSON.stringify({ shot: out }));
} finally { await closeClient(client); await stack.down(); }
