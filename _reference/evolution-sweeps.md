# Evolution & ML Sweeps — Reference

How to run parameter evolution against the KRIBES sim loop well: the
algorithm choices, the budget-allocation tricks, and the throughput
options, mapped onto what `_tools/sweeps/` already does. Sources: the
OpenAI ES paper (Salimans et al. 2017), Hansen's CMA-ES tutorial
(arXiv:1604.00772), mirrored-sampling ES literature, and the
surrogate-assisted EA literature for expensive fitness functions.

---

## 1. What we're actually solving

Black-box continuous optimization: find a gene vector `θ` (BOT_TUNING
subset) that maximizes `f(θ)` where `f` is one or more simulated matches.
Properties that drive every choice below:

- `f` is **expensive** — one 8v8 match costs seconds-to-minutes of wall
  clock. Evaluation budget is the scarce resource, not compute per step.
- `f` is **noisy** — the same genome scores differently across seeds and
  maps; a single match's score is a sample, not a measurement.
- `f` is **deterministic per seed** — (genome, map, seed) always replays
  identically. Results are cacheable, reproducible, and debuggable.
- Dims are **coupled** — e.g. posted leash × think cadence interact (a
  wide leash with slow thinks isn't planted, it's wandered).

These properties are exactly the regime evolution strategies were built
for: ES is invariant to action frequency and delayed rewards, needs no
gradient, no model, no discounting.

## 2. Algorithm: what our (μ/μ,λ) ES is and when to upgrade

Current implementation (`capperSweep.ts`, `hofSweep.ts`): children drawn
`~N(mean, σ²I)` — diagonal Gaussian, no covariance. Mean recenters on the
top-quartile elite each generation, σ anneals ×0.8 to a floor.

That is the **cheap diagonal ES**. Correct for ≤~15 dims when you just
want the neighborhood of the optimum. Its blind spot: it can't learn
that dim A should move only when dim B moves — coupled directions get
explored at random instead of learned.

**Upgrade path, in order:**

