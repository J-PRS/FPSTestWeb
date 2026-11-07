/* oxlint-disable no-console */
// Passive dmg-echo observer: idle in headhunt-1 on prod, count
// [GLITCH:parity-dmg-echo] console lines. Remote MRV/cluster airbursts
// rain client-local bomblets - pre-fix they stamped echoes as MINE.
import { launchClient, closeClient } from './browser.ts';

const SECS = Number(process.argv[2] ?? '90');
const c = await launchClient(
  'http://127.0.0.1:5500/?server=https://play.jprice.app&room=headhunt-1&net=ws');
try {
  await c.waitFor(`window.__test && window.__test.networkManager && window.__test.networkManager.isConnected()`, 90000);
  console.log(`connected — observing ${SECS}s`);
  await new Promise((r) => setTimeout(r, SECS * 1000));
  const parity = await c.test<any>(`JSON.stringify(window.__test.parity)`);
  console.log('parity census:', parity);
} finally {
  await closeClient(c);
}
