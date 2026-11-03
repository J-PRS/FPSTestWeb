/**
 * gallery.ts — visual-regression sweep over the gunlab catalog.
 *
 *   E2E_GPU=1 bun _tools/e2e/gallery.ts --write   # (re)generate goldens
 *   E2E_GPU=1 bun _tools/e2e/gallery.ts          # diff vs goldens
 *
 * Enumerates every rail pick in gunlab.html (weapons rail + the
 * classes/creatures/items/pickups/structures category select), mounts
 * each through the real pipeline, freezes animated previews at a fixed
 * sim time via window.__lab.freeze(), screenshots, and PSNR-compares
 * against committed goldens in _tools/e2e/golden/.
 *
 * GPU rendering is required for speed and for hardware-truth raster;
 * goldens are box-specific anyway (GPU/Driver variance makes cross-
 * machine pixel equality meaningless — the gate is PSNR + diff map,
 * not bit-exactness).
 *
 *   GALLERY_PSNR=38   per-item pass threshold (default 38 dB)
 *   GALLERY_ONLY=ball,classes   subset by pick label
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, type Subprocess } from 'bun';
import { execFileSync, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core');
const FFMPEG = process.env.FFMPEG ?? 'C:/Python313/Scripts/ffmpeg.exe';

const WRITE = process.argv.includes('--write');
// Gate at 35dB: frozen poses still carry sub-pixel edge AA (~36-38dB
// floor on dark bodies); real breakage (missing mesh, wrong pose,
// material loss) craters well below 25.
const PSNR = Number(process.env.GALLERY_PSNR ?? 35);
const ONLY = process.env.GALLERY_ONLY ? new Set(process.env.GALLERY_ONLY.split(',')) : null;
const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT = resolve(import.meta.dir, '../../_tools/e2e/golden');
const DIFFS = resolve(import.meta.dir, '../../screenshots/gallerydiff');
const CHROME = process.env.CHROME_PATH
  ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p));
const CATS = ['weapons', 'classes', 'items', 'pickups', 'structures', 'creatures'];
// Live-rng previews (species wander) can't pose-deterministically — shot
// artifacts only, never golden-diffed.
const NOGOLD = new Set(['creatures']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const lap = (m: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// --- vite spawn on a probed-free port (env.ts's ghost-port rule, vite-only) ---
const tcpFree = (port: number): Promise<boolean> => new Promise((res) => {
  const s = require('node:net').createServer();
  s.once('error', () => res(false));
  s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
});
/** env.ts ghost-port rule: the cmd-shim grandchild survives kill(). */
function killByPort(port: number): void {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 8000 });
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) {continue;}
      const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && Number(m[1]) === port && Number(m[2]) !== process.pid) {
        try { process.kill(Number(m[2])); } catch { /* gone */ }
      }
    }
  } catch { /* netstat gone */ }
}
async function waitHttp(url: string, timeoutMs = 30000): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    try { if ((await fetch(url)).ok) {return true;} } catch { /* boot */ }
    await sleep(300);
  }
  return false;
}
// bun can't uv_spawn a .cmd shim - ride the cmd host like env.ts's npx.
const VITE_CMD: string[] = process.platform === 'win32'
  ? [process.env.COMSPEC ?? 'cmd.exe', '/c', 'npx', 'vite']
  : ['npx', 'vite'];
let vite: Subprocess | undefined;
let port = 0;
for (let p = 5458; p > 5400; p--) {
  if (await tcpFree(p)) {
    vite = spawn([...VITE_CMD, '--port', String(p), '--strictPort'],
      { cwd: `${REPO}client`, stdout: 'ignore', stderr: 'ignore' });
    if (await waitHttp(`http://localhost:${p}/`, 20000)) { port = p; break; }
    vite.kill();
    killByPort(p);
    continue;
  }
  // Port bound but not serving HTTP: an orphaned grandchild (npx shim
  // survives killed runners) - tcpFree can't bind it yet health answers.
  // Reap and retry the same port once.
  killByPort(p);
  if (await tcpFree(p)) {
    vite = spawn([...VITE_CMD, '--port', String(p), '--strictPort'],
      { cwd: `${REPO}client`, stdout: 'ignore', stderr: 'ignore' });
    if (await waitHttp(`http://localhost:${p}/`, 20000)) { port = p; break; }
    vite.kill();
    killByPort(p);
  }
}
if (!port) { console.error('no free vite port'); process.exit(1); }
lap(`vite on :${port}`);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  // Unique per-launch dir: a PID suffix still collides when Windows
  // recycles the pid of a killed run's orphaned Chrome (which keeps
  // its profile lock alive).
  userDataDir: `${process.env.TEMP ?? 'C:/TEMP'}/gallery-chrome-${Date.now().toString(36)}`,
  args: process.env.E2E_GPU
    ? [`--use-angle=${process.env.E2E_ANGLE ?? 'default'}`, '--mute-audio', '--no-sandbox',
       '--disable-background-networking', '--no-first-run', '--no-proxy-server',
       '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendHeaders,BlockInsecurePrivateNetworkRequests']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 960, height: 800 });
page.on('pageerror', (e) => console.error('[pageerror]', e instanceof Error ? e.message : e));

