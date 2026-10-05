# RL bots — what the DeepMind recipe means for KRIBES

Research notes on applying learned policies (DeepMind-style self-play RL) to
our bot stack, vs. the evolution-strategy sweeps we already run. Verdict up
front: **keep ES for tuning; file RL as a moonshot lane** — it earns its keep
only where evolution can't reach, and our harness is already most of the env.

## What DeepMind actually did (and what maps to us)

| DeepMind artifact | Recipe | Our analogue |
|---|---|---|
| Quake III CTF agents (2019) | Two-level RL: fast action RL inside a slow meta-RL that evolved the REWARD + population of teammates/opponents; ~450k matches, thousands of parallel envs | Our brain already IS the two-level split (think cadence vs reflex layer); ES sweeps tune the outer loop; the inner loop is hand-coded sim input |
| AlphaStar | Population of agents ("exploiters" + main), off-policy actor-critic, human priors for early learning | Our role system (capper/chaser/defender) already supplies the population structure; a league would be variants of tuned genomes |
| OpenAI Five | Self-play against past selves (prevents strategy collapse) | Frozen-genome self-play pool — trivially addable to the sweep harness |
| AlphaGo | Search (MCTS) + learned policy/value | Not applicable — real-time FPS has no think-time budget for tree search |

## Why our env is better than the usual starting point

The bottleneck in game RL is never the algorithm — it's a **fast, resettable,
deterministic, headless environment**. We have that natively:

- Deterministic same-tick sims, seeded RNG streams (`simNow`/`skill.rng` —
  zero wall-clock, proven by 600-tick lockstep trace).
- Headless `mkRoom` — a full 8v8 match runs in-process, no GPU, no sockets.
- Fast-forward: sim seconds run far faster than wall (the chaos tests do 8s
  of traffic in ~100ms when not wall-paced).
- The action interface already exists: bots emit the same wire-shaped input
  humans send (`{forward,right,jump,ski,jet}` + yaw). A learned policy
  plugs in at exactly one seam — no shim layer needed.

Unity ML-Agents gives you the env wrapper + trainer; we'd write a thin
Python (or bun-worker) trainer over `matchSim` instead. The missing pieces
are compute and engineering time, not infrastructure.

## Where RL actually beats ES (and where it doesn't)

**ES/genome sweeps (what we do now)** — right answer when the search space is
a parameter vector over an already-good controller. O(10-20) dims, noisy
fitness, minutes-per-eval: rank-shaped ES with antithetic sampling is
near-optimal here. See `_reference/evolution-sweeps.md`.

**Deep RL earns its keep** when the learned object is:

1. **Continuous micro-control** — aim error is the obvious candidate.
   A policy net mapping (relative position, velocity, projectile ballistics)
   → yaw/pitch rate could learn human-grade leading/flicking that our
   parametric noise model only approximates. Reward is dense (hit%).
2. **Learned movement** — ski-line choice, disc-jump chains, energy-managed
   routes. Sparse reward (lap time / cap time) over a long trajectory —
   the classic RL-shaped problem ES struggles with (credit assignment
   across 30s of actions). Our checkpoint-lap idea IS the standard
   dense-reward trick for exactly this.
3. **Opponent modeling** — policy conditioned on recent enemy behavior.
   Rich-observation RL can pick up patterns we'd never hand-feature.

**RL is the wrong tool** for: role choice, weapon/perk selection, tuning
thresholds — discrete, cheap, already covered by ES + the utility brain.

## The sane integration shape (if we ever build it)

**Distill, don't replace.** Ship bots stay a brain: think layer picks
intent, a small trained net (or table distilled from one) supplies
low-level steer/aim. That's how the shipped bot stays debuggable, tunable
by the same genome params, and bounded in worst-case behavior — a black-box
policy that can twitch 180°/frame or stand still forever is a liability
against real humans.

Training topology:
```
python/RL trainer  <--tensor-->  N × bun matchSim workers
                                  (seeded room, scripted obs/reward tap)
```
- Worker = existing soak harness + an `obs()`/`reward()` tap on the bot's
  think tick. Action dim ≈ 7 (move axes + 3 held flags + yaw/pitch rates).
- Self-play pool: previous policy snapshots as opponents, like FTW.
- Curriculum: checkpoint laps → CTF duels → full 8v8 (same ladder the
  capper sweep already uses).
- Budget honesty: a useful result likely needs 10^4–10^6 matches; at our
  sim speed that's days on one box in workers — feasible, not free.

## Traps specific to our game

- **Determinism ≠ fairness**: same-seed rooms are reproducible, which is a
  *testing* gift but an RL trap — the env must reseed per episode or the
  policy overfits fixed trajectories.
- **Wall vs sim clock**: RL wants sim-clock episodes; the prediction/
  reconcile layer is wall-anchored — keep training purely sim-side
  (movement, aim, roles), never touch the netcode layer.
- **Reward hacking**: a flag-camp bot that maximizes "carrier kills near
  stand" learns to feed. Multiple simultaneous reward terms need
  population-level evaluation (Quake-CTF's fix: meta-RL over reward
  weights — which is literally our ES outer loop over the genome).

## Status / roadmap ordering (JP-confirmed)

```
Current:  ES / genome sweeps tuning the authored brain
Next:     better evaluation + self-play pools (frozen-genome opponents)
Future:   RL locomotion module — policy exposes `desiredDirection` +
          `desiredSpeed` and owns ski transitions, jump/disc timing,
          terrain reading. The checkpoint-lap harness IS the dense-reward
          env for this — likely the first real RL experiment, since
          high-speed movement hides optimizations neither hand-tuning
          nor genome ES will find.
Moonshot: RL aim module (leading/flicking from obs → yaw/pitch rate)
Probably never: end-to-end brain replacement — the think layer stays
deterministic, inspectable, tunable; the policy is muscle memory only.
```

Prerequisites already shipped: deterministic sim, seeded RNG, headless
matchSim, ES sweep plumbing, worker-pool pattern. First task if it ever
starts is the obs/reward tap on the bot think tick — everything else is
standard RL plumbing.
