# hhEvo Findings #5 — Throughput: Where the Time Goes + How to Get Orders of Magnitude

*Profiling the sim loop, then mapping external research (parallel RL
infrastructure, EA early-termination literature, JS hot-loop
optimization) onto our harness. Goal: raise the ~100× sim/wall
multiplier without breaking determinism or fitness honesty.*

---

## A. Measured profile (where the time actually goes)

Instrumented `runMatch` with env-gated buckets (`FPS_HHPROF=1`), then a
Bun `--cpu-prof` over a 3-sim-min 6v6 match.

**Level 1 — coarse buckets:**

```
setup ≈ 0.3%   step ≈ 98.5%   respawn ≈ 0.3%   descriptor loop ≈ 0.2%
```

`step()` *is* the program. Batch sizing, descriptor scans, room setup —
all noise. Optimizing anything but `step` is wasted effort.

**Level 2 — self-time inside step (~1.34M sample units):**

| Family | ~Share | What it is |
|---|---|---|
| Heightfield queries (`hmChord`/`hmField`/`hmNormal`) | ~15–18% | Terrain height/normal lookups — several per entity per tick even on the 4-cell flat field. Volume problem, not per-call cost. |
| Bot sense infra (`influenceMap.tick`, `noisesNear`, `spotBoard.update`) | ~6.5% | Splats, noise queries, spot tracking every tick × 12 bots |
| Wall-clock reads (`wallNow`/`now`) | ~6% | Wall time inside the sim loop — pure overhead in warp mode; exists for realtime-mode edges (respawn timers, logger rate limits) |
| Movement sim (`RoomMoveSim.tick`, `bodiesNear`) | ~5.5% | Honest sim work |
| Bot brains (`think`/`driveMove`/`steer`/`selfBlastBlocked`/`groundY`) | ~4.5% | Honest sim work |
| Roster/party (`of` serverParties, `getPlayer`, `onKill`) | ~4.5% | Bookkeeping |

**Interpretation:** no single hot spot — a broad shelf of
bookkeeping/queries (~40%) on top of honest movement+combat work
(~60%). Micro-optimization buys maybe 1.5–2× total. Confirmed:
at 12 entities there is no broadphase cliff or GC pause problem —
the JS-optimization canon (pooling, SoA, spatial hash) doesn't apply
at this entity count.

## B. The research — what actually delivers orders of magnitude

### 1. Parallel environment sharding — the industry answer (~N×)

Every high-throughput self-play framework reaches the same
conclusion: you don't make the sim faster, you run more of them.

- **Sample Factory** (Petrenko et al.) — 100k+ env-frames/s on one
  machine via parallel envs + async sampler, used for FPS self-play.
- **EnvPool** — async batched env execution, 2.8× over naive
  multiprocess *on a laptop*.
- **TimeChamber / Isaac Gym, Brax, Pgx** — same shape pushed to GPU:
  thousands of envs stepped as a batch.

**Fit here:** hhEvo pairings are embarrassingly parallel — each
`(genomeA, genomeB, map, seed)` is an independent deterministic match.
Spawn N Bun processes each owning a slice of the pair list, merge
margins. Generations stay sequential (survivors feed mutations) but
the 15–28 pairings inside a gen are where all the time is.

**Determinism:** preserved — seeds are per-pairing, not sequential;
execution order doesn't matter. No shared room state exists to
serialize.

**Ceiling:** this machine = **24 logical cores**. Expect ~15–20× real
(NUMA/memory-bandwidth tax at full occupancy; Bun processes aren't
free). 100× → **~1500–2000× realtime**.

Cost: a `--shard k/N` flag + parent spawner + result merge. ~A day of
harness plumbing, no sim changes.

### 2. Evaluation-budget racing / successive halving (2–4×)

The EA literature on early termination is deep:

- **Bongard (2011)** — stopping hopeless evaluations early dropped
  time complexity polynomial → sublinear; biggest savings between
  evaluation instances, not within.
- **Generalized early stopping (GECCO 2024)** — up to 75% saved with
  a problem-agnostic criterion.
- **Hyperband / successive-halving brackets** — screen the whole
  field cheaply, spend the budget on survivors.

**Fit here:**

