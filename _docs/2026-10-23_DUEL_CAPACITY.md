# 1v1 capacity — deep report

Date: 2026-10-23. Follow-up to `_docs/2026-10-23_SERVER_HOTPATH_AUDIT.md`.
Question: **if the code were smarter and battles were 1v1, would one core
serve more CCU?**

Short answer: **not with the current server.** Measured, splitting the same
64 players into 32 duel rooms costs *more* than putting them in two 32-seat
rooms — 36.6 % of a core versus 24.1 % (175 vs 266 CCU/core). The reason is
that 1v1 removes the term people expect to dominate (per-record fanout) and
leaves the two terms that actually dominate: **per-room fixed work** and
**per-client transport work**. Both are attackable, but neither is touched by
"fewer players per room" — that's what this report is about.

Everything below is either measured on this box (i7-13700KF, 16C/24T) or
explicitly labelled a projection. No projection is in the summary table.

---

## 1. Method

`bun _tools/profload.ts --bots N --rooms <list> --secs 40` — real WebSocket
clients driven by `server_bun/tools/netBot.ts`, one Bun server process,
CPU read as `(cpu time delta) / wall` via `Get-Process`, i.e. **percent of one
core**, which for a single-threaded Bun process is percent of one P-core.

Rules learned the hard way (two earlier runs were thrown away):

- **Never quote a `--cpuprof` run as capacity.** Sampling costs ~30 %:
  the profiled duel run read 0.759 %/client (132 CCU/core) against
  0.572 %/client (175 CCU/core) unprofiled. Profiles are for *attribution*,
  not for the number.
- **Wait for the port.** `profload` kills its children but the listener can
  linger a second on Windows; the next run then dies with
  `Only one usage of each socket address` because two servers fight over the
  UDP side channel. Check `Get-NetTCPConnection` on 8100+ between runs (a
  reaper landed in `b4fff89c`, but pin `--port` if you are scripting a sweep).
- **Compare only at matched activity.** Ball/projectile/deploy traffic moves
  the number more than room shape does at these sizes. Bots fight, so all
  runs below are "everyone in combat", which is the worst case.

## 2. Measured baseline

| shape | players | core | room tick | per client | CCU/core |
|---|---|---|---|---|---|
| 2 rooms × 32 | 64 | 24.1 % | 0.96 ms | 0.377 % | 266 |
| 1 room × 64 (`FPS_MAX_PLAYERS=64`) | 64 | 28.9 % | 2.12 ms | 0.452 % | 222 |
| 4 rooms × 32 | 128 | 36.7 % | 1.74 ms | 0.287 % | 349 |
| **32 rooms × 2** | 64 | **36.6 %** | **0.15 ms** | **0.572 %** | **175** |

Read the two bold columns against each other. Duel rooms cut the per-room
tick from 0.96 ms to 0.15 ms — the tick is nearly free — and CPU still went
**up 50 %** for the same headcount. Whatever costs the core is not in
`tickRoom`'s measured phases.

That gap is the subject of §3.

## 3. Where the core actually goes

CPU profile, 32 rooms × 2, 40 s (~2 400 samples, 61.6 s sampled). Shares are
of samples, bucketed; native frames blur attribution by a point or two.

| bucket | share | what's in it |
|---|---|---|
| native alloc / transport | ~31 % | `Uint8Array` 8.9, `setTimeout` 8.7, `send` 6.9, buffer getter 3.0, `DataView` 2.6, `Object.assign` 0.9 |
| wire encode/decode | ~9 % | `encodeBallSegment` 4.8, `readInputEdge` 1.5, `encodeBallBatch` 0.6, frame `handle` 1.2 |
| movement sim | ~10 % | `RoomMoveSim.tick` 4.9 (the per-tick capsule grid), `anchoredCompare` 2.6, `restore` 2.1 |
| move judge | ~5 % | `reconcile` 4.7 |
| message handling | ~8 % | `onMessage` 4.4, `dispatchMessage` 2.1, `MessageHandler.handleMessage` 0.9 |
| tick loop bookkeeping | ~7 % | `tickRoom` 2.4, `fire` 1.9, `mark` 1.7 |
| ambient world | ~6 % | `BallSim.stepAll` 1.6, `alivePlayers` 1.2, `influenceMap.tick` 1.1, `snapTarget` 0.6, `stepBall` 0.6 |
| bots | ~1.6 % | `ServerBots` senses/meters |
| hash + rosters | ~1.3 % | `worldModel`, `buildRecords`, state-hash lanes |

