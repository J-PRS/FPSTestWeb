// demorender — offline .demo → .mp4 converter.
//
// Deterministic scrub render: seeks the demo clock to each output frame time
// (NOT wall-clock capture), grabs the WebGL canvas straight from RAM
// (toDataURL, falling back to CDP screenshot if preserveDrawingBuffer is off),
// and pipes JPEG bytes into `ffmpeg -f image2pipe` on stdin — zero temp files,
// zero disk writes except the final mp4.
//
// Usage:
//   node render.js <file.demo> [out.mp4] [--fps=30] [--size=1280x720]
//                  [--crf=19] [--url=http://localhost:5302] [--headless]
//                  [--chrome="C:\path\to\chrome.exe"]
//
// Needs a running vite dev server (--url or auto-detect ports 5300-5310).
// Headed (default) uses the real GPU — much faster than headless SwiftShader.
// -framerate MUST precede -i on ffmpeg's args: as an input option placed after
// the pipe it gets ignored and the timeline silently stretches (puppeteer
// shipped exactly that bug in their screencast recorder).

const puppeteer = require('puppeteer-core');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

// ---------- args ----------
const argv = process.argv.slice(2);
const pos = argv.filter(a => !a.startsWith('--'));
const opt = Object.fromEntries(
  argv.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? true];
  })
);
const demoFile = pos[0];
const outFile = pos[1] || (demoFile ? demoFile.replace(/\.demo$/i, '') + '.mp4' : null);
const FPS = Number(opt.fps || 30);
const CRF = Number(opt.crf || 19);
const HEADLESS = !!opt.headless;
const [W, H] = String(opt.size || '1280x720').split('x').map(Number);
const CHROME = opt.chrome || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const REALTIME = !!opt.realtime;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (!demoFile || !fs.existsSync(demoFile)) {
  console.error('usage: node render.js <file.demo> [out.mp4] [--fps=30] [--size=1280x720] [--headless]');
  process.exit(1);
}

// ---------- find dev server ----------
async function tryUrl(url) {
  return new Promise((resolve) => {
    http.get(url, res => resolve(res.statusCode < 500)).on('error', () => resolve(false));
  });
}
async function findServer() {
  if (opt.url) return String(opt.url);
  for (let p = 5300; p <= 5310; p++) {
    const u = `http://localhost:${p}/`;
    if (await tryUrl(u)) return u;
  }
  return null;
}

