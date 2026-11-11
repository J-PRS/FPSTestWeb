# Verification audit techniques — SOTA survey for agentic coding

Date: 2026-11-11. Trigger: mutation-testing pilot on `client/src/game/blastForce.ts`
(score 46.3%, `npx stryker run` from `client/stryker.conf.mjs`) plus three
consecutive feedback-path bugs the green suite missed (friendly-splash
number lie, teammate body-block, jumpstart air activation). Question:
what other audit classes find "tests pass, behavior is wrong" bugs that
linters, typecheckers, and unit tests structurally cannot see?

## Taxonomy

### 1. Mutation testing (baseline — already piloted)

What it does: rewrites operators/literals/conditionals in the target file
and reruns tests; a surviving mutant = a behavior nobody pinned.

Evidence here: `blastForce.ts` pilot, 518 mutants in 48s. Real gaps
surfaced immediately: `occluded()` deleted entirely survived (no test
covers blast occlusion through structure solids), `blastRemotes`
deployable path uncovered, `KNOCKBACK_SCALE` direction unpinned. The
NaN-guard arithmetic survivors are unactionable noise by construction —
expected, not a suite defect.

Config: `client/stryker.conf.mjs` — vitest runner, perTest coverage,
inPlace (the `../../shared/` imports escape the sandbox), incremental.
Server-side bun runner exists but is unofficial
(`stryker-mutator-bun-runner`, `@hughescr/stryker-bun-runner`); most
shared-code mutants are already covered via the client vitest suite.

Cost model: mutants × covering-tests. Scoped to hot files it is
minutes; whole-repo it is days. Never run unscoped.

### 2. Property-based testing (biggest known ROI)

What it does: declares invariants; a harness generates hundreds of
random inputs per run, shrinking counterexamples to minimal cases.

Evidence: ACM corpus study of 426 Hypothesis projects — each
property-based test kills ~50x more mutants than the average unit test;
76% of mutations die within the first 20 generated inputs (cheap runs
keep most of the signal). The agentic angle (Property-Generated Solver
paper): an invariant is a spec the agent cannot write wrong in the same
way the code is wrong — it breaks the self-deception loop where a
generated test shares the generated code's flaw.

JS tool: `fast-check` (vitest/jest-agnostic).

Fit here: `shared/` is deterministic pure math — properties write
themselves. Candidates:

- `shared/movement.ts`: `energy` stays within [0, max] under any input
  sequence; `pos.y` never ends below terrain height at rest; a grounded
  `jumpstartKick` only fires on a ski-press edge (regression class:
  midair activation).
- `shared/combat.ts`: `aoeDamageAt(damage, dist, radius)` is
  monotonically non-increasing in dist, zero past radius;
  `hitRadiusAt`/`selfDmg` never exceeds the blast's aoeDamage.
- `shared/weapons.ts`: `spendAmmo` never returns a negative pool;
  `payShotCost` is identity when the cost is zero.
- `shared/perks.ts`: `effectiveResist` is 0 above the health threshold,
  the blurb's factor below it (regression class: Armored-was-dead-code).
- `shared/gunGame.ts`: `gunGameAllows(rung, wt)` true iff `wt ===
  gunGameWeapon(rung)` or the allowed belt item — a one-line law over
  every rung.
- `shared/projSim.ts`: swept-segment contact `t` is in [0,1] and contact
  point lies on the segment; bounce conserves tangential speed within
  the declared restitution.

Priority on this list: the formulas the sim shadows must agree on —
movement energy, blast falloff, ammo. A PBT suite here tests the
client/server parity contract implicitly.

### 3. Differential testing (the netcode-native audit)

What it does: run the same inputs through two implementations; any
output divergence is a bug in one of them — no oracle needed.

Why this codebase is the textbook case: `shared/` sims run both sides
of the trust boundary — client prediction and server authority. The
bug history is dominated by differential failures: `trajDiv` ghost
hits, `parity-nugrest`, predicted-splash whiffs, dead-row ping-pong. Each
was found by telemetry, in production, after users noticed.

