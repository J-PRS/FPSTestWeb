# Emergent-Behavior Evo — research reference

Date: 2026-10-19 · status: reference for hhEvo direction

**Question:** can evolution produce bots that *look* intelligent and
interesting — Game-of-Life-style complexity from simple rules — rather
than bots that merely win?

**Short answer:** yes, but only if we stop selecting on winning. The
literature is unambiguous on this: objective fitness is *deceptive* —
it rewards whatever degenerate loop scores fastest, not interesting
play (we've already watched this happen: headhunt evolved corpse-farming
because it scored, not because it was good play). The tools that produce
emergent complexity are all variations on "change what's selected, not
what's simulated." Good news: our harness already has most of the
plumbing. This doc maps the research onto hhEvo concretely.

## The five pillars, ranked by what they buy us

### 1. Novelty search / Quality-Diversity — select for *different*, not just *better*

- **Novelty search (Lehman & Stanley, ECJ 2011):** drop the objective
  entirely; fitness = behavioral distance from everything seen so far.
  Result: because simple behaviors are a finite set, the only way to
  stay novel is to get *more complex*. In maze/biped tasks it beat
  objective search — the field's canonical "ignore the goal to reach
  the goal" result.
- **MAP-Elites:** an archive where each *behavior cell* keeps its best
  genome. Instead of one champion you get a lit map of the strategy
  space — every viable style preserved, specialists included.
- **We already collect the descriptors.** `Desc { agg, mob, air, life,
  heldEnd }` is computed per side per match and printed on the board —
  then discarded for selection. The cheapest meaningful upgrade to hhEvo:
  an archive grid keyed on (agg, mob, air) cells, fitness replaced by
  "best within your cell." In one flag: `--qd` → pool can't collapse to
  one shell because a monoculture loses its cell to itself.
- **Concrete fit:** our chaos run converged to `regenerator` survivability
  at 89% Nash — a generalist monoculture, the exact pathology QD exists
  to prevent. Under MAP-Elites the `featherfall` mobility builds and the
  plated bruisers would hold permanent cells instead of drowning in
  margin.

### 2. Autocurriculum via co-adaptation — the opponent IS the curriculum

- **OpenAI hide-and-seek (2019):** six emergent strategy phases (shelter
  building → ramp counters → surf exploits) from ONE reward (see/don't
  see) + self-play. Nobody scripted ramps — the counter-pressure created
  the skill. The mechanism: each new strategy creates a selection
  gradient that didn't exist before.
- **What we have:** exploiters already do this in miniature — they probe
  the champion and earn seats for finding holes. The chaos run's Nash
  blend is a live meta.
- **The gap:** our exploiters mutate *kit genes*, not *behavior genes*.
  A genome is (aim, move, react, jitter, temper, kit). That's a counter-
  *build* finder, not a counter-*strategy* finder. To get strategy phases
  we need genes that change decision topology: retreat thresholds,
  grouping cohesion, target-priority weights, risk budget. Those knobs
  exist inside the brain code — they're constants today. Making ~6-8 of
  them genes (aggroDist, fleeHp, chaseTime, groupR, horderatio...) is the
  single biggest "emergence lever" available: it's where phase-change
  behaviors live.
- **Minimal Criterion Coevolution (Brant & Stanley 2017):** two
  coevolving populations, each gated only by "survive long enough to
  matter" — no behavior characterization at all, still produces
  diversity. The cheap version: our exploiters become a second population
  whose only job is being *not-yet-beaten*, not maximal.

### 3. Environment coevolution — POET, or "evolve the arena too"

- **POET (Wang/Lehman/Clune/Stanley 2019):** paired evolution of
  environments AND agents; new environments are kept only if they're
  *neither too hard nor too easy* for current agents (minimal criterion),
  and agents transfer between environments when a stepping stone helps.
  Many POET solutions were unreachable by direct optimization.
- **We already did the primitive version:** `--maps all --mapsel random`
  + worst-map margin = environment diversity selects for generalists.
  The full version is `--evomaps`: coevolve mapgen params (the maplab
  toolkit already parameterizes relief/slope/pads) so arenas mutate
  alongside genomes — a pool that solves flat gets thrown onto dunes,
  a pool of skiers gets counter-terrain. Map genes would be the existing
  mapgen param bundles; minimal criterion = "at least one genome wins
  and at least one loses."
- **Why it matters for emergence:** every emergent-strategy showcase in
  the literature happens in environments with *exploitable structure*.
  Flat arena has almost none — 29 real maps have it; coevolving maps
  has unbounded it.

### 4. Believability — the BotPrize lesson

- **BotPrize (UT2004, 2008-2014):** the "Turing test for bots" — the
  winners weren't the best duelists, they were the most *human*.
  Schrum/Miikkulainen's winning entry used multiobjective neuroevolution
  with separate objectives for performance vs human-likeness.
