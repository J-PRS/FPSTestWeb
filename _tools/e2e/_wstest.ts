/** Raw ws probe — is the socket itself reachable from the page? */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const stack = await upStack();
const c = await launchClient(stack.clientUrl('&bots=0'));
try {
  console.log('visibility:', await c.test<string>(`document.visibilityState + ' focus=' + document.hasFocus()`));
  const r0 = await c.test<string>(`new Promise((res) => {
    const ws = new WebSocket('ws://localhost:8477/ws');
    const t = setTimeout(() => res('TIMEOUT readyState=' + ws.readyState), 6000);
    ws.onopen = () => { clearTimeout(t); res('OPEN'); };
    ws.onerror = (e) => { clearTimeout(t); res('ERROR'); };
    ws.onclose = (e) => { clearTimeout(t); res('CLOSE code=' + e.code); };
  })`);
  console.log('ws localhost:', r0);
  const r = await c.test<string>(`new Promise((res) => {
    const ws = new WebSocket('ws://127.0.0.1:8477/ws');
    const t = setTimeout(() => res('TIMEOUT readyState=' + ws.readyState), 8000);
    ws.onopen = () => { clearTimeout(t); res('OPEN'); };
    ws.onerror = (e) => { clearTimeout(t); res('ERROR ' + JSON.stringify(e)); };
    ws.onclose = (e) => { clearTimeout(t); res('CLOSE code=' + e.code + ' reason=' + e.reason); };
  })`);
  console.log('raw ws:', r);
  const r3 = await c.test<string>(`new Promise((res) => {
    const wk = new Worker('/_wkprobe.mjs');
    const t = setTimeout(() => res('WK SILENT'), 12000);
    wk.onmessage = (e) => { clearTimeout(t); res('wk-ws: ' + JSON.stringify(e.data)); };
    wk.onerror = (e) => { clearTimeout(t); res('wk error ' + e.message); };
    wk.postMessage({ url: 'ws://127.0.0.1:8477/ws', ms: 8000 });
  })`);
  console.log(r3);
} finally {
  console.log('server tail:', stack.serverLog().split('\n').slice(-6).join('\n'));
  await closeClient(c);
  stack.down();
}
