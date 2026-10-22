# Low-end levers — what's actually left (2026-10-22)

Question: are there any *big* levers for super-low-end devices, or is
all remaining work incremental? Answer: the obvious wins are done; three
architectural levers remain, and one is cheap.

## Already built (don't re-do)

- **Auto-quality ladder** (`loopPerf.ts`) — two axes: GPU (resScale
  1→0.4, shadow shed, cloud dome off, post shed, forced remote lod1,
  VFX density 0.7→0.45) and CPU (ambient systems off, VFX 0.6→0.4, 2×
  raw buffer). Headroom detection steps back up. This is the standard
  "detect once, then measure" pattern every successful web game uses
  (Krunker, gfx-tier) — and ours is smarter than most because it picks
  the axis: a CPU-bound frame doesn't drop resolution.
- **Draw/anim economics** — skinned parts merge, skeleton dedup (one
  skeleton per armature, ~9→3 updates/body), offscreen-remote mixer
  skip, far-remote burst animation, distance-tiered wire sends,
  staggered AI buckets, species instancing, VFXBatch pooling.
- **Payload** — 11.3MB shipped, ~3.8MB boot-critical, meshopt GLBs,
  OGG/WebP media, dead assets archived.

## The remaining levers, ranked

### 1. 30fps cap tier — cheap, biggest bang on chromebooks

Sustained <40fps already fires the quality dump — but the ladder never
considers *halving the frame budget*. A stable 30 beats a stuttering
45. Implementation: one more rung on the CPU ladder that halves rAF
(`lastTick` mod 2) — sim keeps its fixed dt, render skips alternate
frames. Input/prediction latency is unchanged (input sampling is
event-driven, sim stays 60Hz). ~20 lines, the single biggest
unrealized win on hardware that can't reach 60 no matter what the
ladder sheds. On a box that stabilizes at ~45, it also buys ~50%
thermal headroom — relevant on fanless hardware that throttles.

Engage on sustained <45fps (the watchdog already counts); release is
the subtle part — a cap saturates the fps signal so headroom is
invisible. Measure WORK, not fps: `jsPhases + gpuPhase` against the
33.3ms budget (both already in `__perf()` — the gpu phase is the
timer-query readout). Release when work < ~65% of budget sustained
~20s; cooldown on re-engage. Probe-based fallback for drivers without
timer query: a 1s uncap every ~30s — crude but only on degraded boxes.
(Unity FrameTiming / PresentMon / ADPF all do headroom=budget−workTime
the same way — GPU timers are the web equivalent.)

### 2. Sim offload to a Worker — the architectural lever

`jsBusy` sat at ~96% under 14 bots. All the incremental wins above are
fighting for the main thread. `shared/` is already deterministic and
the netWorker/tickClock workers exist — the shape is proven. Moving
movement-replay + ball/creature sims off the main thread retires the
whole CPU axis rather than shaving it. Honest cost: this is the
biggest remaining project — the client sim and the render loop share
mutable state everywhere (positions read during render), so it needs
a snapshot/transfer boundary, not a flag flip. Do it when the 30fps
cap + imposters aren't enough — not before.

**Real-world precedent** (researched 2026-10-22):

- **OpenFront** (open-source .io RTS, shipped multiplayer) — the
  canonical split: sim+pathfinding in a Worker, PixiJS render + input
  on main. Worker runs `executeNextTick` per tick, batches
  `GameUpdateViewData` messages back with a yield cap
  (MAX_TICKS_BEFORE_YIELD=4 — avoids flooding main with a catch-up
  burst). postMessage-based, not SAB.
- **Aetheris** (design doc, Rust/WASM) — the ambitious version:
  3-worker topology — game worker (net+predict+reconcile), render
  worker (OffscreenCanvas+wgpu+interpolation), main (DOM/input), SAB
  zero-copy between them.
- **vimp** (P2P tanks) — authoritative host IS a worker in the
  creator's tab (Rapier WASM sim @120Hz, snapshots @30/s over WebRTC).
- **MuJoCo/physics** — SAB threading requires COOP:same-origin +
  COEP:require-corp headers; absent on most static deploys, so
  postMessage boundaries are the portable default.

The shape most real games land on is OpenFront's: **sim worker ↔
posted snapshots ↔ render main** — NOT SAB. For us specifically the
prediction path should STAY on main: local input→state feedback is
latency-critical (a postMessage round-trip on mouselook is real
input lag). The right split is *asymmetric*: move the bulk sims
(ball/creature sim, remote interp/judges, corrections replay batch)
to a worker; keep local movement prediction + input on main. That
matches the "server owns interactive state" law — the worker owns
authoritative replay, main owns feel.

### 3. Far-remote imposters — retires the skinning+draw tax at bot scale

45 SkinnedMesh bodies is the biggest single render class and
`applyBoneTransform` is 6.5% of CPU *after* the LOD work. lod1 is the
geometry shed; the next tier is a **billboard/imposter body** beyond
~150m — a pre-rendered sprite (or the existing lod1 baked to a quad)
that skips mixer, skeleton, and per-part draws entirely. Bots at flag
distance already read as silhouettes; the imposter is ~90% of the cost
for ~0% of the read. Medium effort (a texture atlas per variant +
swap logic next to `playerModelLod`), high payoff exactly where our
worst case lives.

### 4. KTX2/Basis textures — real but modest for us

GPU-compressed textures stay compressed *in VRAM* (BC/ASTC/ETC2) —
4-6× less memory and bandwidth, which is the actual constraint on
integrated/mobile GPUs (fill-rate + memory pressure, not download).
Our texture set is small and mostly procedural — the win is on
terrain detail maps and whatever few baked textures remain. Worth it
as part of the asset pipeline long-term, not as a standalone project
— the payload audit showed textures aren't our weight.

### 5. What the research says NOT to bother with

- **WebGPU renderer** — every independent three.js measurement
  (r150-r18x) shows WebGPURenderer *slower* than WebGLRenderer on
  draw-heavy scenes, worse on mobile (Pixel 8: 120fps WebGL vs 70fps
  WebGPU; uniform/bindgroup overhead per-draw is the bottleneck).
  Revisit in 12-18 months; it is not a low-end lever today.
- **OffscreenCanvas render** — same move-the-work problem as #2 but
  bigger and less benefit than just moving the sim.
- **CSS/DOM HUD swap** — HUD was ~0.4% of the frame; nothing there.
- **More draw-call shaving** — incremental at this point (367 draws
  steady / ~880 burst); imposters beat batching at the bot-heavy end.
- **Heightmap memo** — explicitly rejected in `heightmap.ts:171`
  (neighbor-height cache feeds wrong prediction clamps → divergence).

## Recommended order

1. **30fps cap tier** — now, ~20 lines, biggest delta-per-effort.
2. **Far-remote imposters** — next; it's the only item that attacks
   both the skinning CPU tax AND the draw mass at bot scale.
3. Sim-in-worker — the real architectural move, queued behind the
   first two being insufficient.
4. KTX2 — fold into the asset pipeline when it next gets touched.

Everything else on the standard list is either done, disproven by
our own comments/tests, or incremental.
