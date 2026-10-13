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
