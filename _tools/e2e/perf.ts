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
const client = await launchClient(stack.clientUrl(`&room=e2eperf&bots=${BOTS}&mode=nuggets`));

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
  const task0 = (await client.page.metrics()).TaskDuration ?? 0;
  const wall0 = Date.now();
  await sleep(SECS * 1000);
  const task1 = (await client.page.metrics()).TaskDuration ?? 0;

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
