/**
 * democmp.ts — demo-validation E2E: live WebCodecs mp4 vs demo→mp4 render
 * of the SAME bot-driven gameplay window.
 *
 *   E2E_GPU=1 bun _tools/e2e/democmp.ts
 *
 * Flow: autopilot drives the local player through a live MP botfight
 * while the canvas recorder captures real H.264 and the demo recorder
 * captures wire truth. The .demo is then scrub-rendered offline
 * (demorender/render.js --from/--to, anchored via recorder.elapsedTime)
 * and the two videos are compared per-segment on SSIM (vidcmp.ts).
 *
 * The gate is NOT "videos identical" — the demo is authoritative truth,
 * the live clip is rendered beliefs (see _docs/2026-10-27_CLIP_TRUTH_VS_BEAUTY),
 * and particles/VFX are NOT in the demo stream so frames never match
 * pixel-perfect. What the gate bounds: median per-segment SSIM (same
 * scene rendered twice ≈ 0.6 measured; black/frozen/wrong-scene replay
 * collapses it) and lag consistency (clock offset must drift slowly,
 * not jump — jumping means replay desync, not capture jitter).
 *
 *   DEMOCMP_SECONDS=15   capture window
 *   DEMOCMP_SSIM=0.45    gate: median per-segment SSIM
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { vidcmp } from './vidcmp.ts';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT = `${REPO}_tools/e2e/shots`;
const FFPROBE = process.env.FFPROBE ?? 'C:/Python313/Scripts/ffprobe.exe';
const SECONDS = Number(process.env.DEMOCMP_SECONDS ?? 15);
const GATE_SSIM = Number(process.env.DEMOCMP_SSIM ?? 0.45);

let failures = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BLOB_TO_B64 = `(blob) => new Promise((res) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.readAsDataURL(blob);
})`;
const fromB64 = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

const ffprobe = (file: string): { duration: number; fps: number } => {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=r_frame_rate,duration', '-of', 'json', file]).toString();
  const s = JSON.parse(out).streams?.[0] ?? {};
  const [n, d] = String(s.r_frame_rate ?? '30/1').split('/').map(Number);
  return { duration: Number(s.duration ?? 0), fps: n / d };
};

const stack = await upStack();
mkdirSync(OUT, { recursive: true });
try {
  const client = await launchClient(stack.clientUrl('&room=democmp&map=rimrock&mode=ctf&bots=6&autopilot'));
  try {
    await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 45000);
    await client.waitFor(`window.__demoManager`, 10000);

    // Start video + anchor the demo clock at the same instant.
    const t0 = await client.page.evaluate(`(async () => {
      const dm = window.__demoManager;
      const started = await dm['startVideoCapture']();
      return { started, demoT: dm.recorder.elapsedTime };
    })()`).then(r => r as { started: boolean; demoT: number });
    ok(t0.started, 'startVideoCapture() accepted');
    await sleep(SECONDS * 1000);

    // Stop video + demo clock anchor at the same instant.
    const stop = await client.page.evaluate(`(async () => {
      const dm = window.__demoManager;
      const demoT = dm.recorder.elapsedTime;
      const blob = await dm.video.stop();
      const b64 = blob ? await (${BLOB_TO_B64})(blob) : null;
      const f = dm.recorder.buildDemoFile('democmp window');
      const { serializeDemo } = await import('/src/demo/demoWriter.js');
      const buf = new Uint8Array(serializeDemo(f));
      let s = ''; const CH = 0x8000;
      for (let i = 0; i < buf.length; i += CH) {s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CH)));}
      return { demoT, b64, demo: btoa(s) };
    })()`).then(r => r as { demoT: number; b64: string | null; demo: string });

    ok(!!stop.b64, 'video stop() returned an mp4');
    const livePath = `${OUT}/democmp-live.mp4`;
    const demoPath = `${OUT}/democmp.demo`;
    const replayPath = `${OUT}/democmp-replay.mp4`;
    if (stop.b64) writeFileSync(livePath, fromB64(stop.b64));
    writeFileSync(demoPath, Buffer.from(stop.demo, 'base64'));
    console.log(`demo window: elapsedTime ${t0.demoT.toFixed(2)} → ${stop.demoT.toFixed(2)}`);

    // Offline-render the SAME demo window.
    const meta = ffprobe(livePath);
    console.log(`live.mp4: ${meta.duration.toFixed(2)}s @${meta.fps.toFixed(1)}fps`);
    const from = t0.demoT, to = t0.demoT + meta.duration;
    // 640x360@10 is plenty — vidcmp downsamples to 80x45 luma anyway.
    execFileSync('node', [`${REPO}_tools/demorender/render.js`, demoPath, replayPath,
      '--fps=10', '--size=640x360', '--headless',
      `--from=${from.toFixed(3)}`, `--to=${to.toFixed(3)}`,
      `--url=http://localhost:${stack.clientPort}/`], { stdio: 'inherit' });

    // Per-segment SSIM with lag scan — wall-clock video vs demo clock
    // drift needs per-segment alignment; ~0.9s capture lead-in in the
    // live mp4 is normal (encoder warmup), jumping lags are not.
    const r = vidcmp(livePath, replayPath);
    for (const [i, s] of r.segs.entries()) {
      console.log(`  seg ${i * 2}-${i * 2 + 2}s: lag ${s.lag > 0 ? '+' : ''}${s.lag}f ssim=${s.ssim.toFixed(3)}`);
    }
    console.log(`median SSIM ${r.median.toFixed(3)} p5 ${r.p5.toFixed(3)}`);
    ok(r.segs.length >= 3, `enough segments to judge (${r.segs.length})`);
    ok(r.median >= GATE_SSIM, `median SSIM ${r.median.toFixed(3)} ≥ ${GATE_SSIM}`);
  } finally {
    await closeClient(client);
  }
} finally {
  await stack.down();
}

console.log(failures === 0 ? '\nDEMOCMP: ALL PASS' : `\nDEMOCMP: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