- **Between-matches racing:** `MATCHES=2–4` is fixed, but most
  pairings are lopsided. If match 1 produces `|margin| > θ`, skip
  the rest. If most pairings resolve in 1 match → ~2× on eval time.
- **Between-pairings screening:** run the whole pop on 1 match/map,
  cull bottom half, full matrix on survivors — a Hyperband bracket.
  Screening rounds ~4× cheaper.

**The honest caveat:** headhunt margins *can* swing late (hoards
scatter on death — we measured ±50 margins and a −16 to +8 inversion
from a single rule change). θ must be validated against known
comebacks, not guessed. A bad threshold silently kills
comeback-capable genomes — the literature's documented failure mode.
Validate: replay `--pairs` history, check how often early-lead
reverses.

### 3. Common random numbers — variance reduction (free)

Run every pairing in a round on the *same* seed set (already true per
`--seed`; make it explicit and shared across maps). Paired
comparisons cut the matches needed for a given confidence — same
mechanism the regrab-lock A/B exploited when it got a clean answer in
4 matches.

### 4. JS-level trims (1.3–2×, composable with all above)

In priority order from the profile:

1. **Hoist `wallNow` out of the tick loop** — ~6% free, zero behavior
   change. Cache per batch, not per match (respawn timers are the
   known wall-clock edge).
2. **Dedupe heightfield lookups** — per-tick memo on (x,z) cell, or
   trust the move shadow's `onGround`/`ground` state instead of
   re-deriving `groundY` in senses.
3. **Throttle sense infra** — influence/noise/spot at 5Hz instead of
   20Hz; reads identically at bot-reaction timescales. ~4%, small
   behavior drift.
4. **Kill per-tick `getAllPlayers()` copies** — cached array
   invalidated on join/leave. (hhEvo's own descriptor loop does this
   too.)

**What does NOT apply:**

- **GPU batching (Brax/Pgx/Isaac):** needs the sim rewritten as a
  batched tensor program — kills the shared/client code path and
  bit-exact determinism. Off the table.
- **`dt` 0.05→0.1:** halves ticks, but bot reaction granularity and
  projectile windows change — you'd be evolving for a different game.
  Screening-only tool at best.
- **Fewer bots / shorter matches:** changes headhunt dynamics
  (economy needs player density). `--mins 2` biases fitness toward
  aggression.
- **Native/SIMD hot loops:** ~20% of the loop at best, weeks of work,
  determinism risk. Not worth it.

## C. Stacked estimate

| Lever | Multiplier | Fidelity cost | Effort |
|---|---|---|---|
| Parallel shards (24c) | ~15–20× | none | ~1 day harness |
| Racing/screening | ~2–3× | validated θ required | ~0.5 day + validation |
| Step trims | ~1.5× | none–small | incremental |
| **Stacked** | **~45–90× over current** | | |

Current: ~100 sim-min per wall-min (~100×). Stacked: **~4,500–9,000
sim-min/min** — the `--pop 8 --gens 10` matrix "overnight" run becomes
~2–5 wall minutes; `--pop 16 --gens 30` overnight-style runs become a
long lunch.

## D. Recommended order

1. `--workers N` / `--shard k/N` process sharding — the pure win, no
   fidelity question to answer.
2. Micro-trims (wallNow hoist, heightfield memo) — safe, composable.
3. Racing — only *after* validating θ on replayed pair history;
   this is the one that can silently corrupt fitness.

## E. Sources

- Petrenko et al., *Sample Factory: Egocentric 3D Control at 100k FPS*
  (arXiv:2006.11751) — parallel envs > faster env
- Weng et al., *EnvPool* (arXiv:2206.10558) — async batched env exec
- inspirai/TimeChamber — parallel self-play + multi-elo evaluation
- Koyamada et al., *Pgx* (arXiv:2303.17503) — hardware-batched sims
- Bongard, *Generalized Early Stopping* (IEEE TEC 2011) —
  between-instance termination, polynomial→sublinear
- *Generalized Early Stopping in Evolutionary Direct Policy Search*
  (GECCO 2024) — 75% savings, problem-agnostic criterion
- Google Research, *Brax* — differentiable batched physics
  (the shape we'd need for GPU; rejected above)
