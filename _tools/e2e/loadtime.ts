/**
 * loadtime.ts — how fast the game opens: navigation → __test init →
 * connected → first frame. Headless cold boot, no warm cache.
 *
 *   bun _tools/e2e/loadtime.ts [--bots 0] [--runs 3]
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const BOTS = +arg('bots', '0');
const RUNS = +arg('runs', '3');

const stack = await upStack();
console.log(`stack client=${stack.clientPort} server=${stack.serverPort}`);

for (let run = 0; run < RUNS; run += 1) {
  const t0 = Date.now();
  const client = await launchClient(stack.clientUrl(`&room=loadt&bots=${BOTS}`));
  const nav = Date.now() - t0;
  const initT = Date.now();
  try {
    await client.waitFor('t.player', 60000);
  } catch {
    // Dump what the page actually reached — WebGL fail, stuck import, etc.
    const state = await client.page.evaluate(`({
      hasTest: !!window.__test,
      ready: document.readyState,
      err: String(window.__bootErr ?? ''),
      webgl: (() => { try { const c = document.createElement('canvas'); return !!c.getContext('webgl2'); } catch (e) { return String(e); } })(),
    })`).catch((e: unknown) => String(e));
    console.log('init timeout — page state:', JSON.stringify(state));
    await closeClient(client);
    continue;
  }
  const init = Date.now() - initT;
  const connT = Date.now();
  await client.waitFor('t.networkManager && t.networkManager.isConnected()', 30000).catch(() => undefined);
  const conn = Date.now() - connT;
  const frameT = Date.now();
  await client.page.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  const frame = Date.now() - frameT;
  // In-page nav timing: server bytes + module fetch/eval breakdown
  const navTiming = await client.page.evaluate(`(() => {
    const n = performance.getEntriesByType('navigation')[0];
    return n ? { html: Math.round(n.responseEnd - n.startTime), dom: Math.round(n.domContentLoadedEventEnd - n.startTime) } : null;
  })()`);
  console.log(`run ${run}: nav=${nav}ms init=${init}ms connect=${conn}ms frame=${frame}ms total=${Date.now() - t0}ms`, navTiming);
  await closeClient(client);
}
stack.down();
