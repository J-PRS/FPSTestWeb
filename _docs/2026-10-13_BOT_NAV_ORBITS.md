# Bot navigation: why agents orbit, and the structural fix

Reference for the recurring "bot orbits forever" bug class — literature
synthesis + how it maps onto `shared/botGraph.ts` / `botLines.ts` /
`botSteer.ts` / `botBrain.ts`. Written after fixing the katabatic
capper orbit (capRun: 0 caps/480s → grab@108s, cap@~176s).

## The failure class

"Orbiting" is not one bug — it's the *signature* of a model mismatch:
the bot's desired destination and its per-step steering disagree, and the
disagreement recurs every think. Patch latches (stale counters, escape
picks, commit windows) only move the orbit elsewhere.

Symptoms we've hit (all in `server_bun/tests/scenarios/capRun.test.ts`
and livesoak logs):

- Capper circles a basin 100-200m from its stand for the whole match.
- Carrier wanders at speed 10-25 m/s but net displacement ~0.
- `dest`/`d1` keeps re-pointing to fresh local pockets while `goal`/`d0`
  stays fixed and correct.

## What the literature says (verified sources)

**"Seek a static point at max speed and you orbit it. Always."**
Point-seek has no mechanism to bleed *tangential* velocity; any approach
carrying sideways speed circles (Kudahl's steering notes — arrival two
radii; CMU waypoint seeking; Reynolds). Fixes, in order of how
fundamental they are:

1. **Pure pursuit / path following.** Steer to a *lookahead point on
   the path*, never the waypoint itself. `lookahead = K·v` (≈1-2s of
   travel); progress is measured as **projection onto the path
   polyline**, so along-path distance can only grow — orbiting becomes
   *inexpressible*, not just prevented. Bend-radius caution: lookahead
   beyond a curve cuts corners; walking the path's own polyline (as our
   flood parent-chain does) keeps the carrot ON the path past bends.
   - thomasfermi.github.io/Algorithms-for-Automated-Driving/Control/PurePursuit.html
   - cs.cmu.edu/~tmr/waypoint/seeking.html

2. **Corridor + next-visible-corner** (Unity/Recast): the global path
   produces a corridor; local steering aims at the next corner and the
   corridor self-repairs when the agent is pushed off (crowd effects,
   knockback). Same model as (1) — our flood parent-chain IS a corridor.

3. **Kill tangential velocity first** (the missile-orbit fix): decompose
   velocity; zero the perpendicular component before gaining on-target.
   What our steerer failed at — slot scoring kept *adding* tangential pull.
   - gamedev.stackexchange.com/questions/45582

4. **Arrive only at terminals.** Through-waypoints carry a desired
   *velocity direction*, never an arrival radius. Tribes 2's `AI_SkiTo`
   takes `terminalVelocity`/`terminalHeight` — **a ski waypoint is a
   state (position + speed + altitude), not a point.** A 40 m/s capper
   cannot "arrive" at a hop; it must pass through moving the right way.
   - source.tribesrevengeance.net/tyrion/ai_skito.html
   - T2 bots use hand-authored nav graphs ("Treepoints"); our flood
     field is the live-computed equivalent with zero per-map authoring.

## How it maps onto our code

Pipeline per think (`ServerBots.ts`): `flagGoal` → objective (`d0`) →
`brain.think` → `pickDest` (`d0`) → `lines.plan` (`d1`) → `steerer.steer`
(`d2`) → drive input. `FPS_TRACE=<id-substring>` logs d0/d1/d2 per think —
the fastest way to see which stage rewrites a good goal.

- `TerrainFlow` (`shared/botGraph.ts`): Dijkstra flood per goal cell on a
  coarse heightfield grid (climb/dive/danger priced; solids taxed).
  `route(fx,fz,tx,tz,ahead)` returns the carrot ~`ahead` m down the
  parent chain — **the textbook corridor + pure-pursuit carrot**.
  CTF pays ~2 floods/match — shared, cheap.
- `BotLines.plan` (`shared/botLines.ts`): local terrain fan + waypoint
  commit (`lineT`) + orbit machinery (`stale`, `orbitGd`, `orbitFails`,
  `traverseDir`, `passes`). This machinery exists to compensate for
  point-seek — it's where orbits are manufactured.
- `BotSteer` (`shared/botSteer.ts`): slot-scored context steering +
  weave; `beelineClear` gates a laser beeline to `dest`.

`aheadFor(ctx)` in botLines already does speed-scaled lookahead:
`T.graph.ahead + max(0, v - aheadSpeedFree) * aheadSpeedK` (≈69m at
44 m/s, base 34m).

## The 2026-10-13 fix (landed)

Two changes:

1. **`botLines.plan`: runner-with-route commits the flood hop directly.**
   `ctx.runner && ctx.route` → `wp = route(...)` every think, skipping the
   pocket rescore + orbit machinery. Re-issuing the carrot from *current*
   position each think IS pure pursuit — the carrot slides forward as the
   bot moves and can't be permanently "missed".

2. **`botSteer.steer`: routed legs beeline at any range.** The runner
   beeline gated on `objD < 160` — distance to the *objective*. With
   routed hops (~40-90m), `dest` is near while the objective is ~600m
   out, so the beeline never armed en route and slot scoring orbited the
   carrier between every hop. Now `ctx.runner || ctx.running` beelines
   whenever the hop leg is clear AND `ctx.route` exists (offline bots
   without a flood keep the old 160m gate — a raw beeline across the
   map blind is worse than slot scoring).

Result (seed 9001 katabatic): grab@107.9s (was 228s), carry 63.2s at
23.3 m/s, 1 cap. Previously 0 caps in 480s.

## Residual orbit risks / next fixes

- **Extend routed commitment beyond `runner`**: `running` transits
  (escorts, rabbit chases, dropped-flag touches) share the same
  seek-vs-follow hole. Extend after a soak shows no regression.
- **Retire the compensation machinery** on routed legs: `stale`,
  `orbitGd`, `orbitFails`, `traverseDir`, `passes` (~100+ lines) should
  shrink to "no route available" escapes only. Deletion dividend of the
  fix — don't remove until soak coverage proves routed legs hold.
- **Waypoints-as-velocity** (Tribes' `terminalVelocity`): the final
  approach (carrier dive onto the stand) would be cleaner as
  pass-through-with-direction than arrive. Currently masked by the
  generous flag-touch radius.
- **Residual real orbits**: lookahead > bend radius cuts corners into
  terrain; genuinely unreachable goals still need the escape machinery
  (now correctly scoped).
- **Offline bots have no `ctx.route`** — no flood. They still run the
  old machinery. If offline orbits resurface, that's the reason — either
  port a lightweight flow field client-side or accept it as a
  server-only fix.

## Debug recipe

1. `_tools/debug/capdebug.ts` — replicates measureCap; prints goal/dest/
   pos/dHome over the run.
2. `FPS_TRACE=BOT` env — per-think d0/d1/d2; find the stage that
   rewrites the goal.
3. `capRun.test.ts` — the regression gate (775m real-terrain cap).
