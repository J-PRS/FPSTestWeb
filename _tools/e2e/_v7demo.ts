import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { writeFileSync } from 'node:fs';

// Record a short v7 demo headlessly (classic aim mode — balls solo),
// pull the serialized bytes out of the page, save next to demos_out.
const stack = await upStack();
const c = await launchClient(stack.clientUrl('&room=v7demo-0&bots=2&mode=classic'));
await c.waitFor(`window.__test && window.__test.demoManager`, 30000);
// Let the run accumulate ~25s of recorded play.
await new Promise((r) => setTimeout(r, 25_000));
const b64 = await c.page.evaluate(`(async () => {
  const dm = window.__test.demoManager;
  const f = dm.recorder.buildDemoFile();
  const { serializeDemo } = await import('/src/demo/demoWriter.js');
  const buf = new Uint8Array(serializeDemo(f));
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) {s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CH)));}
  return btoa(s);
})()`);
const path = 'demos_out/v7_seed_test.demo';
writeFileSync(path, Buffer.from(b64, 'base64'));
console.log('WROTE', path);
await closeClient(c); stack.down();
