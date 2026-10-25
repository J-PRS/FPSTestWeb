/**
 * perf.ts — frame-time regression harness.
 *
 *   bun _tools/e2e/perf.ts [--bots 8] [--secs 20] [--out _tools/e2e/baseline.json]
 *
 * Boots the real client headless in a busy room and samples rAF frame
 * deltas INSIDE the page — the same clock the render loop sees. Reports
 * median/p95/p99 frame ms, fps, and long-frame counts (>25ms, >50ms).
 *
 * Under SwiftShader absolute numbers are software-rendered, not your GPU
 * — use this for REGRESSION DIFFS against a saved baseline, not absolute
 * 60fps claims. `--out baseline.json` writes the sample for a later run's
 * `--compare baseline.json` to diff against.
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const BOTS = +arg('bots', '8');
const SECS = +arg('secs', '20');
const OUT = arg('out', '');
const COMPARE = arg('compare', '');

interface PerfSample {
  bots: number;
  frames: number;
  fps: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  over25: number;   // frames slower than a 40fps budget
  over50: number;   // frames slower than 20fps — visible hitches
  longestMs: number;
  /** Fraction of wall time the main thread spent in JS (0-1) —
   *  GPU-independent: SwiftShader raster is excluded from this signal
   *  only partially, but game-logic/sim/net cost shows up cleanly. */
  jsBusyFrac: number;
  memMb: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stack = await upStack();
const client = await launchClient(stack.clientUrl(`&room=e2eperf&bots=${BOTS}&mode=${arg('mode', 'nuggets')}&map=${arg('map', 'escalade')}&nocreatures=1&noballs=1&gpuperf=1${arg('extra', '')}`));

