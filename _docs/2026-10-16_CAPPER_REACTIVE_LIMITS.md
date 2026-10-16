# Capper AI: the reactive ceiling, the TAS floor, and the route layer

Written 2026-10-16. Companion to `2026-10-15_CAPPER_STRIKE.md` (which owns
the scoreboard commands and tuning landmines). This doc owns the answer to
"can hand-tuned reactive steering ever reach real capper speed" — and the
evidence says **no**. Read this before adding another gate, latch, or
threshold to `botMoves`/`botRouting`.

## The measured gap

Ground truth comes from `_tools/sweeps/tasStand.ts` — a uniform-time
reachability BFS over the real `MoveSim` (yaw delta x jet on/off per 0.15s
decision, stock energy economy, beam-pruned, deduped on quantized state).
The hit test IS the grab capsule: planar <=6m, |dy|<=6 — same as
`RoomFlags.nearestTouching`.

### Provable arrival speed (TAS, same physics the bots run)

| map / leg | result |
|---|---|
| katabatic alpha->bravo | fastest flyby **65.9 m/s** (dy=+39 — ring passed but too high to grab) |
| katabatic bravo->alpha | fastest flyby **94.4 m/s** (dy=+25) |
| whiteout bravo->alpha | **grab at t=12.2s, grabV=80.8 m/s** (vAvg 59.6) |
| caldera alpha->bravo | **grab at t=12.9s, grabV=61.6 m/s** |
| lagoon bravo->alpha | **grab at t=7.7s, grabV=61.4 m/s** |
| lagoon alpha->bravo | flyby 77.9 m/s at dy=+5.3 |
| corner-to-corner legs (default map) | vAvg 54–85, vMax 70–123 |

TAS flight profile: ~96% ballistic, ~50% jet duty cycle, ~4% grounded.
Speed comes from steep dives + touchdown redirect (vy->vx on contact),
not sustained ski contact. The tank economy sustains ~50% jet duty —
bots currently hoard far above that.

### What the reactive stack delivers (capStat, same maps)

| map | grabV before work | grabV after crest-head routing |
|---|---|---|
| katabatic | 19.1 | 21.7 |
| whiteout | 7.1 | 15.4–21.4 |
| caldera | 19.1 | 21.7–23.5 |
| lagoon | 25.7 | 25.7 |
| 6-map holdout (seeds 21-24) | — | 17.6 avg, caps/run 0.88 |

Best single measured grab: 33.5 m/s (katabatic 9002 post-fix) vs TAS's
66–94 through the same rings. **The reactive ceiling sits at ~20–30 m/s
grab speed — under half the provable floor.**

## Why reactive caps out (the mechanism, not the vibe)

1. **The payoff horizon is 5–15s; the senses see ~0.5s.** Grab speed is
   decided by route choice hundreds of meters upstream — which crest to
   crest, whether to bank energy for a climb, when to commit the dive.
   Every gate in `botMoves.hints` reads instantaneous terrain (6–12m
   probes). No per-think local rule can express "the last descent ends
   40m past the flag."
2. **Potential-field failures get worse at speed** (Koren & Borenstein
   1991 — 34-year-old theorem, measured live): orbit/lap cycles around
   the stand, aim flipping between pole and pass-through, basin traps.
   The codebase's answer has been a sequence of latches (`passCommit`,
   `routeHold`, `headHold`, `odBest` windows) — each one hand-suppresses
   one limit cycle the per-think optimizer provably regenerates.
3. **Stand geometry defeats local rules.** Katabatic bravo is a dais
   inside a moat (stand y=31.7, basin floor 15, rim 70–84). Every
   descent line into it ends with a 17m apron climb; every contiguous-
   rise scan dies at the lip dip. The only fast arrival is ballistic:
   dive off the rim, cross the bowl at 50+, let the apron face redirect
   the vector up through the pole. No "distance-to-goal" signal sees
   that. (Full radial profile: `_tools/devin_scratch/standprofile.ts`.)
4. **Speed is created by commitment, not correction.** TAS's 96%
   ballistic profile means the optimal is *mostly not steering* — the
   maneuver is chosen at the crest and gravity executes it. A steerer
   that re-decides every think is structurally incapable of holding
   still long enough to fall.

## Prior art — everyone solved this the same way

| system | what produces the fast line |
|---|---|
| T2 retail bots | utility task weights on a precomputed `.nav` graph; community answer for real cap runs was **RoboRoute — recorded human routes replayed by bots** |
| Tribes Vengeance (Tyrion) | `AI_SkiTo`/`AI_MoveTo` actions with **terminal states**: `terminalVelocity`, `terminalHeight`, `terminalDistance`, `energyUsage` — a ski objective is a state-goal, not a point |
| Tribes Ascend | no real bots; humans run *practiced* routes — even people don't solve this reactively |
| TORCS racing champions | warmup laps build a track model -> per-segment target-speed profile (racing line) tracked by a local controller |
| Fray's context steering (F1 2011) — the technique botSteer is built on | production uses a **precomputed racing line**; context maps only handle avoidance around it |
| tmrl / Swift drone-racing | learned policies that react per-tick — competence distilled from offline training episodes (the plan is stored in weights) |
| MPCC / MPC racing | replans every tick, but each tick is backed by ~2s of forward simulation |
| Quake III AAS | weapon-jumps and pad launches are precomputed *reachability edges* with per-edge physics — baked, not emergent |

