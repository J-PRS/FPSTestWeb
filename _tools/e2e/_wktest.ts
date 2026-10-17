/** Bare worker round-trip probe — does a module Worker even run headed? */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const stack = await upStack();
const c = await launchClient(stack.clientUrl('&bots=0'));
try {
  const r = await c.test<string>(`new Promise((res) => {
    try {
      const blob = new Blob(['self.onmessage = (e) => self.postMessage("pong:"+e.data)'], { type: 'text/javascript' });
      const wk = new Worker(URL.createObjectURL(blob));
      const t = setTimeout(() => res('WORKER TIMEOUT'), 5000);
      wk.onmessage = (e) => { clearTimeout(t); res(e.data); };
      wk.onerror = (e) => { clearTimeout(t); res('WORKER ERROR ' + e.message); };
      wk.postMessage('hi');
    } catch (e) { res('THROW ' + e); }
  })`);
  console.log('blob worker:', r);

  // And the real netWorker module the game spawns.
  const r2 = await c.test<string>(`new Promise(async (res) => {
    try {
      const mod = await import('/src/networking/netWorker.ts').catch(e => null);
      const wk = new Worker(new URL('/src/networking/netWorker.ts', location.href), { type: 'module' });
      const evs = [];
      const t = setTimeout(() => res('NETWORKER evs: ' + JSON.stringify(evs)), 15000);
      wk.onmessage = (e) => { evs.push(e.data); if (e.data && e.data.kind === 'up') { clearTimeout(t); res('UP ' + JSON.stringify(evs)); } };
      wk.onerror = (e) => { clearTimeout(t); res('NETW ERROR ' + (e.message || 'script load')); };
      wk.postMessage({ kind: 'init', net: 'ws' });
      wk.postMessage({ kind: 'connect', url: 'ws://127.0.0.1:8477/ws', resolve: false });
    } catch (e) { res('THROW ' + e); }
  })`);
  console.log('netWorker:', r2);
} finally {
  await closeClient(c);
  stack.down();
}
