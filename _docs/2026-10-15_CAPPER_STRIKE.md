# Capper strike — how the bots take a flag, and how to measure it

Living reference for the bot **capper** (the runner whose whole job is the
enemy flag). Read this before touching `botRouting` goal logic,
`botLines`/`botMoves` runner branches, or the capper tuning block.

Written 2026-10-15. Numbers below are real runs of the commands in it.

## The scoreboard (run these, don't eyeball it)

```bash
cd server_bun
bun ../_tools/sweeps/capStat.ts --maps oasis,broadside_nef,escalade,raindance_nef,katabatic,surreal --seeds 1,7,11
bun ../_tools/sweeps/capStat.ts --maps katabatic --seeds 1,7 --repeat 3 --verbose   # back-to-back
bun ../_tools/sweeps/approachProbe.ts --map katabatic --seeds 9002 --window 2000 --dt 40   # whole run, 2s steps
bun ../_tools/sweeps/approachProbe.ts --map katabatic --seeds 9002 --window 60              # last 60m, 0.05s steps
```

- **`capStat.ts`** — the table. `caps/run` first (a run that never caps makes
  every other number meaningless), then `grabV` (planar speed at the grab
  instant — the "50 m/s grab"), `grabT`, `carry`, `pace`, `appE`/`peakE`.
  Rooms carry the **real map spec** (structures included), so the stand is
  the stand a live match uses.
  `--set moves.runInSpeed=52` (repeatable, dotted path) pokes one
  `BOT_TUNING` knob for an A/B without editing the table.
- **`approachProbe.ts`** — tick-resolution telemetry of the approach:
  `od`, speed, `dy` above the flag, tank `E`, the jet gate that fired
  (`jet=<why>`/`hold`), escape timer, staging `standoff` (`so=`), the move
  intent (`mv=SJHP` = ski/jet/jump/park), plus **CPA** (closest planar
  approach to the flag) and the speed there. Answers "where did the speed go".
  `--window 2000 --dt 40` gives a whole-run timeline; `--window 60` gives
  the last 60m at full resolution.
- **`capRepeat.ts` / `measureRepeat`** — one live match, every cap timed on
  its own leg (grab, carry, pace, banked energy, fumbles). `capStat --repeat N`
  drives it. `measureCap` stops at the *first* cap, so it cannot answer
  "back to back".
- **`capRun.test.ts`** — the three-map regression gate (`caps > 0`,
  `avgSpeed > 10`). It uses the **bare** room (no map spec), so its numbers
  are *not* comparable to `capStat`'s — don't mix them.

## What a grab actually is

`RoomFlags.nearestTouching` sweeps a **capsule** from the previous tick's
position to the current one, against the flag. It grabs when

- the swept path's planar distance to the flag is `<= FLAG_PICKUP_R` (**6 m**,
  ×`pickupRadius` perk mods), and
- `|path y − flag y| <= 6`.

A full-speed pass **cannot tunnel** — the path only has to *cross* the 6m
ring within 6m of flag height. Passing through is a legitimate grab;
stopping is not required. Capture is separate (`FLAG_HOME_R`, 8m, at your own
stand).

## The physics budget for arrival speed

| constant | value | means |
|---|---|---|
| `GRAVITY` | −28 m/s² | 45 m of descent ≈ 50 m/s |
| `jetForceUp` / `jetForceDir` | 35 / 10 m/s² | thrust is up-dominant; horizontal is the small share |
| `jetMaxFwdAccel` | 50 m/s | **jets alone cannot push forward past 50** |
| `terminalVelocity` | 100 m/s | fall cap |
| `ENERGY` drain / charge / max | 15/s, 8/s, 60 | a full tank is 4 s of burn |
| `groundFriction` | 50 m/s² | an un-skiing grounded bot stops fast |

Consequences, most important first:

1. **50 m/s is reachable two ways**: a ~45 m descent, or ~2.5 s of burn from
   a full tank (10 m/s² × 2.5 s = +25 m/s on top of ~20-25 arriving). Both
   need the approach to *end* downhill or to arrive with gas left.
