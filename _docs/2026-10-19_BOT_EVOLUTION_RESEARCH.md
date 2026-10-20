# Bot Combat AI Evolution — Research Report

*Deep dive on where the hhEvo idea goes, what the field has learned about
evolving game agents, and which variants are worth our cycles. Grounded
against the actual stack: `_tools/sweeps/hhEvo.ts`, `shared/botSkill.ts`,
`shared/botTuning.ts`, `_tools/sweeps/{hofSweep,teamSoakMatrix,teamSoak}.ts`,
`_hhsoak.ts`, `simJournal`/`RoomDemo` capture, warp-speed `step(dt)` soaks.*

---

## 0. TL;DR

The user's plan (team-vs-team, tune until crush, alternate) is the
**fictitious self-play** pattern — the oldest and most trap-prone
self-play scheme. The literature converged on three fixes, all cheap to
adopt given our harness:

1. **Pools beat pairs** (hall of fame / league structure) — already in
   hhEvo's design; the research confirms why it matters and adds the
   *exploiter* roles we're missing.
2. **Fitness diversity beats fitness max** (quality-diversity /
   MAP-Elites) — probably the single highest-value upgrade: we don't
   want one optimal bot, we want a *library* of strong-but-distinct
   bots, and QD is designed exactly for that.
3. **Evolve tactics globally, dial skill locally** (BOT_TUNING sweep +
   per-axis skill specs) — the two-gene-family split from the earlier
   discussion maps cleanly onto the known separation between policy
   search (what to do) and execution difficulty (how well).

The endgame is not "one insanely powerful bot". It's a **difficulty
ladder + personality roster**: a set of tuned strategy packages
(BOT_TUNING patches) each shipped at graduated execution tiers
(BotSkillMix), chosen per-bot to make the lobby feel like a lobby.
That endgame is reachable with current tech + one new harness.

---

## 1. What the field did (and what transfers)

### 1.1 League training — AlphaStar, OpenAI Five, FTW-Quake

The canonical self-play results (AlphaStar: 99.8th percentile;
OpenAI Five: beat world champions) all use a **population with roles**,
not A-vs-B ladders:

- **Main agents** — play the whole league, optimize for robustness
- **Main exploiters** — play only the current main agent; they exist
  to find its holes and force it to patch them
- **League exploiters** — play anyone; they hunt league-wide
  degeneracies (strategies that beat the pool but lose to novel play)
- **Frozen snapshots** — every champion stays in the pool forever, so
  forgetting is impossible; you can't "evolve past" a counter-strategy

DeepMind's own framing: plain self-play **cycles** — rock beats
scissors beats paper beats rock, forever, with no memory that rock was
already solved two cycles ago. The league structure is what converts
cycling into compounding skill.

**Transfer:** hhEvo already keeps winners in the pool (frozen
snapshots). What's missing is the *exploiter* distinction — today every
mutant tries to beat the pool equally, so nobody specializes in finding
the champion's specific weakness. Cheap addition: dedicate ~1/4 of each
generation's mutants as "main exploiters" — they only play the current
#1, and their fitness is margin *against the champion specifically*.

### 1.2 PSRO / Double Oracle — the game-theoretic version

Policy-Space Response Oracles is the formal name for the same loop:
maintain a population, compute a meta-game payoff matrix, add best
responses to the current Nash mixture, repeat. Key concepts worth
stealing:

- **The payoff matrix is the product.** Our round-robin boards ARE the
  restricted-game payoff matrix. Writing it out per gen (hhEvo already
  does, as JSONL) means we can compute the **Nash mixture** over
  genomes — the weighted mix that minimizes exploitability. If the
  champion's Nash weight is 60%+ it's a real strategy; if the
  equilibrium is a 30/30/40 rock-paper-scissors blend, shipping only
  the champion is wrong — ship the *mixture* as the bot roster.
- **Exploitability is measurable.** A genome's exploitability =
  best-response margin against it. hhEvo's board doesn't compute this,
  but the data's there: the worst single-pairing margin a genome takes
  IS its approximate exploitability. Worth reporting per row.
- Cycling is provable, not just observed — if margins keep oscillating
  A>B>A, the fix is adding strategies to the pool, not tuning harder.

