# Path-Free Bot Driving — Alternatives to MPC

Date: 2026-11-01. Trigger: "too sheepish" report on live OCI + the
RANCHO-06 freeze (vmax=0, parked=100% over a 25s `_botspeed` sample).
The MPC option (`server_bun/src/botMpc.ts`) only arms in flag modes
(`ctx.runner||ctx.running && ctx.objective`), so the headhunt freeze
wasn't MPC — but the audit surfaced a real structural flaw in the
precomputed-plan approach that these alternatives eliminate by design.

## The problem being solved

MPC holds a beam-searched action schedule and replays it. The kill
conditions are `diverged` (off-LINE) and `retargeted` — a bot pinned
against a wall **on** its track reads `diverged=false` and replays
`forward+ski` into the wall until the act list exhausts (up to the full
horizon). `f2610580` added a 5s/<3m watchdog as insurance, but the
deeper point stands: **any replayed plan has a staleness class that no
amount of kill-checks fully removes**. Path-free drivers re-decide
every tick, so the stale-track bug class doesn't exist.

## Constraints we already satisfy

- `shared/movement.ts` + `MoveSim` are deterministic and identical
  client/server — the server can roll candidates forward *for free*
  against the same physics the bot actually runs.
- The heightfield (`FieldSurface`/`hmHeight`/`hmChord`) is readable
  anywhere — terrain gradient (downhill=speed) is computable per point.
- Bots think at `THINK_DIV` subdivisions, not every tick — any scheme
  must be cheap per think, per bot, across ~50 bots/room.
- Ski physics means "shortest path" ≠ "best path" — the Tribes route
  builds speed on descents and carries momentum into climbs.

## Candidates (ranked by fit)

### 1. Greedy short-horizon rollout — RECOMMENDED

Each think, evaluate ~8–16 candidate inputs (forward+ski, ±yaw
offsets, jet on/off) by stepping the bot's own `MoveSim` clone
0.5–1.5s ahead. Score: progress toward goal + terminal speed −
wall/contact penalty. Argmax wins; nothing is stored.

- Cost: ~10 sims × ~30 steps/think — orders cheaper than the transit
  beam; no worker needed, could run inline on the tick.
- Kills the freeze class entirely — there is no track to be stuck on.
- Same `drive(id, tgt): boolean` contract `botMpc` already exposes →
  a `botGreedy.ts` drops in as a per-room A/B.
- Bonus: the score can weight *speed* directly, which is the actual
  Tribes currency — a slightly-longer downhill line that lands at
  35 m/s beats the direct 12 m/s trudge.

### 2. Context steering (Fray, Game AI Pro 2 ch.18)

Fixed slot map (~24 headings). Per slot: interest (goal dir,
speed-preserving dir, downhill) minus danger (wall probe, steep
uphill, threat cone). Pick argmax slot → input. ~2 KB of math per
think, stateless, provably no divergence loops. Would replace
`driveMove`'s steering while the brain keeps goal-setting.
Tribes-flavored twist: a **downhill slot** produces the
descend-for-speed behavior humans do naturally.

### 3. Shared flow field / Dijkstra map

One BFS over walkable cells per objective (flag stand, gem zone),
stamped distance-per-cell. Bots descend the gradient + local obstacle
steer. O(cells) once per objective move, shared across all bots —
effectively free per-bot. Weakness: plain distance says nothing about
speed; needs cost-weighting by expected ski speed (downhill cheap,
uphill dear) to be Tribes-aware. Strong as the *global* layer under
#1/#2 local steering.

### 4. Speed-pursuit pointing

Steer at a lead point `goal − vel·tLookahead` while ski-held and
terrain falls away. Zero state, zero search — but open terrain only;
no obstacle negotiation. Useful as one slot inside #2 rather than a
standalone driver.

### 5. Policy distillation

Keep botMpc as an offline teacher: log (state → input) pairs from
worker solves, train a small net/k-d tree, ship inference. Amortizes
search cost to O(1) — but real ML infra. Only if #1 profiles too hot.

## What T2 actually did (for reference)

Tribes 2 bots run a weighted-task script layer over a **prebuilt
`.nav` graph** generated per map (`-navBuild`). No graph → no bots at
all. The well-known failure — bots walking straight at an objective
into geometry where the graph has gaps (Katabatic towers) — is exactly
the stuck-on-track class we're eliminating. Worth not copying: the
graph itself is fine, the *reactive layer on top of it* is what was
missing.

## Recommended architecture

```
brain (think, sets ctx.objective/hunt)   ← unchanged
  └─ global layer: objective target point  ← unchanged
  └─ local driver: greedy rollout (#1) over MoveSim
        + context-steering slots (#2) as the candidate generator
```

`botGreedy.drive(id, tgt)` returns the same bool contract: `false` =
fall back to `driveMove` (no field/shadow), `true` = inputs committed.
Per-room A/B is then one env flag or a roster flag — no behavioral
fork in the sim path.

## Pilot plan

1. `botGreedy.ts`: candidate set = {yaw −30/−15/0/+15/+30} ×
   {jet off} + {yaw 0, jet on}; horizon ~1s at sim dt; score =
   `Δ(goalDist) − 0.4·Δ(distToTrack) + 0.2·terminalSpeed − 10·wallContacts`.
2. Gate: same arm condition as MPC (flag modes only) for the pilot;
   headhunt stays on `driveMove` (its freeze is a different suspect —
   brain posted-park — and needs its own look).
3. Verify: `_botspeed` probe (fast%/parked%/vmax) + `botMs.drive` in
   /metrics for cost, vs the same on an MPC-armed room.

Sources: Game AI Pro 2 ch.18 (context steering);
tribes2wiki mod handbook (`-navBuild`, weighted tasks);
tribesnext forum #2327 (nav-gap wall-stuck reports).