Two things jump out.

**The ambient world costs about as much as the players.** `encodeBallSegment`
alone is 4.8 % of the core — second only to the movement sim's `tick`, and it
is pure ambient wildlife. A duel room with two players still spawns,
bounces and streams balls every tick, because `registerSims()`
(`Room.ts:838`) pushes `balls`, `crawl`, `bots`, `flags`, `pickups`,
`deploy`, `proj`, `move`, `health`, `ping`, `influence` unconditionally. The
existing `noBalls`/`noCreatures` join flags only zero the *population*
(`roomFactory.ts:164`, `Room.ts:530`), so the sims still step.

**The tick loop's own instrumentation is visible.** `mark()`
(`TickLoop.ts:67`) plus `fire()` together are ~3.6 % of samples. Phase marks
run `wallNow()` several times per room-tick and write a `Map` entry each time;
at 640 room-ticks/s that is measurable bookkeeping for a metric nobody needs
at full rate.

## 4. Cost model

Two unknowns, three equations. Marginal per-room cost from the two 64-player
runs at different room counts:

```
(36.6 − 24.1) / (32 − 2) = 0.417 % of a core per room
per-client at duel density  = 0.572 − 0.417/2 = 0.364 %
check: 100 / (0.417/2 + 0.364) = 175 CCU/core   ← matches the measured 175
```

So a duel room is **~0.42 % of a core for the room + ~0.36 % per client**,
and capacity falls out as `100 / (room/2 + client)`.

Two consequences:

1. **Per-client cost is not constant — it is worst at n=2.** Distance tiers
   (`tickRecords.ts:380`: every tick inside 150 m, 150–400 m, 400–600 m,
   every 8th tick past 600 m) cull most records in a 32-player room. In a
   duel the two players are almost always inside 150 m, so **100 % of records
   are tier-0** — the one shape where interest management has nothing to cut.
   1v1 is the least efficient density this stack supports, not the most.
2. **A naive additive model fits poorly.** It predicts 48 % for
   4 × 32 at 128 players where 36.7 % was measured, because it assumes the
   per-client term is density-independent — which §4.1 just showed it isn't.
   Use the marginal-room / per-client split only near the duel shape.

## 5. Levers, in payoff order

Estimates are arithmetic on the model in §4, not measurements. Each lever
lists what it changes and what it risks.

### L1 — Mode-scoped sims (biggest single lever)

A duel room needs `move`, `proj`, `health`, `ping`, `bots` and `records`. It
does not need `balls`, `crawl`, `pickups`, `deploy`, `flags`, `arena` or
`influence`. Make `registerSims()` consult the mode spec instead of pushing
everything, and extend the existing `noBalls`/`noCreatures` plumbing into a
`world: 'empty'` mode flag rather than two booleans.

Expect the ambient bucket (~6 % at 32 rooms) plus its share of native
allocation to fall out, and `encodeBallSegment` — the single largest JS
function — to disappear entirely in duel rooms. Estimate: room cost
0.42 → ~0.25 %, i.e. ~213 CCU/core.

Risk: low. These sims are independent; the only coupling is the world-state
replay used by `stateHash` (`TickLoop.ts:419`) and by joiners. Both must
emit an empty lane rather than `undefined` for consistency with the existing
"unspawned never leaves the server" rule.

### L2 — Quiet-room tick

`tickRoom` ships a frame **unconditionally** (`TickLoop.ts:334`) so the
client's loss metric can read arrival cadence. That is correct for a live
match and wrong for a duel where nothing moved this tick. Two options:

