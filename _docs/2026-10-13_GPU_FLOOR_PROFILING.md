# GPU/CPU floor profiling — livesoak + CDP (2026-10-13)

Method + numbers for the "runs on a school laptop" claim. Machine under
test: i7-13700KF (16c), RTX 3070 Ti, 32GB — i.e. results below are
*ceiling* measurements; the floor is inferred, not observed.

## Live scene

`http://localhost:5400/?server=127.0.0.1:8000&room=live-0`, 6 netbot
fleet (`bun _tools/pvptest/fleet.ts ws://localhost:8000/ws live 1 6 75`),
34 balls, ~103 draw calls, ~330k tris.

## Results

| config | p50 | p95 | p99 | worst |
|---|---|---|---|---|
| unthrottled | 17.4 | 18.0 | 18.4 | 121 (one hitch) |
| 4x CPU throttle | 17.4 | 18.1 | 34.8 | 36 (~2.5% in 33-50ms tail) |
| 8x CPU throttle | 34.9 | 52.8 | 69.8 | 88 (~29fps) |
| 4x CPU + 2x DPR (4.3MP, 4x fill) | 17.4 | 18.0 | 18.5 | 87 |

**GPU cost measured directly:** `gl.finish()` after `renderer.render`
→ p50 **0.5ms**, p95 1.0, p99 1.4, max 8.1 (n=2421). GPU is ~3% of the
16.7ms budget on this card → an iGPU ~20x slower still fits ~10ms.

## What each technique actually measures (researched)

- **CDP `cpuThrottlingRate`** — real CPU slowdown; 4x ≈ mid laptop,
  8x ≈ Atom-class. THE weak-CPU lever in-browser.
