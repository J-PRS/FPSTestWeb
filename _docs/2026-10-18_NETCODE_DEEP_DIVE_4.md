# Netcode Deep Dive #4 — The Whole Pipeline: Measure, Test, Profile

Fourth research pass. Dives 1–3 covered architecture canon, our mapping
onto it, and stack internals (uWS send codes, Blink scheduling, QUIC).
This one covers the part we've been doing by feel: **how to instrument,
test, and profile every stage of the pipeline** — and what the audit of
our own plumbing says is missing.

Sources: Bun repo (PRs #34834, #33160, #37455, #40027; issue #26965),
W3C WebTransport spec + WICG stats IDL, Chrome LoAF docs, Perfetto/CDP
docs, GGPO synctest reference, AoE II sync logs, Widelands syncstream,
clumsy/tc-netem manuals, quic-network-simulator, Fighters Legacy
bot_swarm scale gate, Metaplay BotClient, deterministic.js landmine
catalog, Rune determinism writeup. Own-code audit of every telemetry
and harness file.

---

## Part 0 — The pipeline, end to end

```
input → predict → WorkerTransport → WS/WT → room.commands → tick(20Hz)
      ↓                                                    ↓
   local sim                                    sims → records → fanout
      ↓                                                    ↓
   render ← interp buffers ← wire decode ← network ← per-socket queues
```

Every stage has a measurable signature. The thesis of this doc: **we
already emit or nearly-emit every signal that matters; the gaps are a
handful of counters and a scheduling upgrade, not new systems.**

---

## Part 1 — Server: the tick loop is the heartbeat

### 1.1 `setInterval` is quantizing our cadence — measured + explained

`TickLoop.startTickBroadcast` uses plain `setInterval(tickMs)`. Two
independent problems:

- **setInterval drifts**: it rearms relative to callback *completion*,
so phase error accumulates — Node/Bun never added drift correction.
- **Windows timer quantization**: Bun issue #26965 — `setInterval(16)`
averaged **28ms** on Windows (the 15.6ms system-clock tick; IOCP waits
round to it). This is exactly the "+11ms avg" the sims' measured-elapsed
compensation comments already describe. Bun landed a high-res waitable
timer (PR #34834, `CREATE_WAITABLE_TIMER_HIGH_RESOLUTION`, same approach
Go uses) — on Bun 1.3.14 it *should* be included, but our tickLag metric
is the ground truth: **if tickLagMs.avg stays ~+11ms, we're still
quantized**.

The measured-elapsed `dt` clamp (`[TICK_DT, 1s]`, TickLoop.ts:269-271)
keeps *sim time* honest under jitter — good — but the *broadcast cadence*
still jitters, which lands directly in the client's arrival-interval EMA
and inflates `interpDelay` (BASE + arrival + 2·jitter). Timer slop on
the server is bought back as interpolation delay on every client.

**Fix (small)**: self-correcting `setTimeout` with deadline arithmetic —
`next += TICK_MS; setTimeout(loop, max(0, next - now))`, resync when
`delay < -TICK_MS` and count a dropped tick. Same pattern the sims
already use internally; moves schedule compensation upstream of the
wire. Do NOT switch to a `setImmediate` busy-loop (~1ms precision but
starves the same loop's socket I/O).

### 1.2 Event-loop lag — the metric Bun just made free

`perf_hooks.monitorEventLoopDelay()` was a stub on Bun until PR #22429
(Sep 2025) — now a real histogram (p50/p99/max). One line in serverOps
exposes it on /metrics next to `tickLagMs`. Event-loop lag ≠ tick lag:
the former catches *any* long task (GC, a fat message handler, a sync
fs call), the latter only fires on the tick timer. Export both.

### 1.3 Per-socket queue depth — we compute it, then throw it away

`ConnectionManager` already calls `ws.getBufferedAmount()` on every send
(the 4MB drown gate) but uses it only as a threshold. A `bufferedMax`
gauge into the health/rollup window quantifies backpressure *before* the
drown cap — the difference between "socket died" (what we see) and
"socket was drowning for 4 seconds" (what actually happened). ~5 lines.

### 1.4 Tick execution cost — phase EMAs exist, no distribution

`mark()` gives per-phase EMA (`cmd`, `sim:*`, `auth`, `records`,
`fanout`) in the 10s rollup — but no total-tick wall-time distribution.
A p50/p99/max on `tickRoom`'s own bracket (it already timestamps phase 0)
is the metric every real game server exports first (OPEN//77, ReadyM).
Rising p99 with flat p50 = occasional heavy work (GC, timer scans);
rising p50 = systemic load. Currently indistinguishable.

### 1.5 Profiling the Bun process — the actual commands

- `bun --cpu-prof src/server.ts` → `.cpuprofile`, loads into Chrome
  DevTools / VS Code. `--cpu-prof-md` gives grep-able markdown — run it
  under a netbot soak.
- `bun:jsc` → `profile(fn, intervalUs)` — JSC sampling profiler with
  **JIT tier attribution**: a hot tick function stuck at Baseline (never
  reaching DFG/FTL) is a red flag no time-number reveals.
  `startSamplingProfiler()` brackets a whole soak.
- `heapStats()` object-type diffs across a soak = the leak finder.
  `Bun.generateHeapSnapshot()` → Safari-format snapshot.
- GC pressure: `bun:jsc memoryUsage()` deltas + `--smol` tradeoff flag.

### 1.6 QUIC server-side reality check

Bun's WebTransport is vendored **lsquic**, datagrams-only, draft-15 —
PR #40027 (the explicit `webtransport:` block) still open at research
time; our WT path rides a custom adapter, not Bun.serve's. The
congestion-control finding matters though: lsquic's adaptive CC picked
BBRv1 from the *first RTT sample*, and an event-loop-paced QUIC engine
feeds it loop stalls → BBRv1 models our event loop as the network →
cwnd collapses to the 4-packet floor. Bun fixed it by defaulting to
**Cubic** (PR #37455). If our WT adapter lets lsquic pick CC, verify it
lands on Cubic — an adaptive pick could be part of why datagram loss
measured 33% on loopback. Worth one log line at session open.

Also: `node:quic` (if our adapter uses it) takes explicit
`cc: 'reno'|'cubic'|'bbr'`.

---

## Part 2 — Client: what Chrome actually lets us measure

### 2.1 The LoAF API — attribution we've been guessing at

Long Animation Frames (`long-animation-frame`, Chrome 123+) is the
single most valuable API we haven't wired: `blockingDuration`, plus
`scripts[]` with `invoker` like `"WebSocket.onmessage"`, `invokerType`,
`sourceURL`, `executionStart`. It answers *"did a network handler cause
this dropped frame"* — the question we answered indirectly via `coal`
spikes and starvation probes. A few lines in a diag observer + a counter
into `collectDiag` gives Alt+Q "LoAF blocking ms by invoker" — we'd see
at a glance whether stalls are render, GC, or wire-dispatch.

### 2.2 The `e.timeStamp` trick — free dispatch-latency signal

`MessageEvent.timeStamp` is set at event *creation*; `performance.now() −
e.timeStamp` at handler entry ≈ **main-thread queuing delay** — how long
the WS message waited for the render loop to yield. One line in the
handler, rolls into the existing telemetry uplink as `dispatchLag`.
Complements `deliveryLag` (wire→arrival) with arrival→handler.

### 2.3 CDP `Network.webSocketFrameReceived` — browser-process truth

Per-frame timestamps from the *browser process* (not the renderer) —
the ground truth for splitting "wire was late" vs "renderer was busy."
Usable in our puppeteer E2E today: enable the Network domain, diff
frame timestamps against in-page arrival marks. Also `Tracing.start`
works even when the renderer is pegged (browser-process domain) —
captures CPU profiles from a starved headless client that `evaluate`
can't reach.

### 2.4 WebTransport.getStats — verify before relying

Spec defines `packetsLost`, `smoothedRtt`, `minRtt`, and a `datagrams`
sub-object (`expiredOutgoing`, `droppedIncoming`, `lostOutgoing`) —
**the honest datagram-loss ruler** we built seq-gaps to approximate.
Chromium ships the QUIC-level fields but the datagrams sub-stats are
"limited availability" — and the HWM fields were just renamed
(`incomingMaxAge`/`outgoingMaxAge` set aging; `incoming/outgoing
MaxBufferedDatagrams` — latest-wins semantics done browser-side).
Action: probe `getStats()` keys at runtime, and set
`datagrams.incomingMaxAge` low so stale frames never reach the sim —
free drop-latest behavior.

### 2.5 GC correlation — the tools exist

`performance.memory` sawtooth frequency (add `--enable-precise-memory-info`
in E2E), `page.tracing` with `v8.gc` categories → `Minor GC`/`Major GC`
tasks on the same timeline as frame drops. `--js-flags=--expose-gc` +
`window.gc()` for A/B "is this hitch GC." Our zero-alloc hot-path rule
has no *enforcement* — allocation-instrumentation-on-timeline in a
recorded soak is the cheap audit.

### 2.6 Headless caveats (already burned us once)

- `--headless=new` ≈ headed timing; `chrome-headless-shell` is not.
- SwiftShader needs `--enable-unsafe-swiftshader` and its frame times
  are meaningless for GPU-bound scenes — matches our `fps:0` /
  datagram-starvation artifact from the WT soak. `E2E_GPU=1` exists for
  exactly this.
- `Network.emulateNetworkConditions` **does not affect WebSocket,
  WebRTC, or WebTransport** (crbug 563644) — throttle only affects
  fetches. Never trust it for netcode tests; see §3.2.

---

## Part 3 — Testing methodology: what the canon does that we don't

### 3.1 GGPO synctest — the highest-value missing test

`ggpo_start_synctest`: periodically roll back N frames, resimulate from
saved state, assert the recomputed checksum equals the original —
catches nondeterminism *inside one process*, no second peer needed.
Our pieces are all present: input journal, seeded rng, frozen simClock,
`computeStateHash`, `step()` driving real ticks. The missing 20 lines:
every T ticks, snapshot + journal-replay the last T and compare hashes.
A `--synctest` env flag on the room turns any soak into a determinism
canary. **P0 for this doc.**

### 3.2 Fault injection — clumsy has a loopback gotcha that bites us

- **clumsy** (WinDivert) is the Windows tool: `--lag --drop --duplicate
  --ood --throttle --tamper` on a port filter. GOTCHA: loopback packets
  are captured *twice* and classified all-outbound — a "5% drop" on
  loopback drops ~9.75%. Halve rates or filter one direction.
  `--throttle` (hold-then-burst) is the perfect interp-buffer
  underrun/overrun generator.
- **netem** (Linux/WSL/CI): `loss gemodel` (Gilbert-Elliott **burst**
  loss — real loss bursts; iid overstates resilience), `seed` for
  reproducible impairment in CI.
- **Message-level WS faults need a proxy**: TCP hides packet loss — a
  ~50-line Bun WS relay that drops/dupes/reorders *frames* gives faults
  TCP can't produce (whole-message loss, truncation) and is CI-scriptable.
- Our `ChaosLink`/`LatencyLink` are send-side only — no server-egress or
  receive-path injection. Wiring an optional ChaosLink into
  `ConnectionManager.send` behind a test seam extends existing chaos
  specs to the real fanout.

### 3.3 Reconnect storms — the untested production killer

Server blip → N clients reconnect simultaneously → jittered backoff is
load-bearing. Test: fleet of headless clients, kill+restart server,
assert reconnect-arrival distribution is *spread* (not clustered) and
session reclaim returns the same token. Partial partitions (drop 10%)
matter more than full outages. Our `flapwatch` probes this space but
doesn't measure the arrival spread.

### 3.4 Metrics discipline — distributions, not means

- Percentile-ize everything: p50/p95/p99/max. Delivery-lag p99→max gap
  *is* the burst-stall signature.
- Per-scenario `baseline.json` + ratio gates (p99 > 1.3× baseline =
  fail), not absolute thresholds — our `perf.ts --compare` already does
  this for render; extend the pattern to netcode soaks (`_wssoak` emits
  a metrics JSON; compare vs baseline like `baseline.json`).
- **desyncs-per-client-hour**: hash-mismatch rate per scenario; a soak
  gate where `>0 DESYNC` fails — `desyncsoak.ts` already asserts this;
  make it part of the standard matrix.
- Correlate timelines, not aggregates: align lag spikes with tick-overrun
  timestamps and GC events before calling it a bug.

### 3.5 The determinism landmine specific to OUR stack — JSC vs V8

**Bun runs JavaScriptCore; Chrome runs V8. `Math.sin` (and every
transcendental) is implementation-defined in ECMAScript** — the engines
use different approximations. Our `shared/` sims are replayed on *both*
ends: same input journal, different `Math.sin` results → silent diverge
that no single-runtime test can catch. sharedPurity.test bans
`Math.random` but **not `Math.*` transcendentals** — that's a real
unsealed hatch. Check whether movement.ts/combat paths call sin/cos/
atan2/exp/pow on sim data (they almost certainly do — angles!). Options:

  a) deterministic math lib (fdlibm port) behind shared/env.ts,
  b) LUTs (the RTS classic),
  c) empirically verify divergence is zero *today* — cross-engine
     determinism test: same journal through sim-in-Bun vs sim-in-Chrome
     (Playwright evaluate), compare per-tick hash. Even before fixing,
     this test tells us how exposed we are.

Related: `Map`/`Set` iteration = insertion order — deterministic only
if insertion order is. Rooms inserting players in network-arrival order
*is* deterministic (same arrival order on both ends is not guaranteed
for replicas — check whether client replica iteration order can differ).
`DataView` explicit-endianness: already correct in our binary codec
(verify no raw TypedArray reads cross the wire).

---

## Part 4 — Plan (ordered, sized)

| # | Change | Size | Why now |
|---|--------|------|---------|
| P0 | Self-correcting setTimeout tick loop + dropped-tick counter | ~20 lines TickLoop | removes the ~11ms cadence jitter feeding every client's interpDelay |
| P0 | Cross-engine determinism test (Bun vs Chrome sim hash on same journal) | 1 test + harness | quantifies the JSC/V8 `Math.*` exposure before it bites in production |
| P1 | GGPO-style synctest flag — resimulate+journal-compare every T ticks | ~50 lines Room | catches nondeterminism inside one process, any soak becomes a canary |
| P1 | `monitorEventLoopDelay` + tick-duration p50/p99 + `bufferedMax` on /metrics | ~30 lines | the three server gauges that turn "feels laggy" into a number |
| P1 | LoAF observer → `collectDiag` (blocking ms by invoker) + `e.timeStamp` dispatch lag into clientStats | ~40 lines | answers "render stall vs wire stall" at a glance, forever |
| P2 | WT: log negotiated CC at session open; set `datagrams.incomingMaxAge`; runtime-probe `getStats()` keys | ~20 lines | datagrams-age free latest-wins; CC log closes the 33%-loss question |
| P2 | clumsy E2E scenario (halved loopback rates) + `--throttle` underrun generator; metrics JSON vs baseline | 1 script + doc | first real impairment coverage on Windows; the loopback-double-capture math matters |
| P2 | Interp underrun + `extCapMs` counters into `renderLag`/`clientStats`; WorkerTransport `maxPending`/`drainBatches` | ~30 lines | the user-visible QoE metric (starvation) currently uncounted |
| P3 | Message-level WS fault proxy (drop/dup/reorder frames) for CI | ~60 lines | faults TCP can't produce; scripts the "drop a damage event" case |
| P3 | Reconnect-storm soak: arrival-spread + reclaim-token assertion | extend flapwatch | production killer, currently unmeasured |
| P3 | sharedPurity: add `Math.sin/cos/tan/atan2/exp/pow/sqrt` scan behind shared/env seam | 1 regex + env fns | seals the cross-engine hatch mechanically |

Rejected: io_uring/io_uring-adjacent tuning (Bun handles internally);
SAB/OffscreenCanvas (still the big refactor, unchanged verdict);
switching transports (WT+WS ladder stays; stream-2 is the right WT lane).

## Verification hooks already in place

- `tickLagMs` on /metrics is the A/B for P0's scheduling fix — measure
  before/after in the same soak.
- `replica()` + `computeStateHash` + `desyncsoak` is 90% of the synctest
  plumbing already.
- `healthBump`/`healthTotal` is the funnel for any new server counters —
  they ride to /metrics free.
- `clientStats` is an open Record on the wire — new client metrics
  (dispatchLag, underruns) need no protocol-version bump beyond the
  worldModel decl.

## Skipped / unresolved

- Didn't grep whether lsquic CC is selectable through our WT adapter —
  P2's log line answers it empirically.
- Didn't audit which shared/ paths actually call transcendental Math —
  the P0 test measures exposure before we pay for LUTs.
- `bot_swarm`-style 128-client CI scale gate is aspirational — our
  netbot fleet is smaller; noted, not planned.