interface Pick { cat: string; label: string }
const picks: Pick[] = [];
const results: { pick: string; psnr: number | null; note: string }[] = [];
let failures = 0;

try {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(DIFFS, { recursive: true });
  // networkidle0 is fragile - GLB/asset streaming can hold connections
  // past the timeout on a cold vite. Boot proof is the rail buttons.
  await page.goto(`http://localhost:${port}/gunlab.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('document.querySelectorAll("#rail button").length > 0', { timeout: 60000 });
  // Canvas-only shots: chrome stays hidden for the run via !important
  // (the anim rail re-shows itself per-pick when a preview exposes
  // anims - inline display:none gets overridden).
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = '#rail,#animrail,#status{display:none!important}';
    document.head.append(s);
  });
  lap('gunlab up');

  for (const cat of CATS) {
    if (cat !== 'weapons') {
      await page.evaluate((c) => {
        const sel = [...document.querySelectorAll('select')].find((s) =>
          [...s.options].some((o) => o.value === c));
        if (sel) { sel.value = c; sel.dispatchEvent(new Event('change')); }
      }, cat);
      await sleep(400);
    }
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('#rail button')]
        .map((b) => b.textContent?.trim() ?? '')
        .filter((t) => t && !/inspect|sheet|wire|bake|metal|union|shell|wear|⚠|◉|◈|▦|▣|▧/.test(t)));
    for (const label of labels) { picks.push({ cat, label }); }
    lap(`${cat}: ${labels.length} picks`);
  }

  for (const { cat, label } of picks) {
    if (ONLY && !ONLY.has(label)) {continue;}
    const name = `${cat}_${label.replace(/\W+/g, '_')}`;
    // Re-open the category and click the pick.
    await page.evaluate((c, l) => {
      if (c !== 'weapons') {
        const sel = [...document.querySelectorAll('select')].find((s) =>
          [...s.options].some((o) => o.value === c));
        if (sel) { sel.value = c; sel.dispatchEvent(new Event('change')); }
      }
      const btn = [...document.querySelectorAll<HTMLElement>('#rail button')].find((b) => b.textContent?.trim() === l);
      btn?.click();
    }, cat, label);
    // Model loads + AO bake settle; GLBs cache warm after the first few.
    // Classes need the full window: a body that finishes loading DURING
    // the freeze ticks restarts its mixer at a different phase.
    await sleep(cat === 'classes' ? 6500 : 1500);
    // Inspect auto-fit happens at pick time - re-toggle it now that the
    // async GLB is loaded, or the frame fit stale/empty bounds.
    await page.evaluate(() => {
      const state = (window as any).__gunlab;
      const btn = [...document.querySelectorAll<HTMLElement>('#rail button')].find((b) => b.textContent?.includes('inspect'));
      if (state.inspect) { btn?.click(); }
      btn?.click();
      // 'bind' = T-pose for anims-capable previews (deterministic; mixer
      // crossfade phase still flakes run-to-run at 90 fixed ticks).
      (window as any).__lab?.freeze('bind', 90);
    });
    await sleep(700);
    const shot = resolve(DIFFS, `${name}.png`);
    await page.screenshot({ path: shot });

    const golden = resolve(OUT, `baseline_${name}.png`);
    if (WRITE) {
      copyFileSync(shot, golden);
      results.push({ pick: name, psnr: null, note: 'golden written' });
      continue;
    }
    if (!existsSync(golden)) { results.push({ pick: name, psnr: null, note: 'NO GOLDEN' }); failures++; continue; }
    if (NOGOLD.has(cat)) { results.push({ pick: name, psnr: null, note: 'live (no diff)' }); continue; }
    // ffmpeg PSNR + a visual diff map for the artifact dir. PSNR stats
    // print on STDERR (ffmpeg convention) - spawnSync keeps both lanes.
    const diffPng = resolve(DIFFS, `diff_${name}.png`);
    let psnr = Infinity;
    try {
      const r = spawnSync(FFMPEG, ['-y', '-i', shot, '-i', golden,
        '-filter_complex', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' });
      const m = `${r.stdout ?? ''}${r.stderr ?? ''}`.match(/average:(\d+\.?\d*|inf)/);
      psnr = m ? (m[1] === 'inf' ? Infinity : Number(m[1])) : 0;
    } catch { psnr = 0; }
    if (psnr < PSNR) {
      execFileSync(FFMPEG, ['-y', '-i', shot, '-i', golden, '-filter_complex',
        'blend=all_mode=difference', diffPng], { stdio: 'ignore' });
      failures++;
    }
    results.push({ pick: name, psnr, note: psnr >= PSNR ? 'ok' : 'DIFF' });
  }
} finally {
  await browser.close();
  vite?.kill();
  if (port) {killByPort(port);}
}

for (const r of results) {
  console.log(`${r.note === 'ok' ? 'PASS' : r.psnr === null ? 'INFO' : 'FAIL'}  ${r.pick}${r.psnr === null ? '' : `  psnr=${r.psnr === Infinity ? 'inf' : r.psnr.toFixed(1)}`}${r.note !== 'ok' ? `  ${r.note}` : ''}`);
}
console.log(`\nGALLERY: ${WRITE ? `${results.length} goldens written` : `${results.length - failures}/${results.length} items green`}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
process.exit(failures === 0 ? 0 : 1);