- **DPR/resolution crank** — valid ONLY as a fill-rate diagnostic
  (NVIDIA GPU Gems ch.28: "change resolution; if fps moves you're
  fill-bound"). Does not exercise vertex/raster/driver cost, and the
  ratio math is harsh: iGPU ≈ 30-60x slower fill than 3070 Ti, not the
  4x we applied. Proved pixel cost is trivially light — nothing more.
- **`EXT_disjoint_timer_query_webgl2`** — GPU timestamps in the command
  stream; the "right" tool. DEAD END on Chrome's ANGLE→D3D11 backend:
  `getQueryParameter` returns null + INVALID_OPERATION for queries that
  wrapped real draws (clean-room query over zero draws worked).
  figma/webgl-profiler wraps it for speedscope flamegraphs — same
  backend limitation.
- **`gl.finish()` timing** — the portable substitute. Round-trips to
  Chrome's GPU process; measures CPU encode + GPU drain for everything
  submitted. Serializes the pipeline (artificial worst case) — real
  async GPU cost is ≤ the number reported.
- **`nvidia-smi -lgc 300,300`** — real GPU clock lock ≈ 6-8x slowdown
  on ALL GPU stages. Admin shell required; `-rgc` restores. Untested.
- **`--use-angle=swiftshader`** — software rasterizer; true worst-case
  GPU. Requires browser relaunch. Untested.
- **Spector.js** — frame-level GL call capture (extension or embedded;
  ships an MCP server). For draw-call forensics, not throughput.

## Interpretation (honest)

- CPU is the floor axis, not GPU: 8x throttle → ~29fps playable-but-janky.
  JS+sim per frame ≈ 4ms on a 13700KF.
- GPU cost is genuinely tiny (0.5ms/frame) — trivial shaders, no post
  stack, low overdraw. iGPU concern mostly retired for THIS scene;
  heavier scenes (more balls/tris, shadow res) could change it.
- Still unproven: shared-bandwidth iGPUs, driver overhead on Intel
  ANGLE paths, and sustained-thermal behavior — real hardware or
  clock-lock/swiftshader runs remain the only true proof.

## CPU breakdown — JS Self-Profiling API (20s live)

Enabler: `server.headers['Document-Policy']='js-profiling'` in
client/vite.config.js (dev-only; Chrome refuses `new Profiler`
without it AND — important — without a navigation that fetched the
document after the header existed; a cached doc keeps the old policy).

763 samples/20s, same live scene. Main thread ~75% idle at 60fps —
the frame is a flat spread, no hog:

- `sampleHeightmap` — hottest single leaf (2%): heightfield lookup
  from creature/movement sims. The only function worth memoizing.
- `updateSpeciesAll` 5.5% total — creature/ball sims.
- three.js program/uniform plumbing ~1.5% combined.
- `updateModelAnim` — skinned-mannequin anim cost.
- `hudTick` — HUD DOM churn.

Caveat: trace `parentId` chains are sparse — leaf self-times are the
trustworthy column; "total" undercounts deep paths.

## Profiling toolkit (researched, ranked by unique signal)

- **LoAF** (`PerformanceObserver('long-animation-frame')`) — per >50ms
  frame, `scripts[]` attribution: sourceURL + function name + char pos +
  invoker + forcedStyleAndLayoutDuration. Lightweight enough for field
  use — the docs recommend it over the Self-Profiling API for that.
  CAVEAT: excludes Web Workers — WorkerTransport lane is invisible.
- **JS Self-Profiling API** — real V8 stack samples; heavyweight, dev
  only (we used it). Header: Document-Policy js-profiling.
- **User Timing marks** — phase attribution; our __perf/perfHud already
  implements the zero-GC version (lite-profiler's model).
- **about:tracing** — CrGpuMain vs CrRendererMain: the native view of
  GPU-process work that gl.finish approximates.
- **Spector.js** — frame-level GL call capture + state (extension,
  embeddable, ships an MCP server). Forensics, not throughput.
- **WebGPU Inspector** — RenderDoc-style, WebGPU only (n/a: WebGL2).
- **Needle Inspector** — three.js scene-graph devtools + MCP.

Recommended composite for this game: __perf phases + LoAF (main) +
botMs/worker timers (workers) + gl.finish (GPU).

### Server-side (Bun)

- `bun --cpu-prof --cpu-prof-md` — JSC sampling profiler; writes
  .cpuprofile (DevTools-loadable) plus a grep-friendly hot-functions
  markdown table. Windows caveat: JSC samples at ~15.6ms quantum —
  capture needs LONG soak windows for meaningful resolution.
  Recipe: `bun --cpu-prof-md src/server.ts` under a fleet soak.
- Node tools (clinic.js flame, --perf-basic-prof) don't apply to Bun.

### Production telemetry (the real low-end proof)

Real games don't profile on dev machines — they ship fixed-bucket
frame-time histograms from every session: one integer increment per
frame (~free), flushed at end, p50/p95/p99 server-side. For the
"school laptop" claim this is the honest instrument: an opt-in
`fps-telemetry` flag + /stats ingest would report the actual
low-end floor from real hardware, not CDP guesses.
Tracy is the native-games gold standard; the histogram is the
web-appropriate version of the same idea.

### Memory / GC axis

- **Heap snapshots (compare two)** — leak detection; MCP tool
  `take_heapsnapshot` can drive it.
- **Allocation timeline** — objects allocated-and-still-live over a
  window: the "what's churning GC" instrument.
- **`renderer.info.memory`** — three.js GPU-resource census
  (geometries/textures/programs/buffers): GPU objects need explicit
  dispose() — JS GC can't see them.
- **Three.js bottleneck shape**: draw-call *submission* is the classic
  WebGL CPU hog — projectObject/setProgram/renderBufferDirect hot means
  too many material/geometry combos, not too much math. Matches our
  `render` phase profile under throttle (11.6ms @4x ≈ 2.9ms native).
- `renderer.info.autoReset=false` + manual reset() for multi-pass
  frames, or per-pass stats get stomped.

## Reproduce

```js
// page eval — GPU drain timing
const gl = window.__renderer.getContext(), G = { times: [] };
const orig = window.__renderer.render.bind(window.__renderer);
window.__renderer.render = (...a) => {
  const t0 = performance.now(); orig(...a); gl.finish();
  G.times.push(performance.now() - t0);
};
// frame pacing — rAF deltas into an array, sort + percentile client-side.
```

Pitfalls hit: (1) TIME_ELAPSED queries leak `active` if a wrapped call
throws — always endQuery in try/finally; (2) only one query per target
may be active — guard reentrancy (nested render passes) with an
`active` flag; (3) a leaked query poisons every subsequent beginQuery
silently — INVALID_OPERATION on all later queries; (4) stale gl.getError
flags (1282) outlive the call that set them — don't read it as "this
call failed".
