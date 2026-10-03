/**
 * overlap.ts — HUD layout lint: no visible chrome elements may intersect.
 *
 *   bun _tools/e2e/overlap.ts
 *
 * Audits three states via window.__hudOverlap (ui/overlapAudit.ts):
 *   1. default HUD
 *   2. backquote debug view (stats charts + perfHud + ent-counts + log panel)
 *   3. log panel revealed alone (Alt+Q state, debug off)
 * Any rect intersection between top-level chrome elements is a failure —
 * the --z-* reserved rows exist so this never happens.
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

let failures = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=e2eoverlap&bots=2'));

try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  await client.waitFor(`window.__hudOverlap`, 10000);
  await sleep(1000); // let the HUD settle (killfeed, timers, roster)

  const audit = () => client.page.evaluate(`window.__hudOverlap()`) as Promise<{ a: string; b: string; px: number }[]>;

  const report = async (state: string) => {
    const hits = await audit();
    ok(hits.length === 0, `no HUD overlap — ${state}` +
      (hits.length ? ` (${hits.map((h) => `${h.a}×${h.b}@${h.px}px²`).join(', ')})` : ''));
  };

  // Collisions are viewport-dependent — audit each state at small and
  // large windows (800×600 squeezes every reserved row together).
  for (const vp of [{ width: 800, height: 600 }, { width: 1600, height: 900 }]) {
    await client.page.setViewport(vp);
    await sleep(400); // layout settle
    const tag = `${vp.width}x${vp.height}`;

    // 1. default chrome
    await report(`default HUD @ ${tag}`);

    // 2. backquote debug view — stats panels + perfHud + ent-counts + log panel
    await client.page.keyboard.press('Backquote');
    await sleep(300);
    await report(`debug view (backquote) @ ${tag}`);

    // 3. close debug, Alt+Q reveals the log panel alone
    await client.page.keyboard.press('Backquote');
    await sleep(200);
    await client.page.keyboard.down('Alt');
    await client.page.keyboard.press('KeyQ');
    await client.page.keyboard.up('Alt');
    await sleep(300);
    await report(`Alt+Q log panel @ ${tag}`);

    // reset for the next viewport pass
    await client.page.keyboard.down('Alt');
    await client.page.keyboard.press('KeyQ');
    await client.page.keyboard.up('Alt');
    await sleep(200);
  }
} finally {
  await closeClient(client);
  await stack.down();
}

console.log(failures ? `\n${failures} FAIL` : '\nall green');
process.exit(failures ? 1 : 0);