(async () => {
  const url = await findServer();
  if (!url) { console.error('no vite dev server on :5300-5310 — start one (cd client && npm run dev) or pass --url='); process.exit(1); }
  console.log(`server ${url}  size ${W}x${H}  fps ${FPS}  crf ${CRF}  ${HEADLESS ? 'headless' : 'headed'}`);

  // ---------- ffmpeg encoder: frames in via stdin, mp4 out ----------
  // Prefer GPU encoders (NVENC/AMF/QSV) when present — encodes faster than
  // realtime and leaves the CPU for the renderer.
  const encoderList = (() => { try { return execSync('ffmpeg -hide_banner -encoders').toString(); } catch { return ''; } })();
  const encArgs =
    opt.encoder === 'x264' ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(CRF)] :
    /h264_nvenc/.test(encoderList) ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', String(CRF)] :
    /h264_amf/.test(encoderList) ? ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(CRF)] :
    /h264_qsv/.test(encoderList) ? ['-c:v', 'h264_qsv', '-global_quality', String(CRF)] :
    ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(CRF)];
  console.log('encoder:', encArgs[1]);
  // Frame format decided after the page is up (rawvideo if readPixels works,
  // jpeg_pipe otherwise). ffmpeg is spawned lazily once we know.
  let ffmpeg = null;
  let encDone = null;
  const startEncoder = (mode, cw, ch) => {
    console.log(`frame path: ${mode} ${mode === 'raw' ? `(${cw}x${ch})` : ''}`);
    ffmpeg = spawn('ffmpeg', mode === 'raw' ? [
      '-y',
      '-f', 'rawvideo',
      '-pixel_format', 'rgba',
      '-video_size', `${cw}x${ch}`,
      '-framerate', String(FPS),
      '-i', 'pipe:0',
      '-vf', 'vflip', // GL rows are bottom-up
      ...encArgs,
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outFile,
    ] : [
      '-y',
      '-f', 'image2pipe',
      '-framerate', String(FPS),
      '-i', 'pipe:0',
      ...encArgs,
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outFile,
    ], { stdio: ['pipe', 'inherit', 'pipe'] });
    ffmpeg.stderr.on('data', d => { const s = d.toString(); if (/error|failed/i.test(s)) process.stderr.write(s); });
    encDone = new Promise((res, rej) => ffmpeg.on('close', c => c === 0 ? res() : rej(new Error('ffmpeg exit ' + c))));
  };

  // ---------- browser ----------
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS ? 'new' : false,
    args: [
      `--window-size=${W},${H + 80}`,
      '--mute-audio',
      '--no-sandbox',
      ...(HEADLESS ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []),
    ],
    defaultViewport: { width: W, height: H },
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('[pageerror]', e.message));

  // Pointer lock can't engage without a real gesture/headless flag — stub it
  // so the demo's playback path (lock compare vs rendererCanvas) runs.
  await page.evaluateOnNewDocument(() => {
    window.__lockedEl = null;
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get() { return window.__lockedEl; }, configurable: true,
    });
    Element.prototype.requestPointerLock = function () {
      window.__lockedEl = this;
      queueMicrotask(() => document.dispatchEvent(new Event('pointerlockchange')));
      return Promise.resolve();
    };
    document.exitPointerLock = function () {
      window.__lockedEl = null;
      queueMicrotask(() => document.dispatchEvent(new Event('pointerlockchange')));
    };
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction('window.__demoManager && window.__demoManager.isRecording === true', { timeout: 60000 });

  // ---------- load the demo file through the real UI path ----------
  const input = await page.$('#demo-ui input[type=file]');
  await input.uploadFile(path.resolve(demoFile));
  await page.waitForFunction('window.__demoManager.player.isLoaded === true', { timeout: 10000 });

  const duration = await page.evaluate(() => window.__demoManager.player.duration);
  const totalFrames = Math.max(1, Math.round(duration * FPS));
  console.log(`demo loaded: ${duration.toFixed(2)}s → ${totalFrames} frames`);

  // ---------- enter playback, hide ALL chrome ----------
  await page.evaluate((realtime) => {
    const dm = window.__demoManager;
    // Start via togglePlayPause so onPlaybackStart fires (playbackMode, hidden
    // live remotes, overlay close — the full replay-setup path).
    dm.togglePlayPause();
    if (!realtime) dm.player.pause(); // scrubbed renders own the demo clock;
    // realtime leaves it playing at 1×.

    // Hide every element except the render canvas (and its ancestors).
    const canvas = document.querySelector('canvas');
    let el = canvas;
    const keep = new Set();
    while (el) { keep.add(el); el = el.parentElement; }
    document.body.querySelectorAll('*').forEach(n => { if (!keep.has(n) && !n.contains(canvas)) n.style.display = 'none'; });
    document.body.style.background = '#000';
  }, REALTIME);
  await sleep(300);

  // ---------- frame pump ----------
  // scrubTo() emits only the events inside (prev,t] — O(delta) per frame —
  // vs seek() which tears down and rebuilds every playback object.
  //
  // Fast path: gl.readPixels on the same context, called inside a rAF so it
  // runs right after the game's own render in that frame (safe without
  // preserveDrawingBuffer). Slow path: CDP screenshot (compositor capture).
  let mode = null;
  const frameAt = async (t) => {
    const raw = await page.evaluate(async (tSec) => {
      const dm = window.__demoManager;
      dm.player.scrubTo(tSec);
      dm.onRemotePlayback?.(dm.player.getRemoteStates(), 0);
      // Order matters: the game re-registers its rAF every frame, so a rAF
      // registered now runs AFTER next frame's render → the drawing buffer
      // still holds the rendered image when we read it.
      const pixels = await new Promise(res => {
        requestAnimationFrame(() => {
          const canvas = document.querySelector('canvas');
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
          if (!gl) return res(null);
          window.__rw = canvas.width; window.__rh = canvas.height;
          const buf = new Uint8Array(canvas.width * canvas.height * 4);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          const nonzero = buf.some((v, i) => (i & 3) !== 3 && v !== 0);
          if (!nonzero) return res(null);
          // base64 crosses the CDP boundary far faster than a JSON array
          let s = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < buf.length; i += CHUNK) {
            s += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
          }
          res(btoa(s));
        });
      });
      return pixels ? { raw: true, b64: pixels, w: window.__rw, h: window.__rh } : { raw: false };
    }, t);
    if (raw.raw) {
      if (mode !== 'raw') { mode = 'raw'; startEncoder('raw', raw.w, raw.h); }
      return Buffer.from(raw.b64, 'base64');
    }
    if (mode !== 'jpeg') { mode = 'jpeg'; startEncoder('jpeg'); }
    return page.screenshot({ type: 'jpeg', quality: 92, encoding: 'binary' });
  };

  const t0 = Date.now();
  if (REALTIME) {
    // ---------- realtime capture ----------
    // CDP screencast: the compositor hands us each frame it produces — that
    // IS the realtime path (no RAF stepping, no per-frame screenshot call).
    // Frames arrive as jpeg at whatever rate the machine sustains; ffmpeg
    // timestamps them at --fps intervals, so a GPU that keeps 60fps yields a
    // clean 60fps file. Screencast needs headed Chrome or --headless=new.
    const cdp = await page.createCDPSession();
    mode = 'jpeg';
    startEncoder('jpeg');
    let n = 0;
    await page.evaluate(() => {
      const dm = window.__demoManager;
      dm.player.play(); // resume real-time playback (was paused for scrub)
    });
    cdp.on('Page.screencastFrame', async (ev) => {
      cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
      const buf = Buffer.from(ev.data, 'base64');
      n++;
      if (!ffmpeg.stdin.write(buf)) ffmpeg.stdin.once('drain', () => {});
      if (n % (FPS * 2) === 0) process.stdout.write(`\r  ${n} frames (realtime)`);
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
    await sleep(Math.ceil(duration * 1000) + 1500); // clip length + tail margin
    await cdp.send('Page.stopScreencast').catch(() => {});
    ffmpeg.stdin.end();
    await encDone;
    await browser.close();
    console.log(`\nDONE ${outFile}  (${n} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return;
  }

  for (let i = 0; i <= totalFrames; i++) {
    const t = Math.min(duration, i / FPS);
    const buf = await frameAt(t);
    // backpressure: drain when stdin buffer fills
    if (!ffmpeg.stdin.write(buf)) await new Promise(r => ffmpeg.stdin.once('drain', r));
    if (i % (FPS * 2) === 0) {
      const rate = i / ((Date.now() - t0) / 1000 || 1);
      process.stdout.write(`\r  ${i}/${totalFrames} frames (${rate.toFixed(1)} fps capture)`);
    }
  }
  ffmpeg.stdin.end();
  await encDone;
  await browser.close();
  console.log(`\nDONE ${outFile}  (${((Date.now() - t0) / 1000).toFixed(1)}s render)`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
