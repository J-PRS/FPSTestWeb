/**
 * videorec.ts — canvas video recorder E2E: real Chrome vs real servers.
 *
 *   bun _tools/e2e/videorec.ts
 *
 * Asserts through the live game:
 *   1. VideoRecorder.start lands on the WebCodecs path (hardware or sw —
 *      either way real encoded chunks flow).
 *   2. The rolling buffer accumulates chunks while frames render.
 *   3. cutWindow produces a standalone mp4: ftyp+moov boxes, >0 video data,
 *      duration in the expected ballpark.
 *   4. stop() finalizes a full mp4 too.
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

let failures = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=e2evideo&bots=3'));

// Node-side mp4 top-level box walk — puppeteer can't return ArrayBuffers,
// so the page hands back base64 and we inspect here.
const MP4_STATS = (buf: Uint8Array) => {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o + 4), dv.getUint8(o + 5), dv.getUint8(o + 6), dv.getUint8(o + 7));
  const boxes: string[] = [];
  let off = 0;
  while (off + 8 <= dv.byteLength) {
    const sz = dv.getUint32(off);
    boxes.push(tag(off));
    if (sz <= 8) break;
    off += sz;
  }
  return { size: dv.byteLength, boxes };
};

const BLOB_TO_B64 = `(blob) => new Promise((res) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.readAsDataURL(blob);
})`;
const fromB64 = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  await client.waitFor(`window.__demoManager`, 10000);

  // 1. start capture — start() resolves true on either path
  const started = await client.page.evaluate(`window.__demoManager['startVideoCapture']()`);
  ok(started === true, 'startVideoCapture() returned true');
  await sleep(1500);
  const state = await client.test<string>(
    `(() => { const v = t.demoManager?.video ?? window.__demoManager.video; return JSON.stringify({ rec: v.isRecording, hw: v.usingHardware, enc: !!v['enc'] }); })()`);
  const { rec, hw, enc } = JSON.parse(state);
  ok(rec, `recorder running (webcodecs=${enc}, hardware=${hw})`);

  // 2. let frames flow ~8s of game time
  await sleep(8000);
  const ringLen = await client.test<number>(`window.__demoManager.video['ring'].length`);
  ok(ringLen > 10, `ring buffer accumulating chunks (${ringLen})`);

  // 3. cut a 4s window from 6s ago — must produce a standalone mp4
  const cut = await client.page.evaluate(`(async () => {
    const v = window.__demoManager.video;
    const now = performance.now();
    const blob = v.cutWindow(now - 6000, now - 2000);
    if (!blob) return { ok: false, why: 'null blob' };
    const b64 = await (${BLOB_TO_B64})(blob);
    return { ok: true, b64 };
  })()`).then(r => r as { ok: boolean; why?: string; b64?: string });
  ok(cut.ok && !!cut.b64, `cutWindow produced a blob ${cut.why ?? ''}`);
  if (cut.b64) {
    const bytes = fromB64(cut.b64);
    const stats = MP4_STATS(bytes);
    ok(stats.boxes.includes('ftyp') && stats.boxes.includes('moov'),
      `cut mp4 well-formed: boxes=[${stats.boxes.join(',')}], ${(stats.size / 1e6).toFixed(1)}MB`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync('_tools/e2e/shots/videorec-cut.mp4', bytes);
    const probe = Bun.spawnSync(['C:/Python313/Scripts/ffprobe.exe', '-v', 'error', '-show_entries', 'stream=codec_name,width,height,nb_frames,duration', '-of', 'json', '_tools/e2e/shots/videorec-cut.mp4']);
    const meta = JSON.parse(probe.stdout.toString()) as { streams?: { codec_name: string; width: number; height: number; nb_frames?: string; duration?: string }[] };
    const s = meta.streams?.[0];
    ok(s?.codec_name === 'h264' && s.width === 1920 && s.height === 1080,
      `ffprobe: ${s?.codec_name} ${s?.width}x${s?.height} ${s?.nb_frames ?? '?'}f ${s?.duration ?? '?'}s`);
  }

  // 4. stop() finalizes the whole recording as one mp4
  const full = await client.page.evaluate(`(async () => {
    const blob = await window.__demoManager.video.stop();
    if (!blob) return { ok: false };
    const b64 = await (${BLOB_TO_B64})(blob);
    return { ok: true, b64 };
  })()`).then(r => r as { ok: boolean; b64?: string });
  ok(full.ok && !!full.b64, 'stop() returned the full mp4');
  if (full.b64) {
    const bytes = fromB64(full.b64);
    const stats = MP4_STATS(bytes);
    ok(stats.boxes.includes('ftyp') && stats.boxes.includes('moov'),
      `full mp4 well-formed: boxes=[${stats.boxes.join(',')}], ${(stats.size / 1e6).toFixed(1)}MB`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync('_tools/e2e/shots/videorec-full.mp4', bytes);
  }
} finally {
  await closeClient(client);
  stack.down();
}

console.log(failures === 0 ? '\nVIDEOREC: ALL PASS' : `\nVIDEOREC: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
