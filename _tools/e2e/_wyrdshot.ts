// Screenshot wyrd's arcane preset in maplab (real map bin + spec preset).
//   bun _tools/e2e/_wyrdshot.ts <out.png>
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const out = process.argv[2] ?? '_wyrd_arcane.png';
const stack = await upStack();
const client = await launchClient(`http://localhost:${stack.clientPort}/maplab.html`);
try {
  await client.page.waitForFunction('window.__maplab !== undefined', { timeout: 30000 });
  await client.page.evaluate(() => {
    const lab = (window as unknown as { __maplab: { state: Record<string, unknown>; refresh(): void } }).__maplab;
    lab.state.map = 'wyrd';
    lab.refresh();
  });
  // loadMap is async — poll until the map paint lands.
  await client.page.waitForFunction(
    `(() => { const l = window.__maplab; return l && l.loaded === 'wyrd'; })()`,
    { timeout: 20000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));
  await client.page.screenshot({ path: out });
  console.log(JSON.stringify({ shot: out }));
} finally { await closeClient(client); await stack.down(); }
