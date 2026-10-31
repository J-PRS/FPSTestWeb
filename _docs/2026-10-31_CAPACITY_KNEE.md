# Capacity knee — 2026-10-31

Single-process seat ceiling, measured with `profload` (real sockets, loopback).

## The measurement that was wrong first

`profload --bots 500` kept reporting `players=74` — bots weren't dying.
The caps worked: `CONFIG.maxPlayers=32` per room, `globalMaxPlayers=128`
per process (config.ts). 200 bots / 2 rooms = 100 wanted, each room took
32 + grace = ~74 total. `FPS_MAX_PLAYERS=500 FPS_GLOBAL_MAX_PLAYERS=2000`
for capacity runs. A stale 512-bot netBot zombie from a previous session
was also alive in the log (its heartbeat showed joins still climbing) —
`profload --sweep` before trusting a fill number.

## Where the knee is: ~350-370 seats/process

`FPS_MAX_PLAYERS=500 FPS_GLOBAL_MAX_PLAYERS=2000 bun _tools/profload.ts
--bots 500 --rooms prof1 --secs 40` (368 seated):

| metric | value |
|---|---|
| cpuPct | 96.1 of a core |
| tickMsAvg | 40.3ms (50ms budget — ticks dropping) |
| phaseMs.fanout | 31.0 of 40ms |
| phaseMs.sim:proj | 5.0 |
| sendsPerSec | 6,719 (~18Hz effective/seat) |
| sendUsPerCall | 32µs — flat with load, per-call cost is fine |
| cappedPerSec | 685,913 records culled/s — the K=32 cap firing |
| bin:7 egress | 735MB/40s = 18.4MB/s ≈ 147 Mbps |

## The real quadratic was never the wire

`fanoutRecords` computes dSq for every seat × record pair: 368×367 ≈
135k/tick × 20Hz ≈ 2.7M/s — that IS the 31ms fanout phase. The
`MAX_RECORDS=32` cap (4d865a5b) bounded the BYTES sent but not the CPU
loop that decides which records to send.

At N seats: tick CPU ≈ 20Hz × N² distance tests. N=368 → ~2.7M/s;
N=2000 → ~80M/s → the loop alone needs a spatial index, not tuning.

## Second find: intro seats blow the frame

Avg bin:7 frame = 2.16KB, not the capped ~350B. Intro recipients are
cap-exempt AND get full-cadence full records of every entity for the
window; with 364 joins churning through the run, a rotating slice of
seats each carried ~300-record frames. Join bursts at scale are
double-punishing: O(N²) per tick AND O(N) per joiner's frames.

## Fix order for thousands-per-box

1. **Spatial index for the interest loop** — bucket by map cells; a
   recipient only distance-tests records in nearby cells. O(N + visible)
   replaces O(N²). THE blocker for thousands-per-process.
2. **Cap intro seats too** — paced admit already exists; an intro seat
   doesn't need 300 records at once. Cheap fix, big join-storm win.
3. **Sharding** — proven multiplier (24 logical cores, ~2× seats per
   core vs one process); raises the box total but each process's knee
   stays at #1 until the index lands.

## Prior context

- 74-seat profile (`server_bun/CPU.20261030.165523.29252.0.001.cpuprofile`)
  said `send` ~36% of CPU — that's uWS internal buffered-write work,
  scaling with egress BYTES, not call count (sendUsPerCall measured
  26-33µs = ~4% of CPU at load).
- Record cap commit `4d865a5b`, send telemetry `a3a7ccf2`.
- `_docs/2026-10-30_NATIVE_ACCEL.md` — why FFI-encode is dead: encode is
  ~1.5% while socket-write work dominates.