Harness shape: record one input stream (the demo recorder already
captures this — `DemoManager`/shot claims + movement inputs), replay it
through `Player`/`RemoteInterp` client-side AND `RoomMoveSim`
server-side, assert identical position/energy/health sequences. The
substrate exists; the missing piece is the replay-compare test driver.
Mokav-style input generation (LLM-generated difference-exposing inputs)
is the research frontier — overkill until the replay-compare runs.

Cheaper same-family check already half-built: `projSim` step for
client-spawned predicted shells vs `RoomProjectiles` authoritative arcs
on the same claim — divergence measured by `trajDiv` could be a CI
assertion instead of telemetry.

### 4. Executable invariants (extend what's there)

`shared/invariants.ts` (`invEq`, `inv`, `setInvariantSink`) already
fires on `health-pool-formula` mismatches with offender context. The
direction that scales: every computed budget has a self-check at the
site of the computation — energy pool vs class+perk, belt charge count,
ammo pool vs clip, rung weapon legality, `sheep` accumulation rate.
One line per formula; fails with the numbers, not a downstream symptom.
This is the "specs over vibes" essay's core point: agents edit code
confidently when invariants complain locally, and silently mis-edit
when the only check is an aggregate test three layers away.

Fit: extremely high — the codebase already has the sink and the culture;
it's an expansion of a proven mechanism, not a new tool.

### 5. Semantic-diff gates (change-classification)

Tool category (act101-style): classify each changed function's diff as
behavior-preserving vs behavior-changing; gate merges on "unrelated
files changed semantics". Directly relevant because this repo's repeat
failure mode is WIP bleed — an unrelated edit silently shifting
behavior (the `thrift: rng()` draw that reseeded a whole deterministic
room and broke a scenario by shifting the RNG stream).

No polished OSS tool exists at TS maturity; the cheap version is
already in-tree (`_tools/review.sh` → fresh-context verifier agent).
The upgrade would be a small AST-hash diff per exported function:
`git diff` → "these functions changed" → "were they in scope?"

### 6. Fuzzing (wire/protocol surface)

`netMalformed.test.ts` hand-writes malformed cases. Structured fuzz
(jazzer.js or a custom mutator over `WIRE`/protocol decode paths) finds
the crash/NaN/decode-accept class systematically. Moderate fit — the
protocol surface is real but well-tested manually.

### 7. Static security analysis (taint on claims)

CodeQL/Semgrep over "client-sent field reaches damage/motion without a
gate". The funnel audits already do this manually each pass; tooling
it converts a recurring human audit into CI. Lower marginal value given
the funnel's explicit gate structure, but a one-time setup that never
regresses.

## Recommended order for this repo

1. **fast-check on `shared/` sims** — highest signal-per-line; the
   deterministic substrate is the cheapest PBT surface that exists.
2. **Differential replay harness** — record-once inputs through client
   prediction vs server shadow; promotes `trajDiv`/parity telemetry
   into CI assertions. The codebase's dominant bug class.
3. **Invariant lattice expansion** — more `invEq` sites (energy, ammo,
   belt, rungs). One line each, immediate.
4. **Scoped mutation runs** — the working Stryker pilot, extended to
   the damage funnel files (`CombatHandler`, `projContact`, `beamSweep`,
   `hitLedger`, `combatBlast`). Nightly/incrmental, not a gate.
5. Semantic-diff + protocol fuzzing — opportunistic, lower marginal.

## What NOT to do

- Whole-repo Stryker (months of compute, mostly unactionable survivors).
- E2E as a substitute — browser soaks prove integration, not properties;
  they can't express "never below zero".
- Aiming for a mutation-score number — score is diagnostic, not a KPI;
  unactionable survivors (NaN guards, optional chains) inflate the
  denominator. Report "did any load-bearing mutant survive" instead.

## Extended survey (second pass — agentic-era + general SOTA)

### 8. Deterministic Simulation Testing (DST) — highest ceiling

