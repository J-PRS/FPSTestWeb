# FPS Bot AI — Deep Reference

A field guide for KRIBES: what the best bot systems ever shipped actually
do, the papers behind them, the mechanics that matter, and where each
idea lands in our architecture (senses → memory → brain → goal/dest/fire
pickers).

Scope rule: we are building *believable and effective per CPU budget*.
Cheap is a feature — a browser server runs rooms on pennies. That biases
every recommendation below toward methods that cost microseconds, not
models.

---

## 1. Taxonomy of shipped systems

| System | Game | Year | Top-level model | What made it good |
|---|---|---|---|---|
| Quake 3 Arena bots | id | 1999 | Fuzzy-logic goal selection + AAS nav | Item/weigh-style scoring; first believable DM bots |
| UT bots | Epic | 1999-2004 | State machine + squad slots | Scripted orders (attack/defend/freelance) + combat states |
| F.E.A.R. AI | Monolith | 2005 | GOAP (goal-oriented action planning) | Planner picked *action sequences*; sold as "smart" with only ~3 goals |
| Killzone 3 bots | Guerrilla | 2011 | 3-layer hierarchy + HTN planner + influence maps | Commander→squad→individual; RTS ideas in an FPS |
| Halo Infinite bots | 343 | 2021 | Ambitions blackboard + behavior quality tiers | Difficulty = *behavior* (strafe, nades, equipment), not aim |
| CS:GO official bots | Valve | 2012 | Attention system + skill knobs | Reaction-time, aim-error, confidence model — humanization done cheap |
| ML clones | Research | 2017-24 | Imitation/RL | ViZDoom, CS:GO BC agents, movement transformer — believable but data-hungry |

The industry's convergence: **hierarchical structure above, utility
scoring inside, spatial memory underneath, humanization on the outside.**

---

## 2. Deep dives — the three systems worth copying

### 2.1 Killzone 3 — hierarchical chain-of-command
(Straatman, Verweij, Champandard et al., Game AI Pro ch.29)

Three layers, each controlling the one below, information flowing back up:

- **Strategy layer** — one commander per team. Watches mode state, creates
  weighted objectives (attack/defend/escort/regroup — each has an
  importance weight and an *optimal bot count*), assigns squads to them,
  rebalances when a squad reports decimation.
- **Squad layer** — translates objectives into member orders (move to
  area, attack target, use object, stay in region), manages group
  movement, monitors objective progress, reports completion/failure up.
- **Individual layer** — highly autonomous: picks own target, firing
  position, weapon, class ability. May *ignore orders to survive*. Reports
  observations (threats seen) back up.

Key mechanics to steal:

- **Objective = {type, weight, optimal bot count}**. The commander is a
  resource allocator, not a micromanager. Bots join objectives up to the
  optimal count — a second capper is waste, so squad sizing is itself the
  intelligence.
- **Continuation conditions**: an active plan carries conditions that
  kill it (buddy died, objective captured) — plans interrupt on relevance
  loss, not on a timer. This is the clean version of our goal-ladder
  re-evaluation.
- Orders down, *reports up* — the commander can't see the map; squads
  tell it what's true. Keeps the top layer O(#squads), not O(#players).

### 2.2 Halo Infinite — ambitions + behavior-quality difficulty
(Chin-Deyerle, GDC 2022 — "Deconstructing the Combat Dance")

- **Ambitions**: objects/areas relevant to scoring in the current mode
  (a flag stand, an oddball, a stronghold zone), each carrying metadata:
  type, owning team, which bots may use it. They live on the **BotManager
  blackboard** that mode logic (Lua) and all bots read/write.
- **Difficulty = behavior, not aim**: higher-tier bots strafe during
  fights, bounce grenades, use equipment, contest power weapons, melee
  after shield-break. Low tiers just shoot straighter-or-worse. Reviewers
  consistently rated these the most human-like console bots ever shipped.
- Decision framing is explicit: flag carrier faces "fight the enemy vs
  keep delivering" as a scored choice — the same contested-goal tension
  our gem chase has.