Zero documented cases of hand-authored reactive steering reaching
racing-line-level speed over terrain. The pattern is always:
**plan/search/learn produces the line; a cheap local controller tracks it.**

## The layered architecture this implies

```
┌─ utility brain (botBrain + flagGoals) ─ what job am I doing ──────┐
│  unchanged: role pick, chase/escort/press arbitration             │
├─ route layer (NEW) ─ which committed leg gets me there ───────────┤
│  options = (initiation set, policy, terminal STATE):              │
│  e.g. SkiRun: enter at descent head with tank > X,                │
│       policy = baked input schedule OR pursuit along stored path, │
│       terminal = grab capsule | speed died | interrupted          │
├─ reactive execution (botSteer + botMoves + botLines) ──────────────┤
│  unchanged job: bodies, bumps, hazards, the last 10 meters        │
└───────────────────────────────────────────────────────────────────┘
```

`passCommit`, `bank` leg, `headHold` are already proto-options built by
hand. The structural change is making them explicit **options with
terminal states** — Tyrion's `AI_SkiTo(terminalVelocity=40, ...)`, not
another radius latch.

### Route sources (in order of cost)

1. **Offline bake (RoboRoute-style) — recommended first.** Run the
   tasStand BFS per stand-pair at map load / bake time into a route
   table: input schedule + checkpoints [(x,z,v,agl)]. Replay with
   pure-pursuit tracking; steerer handles local hazards. Deterministic,
   zero per-tick cost, provably near-optimal, gives each map a hard
   achievable bound that capStat can grade against. The BFS already
   exists (`tasStand.ts`) — productizing is plumbing.
2. **Online MPC-flavored.** Every few seconds (on `lineT`-scale
   commitment points), beam-search 3–6s of MoveSim forward from the live
   state (~3k frontier like tasStand), take the first input, replan.
   Handles disruptions a baked route can't; costs a bounded sim burst
   per window, not per tick.
3. **Both.** Bake the nominal route; replan only when the tracker
   diverges past a threshold (damage, blast knock, interceptor).

### What stays reactive

The grab itself is already a pass-through (swept capsule, FLAG_PICKUP_R
6m) — no stopping required. The last ~40m (`passCommit` aim lead +
miss-vector correction + `pull` trim) is a legitimate local-control job.
So is the carry leg: hop-chains, jet taps, dodge — reactive is fine
there because the goal is "get home fast and don't die," a problem
with no hidden horizon.

## Files touched / created this pass

- `server_bun/src/botRouting.ts` — crest-fan descent-head sense ahead of
  the press/entry split: per bearing, crest = tallest ground within
  250m, route = pos->via->stand scored by **projected arrival speed**
  (point-mass integration: descents gain 2g·dh, climbs bleed it, tank
  buys a transit floor, 0.15 m/s tax per extra second). `headHold`
  latch (30s, drops when the bot enters the run). This is the reactive
  ceiling made as good as it gets — it improved grabV ~25% and grabbed
  kata 9002 at 33.5 vs 6.9, but it does not close the TAS gap.
- `shared/botMoves.ts` — `tail` featherjet vetoed over `travelDescent`
  (airtime over pumpable slopes is thrown speed); carrier exempted from
  the grab-orbit park brake (`!ctx.running` — a carrier's objective is
  its own stand; it parked 20–32m short of home on oasis).
- `_tools/sweeps/tasStand.ts` — NEW: stand-to-stand TAS oracle. Usage:
  `cd server_bun && bun ../_tools/sweeps/tasStand.ts --map <name>`
  (env: TAS_BEAM, TAS_SEEN, TAS_WALL, TAS_MAXT, TAS_DYAW, TAS_JETS).
  Reports legal grabs (grabV at capsule entry) and fastest flybys.
- `_tools/devin_scratch/{headcheck,headcheck2,standprofile,tas_summary}.ts`
  — stand-profile / head-election debug probes.

## Landmines discovered (see also corrections.md)

- **Kata's bravo stand is a dais in a moat.** Contiguous-rise-from-stand
  scans find nothing; crest-first + climb-back pricing is required.
- **A late-elected head is a stall.** Electing a crest at od~150 with a
  dry tank = 60s orbiting the rim wall (kata 9002). Affordability or
  time-cost must be IN the score.
- **An aligned crest beyond the bot is the run it's already inside** —
  electing it backtracks uphill. Skip `|bearing offset|<=1 && crestD > dStand`.
- **`ctx.running` = carrying; `ctx.runner` = the capper role.** Measured
  225/225 vs 428/428. The grab-orbit brake must not touch carriers.
- **`approachProbe` ">>> CAP" never fires** (it reads matchEnd); its
  "flag home" is a drop. Trust capStat legs.
- **The carrier meander is the next leak**: after the grab, `odHome`
  wanders mid-field for ~60-100s on kata (pace ≈5 m/s net). Same
  myopia class — the carry leg needs its own route/option answer.

## Open questions the route layer answers differently

- Per-map difficulty reporting: tasStand gives each stand a provable
  grabV ceiling — bake it into mapAudit / the balance page.
- Route *diversity*: a baked route is one line; human cappers vary
  (routePref bearing offsets exist for exactly this). Bake 2–3 route
  variants per leg, pick per bot personality.
- Failure mode: a mid-route blast knocks the bot off the schedule —
  the option's termination must notice (`|pos - expected| > X` or
  `v < floor` for T seconds) and hand back to reactive + replan, not
  grind dead inputs into a wall.
