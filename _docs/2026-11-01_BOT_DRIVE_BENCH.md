# Bot Drive Methods — Speed vs Cost Bench

Date: 2026-11-01. Measurements from `tests/scenarios/_greedyab.ts`
(same seed 1337, peaks.bin real CTF terrain, 90–120s sim, ~10 bots,
impossible skill) and an inline decide-cost bench. All numbers
reproducible: `DRIVER=mpc|greedy SIM_S=120 bun tests/scenarios/_greedyab.ts`.

## Methods compared

| Method | What it is | Where |
|---|---|---|
| `legacyMove` | Direct pos writes, walk pace | fallback when no shadow |
| `driveMove` (reactive stack) | Brain `out.move` → `moveSim.setInput`; senses → steer/jet heuristics | default for every bot |
| `botMpc` (beam search) | Worker-thread beam over MoveSim snapshots; replays a multi-second act schedule, re-solves on diverge/retarget/exhaust | flag-mode committed runners only (`ctx.runner||running`) |
| `botGreedy` (rollout) | Every ~4Hz: 14 candidates (7 yaw × jet) rolled 0.9s through the live shadow's own sim snapshot; argmax wins; nothing stored | same arm slot as MPC, `FPS_GREEDY=1` |

## Measured speed (armed capper-roles, peaks terrain)

| Driver | Armed avg speed | vmax |
|---|---|---|
| MPC (seed 1337, 120s) | 36.7 / 15.8 / 41.0 m/s | 60–69 |
| **Greedy** (same seed, 120s) | **41.6 / 68.4 m/s** | 53–73 |
| Reactive stack (from `_docs/2026-10-16_CAPPER_REACTIVE_LIMITS.md`) | ~20–30 m/s grab speed ceiling | — |
| MPC deep solves (same doc, offline harness) | 33–43 m/s grabs | — |

Grabs: tied 1–1 per 120s on the shared seed. Caps: 0 both (slow
match, needs multi-seed to differentiate). Single-seed speed table is
directional, not gospel — armed count differs because the sims
diverge into different role assignments.

## Measured cost

| Method | Cost per armed bot | Notes |
|---|---|---|
| `driveMove` | ~µs/tick | pure input writes |
| Greedy decide | **0.27 ms** per decide | 14 candidates × 54 ticks; runs inline on the tick |
| Greedy apply | **12 µs/tick** between decides | ≈ 0.03 ms/tick sustained per armed bot at 4Hz decide |
| Greedy total | ~0.1 ms/tick for 3 armed | fits in the 50ms budget with enormous headroom |
| MPC solve | **~22–24 ms** per solve | worker thread normally; `FPS_MPC_SYNC` pins main-thread (tests) |
| MPC solve rate | ~101 solves / 120s (3 armed) | ≈0.28 solves/s/armed bot; ~2.2s total CPU per 120s room |
| MPC replan churn | why: miss3 / exhausted89 / div1 / retgt8 | exhaustion re-solves are the dominant cost |

CPU verdict: greedy is ~**25× cheaper** per unit of driving authority
(0.03 ms/tick sustained vs ~2.2s worker wall per room-120s), and it
needs no worker, no arena, no plan bookkeeping.

## Qualitative differences that matter for the decision

- **Staleness class**: MPC replays a stored plan — a wall-pinned bot
  ON its track reads `diverged=false` and replays into the wall until
  the act list exhausts (the `f2610580` watchdog exists because of
  this). Greedy stores nothing; a stale pick dies in ≤0.25s.
- **Horizon**: MPC sees 4–5s ahead (dive lines no local rule can see —
  the whole reason it exists, `CAPPER_REACTIVE_LIMITS`). Greedy sees
  ~0.9s — it will NOT pre-position for a far-terrain speed line.
- **Cost shape**: greedy's cost is flat and predictable (~0.1ms/tick
  per room); MPC's is bursty (a solve window can land mid-firefight).
- **Failure surface**: MPC = worker spawn, pending-job bookkeeping,
  retarget churn. Greedy = candidate-set quality only.

## Decision guidance

- Greedy is ready to be the **default armed driver** — cheaper,
  faster on measured terrain, no freeze class. Its weak spot is
  far-sight route planning (crest-to-crest dives).
- Best-of-both exists: keep MPC armed ONLY for the deep-solve
  line-setter (DEEP solves are where 40+ grabs come from) and let
  greedy run the transit legs — the arm map already selects static
  goals; a `deepOnly` MPC mode + greedy transit is ~30 lines of
  glue, not a new system.
- `driveMove` stays the unarmed path everywhere — non-runner bots
  never needed planning; their fixes live in brain goals, not drivers.