2. **A grounded descent pumps speed** (the sim redirects velocity along the
   slope, killing only the into-ground component). An **airborne** descent
   does not — you just fall, and horizontal speed is unchanged. This is why
   approaches read a flat `v=21` for 40 m while `vy` runs −15 → −31.
3. **A stand on a rising apron** (katabatic bravo) makes the last 40 m a
   climb, so burns there buy altitude, not speed.

**The capper already reaches 40-61 m/s mid-route** (see the katabatic 9002
trace). Arrival speed is therefore not a speed cap — it is *preservation*.
See "What actually went wrong".

## Pipeline (who decides what)

`ServerBots` think → `botRouting` picks `goalPos` (d0) → `botBrain.pickDest`
→ `botLines.plan` (d1) → `botSteer` (d2) → `botMoves.hints` (buttons).

Capper-specific stages:

- **`botRouting` stand press** (~line 507 onward): once the lane to the stand
  is clear, the aim is `enemyStand + trackLead + passThrough − altitudePull`.
  - `passThrough` = `min(PASS_M=40, dStand*0.5)` along the home direction, so
    the exit wraps toward home for free.
  - `altitudePull` = `clamp((dy−5)*1.6, 0, 24)` aims the landing **short** of
    the flag when the bot is high — a deliberate brake.
  - **`passCommit` latch**: the gates are `spd > 14 && dStand > 20`, and as a
    per-think test they made the aim flip between the pole and a point 40 m
    past it — a limit cycle in the last 40 m. Now the commitment is latched
    and released when speed dies (`spd < 9`); `altitudePull` is trimmed to
    35% while committed. Non-cappers keep the old per-think behaviour.
- **Ring entries** (`RING_MAX=150`): elected only when the straight lane is
  blocked. Entries score `(drop − rise)*1.5` for cappers over the last 1/8
  of the leg — a run-in that drops is rewarded, but over a **short window**.
- **`botLines.plan`**: inside `runnerDirectGd` (48 m) the runner is handed
  the pole itself; outside, the flood hop each think.
- **`botMoves.hints`**: the whole approach game.
  - **bank leg** (`bank`): `runner` and `140 < od < strikeBankGd`. Only a real
    climb (or a live prey chase) may burn. Everything else — `hop`,
    `destHigh`, `boost`, `tap` — is dropped so regen refills the strike.
  - **strike leg** (`strike`): `runner` and `od < strikeGd` (140). Drops the
    `comfy` energy gate so the tap floor is `strikeTapMin`.
  - `runIn` burn inside `runInGdMax` (70) capped at `runInSpeed` (36);
    `grabWatchGd` (30) is the orbit-brake ring; `runnerHopGd` (28) ends hop
    chains.
  - **`mountE` start floor** (15): *no* burn may start below it, in or out of
    the strike window. Load-bearing — see landmines.

## What actually went wrong (measured, 2026-10-15)

Baseline, real map specs, 3 maps × 2 seeds: **caps/run 0.67, grabV 19.1 m/s,
grabT 69.5 s**. The failures were not slow movement:

- **The tank was empty at the stand.** The bank leg only vetoed `boost`/`tap`,
  so the hop chain and `destHigh` kept spending the same 8/s regen. The
  strike leg opened at `E≈2-13` and the run-in died on the `mountE` floor
  15 m short. Widening the bank window and vetoing every discretionary burn
  is the biggest single win measured so far.
- **Aim limit cycle in the last 40 m.** `spd>14 && dStand>20` flipped the aim
  between the pole and a point 40 m past it every think (katabatic 9002
  parked at 12-25 m for ~20 s, `mv=---P`, hop ring chattering at `v≈0`).
- **Terrain traps mid-route.** katabatic 9002 also burned ~30 s bouncing
  around 110-220 m in a bowl, and the *staging* orbit theory was wrong —
  `so=-` throughout, the standoff never armed.

**Still open**: the terrain-trap bounce. `stale`/`lastGd` in `botLines` and
the inherited `stuck` escape were aimed at exactly this, but that escape is
gated on `!ctx.running` and `ctx.running` is a **role** flag (see landmines),
so it is dead for cappers. Fixing it is the obvious next lever.

