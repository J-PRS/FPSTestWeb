# Correctness by Design

Why: the whackamole cycle (bug → telemetry → fix → next bug) happens when
truths live in reviewers' heads. This file is the standing rulebook; the
mechanisms below make each rule executable, so a regression fires a named
violation instead of a symptom hunt.

## The rules

1. **One measurement, one accessor.** Two sides of a comparison must read
   the same source. `pos.y` IS the eye point — measure burial with the
   sim's own `eyeHeight` (`moveSim.eyeOf`), never a class table a refit
   may have left stale. (The 1-rescue/sec unbury loop was class-eye vs
   sim-eye measuring the same body.)

2. **Rendered things floor on the drawn surface.** The mesh the player
   sees is the clipmap chord, not the bilinear field — flat triangles
   bridge gullies above it and dip below it on convex ground. Server
   truth that clients render must use `max(hmHeight, hmChord)`; client
   presentation uses `terrain.getRenderedHeight`. Bots, nuggets, blob
   shadows, remote lifts all obey this now — any new "thing that stands
   on ground" joins the same convention, no exceptions.

3. **shared/ is pure.** No `Date.now`, `performance.now`, `Math.random`,
   `process.env`, fs — shared code reads `sharedNow()` and injected RNG
   (`shared/env.ts`, `botRand.ts`; `strictRng` throws on ambient draws
   in deterministic harnesses). Client prediction only converges if both
   sides run the same step on the same input (Colyseus determinism
   contract: same inputs, same elapsed, no outside reads).

4. **Every prediction gets a verdict.** A claim the server refuses must
   answer back — `shotRejected`, `claimDropped`, `tickNack` — or the
   client's ledger ghosts forever. If you add a claim, add its verdict
   path in the same change; a silent decline is a ghost-hit bug by
   construction.

5. **Violations are named, counted, and survive.** `inv(name, holds, ctx)`
   (shared/invariants.ts): throws under `setStrictInvariants` in tests,
   counted via the host sink in prod (server `inv:*` health counters /
   client glitch census → alt+q dump). Assert truth, not representation;
   name the bug class, not the line. A hot-path invariant never crashes
   the match — it makes the dump say exactly what broke.

5a. **NaN passes every `>` gate — check `isFinite` before comparing.**
   `NaN > x` is always false, so a non-finite value sails through
   `dist > MAX`, `reach > cap`, `health <= 0` untouched. Every untrusted
   number needs its own finite gate at ingest AND at the write site —
   a validator upstream doesn't protect a path that writes around it
   (the teleport claim fed `lastValid*` directly, past the gated
   `updatePosition`; `healPool`'s `min(cap, NaN)` = NaN; NaN damage
   made a player unkillable because `health <= 0` was never true).
   Closed sites: move-claim anchor+sim, slam landing, deploy plant,
   hit-claim legality, knockback wire+shove, damage chokepoint,
   reconnect seat, healPool, shot/contact ingest, energy grant/drain,
   deployable hurt, clientStats renderLag, clampPing/rewindPos,
   pushRewindSample, remote roster (hit/join/diff-heal), deployHp.

   Sticky variant: `Math.max(0, NaN) = NaN` — a poisoned pool never
   self-heals. Pools also need a finite *recovery* at the tick clamp
   (energy drains to 0 and regen rebuilds; local health snaps to max).

6. **Render can lie, but every lie is watched.** Prediction, interp
   smoothing, corpse physics may diverge from wire truth — each divergence
   budget gets a census counter (render-blend, seg-div, nugrest, dmg-echo,
   remote-buried, anim-bind). New cosmetic divergence ⇒ new counter at
   birth, or the next "sometimes looks wrong" report has no instrument.

## Audited — verified state (2026-10-10)

- **Determinism (rule 3): clean.** `movement.ts`, `projSim.ts`,
  `combat.ts`, `heightfield.ts`, `ballSim.ts` hold zero ambient reads
  (`Math.random`/`Date.now`/`performance.now`). `MoveSim` integrates at
  fixed 60Hz with a step accumulator — same-step determinism on both
  sides. Ambient draws live only in bot brains (`botDisposition`,
  `botGoals`, `botHunt`, `botBrain`), which clients never predict —
  prod-legal by the rule's own letter.
- **Wire-row coherence:** `wire-row-finite` + `wire-row-coherent`
  (alive ⇒ hp>0) at the tick egress; `wire-vel-sane` magnitude cap at
  client ingest. No upper bound on hp — seeded pools legitimately
  exceed class max.
- **Above-floor postconditions:** `spawn-above-ground`,
  `teleport-above-ground` — both seed paths for "body under terrain"
  name the violation at birth.
- **Verdict-complete:** every WIRE table claim returns a verdict or
  reject; the three silent shotFired declines (dead shooter, dry belt,
  spawn refuse) now reject with shotId.

## When adding a system

- List the truths it must hold at its boundaries (position vs terrain,
  counts vs ledger, coverage vs visibility).
- Put `inv()` on the boundary that can violate it — cheapest place that
  still sees the truth every tick, not per-frame if a 2Hz sweep suffices.
- If a check duplicates an existing rescue/fix, the invariant names it
  and the rescue stays — invariants report, they don't repair.
