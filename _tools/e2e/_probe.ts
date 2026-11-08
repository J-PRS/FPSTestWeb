/* oxlint-disable no-console */
import { launchClient, closeClient } from './browser.ts';
const c = await launchClient(
  'http://127.0.0.1:5500/?server=https://play.jprice.app&room=headhunt-1&net=ws&debug');
try {
  await new Promise((r) => setTimeout(r, 20000));
  const probe = await c.test<any>(`JSON.stringify({
    hasTest: !!window.__test,
    nm: typeof window.__test?.networkManager,
    isConn: window.__test?.networkManager?.isConnected?.(),
    pid: window.__test?.networkManager?.getLocalPlayerId?.(),
    dead: window.__test?.player?.isDead,
    dc: window.__test?.player?.deadConfirmedByWire,
    hp: window.__test?.player?.health,
  })`);
  console.log('probe:', probe);
} finally {
  await closeClient(c);
}