try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  await client.waitFor(`t.world.remotePlayers.entities.size >= 1`, 20000);

  // Sample rAF deltas in-page — the render loop's own clock.
  await client.page.evaluate(`(() => {
    window.__frames = [];
    let last = performance.now();
    const loop = (t) => { window.__frames.push(t - last); last = t; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  })()`);

  // Warm-up: spawn-in burst skews the first seconds.
  await sleep(3000);
  await client.page.evaluate(`window.__frames = []`);

  // CDP Profiler flame (--cpu N seconds): real function-level self-time,
  // the 'no guessing' answer to which JS function eats the frame.
  const cpuSecs = +arg('cpu', '0');
  let cdp: Awaited<ReturnType<typeof client.page.createCDPSession>> | null = null;
  if (cpuSecs > 0) {
    cdp = await client.page.createCDPSession();
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Profiler.start');
  }
  const task0 = (await client.page.metrics()).TaskDuration ?? 0;
  const wall0 = Date.now();
  await sleep(SECS * 1000);
  const task1 = (await client.page.metrics()).TaskDuration ?? 0;

  let cpuProfile: { profile?: { nodes?: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }[]; timeDeltas?: number[]; samples?: number[] } } | null = null;
  if (cdp) {
    await sleep(cpuSecs * 1000);
    cpuProfile = await cdp.send('Profiler.stop') as typeof cpuProfile;
  }

  const deltas = await client.test<number[]>(`window.__frames`);
  deltas.sort((a, b) => a - b);
  const n = deltas.length;
  const q = (p: number) => deltas[Math.min(n - 1, Math.floor(n * p))]!;
  const mem = await client.page.metrics().then((m) => (m.JSHeapUsedSize ?? 0) / 1048576).catch(() => null);

  const sample: PerfSample = {
    bots: BOTS,
    frames: n,
    fps: +(1000 / (deltas.reduce((s, d) => s + d, 0) / n)).toFixed(1),
    medianMs: +q(0.5).toFixed(2),
    p95Ms: +q(0.95).toFixed(2),
    p99Ms: +q(0.99).toFixed(2),
    over25: deltas.filter((d) => d > 25).length,
    over50: deltas.filter((d) => d > 50).length,
    longestMs: +deltas[n - 1]!.toFixed(1),
    jsBusyFrac: +((task1 - task0) / ((Date.now() - wall0) / 1000)).toFixed(3),
    memMb: mem !== null ? +mem.toFixed(0) : null,
  };

  console.log(`PERF bots=${BOTS} frames=${n} | fps=${sample.fps} median=${sample.medianMs}ms p95=${sample.p95Ms}ms p99=${sample.p99Ms}ms | >25ms:${sample.over25} >50ms:${sample.over50} worst=${sample.longestMs}ms | jsBusy=${(sample.jsBusyFrac * 100).toFixed(1)}% heap=${sample.memMb}MB`);

  // Phase attribution — __perf() is the gameLoop's own EMA table
  // (sim/fx/hud/render + budget + draws). A median that grew is only
  // half an answer; this says which subsystem grew it.
  const ph = await client.test<Record<string, number>>(`window.__perf ? window.__perf() : null`).catch(() => null);
  if (ph) {
    const row = Object.entries(ph)
      .filter(([k, v]) => k !== 'frame' && typeof v === 'number' && v >= 0.5)
      .map(([k, v]) => `${k}=${v.toFixed(1)}`)
      .join(' ');
    console.log(`  phases frame=${(ph.frame ?? 0).toFixed(1)}ms | ${row}`);
  }

  // Per-pass GPU ms (?gpuperf=1) — real raster time per composer pass,
  // unfuzzed under --enable-webgl-developer-extensions. This is the
  // 'exactly which pass costs what' table, not a phase estimate.
  const gp = await client.test<{ pass: string; avgMs: number; maxMs: number; n: number }[]>(
    `window.__gpuPass ? window.__gpuPass() : null`).catch(() => null);
  if (gp?.length) {
    for (const r of gp) {
      console.log(`  gpu:pass ${r.pass} avg=${r.avgMs.toFixed(2)}ms max=${r.maxMs.toFixed(2)}ms n=${r.n}`);
    }
  }

  // Draw-call census: visible meshes grouped by class name + parent —
  // 'which objects cost the 300 calls', grouped so instanced pools
  // (one mesh, many slots) report correctly.
  const census = await client.test<Record<string, number>>(`(() => {
    const scene = t.scene;
    if (!scene) {return null;}
    const counts = {};
    scene.traverse((o) => {
      if (!o.visible) {return;}
      if (!o.isMesh && !o.isSkinnedMesh && !o.isLine && !o.isPoints && !o.isSprite) {return;}
      let n = o;
      while (n && !n.name && n !== scene) {n = n.parent;}
      const chain = [];
      let c = o;
      while (c && chain.length < 3) {chain.push(c.name || c.type); c = c.parent;}
      const mat = o.material;
      const matKey = mat ? (mat.name || mat.type + '#' + String(mat.id)) : '-';
      const k = (o.name ? o.name : o.type) + '|' + chain.join('<') + '|' + matKey;
      counts[k] = (counts[k] ?? 0) + 1;
    });
    return counts;
  })()`).catch(() => null);
  if (census) {
    const top = Object.entries(census).sort((a, b) => b[1] - a[1]).slice(0, 15);
    console.log(`  drawcensus ${top.map(([k, v]) => `${k}:${v}`).join(' ')}`);
  }

  if (cpuProfile?.profile?.nodes && cpuProfile.profile.samples && cpuProfile.profile.timeDeltas) {
    const nodes = new Map(cpuProfile.profile.nodes.map((n) => [n.id, n]));
    const selfMs = new Map<number, number>();
    cpuProfile.profile.samples.forEach((id, i) => {
      const dt = (cpuProfile.profile!.timeDeltas![i] ?? 0) / 1000; // µs → ms
      selfMs.set(id, (selfMs.get(id) ?? 0) + dt);
    });
    const rows = [...selfMs.entries()]
      .map(([id, ms]) => {
        const f = nodes.get(id)?.callFrame;
        return { name: f?.functionName || '(anon)', file: f ? `${f.url.split('/').pop()}:${f.lineNumber}` : '?', ms };
      })
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 20);
    console.log(`  cpuflame (self ms over ${cpuSecs}s):`);
    for (const r of rows) {console.log(`    ${r.ms.toFixed(1)}ms ${r.name} ${r.file}`);}
  }

  if (COMPARE && existsSync(COMPARE)) {
    const base = JSON.parse(readFileSync(COMPARE, 'utf8')) as PerfSample;
    const d = (k: keyof PerfSample) => `${k}: ${base[k]} → ${sample[k]} (${((sample[k] as number) - (base[k] as number)) >= 0 ? '+' : ''}${((sample[k] as number) - (base[k] as number)).toFixed(1)})`;
    console.log(`  vs ${COMPARE} — ${d('fps')} | ${d('medianMs')} | ${d('p95Ms')} | ${d('jsBusyFrac')} | ${d('over50')}`);
    // Regression gates. jsBusy at +75% is the load-bearing signal: it's
    // frame-count-independent CPU share, stable across noisy runs.
    // p95 sits at 3x because ~70-frame samples put it on ~3 tail frames —
    // SwiftShader spikes swing it 2x run-to-run even when median/jsBusy
    // are flat (verified: +133% p95 with identical median).
    if (sample.p95Ms > base.p95Ms * 3.0) {
      console.log(`REGRESSION: p95 frame time +${((sample.p95Ms / base.p95Ms - 1) * 100).toFixed(0)}% over baseline`);
      process.exit(1);
    }
    if (sample.jsBusyFrac > base.jsBusyFrac * 1.75) {
      console.log(`REGRESSION: JS busy fraction +${((sample.jsBusyFrac / base.jsBusyFrac - 1) * 100).toFixed(0)}% over baseline`);
      process.exit(1);
    }
  }
  if (OUT) {
    writeFileSync(OUT, JSON.stringify(sample, null, 2));
    console.log(`baseline written: ${OUT}`);
  }
} finally {
  await closeClient(client);
  stack.down();
}