- a low-rate heartbeat (e.g. 4 Hz) when the room is fully suppressed and no
  events fired, with `ackSeq` still riding each heartbeat — the client must
  distinguish "quiet" from "lost", so this needs an explicit flag, not
  silence;
- decimate the room's *tick* (not just its records) to 10 Hz when no player
  input landed in the window. Deterministic sims cannot simply skip time
  without a catch-up step, so this is the riskier half.

Estimate: room cost 0.25 → ~0.15 %.

Risk: medium. Touches the loss metric, `stateHistory` pruning, match clock
and respawn timers. Scenario tests should pin the heartbeat semantics before
code lands.

### L3 — Ambient decimation

For low-pop rooms, step balls/creatures at half rate (still deterministic —
they are server-authoritative edges, so the client replays whatever arrives).
This is a cheaper variant of L1 for modes that want wildlife but not much of
it. Estimate: a third of the ambient bucket.

### L4 — Occupancy-scaled hash cadence

`broadcastStateHash` runs every `hashBroadcastIntervalMs` (2 s) per room and
builds every world-state lane (`TickLoop.ts:419`). At 32 rooms that is 16
full-roster hashes per second to verify rooms with two players. Scale the
cadence by occupancy, or hash only the lanes the mode actually has (which
follows from L1).

### L5 — Sample the phase marks

`mark()` is ~1.7 % of samples for a debug metric. Mark every 10th tick (or
gate behind `FPS_TICK_PHASES=1`) and keep the EMA. Free ~1.5 points.

### L6 — Frame allocation

`Uint8Array` + `DataView` + buffer getter ≈ 14 % of samples. `evScratch`
(`f0ee644a`) removed the event-path triple-alloc; the tick path still builds
a frame per recipient per tick (`encodeTickFrame` returns a sized subarray).
A per-connection frame arena (reuse the buffer until the socket drains) would
cut most of it. Medium effort, no semantic change.

### L7 — Per-send cost

`send` is 6.9 % of samples for 1 280 sends/s (~53 µs each). `WIRE_BATCH`
already merged the in-tick sends. Remaining wins are frame size (L1/L3 shrink
the payload, which also shrinks the syscall) and, for identical payloads,
`publish`. Duel frames are per-recipient, so publish does not apply.

### L8 — Process-per-core

Independent of everything above: capacity per *box* is `cores × per-core`,
and the lobby already multi-tenants rooms. The missing piece for 1v1 at scale
is a stateless matchmaker handing out room placement (Colyseus-style seat
reservation) so duel rooms are created where there is headroom rather than
where a name hash lands.

## 6. Projection

Arithmetic from §4, with per-client shrinking because L1/L3 remove records
from the duel frame. **Not measured** — the experiment plan in §8 is how these
get their real numbers.

| state | room % | client % | CCU/core |
|---|---|---|---|
| today (measured) | 0.42 | 0.36 | **175** |
| L1 (empty-world duel room) | 0.25 | 0.30 | ~222 |
| + L2 quiet tick | 0.15 | 0.25 | ~286 |
| + L6/L7 smaller frames | 0.10 | 0.20 | ~400 |
| + L5, L4, tuned | 0.05 | 0.15 | ~570 |

