/**
 * vgs.ts — VGS e2e: real key chords → real chat wire.
 *
 *   bun _tools/e2e/vgs.ts
 *
 * Two clients in one room. A presses V,G,S (Global ▸ Shazbot) via real
 * keyboard events; B must receive 'SHAZBOT!' on the chat wire — proving
 * the whole path: key handler → chord menu → wire send → remote receive.
 * Also asserts a tactical chord (V,A,A) delivers (ffa rooms fall back to
 * global scoping, same as a real un-teamed Tribes server).
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { check, checkCount } from './check.ts';

const stack = await upStack();
const url = stack.clientUrl('&room=e2evgs&bots=0');
const [a, b] = await Promise.all([launchClient(url), launchClient(url)]);

try {
  for (const c of [a, b]) {
    await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  }

  // Spy B's receive path BEFORE chords fire — feed DOM fades make
  // polling flaky under SwiftShader, onChat is the raw wire landing.
  await b.page.evaluate(`(() => {
    const nm = window.__test.networkManager;
    window.__chatLog = [];
    const orig = nm.onChat;
    nm.onChat = (id, text, team) => { window.__chatLog.push({ from: id, text, team }); orig?.(id, text, team); };
  })()`);

  // Real key chords — V opens the menu, G picks Global, S is Shazbot.
  await a.page.keyboard.press('v');
  await new Promise((r) => setTimeout(r, 300));
  await a.page.keyboard.press('g');
  await new Promise((r) => setTimeout(r, 300));
  await a.page.keyboard.press('s');

  let shazbot = false;
  try {
    await b.waitFor(`window.__chatLog?.some(l => l.text === 'SHAZBOT!')`, 30000);
    shazbot = true;
  } catch { /* diagnostics below */ }
  check(shazbot, `V,G,S → B receives 'SHAZBOT!' (log: ${JSON.stringify(await b.test(`window.__chatLog`))})`);

  // Tactical chord V,A,A → 'Attack!' — team-scoped line; un-teamed rooms
  // fall back to global so B still hears it.
  await a.page.keyboard.press('v');
  await new Promise((r) => setTimeout(r, 300));
  await a.page.keyboard.press('a');
  await new Promise((r) => setTimeout(r, 300));
  await a.page.keyboard.press('a');

  let attack = false;
  try {
    await b.waitFor(`window.__chatLog?.some(l => l.text === 'Attack!')`, 30000);
    attack = true;
  } catch { /* fall through */ }
  check(attack, `V,A,A → B receives 'Attack!' (log: ${JSON.stringify(await b.test(`window.__chatLog`))})`);
} finally {
  await Promise.all([closeClient(a), closeClient(b)]);
  stack.down();
}
console.log(`\n${checkCount()} checks passed`);