## Landmines

- **`running` / `runner` are ROLE flags, not state.** `botRouting` ~line 778
  sets `running: (role === 'infiltrator' || role === 'capper' || push)` and
  `runner: role === 'capper'`. A capper has **both true for his entire run**,
  carrying or not. Any `!ctx.running` / `!ctx.runner` gate silently means
  "not a capper".
- **`strikeTapMin=2` is only a HOLD floor.** The `mountE` *start* floor
  overrides it. Lowering the start floor to `strikeTapMin` measured **worse on
  every axis** (grabV 22.4→15.0, oasis 22.4→8.7): a capper arriving on 2 E
  cannot mount the dais and crawls the last meters in.
- **`runInSpeed` alone is not the lever.** 36→52 alone measured *worse*
  (grabV 19.1→16.1) because the tank was empty. Pair it with a bank change and
  re-measure before believing it.
- **The harness freezes every non-capper** (`room.bots.quiet`), so there is no
  wave and no enemy. `capStat`/`capRepeat` numbers isolate **movement**, not
  survival. Never tune interception or staging off them — and note the capper
  has no standoff/wave in this harness.

## Measured history (newest first)

**Baseline caveat**: every number here was taken with the *inherited*
uncommitted WIP in `shared/botGraph.ts` (bend-brake: stop the waypoint walk
at sharp cumulative turns) and `shared/botLines.ts` applied. The `botLines`
half is inert for cappers (`!ctx.running` — see landmines); the `botGraph`
bend-brake is live. Re-baseline if that WIP is ever reverted.

| date | setting | runs | caps/run | grabV | grabT | carry |
|---|---|---|---|---|---|---|
| 2026-10-15 | **bank veto + `strikeBankGd=320` + `passCommit`** | 5 seeds × 3 maps | 0.80 | **22.4** | **44.3** | 61.9 |
| 2026-10-15 | same, whole T2 set | 3 seeds × 6 maps | 0.83 | 18.3 | 50.8 | 72.0 |
| 2026-10-15 | `passCommit` only | 2 seeds × 3 maps | 0.67 | 20.9 | 53.1 | 74.5 |
| 2026-10-15 | bank veto only (`strikeBankGd=200`) | 5 seeds × 3 maps | 0.80 | 19.1 | 52.4 | 68.8 |
| 2026-10-15 | baseline (inherited WIP applied) | 2 seeds × 3 maps | 0.67 | 19.1 | 69.5 | 70.1 |
| 2026-10-15 | baseline + `runInSpeed=52` | 2 seeds × 3 maps | 0.83 | 16.1 | 58.7 | 75.3 |
| 2026-10-15 | `strikeTapMin` start floor ***reverted*** | 5 seeds × 3 maps | 0.80 | 15.0 | 50.9 | 77.5 |

Back-to-back (`--repeat 3`): katabatic 3/3 caps on seeds 1 and 7, best leg
`grabV=36.6`; surreal 3/3 on seed 1, 0 on seed 7; oasis 0-1. Back-to-back works
on the maps whose corridors hold up; re-running a cap is not free (the capper
restarts from wherever the last cap left him).

Per-map, 3 seeds (`capStat`): oasis 0.67/20.6 m/s, broadside_nef 1.00/15.6,
escalade 0.67/13.9, raindance_nef 1.00/16.6, katabatic 1.00/24.1,
surreal 0.67/18.3. Every T2 map now caps at least 2 runs in 3 — oasis and
escalade were 0/1 in the earlier `capperSweep --genomes 0` baseline.

## Sweep history (env-var experiments)

- `_tools/sweeps/energySweep.ts`, `energyThreshold.ts` — jet economy per meter.
  `skiVetoSpeed` and `eScoreW` were swept; results in `_tools/sweeps/out/energy_*.csv`.
- `capperSweep.ts [--genomes N] [--gens N] [--lap]` — random/ES sweep over 40
  tuning genes. Baseline row = `--genomes 0`.