- **Key finding for us:** human-likeness is measurable offline:
  reaction latency distribution, aim error vs. angular velocity, target
  switching entropy, path curvature, retreat-when-hurt rates. We HAVE
  the genes (react/jitter/temper) — what's missing is a believability
  *term* in fitness. A cheap proxy set from match telemetry: aim-snap
  variance (humans overshoot), weapon-switch cadence, movement jitter
  autocorrelation, post-kill behavior (humans loot/reposition; bots
  insta-re-engage).
- **Distortion warning from the paper:** when judging had incentives,
  humans gamed it. Same here: a believability fitness term can be gamed
  into "theatrical inefficiency." The fix used in the literature is
  *multiobjective* (NSGA-II): win AND look human, keep the Pareto front —
  which composes perfectly with the MAP-Elites archive (one axis can
  literally be believability score).

### 5. Exo-conventional play — optimizing the *game experience*, not the outcome

- Zook & Riedl (ICCC 2011): agents that optimize the *trajectory* of the
  game (keeping it close, creating comebacks) rather than the end state.
  For a bot whose job is *to entertain humans*, the fitness function
  should include spectator-facing terms: match closeness at t=80%,
  lead-change count, comeback frequency, "highlight" events per minute.
- For us: a `hype` descriptor is nearly free — we already record margins
  per match; add "margin at half-time vs end" (comeback detector) and
  score swings. Bots selected for producing close, swingy games is the
  direct answer to "align AI with our vision."

## The honest catch — simple rules are not free

The Game-of-Life framing is seductive but the literature is precise:
complexity emerges when (a) the state space has deep combinatorial
structure (our movement/kit/mode space does — the arsenal audit showed
~22k legal kits alone), AND (b) selection pressure can't collapse onto
one degenerate exploit (our corpse-farming finding says it currently
can), AND (c) evaluation is noisy enough to avoid brittle over-fits
(sharded multi-match margins — done). We're 1.5 of 3 — the missing
half is behavior-level genes + a diversity-preserving selection rule.

## Concrete ladder for hhEvo

| Step | Change | Cost | Buys |
|---|---|---|---|
| 1 | `--qd` archive on existing descriptors | ~80 lines | diversity can't collapse; specialists persist |
| 2 | Behavior genes (6-8 brain constants → genome) | ~half day | counter-*strategies*, not just counter-builds; where phase shifts live |
| 3 | `hype` descriptor (comeback/lead-change/closeness) | ~40 lines | entertainment-directed selection — "align with vision" literally |
| 4 | Believability proxy scores in descriptors | ~100 lines | BotPrize-style human-likeness as a selectable axis |
| 5 | `--evomaps` minimal-criterion map coevolution | ~half day | POET: arenas coevolve with the pool; open-ended difficulty |
| 6 | NSGA-II or Pareto-aware archive (win × interesting) | ~120 lines | keeps "good AND watchable" elites instead of trading one for the other |

Suggested order: 1 → 3 → 2. Step 1 makes the existing machinery stop
throwing away diversity; step 3 points selection at the actual goal
(games worth watching); step 2 is the real emergence engine once the
selection rule protects variety. Steps 5-6 are the long-run payoff and
can wait until the archive proves out.

## What NOT to do

- **Don't add scripted "smart" behaviors** to fake emergence — the whole
  point of the research is that scripted complexity plateaus and reads
  as artificial; evolved complexity under diversity pressure doesn't.
- **Don't fitness-blend win+novelty+human in one scalar** — weighted
  sums collapse to whichever term has the best gradient. Pareto/archive
  is the shape that works (every QD paper converges here).
- **Don't expect rabbit/FFA to be the emergence testbed yet** — its
  hunter brain is MPC-chained and deterministic-path-heavy; emergence
  needs the cheap modes (dm/headhunt) where thousands of matches fit.
- **Don't widen `--mins` for behavior-evo runs** — short 1-2min matches
  gave the best signal-per-wall-second everywhere so far; behavior
  descriptors stabilize fast anyway.

## Sources (load-bearing)

- Lehman & Stanley, *Abandoning Objectives* (ECJ 2011) — novelty search
- Mouret & Clune / Pugh et al., *Quality Diversity* frontiers 2016 — MAP-Elites + hybrid BCs
- Wang, Lehman, Clune, Stanley, *POET* (GECCO 2019) + Enhanced POET (ICML 2020)
- Brant & Stanley, *Minimal Criterion Coevolution* (GECCO 2017)
- OpenAI, *Emergent Tool Use from Multi-Agent Autocurricula* (2019) — hide-and-seek 6 phases
- Schrum, Karpov, Miikkulainen — BotPrize believability line (2012); BotPrize 2008-2010 protocols
- Zook & Riedl, *Understanding Human Creativity for Computational Play* (ICCC 2011) — exo-conventional play
- Amorphous Fortress / QD-AF (CEC 2024) — FSM-ecology emergence + complexity metrics
- Perez-Liebana et al., MAP-Elites for Tribes (the board game, CoG 2021) — QD agents generating play-style archives
