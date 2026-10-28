# Server performance research — what actually moves the needle

> Reference for post-stress optimization direction. Researched 2026-10-28
> after `_tools/profload.ts --cpuprof` attribution at 490 clients
> (CPU.*.cpuprofile + `_tools/_cpuprof_sum.ts`). Companion to
> `_docs/2026-10-23_DUEL_CAPACITY.md` and `_docs/2026-10-23_SERVER_HOTPATH_AUDIT.md`.

## Where we actually stand

Published closest-analog: growordie.io's "1000 players per CPU core"
single-loop arena — but that's a snake game with no combat adjudication,
no ambient sims, no authoritative shadow sim per player. Our measured
~400 CCU/core on 24-seat CTF with full sim stack is honest, not behind.

Every published source converges on the same ceiling: **one event loop =
one core**. growordie's plan past ~1000 CCU is *room sharding* — more
processes, not threads. Our `sim:move`+`fanout` tick budget (~1.7ms/room-tick
at 490) leaves huge 20Hz headroom; the per-core CPU is the binding
constraint, not the tick budget.

## The GC finding — probably our tickMsMax spikes

Two Bun PRs (oven-sh/bun **#35356**, **#35431**) document that
`GarbageCollectionController` re-arms an **eden GC every ~16ms** while
the event loop is active — ~60 collections/s under load, each a multi-ms
stop-the-world on a grown heap. A production report cited: *"switched
Bun→Node, CPU and loop-lag p95 dropped."*

That is the same class as our measured `tickMsMax` spikes (16ms typical
ceiling, 139ms earlier ball-tick anomaly, **531ms** in the last soak) —
multi-ms pauses inside sim code that the code cannot explain.

- Fix: PRs gate the nudge on real heap growth (`clamp(prev/8, 1MiB,
  32MiB)` past post-GC low-water). Landed ~2026, likely **post-1.3.14**
  (our version). Verify which release ships it before planning the bump.
- Diagnostic path: `BUN_JSC_logGC=2` during a soak and correlate
  `tickMsMax` timestamps with eden collections. `Bun.gc(true)` /
  `require('bun:jsc').heapStats()` for manual probing.
- `BUN_GC_TIMER_DISABLE` / `BUN_GC_TIMER_INTERVAL` exist but were
  **silently ignored** until the fix — they are not a workaround on
  1.3.14. `BUN_JSC_forceRAMSize` changes GC *heuristics*, not a cap;
  `--max-old-space-size` is accepted but unenforced (issue #34917).
- `--smol`/`WorkerOptions.smol` shrinks the JSC heap at a speed cost —
  not a server knob.

**A/B tested 2026-10-28** (240 bots / 10 rooms / 45s, `profload.ts`):

| Run | tickMsAvg | tickMsMax |
|---|---|---|
| GC controller ON (default) | 1.56ms | 12ms |
| `BUN_GC_TIMER_DISABLE=1` | 2.08ms | **108ms** |

**Negative for the "timer is the enemy" hypothesis** — the controller's
frequent small eden collections were preventing larger pauses, not
causing them. The 16-531ms tick spikes are JSC GC pause-class regardless
of the controller; they scale with heap size and allocation rate, which
is why the scratch-pool/alloc work in this session is the real lever.
Remaining mitigation: Bun upgrade (the fixed controller is smarter, not
absent) — or fewer allocations. `BUN_GC_TIMER_*` knobs don't exist as
tunable env vars on 1.3.14 anyway (BUN_JSC_* env vars are allowlist-
locked; `logGC`/`recordGCPauseTimes` were both rejected).

**UPGRADED — Bun 1.3.14 → 1.4.4, measured 2026-10-28** (`profload.ts`,
same fleet shapes):

| Fleet | Metric | 1.3.14 | 1.4.4 |
|---|---|---|---|
| 240 bots / 10 rooms | cpuPct | 69.3 | **37** |
| | tickMsAvg / tickMsMax | 1.56 / 12 | **1.12 / 3** |
| 480 bots / 20 rooms | cpuPct | 119.7–131 | **72** |
| | tickMsAvg / tickMsMax | 1.66 / 13–531 | **1.29 / 10** |
| | ccuPerCore | 376–409 | **681 (+66%)** |

The ws rewrite + JSC upgrade + GC controller fix combined into the
largest single win of the session — CPU nearly halved AND the spike
class is gone at this scale. Also new in 1.4.4: `ws.pause()`/`resume()`
(closes the #32483 inbound-backpressure hole — wire it into the flood
path when touching that code), `bun check` (fast typecheck candidate
for check.sh), and 3 security fixes (QPACK amplification, CA trust,
brotli OOB) that matter for launch.

## Validated as already-correct architecture

- **Encode-once + filter-per-recipient** — the textbook broadcast
  pattern (nanoMMO, Photon docs). Our v4 masked deltas + sparse
  far-tiers match published interest-management practice.
- **Single-frame-per-tick sends** — `ws.cork` batching advice is for
  multi-send batches; we already emit one frame per socket per tick.
  N/A.
- **Bounded tick** — 1.7ms/50ms budget; published advice ("keep tick
  work <50% of budget") is far exceeded.

## Worth knowing (not bugs, but traps)

- **Bun inbound WS has no backpressure** (oven-sh/bun#32483):
  `message` handlers run *concurrently*, there's no `pause()`, and a
  flood-faster-than-handler client can grow RSS unbounded. Our
  pre-join flood guard covers the join path; slow-handler OOM is a
  platform-level hole. Keep the guard; note the hole.
- `Bun.serve` corks `message`/`open`/`drain` handlers automatically —
  sends fired from *other* contexts (our `setInterval` tick) get no
  auto-cork, but that only matters if a tick issues multiple sends per
  socket, which ours doesn't.
- Room-sharding is the standard scale-out — consistent with the
  WorkerTransport/sim-in-worker direction already on the roadmap;
  multiple Bun processes per box is the cheap version of the same idea
  (one process per core, rooms assigned round-robin).

## Applied this session (verified by re-profile)

| Fix | Profile delta |
|---|---|
| `ffaScore` → delta `{playerId, score}` protocol (was full-map echo per kill) | j:ffaScore lane ~20-50× smaller |
| `alivePlayers` caller-owned scratch (BallSim/CreatureSim) | alloc churn gone, ~8.3s → ~5.2s combined |
| `humanFoeNear` squared-compare early-out | sqrt pair eliminated for out-of-range bodies |
| `meterHumans` staggered 5Hz/human (dt×4 keeps sheep math) | meterHumans total 15.0s → 11.3s; foeNear self 9.5s → 6.0s |
| `tiers.set` write-on-change; `fields` shared scratch; `spd` squared-compare | `records` phase 0.18 → 0.06ms/tick |
| Resting-gate: cheap vel/input gates before the heightfield probe | `hmChord` ~2.7s → ~0.9s |

Cumulative: ccuPerCore 376 → **409** measured (`profload --cpuprof`,
490 players, 20×12v12 CTF rooms, rimrock). `tickMsMax` spikes are GC,
not sim.

## What's left (ranked by expected gain)

1. **Bun upgrade for the GC controller fix** — latency-variance, not
   throughput. Confirm the shipping version first.
2. **Room sharding / sim-in-worker** — the only remaining step-function
   for raw capacity. Everything else is single-digit %.
3. `RoomPickups` swept-grab bounding prefilter (~1s/235s profile) —
   small, has real test history, diminishing.
4. `j:stateHash` 15MB/60s — diagnostic channel; `FPS_HASH_INTERVAL_MS`
   is the knob, not a bug.
5. `send`/`RoomMoveSim.tick`/`parse` — real work (syscalls, physics,
   inbound validation). Not waste.

## References

- growordie.io "1,000 players per CPU core" — single-loop + shard architecture
- oven-sh/bun#35356, #35431 — GC controller 16ms eden-nudge fix
- oven-sh/bun#32483 — no inbound WS backpressure in Bun
- oven-sh/bun#34917 / #34924 — `--max-old-space-size` unenforced
- nanoMMO ep.20, Photon Fusion interest docs — distance/cell tiered send
- Colyseus 50ms-tick writeup — "combat is ~150× heavier than movement" sanity check
