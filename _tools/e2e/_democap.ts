// Record a live demo window and dump the serialized .demo to disk for
// the offline validators. bun _tools/e2e/_democap.ts [secs]
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { writeFileSync, mkdirSync } from 'node:fs';

const secs = Number(process.argv[2] ?? 15);
const stack = await upStack();
let c: Awaited<ReturnType<typeof launchClient>> | null = null;
try {
  c = await launchClient(stack.clientUrl(`&room=democap&map=${process.env.DEMOCAP_MAP ?? 'rimrock'}&mode=${process.env.DEMOCAP_MODE ?? 'ctf'}&bots=8&autopilot`));
  await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 45000);
  await c.waitFor(`window.__demoManager`, 10000);
  const t0 = await c.page.evaluate(`window.__demoManager.recorder.elapsedTime`) as number;
  await new Promise(r => setTimeout(r, secs * 1000));
  const out = await c.page.evaluate(`(async () => {
    const dm = window.__demoManager;
    const f = dm.recorder.buildDemoFile('democap window');
    const { serializeDemo } = await import('/src/demo/demoWriter.js');
    const buf = new Uint8Array(serializeDemo(f));
    let s = ''; const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) {s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CH)));}
    return { t: dm.recorder.elapsedTime, b64: btoa(s) };
  })()`) as { t: number; b64: string };
  mkdirSync('_tools/e2e/out', { recursive: true });
  writeFileSync('_tools/e2e/out/democap.demo', Buffer.from(out.b64, 'base64'));
  console.log(`recorded ${(out.t - t0).toFixed(1)}s -> _tools/e2e/out/democap.demo`);
} finally {
  if (c) {await closeClient(c);}
  await stack.down();
}