**Transfer:** compute the meta-Nash over the board's payoff matrix each
gen (a tiny LP — ~30 lines via iterative fictitious play, no deps) and
report it. It answers "is the champion dominant or is the meta mixed"
in one number.

### 1.3 Quality-Diversity / MAP-Elites — the best fit for our actual goal

Standard evolution asks "find the best genome". MAP-Elites asks
"find the best genome *at every point in behavior space*". You pick
behavior descriptors (axes of variation), it fills a grid of
high-performing cells.

For a game that needs **varied, personality-bearing bots**, this is
the right objective — we explicitly do NOT want all bots to converge
on one optimal style (a lobby of identical cappers is both boring and
fragile). QD also reliably finds *better* optima than objective
evolution because stepping stones are preserved: the weird genome that
loses today may be one mutation from the dominant strategy tomorrow.

Natural behavior descriptors for our space:

| Axis | Measure | What it names |
|---|---|---|
| Aggression | kills/min, mean engagement distance | brawler ↔ artillery |
| Mobility | mean speed, jet airtime fraction | anchor ↔ skier |
| Objective | tokens held EOT, grab rate per kill | duelist ↔ hunter |
| Survivability | median life span | suicide ↔ turtle |

An hhEvo-QD variant keeps the same genome + matches, but selection is
"best genome per grid cell" instead of "top half" — the champion of
the *mobile* cell and the champion of the *artillery* cell both
survive. Output: a roster of strong, distinct personalities — which is
exactly the shipping artifact we want.

**Transfer:** high value, medium effort (~half a day on hhEvo's
scaffold). The descriptors are all already measurable in runMatch —
we just record them instead of discarding them.

### 1.4 CMA-ES — for the continuous parameter space

hhEvo's mutation is discrete (tier indices ±1, kit resample). For
BOT_TUNING (~150 continuous knobs) the right tool is **CMA-ES**: the
standard black-box continuous optimizer — sample a population around a
mean genome, weight by fitness, update covariance, repeat. Proven on
racing-game parameter tuning (TORCS/Trackmania lineages) at exactly
this scale (10-50 dimensions, noisy fitness, minutes of eval time).

CMA-ME (CMA-ES + MAP-Elites hybrid) exists if we want continuous genes
*and* diversity later — likely overkill for v1.

**Transfer:** when we move to BOT_TUNING evolution, start with plain
CMA-ES, ~10-20 hand-picked dims (strikeGd, mountE, cruiseSpeed,
grabOrbit*, hof.*), not all 150 — the sweep results already name which
knobs move the needle.

### 1.5 Behavior cloning / imitation — the demo pipeline already built

FPS-specific imitation research (TeaPearce's CS:GO deathmatch agent —
95h of scraped pub play pretrained + 3h expert fine-tune; Stanford's
CS movement model; VALORANT-likes with ray-cast sensors) converges on:

- **Pretrain on volume, fine-tune on quality** — two-stage BC
- **Hybrid scripted+learned** — rule-based skeleton, learned weights
  only where scripting is weak (aim, movement micro-decisions);
  guarantees developer control + behavior floor
- **Symbolic state, short horizons** — predict the next few actions,
  not the whole plan

Our position is unusually good here: `RoomDemo` records *authoritative*
matches (server-side truth, no loss/interp noise) — a better BC
dataset than scraped client demos, which is what most of the literature
had to settle for. If a human ever plays against the evolved bots,
their demos are the imitation dataset for "how a good human handles
this exact situation".

**Transfer:** not needed for evolution per se, but it's the
*believability* answer: evolved bots will win optimally and possibly
look inhuman doing it. BC from human demos is the known way to add the
human-texture back. Keep it in the "later" drawer; the demo pipeline
means the option stays open at zero ongoing cost.

### 1.6 Believability & Dynamic Difficulty — the endgame constraint

Two important findings for the "dial it down" half of the plan:

- **Perceived skill ≠ actual skill.** Studies repeatedly show players
  enjoy opponents that look *convincingly imperfect* more than
  near-optimal ones (DPBM vs near-optimal heuristics: the modeled
  "imperfect" bots scored higher on interest-enjoyment, lower on
  tension-pressure). A bot that never misses reads as a cheater; a bot
  that makes *human-plausible* mistakes reads as skilled. Our
  skill-matrix (per-weapon axes, form drift, courage, beltPull
  personality) is already structured for this — evolution should
  optimize *style*, then ship style × execution-tier products.