- Tiny team (~1-3 engineers) — proof this scale of system fits a small
  codebase when the abstractions are right.

### 2.3 CS:GO bots — humanization as first-class system
(Valve, documented across SDK headers/community)

- **Reaction time**: a real delay between stimulus and aim response, not
  instant lock-on.
- **Aim error model**: gaussian-ish noise scaled by target speed,
  distance, and the bot's skill tier — misses are *shaped*, not random.
- **Attention budget**: bots track one focus target; peripheral contacts
  queue. Kills the "sees everything simultaneously" tell.
- **Confidence/aggression knob**: the same skill value that scales aim
  also scales push-vs-hold tendency — personality falls out of one number.

---

## 3. Utility AI — the decision core

Mechanics (industry standard; Dave Mark's GDC talks; Erkert's writeup):

- A **candidate action** (grab flag, pick gem, join fight, retreat, farm)
  owns any number of **considerations** — each maps an input (distance,
  health, enemy count, teammates already on it) through a normalized
  response curve to 0..1.
- Action score = product (or weighted geometric mean) of considerations.
  Multiply, not add: any zero consideration kills the action — that's how
  you get "never fight at 5hp" for free.
- Argmax wins; the winner gets **hysteresis** (a bonus while running) so
  scores near-tied don't flicker every tick.
- **Hybrid with BT/FSM**: behavior tree decides the *mode* (engage /
  disengage / patrol), utility picks *which* target/item inside it. The
  inverse (utility choosing whole trees) thrashes and is hard to debug.
- Cost discipline: prune with a cheap gate consideration first (range
  check), re-score only when facts change — 40 actions × 8 considerations
  every tick is how utility systems get a bad name.

Failure modes to design around: un-normalized inputs pinning a score at
1.0; missing hysteresis → oscillation; designer can't debug scores →
always ship a live-score overlay/log (our kpi line is already the right
hook).

## 4. Influence & pheromone maps — spatial memory

Mechanics:

- A coarse 2D grid over the map (32m cells is plenty for our map sizes).
  **Sources** deposit influence that spreads outward with falloff and
  **decays over time** (exponential half-life ~30s reads like human
  memory of "that just happened").
- Multiple layers compose: `danger[team]` (enemy contacts/deaths),
  `opportunity` (gem spawns, flag events), `traffic` (where everyone has
  been). Queries are trivial: read cell value, or BFS-search for the
  lowest-danger cell in a radius (flee direction), or argmax in a ring
  (hunt destination).
- **Pheromone maps** (Yahyavi & Kemme 2013, Quake III study): events —
  not just presences — leave scent. A death site stays "hot" for half a
  minute. Their measured result: static-scheme bots are identifiable as
  bots by movement distribution; pheromone-conditioned bots produce
  human-like spatial behavior. This is the paper that justifies Phase 1.
- Cost: a 128×128 f32 grid is 64KB; one decay tick + a few source splats
  per room-tick is sub-millisecond. Trivially server-side, deterministic.

## 5. Opponent modeling & prediction

- **Strafe/orbit tracking**: humans lead shots not by velocity but by
  reading rhythm — a target's strafe is quasi-periodic. A cheap filter
  per target (EMA of lateral velocity sign-flips → strafe frequency +
  amplitude) lets aim lead *the pattern*, not just the position. This is
  the level-2 thinking humans call "I knew he'd juke".
- **Dead reckoning/NN extrapolation** (IEEE TOG 2023, P2P games): learned
  extrapolation cut opponent-position error ~45% vs classic DR. Our
  version: a per-target movement-state guess (skiing/jetting/grounded —
  all readable from our own sim) selects the right prediction horizon.
- **Aim is a perception output, not a math function**: CS:GO-style error
  scaled by target speed + our existing `aimSkillFor` per-weapon bias is
  already the right skeleton — the upgrade is the error *shape*
  (correlated streaks of over/under-lead, not iid noise).

## 6. Humanization science — what sells "human"

