/**
 * profile.ts — deep frame-profiler harness ("Lighthouse for game frames").
 *
 *   bun _tools/e2e/profile.ts [--room PROF] [--bots 10] [--secs 20]
 *                             [--cpu 1] [--out _tools/e2e/profout/run.json]
 *
 * Boots a real client into a live room, arms every instrument we have,
 * then emits one structured report:
 *   - phase table  (__perf EMAs sampled over the run -> mean/p95)
 *   - render stages (__renderScan: scene/shadow/composer/viewmodel
 *                    -> cpuMs + calls + tris + gpuMs each)
 *   - hot functions (JS Self-Profiling API when Document-Policy allows)
 *   - LoAF entries  (every >50ms frame w/ script attribution)
 *   - scene census  (drawables / skinned / bones / material instances)
 *   - GPU drain     (gl.finish timing — portable timer-query stand-in)
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const ROOM = arg('room', 'prof');
const BOTS = arg('bots', '10');
const SECS = +arg('secs', '20');
const CPU = +arg('cpu', '1');
const MAP = arg('map', 'crossfire');
const MODE = arg('mode', 'ctf');
const EXTRA = arg('extra', ''); // e.g. "&noballs=1&nocreatures=1"
const OUT = arg('out', `_tools/e2e/profout/${Date.now()}.json`);

const stack = await upStack();
const c = await launchClient(stack.clientUrl(`&room=${ROOM}&map=${MAP}&bots=${BOTS}&mode=${MODE}${EXTRA}`));
await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
await c.waitFor(`t.world.remotePlayers.entities.size >= 1`, 20000).catch(() => undefined);
await new Promise((r) => setTimeout(r, 5000)); // settle past spawn burst

if (CPU > 1) {
  const cdp = await (c.page as any).createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
}

// Arm in-page instruments: LoAF observer, frame sampler, GPU drain
// (gl.finish), JS self-profiler when the policy header allows it.
await c.page.evaluate(`(() => {
  window.__prof = { loaf: [], perf: [], jsprof: null, gpu: [] };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        window.__prof.loaf.push({
          dur: +e.duration.toFixed(1),
          block: +e.blockingDuration.toFixed(1),
          scripts: e.scripts.map((s) => ({
            fn: s.sourceFunctionName || s.invoker,
            ms: +s.duration.toFixed(1),
            file: s.sourceURL.split('/').pop(),
            forced: +s.forcedStyleAndLayoutDuration.toFixed(1),
          })),
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch (e) { window.__prof.loafErr = String(e); }
  // GPU drain: finish() round-trip = real GPU cost incl. backpressure.
  const gl = window.__renderer.getContext();
  const G = window.__prof.gpu;
  const origRender = window.__renderer.render.bind(window.__renderer);
  window.__renderer.render = (s, cam) => {
    const t0 = performance.now();
    origRender(s, cam);
    gl.finish();
    G.push(performance.now() - t0);
    if (G.length > 4000) {G.shift();}
  };
  // JS self-profiler (Document-Policy: js-profiling must be served).
  if (typeof Profiler === 'function') {
    window.__prof.jsprof = new Profiler({ sampleInterval: 10, maxBufferSize: 100000 });
  }
  window.__profTimer = setInterval(() => {
    if (window.__perf) {window.__prof.perf.push({ t: performance.now(), s: window.__perf() });}
  }, 2000);
})()`);

await new Promise((r) => setTimeout(r, SECS * 1000));

const data = await c.page.evaluate(`(async () => {
  clearInterval(window.__profTimer);
  const P = window.__prof;
  const quant = (a, q) => { if (!a.length) {return 0;} const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(2); };
  const gpu = P.gpu;
  const gpuStats = { n: gpu.length, p50: quant(gpu, 0.5), p95: quant(gpu, 0.95), p99: quant(gpu, 0.99), max: gpu.length ? +Math.max(...gpu).toFixed(1) : 0 };
  // Phase table: mean + p95 across 2s snapshots (EMAs inside each).
  const phases = {};
  for (const { s } of P.perf) {
    for (const [k, v] of Object.entries(s)) {
      if (typeof v !== 'number' || k.startsWith('w:') || k.startsWith('max:')) {continue;}
      (phases[k] ??= []).push(v);
    }
  }
  const phaseTable = Object.fromEntries(Object.entries(phases)
    .map(([k, a]) => [k, { mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2), max: +Math.max(...a).toFixed(2), n: a.length }])
    .sort((a, b) => b[1].mean - a[1].mean));
  // JS profiler -> aggregated self-time per function.
  let hot = null;
  if (P.jsprof) {
    const trace = await P.jsprof.stop();
    const self = new Map(), total = new Map();
    const frames = trace.frames || [];
    const stacks = trace.stacks || [];
    const nameOf = (fi) => {
      const f = frames[fi];
      return f ? (f.name || '(anon)') + ' @' + (f.url || '').split('/').pop() + ':' + (f.line ?? '?') : '?';
    };
    for (const s of trace.samples || []) {
      let stackId = s.stackId, leafKey = null;
      const seen = new Set();
      while (stackId != null) {
        const st = stacks[stackId];
        if (!st) {break;}
        const key = nameOf(st.frameId);
        if (leafKey === null) {leafKey = key; self.set(key, (self.get(key) || 0) + 1);}
        if (!seen.has(key)) {seen.add(key); total.set(key, (total.get(key) || 0) + 1);}
        stackId = st.parentId;
      }
    }
    const n = (trace.samples || []).length || 1;
    hot = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
      .map(([k, v]) => ({ fn: k, self: +(100 * v / n).toFixed(1), total: +(100 * (total.get(k) || 0) / n).toFixed(1) }));
  }
  // Census
  const cens = (() => {
    const sc = window.__scene, st = { objs: 0, skin: 0, bones: 0, inst: 0, mats: new Set() };
    sc.traverse((o) => {
      st.objs++;
      if (o.isSkinnedMesh) {st.skin++; st.bones += o.skeleton?.bones?.length || 0;}
      if (o.isInstancedMesh) {st.inst++;}
      if (o.isMesh || o.isSkinnedMesh) {(Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => st.mats.add(m.uuid));}
    });
    return { ...st, mats: st.mats.size };
  })();
  return { perfSnaps: P.perf.length, loaf: P.loaf, loafErr: P.loafErr, gpuStats, phaseTable, hot, cens };
})()`);

// RenderScan AFTER profiling (it renders extra bursts — disturbs live sampling)
const scan = await c.page.evaluate(`window.__renderScan ? window.__renderScan(8) : null`).catch(() => null);

if (CPU > 1) {
  const cdp = await (c.page as any).createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
}
await closeClient(c); stack.down();

const report = {
  meta: { room: ROOM, map: MAP, bots: +BOTS, secs: SECS, cpuThrottle: CPU, extra: EXTRA, when: new Date().toISOString() },
  phases: data.phaseTable,
  renderStages: scan,
  gpuDrainMs: data.gpuStats,
  hotFunctions: data.hot,
  loaf: data.loaf.slice(-40),
  loafErr: data.loafErr,
  census: data.cens,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2));

// Console summary — Unity-profiler-ish phase table + top offenders.
console.log(`\nPROFILE ${ROOM} cpu=${CPU}x secs=${SECS} -> ${OUT}`);
console.log(`\n== phases (mean ms / max) ==`);
for (const [k, v] of Object.entries(data.phaseTable).slice(0, 18)) {
  console.log(`  ${k.padEnd(12)} ${String(v.mean).padStart(7)} / ${v.max}`);
}
if (scan) {
  console.log(`\n== render stages (cpuMs / calls / tris / gpuMs) ==`);
  for (const [k, v] of Object.entries(scan)) {
    console.log(`  ${k.padEnd(14)} ${v.cpuMs}ms / ${v.calls}c / ${Math.round(v.tris / 1000)}kt / ${v.gpuMs ?? '-'}ms`);
  }
}
console.log(`\n== gpu drain == ${JSON.stringify(data.gpuStats)}`);
if (data.hot) {
  console.log(`\n== hot functions (self% / total%) ==`);
  for (const h of data.hot.slice(0, 15)) {console.log(`  ${String(h.self).padStart(5)}% / ${String(h.total).padStart(5)}%  ${h.fn}`);}
} else {console.log(`\n== hot functions == unavailable (js-profiling header?)`);}
if (data.loaf.length) {
  console.log(`\n== LoAF (${data.loaf.length} long frames) — worst 5 ==`);
  for (const e of [...data.loaf].sort((a, b) => b.dur - a.dur).slice(0, 5)) {
    console.log(`  ${e.dur}ms block=${e.block} :: ${e.scripts.map((s) => `${s.fn}(${s.ms}ms)`).join(', ')}`);
  }
}
console.log(`\n== census == ${JSON.stringify(data.cens)}\n`);