For reference, **Photon reports 2 000–3 000 CCU on a 4-core box** (500–750
CCU/core) at ~200 messages/room/s and says the bottleneck is usually the NIC,
not the CPU ([Photon perf tests](https://doc.photonengine.com/zh-tw/server/v4/performance/performance-tests)).
They simulate nothing; we currently simulate a full CTF world per duel. The
gap between 175 and ~570 is the price of that world, not of the players.

## 7. Industry patterns worth copying

1. **Room is the scaling unit; the matchmaker is stateless.** Colyseus:
   rooms distribute across processes, a join reserves a seat via Redis
   presence, then the client connects directly to the owning process —
   "increasing the number of processes increases the amount of rooms"
   ([docs](https://docs.colyseus.io/scalability)). Photon: a Master Server
   distributes rooms across Game Servers
   ([glossary](https://doc.photonengine.com/server/v5/reference/glossary)).
2. **Budget per room, not per player.** Photon publishes "~200 messages per
   room per second" as the planning unit and caps messages per room to keep
   a fixed slice of a shared server. Our equivalent should be
   *sims + records + hash per room per second*, and a duel room should have a
   much smaller bill of materials than a 32-seat CTF room.
3. **Fanout is c·n·s·f; attack n and s.** AOI filtering plus delta encoding
   took Quake II at 8–64 players down to 62–492 kbps
   ([Colyseus/NSDI'06](https://www.usenix.org/legacy/event/nsdi06/tech/full_papers/bharambe/bharambe.pdf)).
   At n=2 there is nothing left to filter, which is exactly why the duel
   needs *fewer things in the room*, not smarter filtering of them.
4. **Adaptive rates instead of one rate for everyone.** Overwatch ships a
   client update rate of 20.8 Hz by default and a 63 Hz high-bandwidth mode,
   with the simulation on fixed command frames and a separate cost/latency
   tradeoff per mode ([GDC 2017 writeup](https://edgegap.com/blog/game-backend-deep-dive-overwatch-2016-netcode-architecture-rollback)).
   The transferable idea is the *policy*, not the rate: pick the cadence by
   match state and client budget.
5. **Sleep aggressively.** Empty rooms already hibernate here; the missing
   rung is a quiet-but-occupied room, which L2 adds.

## 8. Experiment plan

Each step is one `profload` run (~90 s), matched against the 175 baseline.

1. **Empty-world duel.** Add a `duel` mode (or pass `noBalls`+`noCreatures`
   plus skip flags/pickups/deploy/influence) and run
   `--bots 64 --rooms duel1..duel32`. This needs `netBot` to forward the
   join flags — it currently does not (`server_bun/tools` has no
   `noBalls`/`noCreatures`). Acceptance: ≥ 220 CCU/core, `encodeBallSegment`
   absent from the profile.
2. **Quiet tick.** Only after the state-hash and loss-metric semantics are
   pinned by scenario tests. Acceptance: no `stateHash` mismatch in the wire
   parity harness, no client loss spike in the E2E smoke.
3. **Frame arena.** Profile-only acceptance (allocation bucket halves);
   capacity must not regress.
4. **Box-level.** Once per-core is settled, measure 8 processes × 349-ish on
   this box to confirm the processes do not contend on the single uWS loop
   per process.

Record every run in this file with the command, the four numbers from §2, and
the activity mix (balls/creatures on or off). A run without its mix is not
comparable.

## 9. Hazards

- **State hash is load-bearing.** Any sim you skip in L1 must still emit its
  lane in `stateHash`, or every client trips `Hash mismatch` forever. The
  existing rule — "an empty lane, not `undefined`" (`TickLoop.ts:419`) —
  exists for exactly this.
- **The client's loss metric reads cadence, not content.** A silent room is
  indistinguishable from a dropped stream; L2 must ship a heartbeat.
- **Determinism.** Balls and creatures replay on the client. Decimating
  their *send* rate is safe (edges + committed snapshots); decimating their
  *sim* rate changes trajectories and needs the shared sim changed on both
  ends in the same commit.
- **Bot fill expectations.** Bots are virtual clients — they generate inputs
  and claims at full rate, so a "quiet" room with bots is never quiet.
  Measure quiet-tick wins with bots parked or absent, then re-measure with
  bots to see the real number.
- **Respawn timers are the known wall-clock edge** (`server_bun/AGENTS.md`);
  L2 changes how often they get serviced.

## 10. Bottom line

1v1 is not a shortcut to capacity on this stack — measured, it is **1.5× more
expensive per client** than a full 32-seat room, because tiers cull nothing at
n=2 and every duel room carries a complete simulated world. The capacity is
recoverable, but only by **making the room smaller in content, not in
players**: empty-world duel mode (L1) is the lever that matters, quiet-tick
(L2) and frame allocation (L6) are the follow-ups, and the per-core number
should land somewhere around 220–400 CCU/core before the NIC becomes the
constraint — still short of a relay-only stack like Photon, and honestly so,
because we simulate and they do not.
