import { launchClient, closeClient } from './browser.ts';
import { writeFileSync, mkdirSync } from 'node:fs';

// DUAL capture — the client records its own lens while the server records
// authoritative truth into the SAME room. Diff them afterwards and every
// delta is something the wire dropped or the client fabricated.
const c = await launchClient(`http://localhost:5400/s/dualtest?server=localhost:8000&mode=ctf&bots=8`);
await c.waitFor(`window.__test && window.__test.demoManager && window.__test.networkManager && window.__test.networkManager.isConnected()`, 45000);
console.log('seated — recording 60s of live play');
await new Promise((r) => setTimeout(r, 60_000));
const b64 = await c.page.evaluate(`(async () => {
  const dm = window.__test.demoManager;
  const f = dm.recorder.buildDemoFile('dual capture client side');
  const { serializeDemo } = await import('/src/demo/demoWriter.js');
  const buf = new Uint8Array(serializeDemo(f));
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) {s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CH)));}
  return btoa(s);
})()`);
mkdirSync('demos_out', { recursive: true });
const path = 'demos_out/dual_client.demo';
writeFileSync(path, Buffer.from(b64, 'base64'));
console.log('WROTE', path);
await closeClient(c);
