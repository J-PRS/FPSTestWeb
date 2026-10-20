import { launchClient, closeClient } from './browser.ts';
import { writeFileSync, mkdirSync } from 'node:fs';

// Record a REAL botfight demo: headless client joins the live CTF room on
// the local server (same box the cloudflared tunnel fronts), watches ~75s
// of 7-bot combat, extracts the serialized .demo, then hands off to
// `bun _tools/demoAudit.ts` for the structural/kinematic/lifecycle checks.
const c = await launchClient(`http://localhost:5400/s/demoaudit?server=localhost:8000&mode=ctf&bots=8`);
await c.waitFor(`window.__test && window.__test.demoManager && window.__test.networkManager && window.__test.networkManager.isConnected()`, 45000);
console.log('seated — recording 75s of live play');
await new Promise((r) => setTimeout(r, 75_000));
const b64 = await c.page.evaluate(`(async () => {
  const dm = window.__test.demoManager;
  const f = dm.recorder.buildDemoFile('live botfight CTF soak');
  const { serializeDemo } = await import('/src/demo/demoWriter.js');
  const buf = new Uint8Array(serializeDemo(f));
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) {s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CH)));}
  return btoa(s);
})()`);
mkdirSync('demos_out', { recursive: true });
const path = 'demos_out/live_botfight.demo';
writeFileSync(path, Buffer.from(b64, 'base64'));
console.log('WROTE', path);
await closeClient(c);