FoundationDB/Antithesis model: one seed-driven simulation of the whole
system, injected faults, bugs replay bit-for-bit. This codebase is
architected for it already — `shared/` deterministic sims, `botRand`/
room seeds, `SimJournal`, `DemoManager` recording. The missing piece is
"replay a captured anomaly in the harness" — `moveReplay.test.ts`
(client/src/__tests__, landed 2026-11-11) is the first step: two
`MoveSim` instances on identical seeded input streams assert identical
state, plus never-below-terrain / finiteness invariants. Next: the
same replay through client prediction vs `RoomMoveSim` shadow.

### 9. Agentic concolic execution (research frontier)

CONCOLLMIC (IEEE S&P 2026): an LLM agent replaces the SMT/symbolization
layers of concolic execution — 115–233% more coverage than KLEE on real
subjects, 11 new vulnerabilities found. Language-agnostic, so it works
on TS where KLEE can't. Not a shipped tool yet; watch it for
`shared/` sims once it matures — same target surface as PBT but
constraint-driven instead of random.

### 10. Metamorphic testing — oracle-free correctness

When no spec exists, assert *relations* instead of values: "doubling
blast distance never increases damage", "more tokens never reduces
plating", "a heavier chassis never out-accelerates a lighter one".
Each relation is one `for` loop over generated inputs — same cost as a
PBT property, no oracle needed. UTBoost's intramorphic variant (same
inputs through original vs patched code) found **345 wrongly-passed
patches on SWE-Bench** — the "tests pass but fix is wrong" detector.

### 11. Iterative test generation (TestForge pattern)

Generate tests → run → refine toward uncovered lines / survivors in a
loop (~$0.63/file, 33.8% avg mutation score on TestGenEval). This is
the "agent kills Stryker survivors" loop made formal — pairs directly
with the scoped Stryker config: mutate a hot file, agent writes tests
until the load-bearing mutants die, stop at noise.

### 12. Dynamic invariant inference (Daikon pattern)

Infer "likely invariants" from observed traces rather than hand-writing
`invEq` sites: run soaks, capture pos/energy/health/ammo series, derive
bounds automatically, flag violations. The telemetry counters already
record the raw material (`netprobe`, `parity`, `trajDiv`, ghost-hit
logs) — the upgrade is a summarizer that proposes invariants instead of
a human reading dumps.

### 13. Fault injection (chaos — deterministic-flavored)

The resync/recovery batch (reseat gates, wall-clock throttle, hidden-
spawn guard) is the exact surface chaos exercises: flap transports
mid-pull, drop ticks, hold the tab hidden. `resyncRecovery.test.ts`
proved these are unit-testable — a fault-injection soak is the
system-level version and shares the same "designed recovery, broken
detector" bug class.

## Provenance

- Mutation score 46.3% → **47.5%** after pinning occlusion +
  blastRemotes (blastForce.test.ts 21 tests): `npx stryker run` in
  `client/`,
  `client/stryker.conf.mjs`, report `client/reports/mutation/index.html`.
  Windows caveat: inPlace restore can EPERM on file-locked scratch dirs;
  verify `git status` after every run (mutated source restored fine here).
- PBT efficacy: ACM PLS 2025, "An Empirical Evaluation of
  Property-Based Testing in Python" (~50x mutants/test, 76% in first
  20 inputs).
- Agentic framing: arXiv 2506.18315 (Property-Generated Solver), Mokav
  (JSS 2025, execution-driven differential tests), eduardito.dev
  "specs over vibes".
- Extended survey: CONCOLLMIC (IEEE S&P 2026 — agentic concolic exec,
  +115-233% coverage vs KLEE), UTBoost (arXiv 2506.09289 — 345 bad
  SWE-Bench patches caught intramorphically), TestForge (arXiv
  2503.14713 — $0.63/file iterative testgen), Daikon (dynamic invariant
  inference), FoundationDB/Antithesis (deterministic simulation testing).
- Replay harness landed: `client/src/__tests__/moveReplay.test.ts`
  (vitest, 2 tests — dual-sim determinism + physical invariants).