| Level | When | Cost |
|---|---|---|
| Diagonal ES (current) | first mapping of a param space | none — already written |
| + antithetic pairs | always, free | halves gradient variance |
| + rank shaping | always for noisy f | removes outlier steering |
| Sep-CMA-ES (diagonal covariance) | dims visibly interact in CSVs | ~10 lines more |
| Full CMA-ES | plateau on coupled params | use a library (`cma`, `cmaes` npm, or port pycma's core) |
| BIPOP-CMA-ES restarts | suspected multimodal fitness (several "good" regions) | run 2-3 seeds from different starts instead — same answer cheaper |

Population size rule of thumb: **λ ≈ 4 + ⌊3·ln n⌋**. For 12 dims that's
~11 children/generation — pop=4 (our old default) undersamples and the
elite mean jitters on noise. `--pop 10` is the right ballpark.

## 3. Variance reduction — free wins, always on

### Antithetic (mirrored) sampling
Draw each perturbation as a ±ε pair: evaluate `mean+ε` AND `mean−ε`.
Mirrored pairs cancel the shared-match luck component, halving the
gradient-estimate variance at zero extra parameter count. Population
size must be even when enabled.

### Rank-shaped fitness
Never feed raw fitness into the mean update. Sort the population, update
on centered ranks (rank − mean_rank). One freak match (a 6-cap blowout
from spawn RNG) changes a genome's rank by one slot, not its score by
thousands — the update becomes invariant to monotone rescaling and
robust to outliers. For match-scored fitness this is close to mandatory.

### Median-of-seeds
When re-evaluating the same genome across seeds, take the median
fitness, not the mean. Means let one weird draw dominate; the median is
the honest "typical" genome.

## 4. Budget allocation — where most of the wall clock is saved

The expensive unit is the evaluation; spend it where the information is.

**Successive halving / racing.** Order evaluations cheapest-first
(short-map match before the long-map match). Every genome pays stage 1;
only the top half pays stage 2, top quarter pays stage 3. A genome
that's garbage on a 121m map never burns a 982m katabatic match.
Expected saving vs flat evaluation: 2-3× for the same ranking quality.
This is the single biggest efficiency lever after parallelism.

**Early termination.** A match that's already decided still simulates
to the clock. If a genome concedes its 3rd cap inside 2 minutes, the
fitness can't recover — cut the match at a concession cap and score it
as-is. Worth ~20-40% more throughput on bad genomes specifically.

**Deterministic caching.** (genome, map, seed) → immutable result. Keep
a results table keyed on that tuple; re-runs and generation-boundary
genomes (elite survivors) reuse evaluations for free.

## 5. Throughput — parallelism

Matches are embarrassingly parallel: each (genome, map, seed) tuple is
independent, returns scalars. The OpenAI ES paper demonstrated near-
linear scaling to **1,440 workers** — because workers only exchange one
scalar per episode, communication is free. Our ceiling is the box's
core count, not the algorithm.

Options in order of effort:

| Approach | Speedup | Effort |
|---|---|---|
| Sequential (current) | 1× | done |
| Bun `Worker` pool | ~N cores (8-16×) | moderate — worker file imports the same modules, receives a (genes, map, seed) tuple, returns stats |
| OS process farm (spawn `bun eval.ts --genes ...`) | ~N cores | trivial, higher per-job startup cost — fine since matches run minutes |
| Multi-machine (OpenAI-style) | linear × machines | overkill until sweeps run daily |

Note for the sim loop itself: `step()` is synchronous CPU — workers give
true parallelism only if each runs its own Bun process/worker (no shared
GIL problem in Bun; workers are real threads with isolated heaps).

## 6. Surrogate prescreening (later stage)

Once the CSV holds a few hundred (genes → fitness) rows, a cheap model
(RBF net, gradient-boosted trees, even linear regression over the dims)
predicts fitness for proposed children. Screen children with the
surrogate, only run real matches on the promising half. The literature
(SA-MOEAs) shows 2-5× effective budget multiplication on expensive
problems. Ours is borderline-worth-it at ~10s/match; becomes compelling
if matches stretch past a minute.

## 7. Practical recipe for this codebase

```bash
# 1. Random-phase mapping — wide, cheap, seeds the ES
cd server_bun && bun ../_tools/sweeps/hofSweep.ts --genomes 16 --mins 6 --seed 1

# 2. ES refinement — antithetic + rank-shaped, λ≈10
bun ../_tools/sweeps/hofSweep.ts --gens 8 --pop 10 --mins 6 --seed 1

# 3. Confirm the winner — high-trial re-eval on ALL maps, not just
#    the race survivors' subset
bun ../_tools/sweeps/hofSweep.ts --genomes 1 --trials 4 --mins 8
```

Then fold the winning genes into `shared/botTuning.ts` defaults and
re-run the baseline row to log the delta.

## 8. Pitfalls this codebase has already hit (don't relearn)

- **Global stream contamination**: a genome sweep shares the process
  RNG — `mkRoom`/`step()` already inject per-room seeded streams and
  restore `Math.random` afterward. Any new measure function must do the
  same or genomes stop being comparable.
- **Respawns ride simNow**: stepped sims advance sim-time, not wall —
  `room.messages.respawnTick(simNow())` must be called inside the loop
  or dead bots never return (matchSim shows the pattern).
- **Fitness leaks**: watch() records broadcasts — verify the measure
  isolates the metric you intend (hofSweep attributes kills via the
  roster's role map, not position guesses).
- **Restore tuning between genomes**: `evaluate()` must reset every dim
  to defaults after scoring or the next genome inherits leftover genes.
- **Wall-clock watchdog**: a degenerate genome can orbit forever —
  cap wall time ~3× expected sim time and bail, like capMeasure does.

## 9. Glossary → where it lives

- **(μ/μ,λ) ES**: λ children sampled per generation, mean recenters on
  the μ best. Ours: `hofSweep.ts` gens mode.
- **Antithetic sampling**: mirrored ±ε pairs. `hofSweep.ts` gen loop.
- **Rank shaping**: update on ranks not raw fitness. `hofSweep.ts`
  elite-weight block.
- **Successive halving**: `hofSweep.ts` stageOne/finishRace.
- **BOT_TUNING**: the genome space, `shared/botTuning.ts`. Add dims by
  moving literals into it (e.g. `hof.*` was extracted for this sweep).
- **fitness()**: per-sweep scalarization of a match's column stats.
