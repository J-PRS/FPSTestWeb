# Native acceleration — wasm/FFI analysis

Where native code (client wasm, server bun:ffi) would and wouldn't
pay off for this codebase. Bottom line first: **native is a batch-API
lever, not a per-call one** — and both sides have cheaper parallel-
scaling cards to play first. Measure before porting.

## The rules that decide everything

1. **Boundary cost is the tax.** wasm call ≈ a few ns; bun:ffi call
   ≈ 20-50ns + marshal. Any function called per-item (hmHeight per
   texel, a single lerp) goes *slower* across the boundary than the
   JS it replaces. Native only wins when one call does a whole sweep.
2. **Shared memory, or don't bother.** wasm's linear memory can *be*
   the backing of the Float32Arrays (`new Float32Array(wasm.memory.buffer)`)
   — all sim state lives inside the wasm buffer, JS views it for free.
   Without this, marshaling eats the entire win.
3. **Realistic ceiling on hot math:** ~1.1-1.5× for arithmetic the JIT
   already handles well; ~1.5-3× only where the code is branchy or
   bit-heavy. Never a game-changer alone.

## Client — wasm candidates (ranked)

| Slice | Shape | Expected win | Why |
|---|---|---|---|
| VFX particle pools | one call steps N particles over shared mem | best | thousands of entities × integrate+fade; the classic wasm win in real engines |
| Projectile/beam sweeps | `sweep(seg, field)` does the whole ray march in one call | good | hmHeight/hmChord get called dozens of times per sweep today — collapse to one |
| Prediction replay | `replay(journal)` runs all re-sim ticks in one call | moderate | corrections replay 10-50 sequential moveSim ticks; call is already batched by nature |
| Remote interp | N remotes × lerp | skip | too few entities — boundary cost cancels it |

**Beaten by two cards that cost less:**

- **Worker offload** — prediction replay + ballSim replay are pure CPU,
  shared deterministic code, no DOM. A Worker with SharedArrayBuffer
  runs them *parallel* to the render thread — scaling, not just speed.
- **GPU-side** — VFX stepping can move to compute/instanced-attribute
  updates; terrain already displaces on GPU via clipmap. WebGPU is the
  real "next level" render path.

## Server — bun:ffi candidates (ranked)

bun:ffi dlopens a plain C shared library — no N-API/node-gyp needed.
(N-API exists on Bun but only matters for GC-managed objects across
the boundary, which none of these paths need.)

| Slice | Shape | Expected win | Why |
|---|---|---|---|
| Wire encode | `encodeTick(seats, out)` — one call, big buffer, bit math | best | hot bit-packing over N seats per tick; textbook FFI batch |
| Whole-tick moveSim | `stepAll(seats, inputs, field)` — C walks N players vs read-only heightfield | good, biggest surface | one crossing per tick; but it's a large port |
| Projectile/ball sweeps | batch segments × field | good | same shape as encode, smaller hot slice |

**Beaten by threads if the bound isn't FLOPs.** The measured seat
ceiling (~550-970/proc, ELD p99 384-649ms) was main-thread saturation —
and the fix that actually worked last time was *sharding* (2 procs ×
~490 seats → ELD p50 1.78-2.73ms). The same family inside one process:
`Worker` + SharedArrayBuffer on the heightfield, seat ranges split
across threads. 24 logical cores, currently ~2 utilized — linear-ish
scaling on JS we already have, no port.

## What to actually do — measured 2026-10-30

`bun _tools/profload.ts --bots 500 --secs 40 --cpuprof` (74 seats
joined, 59.5s profile, `server_bun/CPU.20261030.165523.29252.0.001.cpuprofile`):

| Slice | Self ms | Share |
|---|---|---|
| `send` (ws.send syscall) | 21,524 | **~36%** |
| `fanoutRecords` | 3,291 | 5.5% |
| `tick` (RoomMoveSim) | 3,202 | 5.4% |
| `hmChord` | 1,512 | 2.5% |
| `buildRecords` | 1,156 | 1.9% |
| `wallNow` | 889 | 1.5% |
| `encodeTickPlayerV4` | 889 | 1.5% |

**The guess was wrong — and the profile caught it.** `send` alone is
~36% of CPU, 24× the encode slice. phaseMs agrees: `fanout 0.87ms` vs
`sim:move 0.22 + sim:proj 0.12` at 74 seats — the broadcast path costs
~2× the sim, and it scales linearly per seat.

- **FFI-encode is dead by the data** — encode is 1.5%, not a pilot.
- **FFI can't help `send` at all** — it's a kernel socket syscall,
  not JS math. No portable work there.
- **The lever is fewer, bigger frames** — at 17-19µs/ws.send (bare-
  socket measure, earlier herd work), send-count reduction is the
  whole game: more aggregation per seat-tick, the volatile-batching
  direction continued.
- **Shards still work** — same lever as the 2×490-seat split that
  crushed ELD; there are spare cores for a third/fourth worker.
- Second tier (`fanoutRecords`+`buildRecords`+`wallNow` ≈ 9%) is
  FFI-shaped if the send path ever stops dominating — worth a look
  after the send lever is pulled, not before.

Client-side conclusion unchanged: profile before piloting; worker
offload and GPU-side updates rank above any wasm.

## Don't bother

- Per-call FFI/wasm for helpers (hmHeight, lerp, normalize) — boundary
  cost cancels the gain by construction.
- N-API for these paths — nothing GC-managed crosses.
- Rewriting a sim in C "for speed" — the port surface is the whole
  shared/deterministic layer; the bug-risk-to-win ratio is terrible
  vs worker threads on the same JS.

---
*Analysis, not measurement. Numbers cited are from prior documented
runs (join-latency autopsy, shard tests); the ranked picks need one
fresh cpuprof to confirm before any pilot.*