Ordered by how much evaluators actually notice:

1. **Movement** — the CS:GO transformer study is explicit: human raters
   scored trained *movement* far above scripted controllers; aim barely
   registered. Humans arc, vary speed, overshoot landings, ski-surf on
   downhill exits. Goal-direct beelines are the #1 "that's a bot" tell.
2. **Selective attention** — ignoring the third contact while focused on
   the first. Our spot-board already ranks; making it a real budget
   (focus decays, queues) is cheap.
3. **Intentional mistakes** — occasionally taking the *second*-best
   option, mistiming a jump, re-checking a cleared corner. HERO_CHANCE
   and chance-band greed are already this pattern; extend it.
4. **Social texture** — reacting to events with positioned callouts,
   tilting after deaths, gloating after kills. We have the chatter
   channel; feeding it influence-map knowledge ("they keep pushing east")
   makes it informational, not noise.
5. **Aim imperfection** — last, because everyone overweights it. Reaction
   delay + shaped error already lands most of the value.

## 7. Learned approaches — what the papers say is and isn't practical

- **Behavioral cloning** (Pearce & Zhu, IEEE CoG 2022): CS:GO deathmatch
  agent from 95h scraped play + 3h expert demos — matched casual humans.
  Lesson: needs *orders of magnitude* of data; we can't scrape Tribes.
  BUT: our soak warp generates unlimited self-play data — cloning *our
  own* winners' goal choices is a legitimate cheap version.
- **Movement transformer** (Rastrogin et al., NVIDIA 2024): 123h pro
  CS:GO → transformer outputs team movement at <0.5ms/step, one CPU core.
  The relevant lesson isn't the model — it's that **movement quality is
  the metric that separates human from bot** in blind evaluation.
- **RL self-play** (AlphaStar/OpenAI Five): superhuman but non-human
  (inhuman APM and timing) — explicitly counterproductive for
  believability. Keep RL out of the runtime entirely.
- **Distillation** (SEED-style hindsight skills, 2026): overkill for us,
  but the *shape* is right — extract rules from trajectories, don't ship
  a model. Our soak → KPI → tuning loop already does a manual version;
  automating "which goal choice correlated with wins" is the feasible
  step.

## 8. Evaluation — how to prove we're there

Metrics that have actually been used to call bots "human-like":

- **Movement distribution** — path curvature, speed-variance histograms
  vs human traces (Yahyavi/Kemme; NVIDIA). We have trail renders — add a
  curvature metric to the soak.
- **Decision quality under contention** — kills/objectives per death in
  contested moments; our `die` (died-for-gem) and `hot` (contested bank)
  counters already measure the right thing.
- **Blind Turing tests** — ultimate check, cheap approximation: does the
  sheep meter + hunt/idle mix read like a human lobby?
- **Regression floor** — every phase ships with the soak gate: the KPIs
  we already print (pkEv, inSight, TTK, selfK, nug, caps) must not
  regress. Believability work that costs kills is a failed experiment.

## 9. Mapping onto KRIBES

| Idea | Lands in | Shape |
|---|---|---|
| Influence map | `server_bun/src/` new `influenceMap.ts` + senses write events | 32m grid, per-team danger/opportunity layers, 30s half-life |
| Utility goals | `shared/botGoals.ts` (replaces ladder internals) | candidates×considerations, argmax+hysteresis, ladder tiers become default weights |
| Commander layer | `ServerBots.ts` + new `commander.ts` | objectives {type,weight,optimalCount}, squad assignment, Killzone's reports-up |
| Opponent model | `serverSenses.ts` memory + `botArsenal.ts` lead | per-target strafe filter, movement-class prediction |
| Human texture | `botDrive.ts`/`botBrain.ts` | path arcs, speed variance, overshoot, informed chatter |
| Learning loop | `_tools/` + soak | mine goal-choice→outcome correlations from warp data, A/B vs tuned weights |

Anti-goals (binding): no A*/navmesh — everything dynamic; nothing is
100%, only strong suggestions; no per-frame heavy models.