- **DDA works best when it's not visible.** Rubber-banding (bot
  suddenly misses everything when losing) breaks motivation. The
  invisible version: vary *which genome/tier* spawns per slot —
  difficulty changes arrive as different opponents, not the same
  opponent getting dumber mid-fight. A lobby that quietly fills the
  hardest slots with evolved champions and the filler slots with
  medium-tier variants is more honest *and* more fun than one
  difficulty knob on every bot.

**Transfer:** the evolved artifact set should be a *tiered roster*, not
a single super-bot config. `BOT_TIERS`/`BotSkillMix` is already the
shipping dial — the evolution work should produce "strategy genomes",
and difficulty is set by which tier each bot's skill axes resolve at.

---

## 2. Variants ranked for this codebase

| # | Variant | Cost | Payoff | Verdict |
|---|---------|------|--------|---------|
| 1 | **hhEvo as-is + exploiters + meta-Nash** | ~1 day | Closes the cycling trap; names the real champion vs a blend | **Do next** |
| 2 | **QD/MAP-Elites layer on hhEvo** | ~0.5-1 day | Personality roster, not a single bot — the actual product | **High value** |
| 3 | **BOT_TUNING CMA-ES sweep** (global brain tuning, fitness = aggregate match score) | ~1-2 days | Learns situation-weighting (engage dist, energy thresholds) — "how to use each situation" | **High value, different question** |
| 4 | **Duel evo** (1v1, per-weapon skill profiling) | ~0.5 day | Which axis mix wins per weapon → per-slot skill budgets | **Cheap, do opportunistically** |
| 5 | **Behavior cloning from RoomDemo** | days-weeks | Human-texture bots; needs the BC infra (model, inference path) | **Defer — keep demos rolling** |
| 6 | **DDA tier ladder** (spawn-slot difficulty assignment, not rubber-banding) | ~1 day | Ships the "not unkillable" requirement the right way | **With the roster, after 2** |

### Recommended sequence

1. **Now:** hhEvo gets exploiters + the meta-Nash report (the pool is
   already there; this is analysis + a matchmaking rule).
2. **Then:** behavior descriptors + cell-grid selection (QD) — the
   moment the output becomes "a roster" instead of "a champion".
3. **Parallel track:** CMA-ES over 10-20 BOT_TUNING dims scored on
   aggregate match fitness — the "situation-weighting" evolution the
   duel question is really asking about.
4. **When a champion exists:** tier it through `BotSkillMix` ladders
   (easy→impossible on execution axes) and you have the difficulty
   dial without the unkillable-blob problem.

## 3. What this doesn't solve (honest limits)

- **No within-game learning.** All of this is offline search over
  parameter vectors. Bots won't adapt *during* a match — that's RL
  territory (policy networks, real compute) and a different project.
- **Evolved strategy can look inhuman.** Optimal play and human-like
  play diverge; if "feels like a real lobby" is a goal, BC-from-demos
  or human-authored flavor (taunts, hesitations, form tilt — which we
  already have) carries that load, not evolution.
- **Flat-field bias.** All trials so far ran on the flat arena. Evolved
  strategies tuned on flat may lose on real terrain — run champions
  on `--map` before trusting them. (hhEvo already accepts `--map`.)
- **Match-length sensitivity.** 4-5 sim-min favors aggressive builds;
  20-min matches may reward different energy economy. If results
  look extreme, re-run finalists at `--mins 15`.

## 4. Immediate next steps (mechanical)

- [ ] hhEvo: dedicate ~25% of mutants as champion-exploiters (fitness =
      margin vs #1 only)
- [ ] hhEvo: report per-genome worst-pairing margin (≈ exploitability)
      and the board's Nash mixture (fictitious-play iterate, ~30 LOC)
- [ ] Add behavior-descriptor capture to runMatch output (agg/mob/obj/
      surv) — prerequisite for QD
- [ ] Draft the BOT_TUNING dim shortlist for CMA-ES (~10-20 from the
      annotated sweep results)
- [ ] Re-run champion at `--mins 15 --map katabatic` as a sanity check
