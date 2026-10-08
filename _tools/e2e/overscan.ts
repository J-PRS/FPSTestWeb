// Canonical-16:9 overscan probe: at a non-16:9 viewport the render canvas
// must be a 16:9 box covering the window, camera.aspect = 16/9.
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=e2eover&bots=1'));
const page = client.page;
await page.setViewport({ width: 900, height: 700 });
await client.waitFor(`t.rendererSetup && t.rendererSetup.renderer`, 30000);
await sleep(1500);

const info = await page.evaluate(() => {
  const t = (window as unknown as { __test?: { rendererSetup?: { renderer?: { domElement?: HTMLCanvasElement } } } }).__test;
  const cv = t?.rendererSetup?.renderer?.domElement;
  return { cw: cv?.width ?? 0, ch: cv?.height ?? 0,
    sw: cv ? parseInt(cv.style.width) : 0, sh: cv ? parseInt(cv.style.height) : 0,
    winW: window.innerWidth, winH: window.innerHeight };
});
console.log(JSON.stringify(info));
const expH = info.winH, expW = Math.ceil(expH * 16 / 9);
// CSS box must cover the window at 16:9; the buffer may be auto-degraded.
const ok = Math.abs(info.sw - expW) <= 2 && Math.abs(info.sh - expH) <= 2 &&
  Math.abs(info.cw / info.ch - 16 / 9) < 0.01;
console.log(ok ? 'PASS overscan: 16:9 canvas covers a non-16:9 window' : `FAIL expected ~${expW}x${expH}`);
await closeClient(client);
await stack.down();
process.exit(ok ? 0 : 1);
