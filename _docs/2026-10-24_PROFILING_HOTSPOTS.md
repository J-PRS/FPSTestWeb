# Server profiling hotspots — 512-player soak

Measured via `_tools/profload.ts --bots 512 --roomspec prof=16 --cpuprof`
(512 players, 16 rooms of 32, 30 s measurement, WS tier). CPU profile:
`server_bun/CPU.*.cpuprofile` (deleted after analysis).

## Phase-level breakdown (per tick, ms)

| Phase | ms | Share |
|---|---|---|
| `fanout` | 1.35 | 38 % |
| `sim:move` | 0.55 | 15 % |
| `records` (buildRecords) | 0.36 | 10 % |
| `sim:proj` | 0.34 | 10 % |
| `sim:balls` | 0.10 | 3 % |
| `sim:bots` | 0.12 | 3 % |
| `sim:crawl` | 0.14 | 4 % |
| `sim:deploy` | 0.05 | 1 % |
| `sim:pickups` | 0.00 | 0 % |
| `cmd` | 0.06 | 2 % |
| `auth` | 0.00 | 0 % |
| `sim:health` | 0.01 | 0 % |

Tick total: **3.57 ms avg / 20 ms max**. Sim is not the bottleneck;
fanout + encoding is.

## Function-level hotspots (by CPU sample hits)

| Hits | Function | File | Category |
|---|---|---|---|
| 2551 | `send` | (socket I/O) | network write |
| 542 | `tick` | RoomMoveSim.ts:619 | movement sim |
| 288 | `fanoutRecords` | tickRecords.ts:354 | fanout |
| 232 | `set` | (internal) | bookkeeping |
| 128 | `encodeBatch` | wire.ts:789 | encoding |
| 127 | `buildRecords` | tickRecords.ts:106 | fanout |
| 114 | `Uint8Array` | (alloc) | allocation |
| 108 | `encodeTickPlayerV4` | wire.ts:653 | encoding |
| 106 | `encodeTickFrame` | wire.ts:367 | encoding |
| 104 | `bodiesNear` | RoomMoveSim.ts:642 | spatial query |
| 85 | `humanFoeNear` | ServerBots.ts:758 | bot AI |
| 67 | `reconcile` | moveJudge.ts:279 | lag comp |
| 67 | `stepAll` | BallSim.ts:349 | ball sim |
| 60 | `restore` | movement.ts:367 | movement |
| 57 | `tickMine` | deployTicks.ts:68 | deployable |
| 55 | `meterHumans` | ServerBots.ts:728 | bot AI |
| 48 | `flushOutboxes` | ConnectionManager.ts:125 | network write |

## Hotspot ranking

1. **`send` (2551 hits)** — raw socket write dominates. Egress is #1 cost.
2. **`fanoutRecords` + `buildRecords` + `encode*`** — encoding player state
   per recipient, per tick.
3. **`RoomMoveSim.tick` + `bodiesNear`** — per-player movement + O(n²)
   spatial queries.
4. **`humanFoeNear` / `meterHumans` / `reconcile`** — bot AI + lag comp.

## Optimization roadmap (ordered by expected impact)

### Tier 1 — encoding & fanout (biggest, ~40 % of tick)

1. **Encode once, fan out bytes.** `encodeBatch` already exists; verify no
   per-recipient re-encoding in `fanoutRecords`. Grep for `.encode(` inside
   per-player loops.
2. **Delta fanout.** `buildRecords` encodes full player state every tick.
   Ship only changed fields (position delta, health delta, etc.) and let
   the client apply patches. Biggest single win for egress bandwidth.
3. **Suppress unchanged players earlier.** The `recordsSuppressed` counter
   exists but is reset every rollup window; ensure suppression runs before
   encoding, not after.
4. **Reduce `send` call count.** `flushOutboxes` batches per-socket, but
   stray `send()` in bot/AI paths bypass it. Audit all `.send(` calls.

### Tier 2 — movement & spatial (sim:move + bodiesNear)

5. **Broadphase for `bodiesNear`.** Replace O(n²) with a spatial grid or
   sweep-and-prune. `bodiesNear` is called per player per tick.
6. **Skip `restore`/`reconcile` for idle players.** Only run lag comp
   for players with recent input.

### Tier 3 — bot AI

7. **Gate `humanFoeNear` / `meterHumans` by room type.** In 1v1 rooms
   without bots, these are no-ops but still iterate.
8. **Reduce `ServerBots` think frequency.** Bots think every tick; many
   could think every 2–3 ticks without perceptible degradation.

### Tier 4 — allocation hygiene

9. **Eliminate `Uint8Array`/`DataView` churn.** Pre-allocate encode buffers
   and reuse. GC pauses show up as tick spikes (max 20 ms).
10. **Pool `send` buffers.** Avoid per-frame allocation in the hot path.

## Evidence

- 512 players: fanout 1.35 ms (38 % of 3.57 ms tick).
- `send` = 2551/3476 samples = **73 % of CPU time**.
- `fanoutRecords` + `buildRecords` + `encode*` = ~653 hits = **19 %**.
- `RoomMoveSim.tick` + `bodiesNear` = ~646 hits = **19 %**.

## Next steps

1. Run `--cpuprof` on a 1v1-only mix to see if the profile changes
   (expect `fanout` to shrink, `sim:move` to dominate).
2. Implement Tier 1 (delta fanout) — highest impact, lowest risk.
3. Re-run soak to measure before/after.