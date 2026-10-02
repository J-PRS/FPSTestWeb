# KRIBES Bots — State-of-the-Art Plan

Goal: bots indistinguishable from competent humans on voice-off comms —
not the smartest possible AI, the most *believable and effective per CPU
budget* (cheap is a feature; a browser server must run rooms on pennies).

Research base, what the best systems actually do:

- **Killzone 3** (Straatman et al., Game AI Pro ch.29): three-layer
  hierarchy — commander AI assigns objectives to squads, squad AI turns
  objectives into member orders, individuals stay autonomous (pick own
  target/position/weapon, may break orders to survive). Orders flow down,
  reports flow up.
- **Halo Infinite** (343, GDC 2022): "ambitions" — mode-relevant objects/
  areas with metadata (type, owning team, who may use it) living on a
  blackboard (BotManager) that mode logic and bots read/write. Difficulty
  = behavior quality, not aimbot levels: strafing, grenade bounces,
  equipment use, power-weapon seeking.
- **Utility AI** (industry standard over pure BTs): score every candidate
  action from normalized considerations, multiply, pick argmax. BT on the
  outside (engage/disengage/patrol), utility inside for *which* target/
  item. Hysteresis to stop flicker.
- **Pheromone/influence maps** (Yahyavi & Kemme; RTS practice): a coarse
  grid where events and presences deposit decaying influence — gives bots
  spatial memory of "where things happened" without raycast spam.
- **CS:GO movement transformer** (Rastrogin et al. 2024, NVIDIA): 123h of
  pro play trained a small transformer producing human-like team movement
  at <0.5ms/step on one CPU core — proves learned movement is
  commercially viable, and that *movement* is what sells humanity.
- **Behavioral cloning** (Pearce & Zhu 2022): pixel-input CS:GO agent
  matching casual-human deathmatch — ceiling exists but costs data we
  don't have; keep as an option, not a pillar.
- **Dead-reckoning opponent models** (IEEE TOG 2023): NN extrapolation of
  opponents cuts prediction error ~45% — maps to our "lead the orbit"
  aiming.

## Gap analysis — where we stand

Already SOTA-shaped: senses→memory→brain split, event-driven reports
with distance tiers, honest projectiles that whiff, per-bot skill matrix,
mood system (hero/fear rising edges), chance-band greed, creature+belt
economy.

Gaps vs the research:
1. **Goal ladder is static** — pickup < sounds < objective is a priority
   queue, not utility scoring. A contested gem 40m away should out-score a
   distant objective sometimes; today it never can.
2. **No spatial memory** — bots know what they see *now*, not where the
   fighting was. Katabatic fleets orbit blind (inSight ~19%); humans
   drift toward the sound of battle.
3. **Squads are assigned, not negotiated** — role assignment exists but
   there's no commander layer allocating effort to objectives, and no
   squad-level "we're getting farmed, regroup" feedback.
4. **No opponent model** — aim leads by fixed projectile-time, not by the
   target's observed strafe pattern/orbit frequency.
5. **No per-bot experience** — every bot makes the same decision in the
   same state. Humans learn "that lane is death" this match.
6. **Movement is functional, not performed** — humans arc, vary speed,
   overshoot, ski-surf. Ours is goal-direct.

## Plan — four pillars, ordered by believability-per-effort

### Phase 1 — Influence map ("the world remembers") (~1 session)
Coarse grid (map/32m cells), per-team layers: recent contacts, deaths,
shots heard, flag events, gem spawns — all decaying ~30s half-life.
Senses write events; brains read a `danger`/`opportunity` scalar at any
position for free.

Uses: hunt destination weighting (drift toward action), flee direction
(pick low-danger cells), route bias, capper wait-spot selection,
"bad lane" avoidance. Kills the biggest current tell: blind orbiting.

### Phase 2 — Utility goals (replace the static ladder) (~1-2 sessions)
Score each goal candidate: objective grab/return/defend, gem pickup,
fight join, hunt creature, retreat — considerations: distance, health
fraction, hero/fear mood, enemy presence from the influence map,
teammates already handling it (avoid double-capping), role weight.
argmax + hysteresis. The ladder's static tiers become the *default
weights* — same behavior in the common case, graded behavior at edges.

This directly fixes "creature-first pkEv drop" properly: a visible player
in range isn't a tier — it's a +score term on the fight candidate.

### Phase 3 — Commander/squad layer (Killzone shape) (~2 sessions)
Per-team commander: tracks match state, assigns squads objectives with
weights (attack/defend/escort/regroup), rebalances when squads get
decimated. Squads translate to per-bot orders the brain treats as
*strong goal suggestions* (nothing is 100% — JP's rule).

First version stays thin: our role coordinator already half-does this —
promote it to a real layer that also reads the influence map, so the
"enemy density bends routing" behavior is emergent, not scripted.

### Phase 4 — Human texture (~2-3 sessions, parallelizable)
- Opponent model: per-target strafe-frequency/orbit tracker feeding aim
  lead (the NN dead-reckoning idea, done with a cheap filter instead).
- Per-bot experience: small per-match memory — lanes where this bot died,
  nug spots where it got shot — biasing phase-2 considerations.
- Movement performance: arc/speed variation on approach legs,
  overshoot-then-correct on landings, ski-surf entry on downhill
  transitions. Humans aren't goal-direct; this is what evaluators
  actually rated in the CS:GO study.
- Emotional continuity: taunts/complaints tied to the influence map
  ("watch east, they keep coming that way").

### Phase 5 — Learning loop (experimental, gated)
We're uniquely positioned: the soak warp produces thousands of matches of
clean behavioral data. Train a tiny learned ranker on "which candidate
goal did the winning team's bots choose" and A/B it against phase-2
weights — behavioral cloning on our own telemetry, no human data needed.
If it doesn't beat the hand-tuned utility, drop it — the utility layer is
the deliverable, learning is the bonus experiment.

## Measurement — every phase ships with a soak gate

Existing harness already produces the metrics that matter: pkEv,
inSight%, duel TTK, selfK, nug banked/decayed, cap times, sheep meter.
Add per-phase assertions: phase 1 → katabatic foeM/inSight must improve;
phase 2 → nug decay down AND pkEv up simultaneously (the tension the
ladder can't resolve); phase 3 → cap times and squad focus metrics;
phase 4 → human-rater spot checks on trail renders.

## Explicit non-goals

- No A*/navmesh — JP's rule: everything dynamic, ski lines stay sampled.
- No pixel-input NN — wrong cost curve for a browser game.
- No per-frame LLM — same reason.
- Nothing 100% — phases 2-3 produce suggestions bots may override.
