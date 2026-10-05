# Harness validation — determinism as a gate, not a hunt

Status: living plan, born from the groundMemo desync RCA (2026-10).

## The rule

Every core system runs inside the deterministic harness and is
*validated before the fact*: a lockstep run + per-tick checksum diff
proves determinism in CI, and invariant probes prove the logic. If it
can't run in the harness, it isn't core — it's decor or a bug.

## What the industry does (researched)

- **Photon Quantum**: partial checksums recorded after every system
  inside a frame. First divergent checksum names the subsystem —
  `detTrace.ts` already does exactly this per sim tick.
- **Factorio (FFF#47)**: CRC the whole map every tick AND save a
  human-readable tagged dump at the same tick; replay does the same;
  first CRC mismatch + the two dumps = a readable diff of the exact
  fields that moved. Our `diffTrees` output is this.
- **Klotho SyncTestRunner**: forward-run → rollback → re-sim → hash
  compare. Validates that rollback restores byte-identical state —
  the client-prediction bridge analogue.
- **Colyseus "Determinism & The Contract"**: everything a step reads
  must live on the step's inputs; reading outside state (wall clock,
  unseeded RNG, history-dependent memo) diverges silently. Our
  `groundY` memo caching an exact-point height under a 4m key was the
  textbook violation — fixed by sampling at the cell center.
- **Age of Empires (1500 Archers)**: seeded RNG for every sim call,
  checksum world/objects/pathing/targeting, and compile the sync
  debugging out of release builds — zero hot-path cost in production,
  full observability on demand. Exactly JP's constraint.

## Layers (apply to all core parts)

### L0 — Purity contract (the cheapest fix, biggest win)

A sim step may read ONLY: its own state, its inputs, injected
clock/rng. Forbidden inside sim/sense code: `Date.now`,
`performance.now`, `Math.random`, unquantized history-dependent
caches, live object identity ordering (Map insertion order feeding
selection when two inserts could interleave differently).

- Clock: `simNow()`/`wallNow()` split already exists — audit for
  stragglers, keep `simNowReset` epoch fixed in tests.
- RNG: `botRng`/`tauntRng` stream globals are per-room seeded in the
  harness; brains' spawn-time rolls now seed off the spawn point.
  Rule: no `Math.random` under `shared/` or `server_bun/src` sim
  paths — lint-grep gate.
- Memos: any cache must be a pure function of its key. If the value
  depends on the first queryer's finer-grained argument, quantize the
  sample point (done: groundY) or key the cache on the full argument.

### L1 — Lockstep gate (`traceLockstep`)

Two `mkRoom` rooms, same seed, ticked in lockstep with per-room
seeded streams; after each sim tick, canonical-hash that sim's
reachable state; on mismatch, `diffTrees` names the field. Built in
`tests/scenarios/detTrace.ts`, exercised by
`replayDeterminism.test.ts` canaries. Extend to a CI gate covering:

- shared sims (MoveSim, projSim, ballSim, creatureSim) — already
  hashable via the room probe;
- bot stack (ServerBots brains + ServerBotSenses + ServerParties) —
  the groundY class of bug;
- combat chain (claims → applyDamage → blast) — the claim/outcome
  ledger already exists to compare against;
- deployables/influence/flags — the newest sims.

### L2 — Invariant probes (property checks, same harness)

Every tick, assert cheap invariants — failures name the tick and the
field, like the checksum does:

- positions/velocities finite (NaN/Infinity abort);
- energy ∈ [0, energyMax]; health ∈ [0, maxHealth] (or dead);
- every claim eventually reaches a ledger outcome (no orphaned
  pendingHits);
- projectile count bounded by cap; no negative ages;
- roster membership consistent across senses/parties/room views.

These run only in the harness — zero production cost.

### L3 — Client-server bridge (prediction drift)

The client replays shared sims against server snapshots. The same
canonical hash should run on BOTH ends of the bridge:

- `stateHash` already rides snapshots — extend it to include the sims
  the client replays locally, so a prediction-vs-authority drift is a
  hash mismatch, not a visible rubber-band.
- Klotho-style re-sim check in the harness: snapshot → mutate →
  replay inputs → hash must equal the uninterrupted run. Proves the
  replay path is a pure function of inputs (the thing reconciliation
  silently assumes).

### L4 — On-demand production observability

Factorio/AoE model: compile-out cost in release, full trace on
demand. `detTrace` runs in tests/tools only; the per-tick checksum
machinery should live behind a dev flag (existing `detTrace` export),
never on the hot path. If a desync is ever seen live, the same probe
dumps tagged saves at the first divergent tick — the report is the
diff, not a 50MB log.

## What "inside the harness" means per system

| System | Harness coverage | Gate |
|---|---|---|
| MoveSim/projSim (shared) | lockstep both rooms | L1 hash + L2 invariants |
| Bot brains/hunt | lockstep | L1 hash on lastOut + brains |
| Senses/parties/groundY | lockstep | L1 hash on ctx answers (pure-fn rule) |
| Combat claims | scenario + lockstep | L2 ledger: every claim → outcome |
| Deployables/flags | lockstep | L1 hash |
| Netcode journal/replay | re-sim check | L3 replay-hash equality |
| Client prediction | re-sim check | L3 vs server hash |

## The FPS-specific layer (server-authoritative, not lockstep peers)

JP's correction stands: humans push inputs, the server is authority —
we're not P2P-lockstep like AoE. What the FPS-specific literature adds:

- **Overwatch (GDC 2017)**: ECS + determinism so replays are byte-
  exact — the replay IS the bug repro (and the killcam). Proof that a
  server's tick can be a pure function of inputs even at FPS pace.
- **exfil**: the sim implemented TWICE (Rust + Go) against a written
  contract, CI replays a shared input trace and demands identical
  per-tick world hashes — cross-implementation determinism as a gate.
  Headless harness with injected latency *measures* prediction error
  rather than asserting it.
- **Lag-compensation ring** (Valve/exfil): server keeps ~1s of past
  world state, rewinds to the shooter's view tick to validate hits —
  our claims ledger already rewinds; the hash gate makes the rewind
  reproducible.
- **Prediction convergence**: don't assert "no rubber-band", measure
  prediction error per tick under synthetic latency — a divergence
  number that trends, not a bool.

So the FPS reinterpretation of the layers: determinism isn't for
peer agreement — it's for **replayability of authority** (any reported
state can be regenerated and diffed) and **prediction convergence**
(client shadow provably follows the same rule). The gate is: same
input journal → same world hash, always, server-internal. That is the
"before the fact" property.

## AI-codegen validation (2026-era techniques)

Since most code is AI-written, validation must precede acceptance —
not follow a bug report. Current research patterns that apply:

- **PROBE (ACL 2026)**: adversarial property hardening — a validator
  generates *counter-implementations* that satisfy the written
  property but are semantically wrong, exposing loopholes in the
  probe itself. Our L2 invariants should be built adversarially: for
  each probe, ask "what wrong code would still pass this?" and close
  the gap.
- **PBT-Bench / property synthesis**: LLMs can mine semantic
  invariants from docs+code (Hypothesis-style). Per-module invariant
  extraction is a delegable, generated artifact — the L2 probe list
  should be grown mechanically per system, not hand-curated.
- **HarnessLLM**: verification harnesses generated from existing
  scenario tests — our `tests/scenarios/` suite is already the seed
  corpus; lockstep wrapping is the mechanical uplift.
- **"Correct-ish by design" (Springer 2026)**: upfront verification
  pairs with continuous monitoring — runtime invariant checks on the
  live server (sheep meter, desync counters, claim-ledger orphans)
  ARE the production complement of the pre-ship gate.
- **Guess-and-check with formal feedback (LORIS)**: validate the
  agent's reasoning, not just output — applicable pattern: when a
  change touches sim logic, the reviewer pass must name which
  invariant or hash it could affect.

## Migration order

1. L0 purity audit — grep-gate `Math.random`/`Date.now`/`performance.now`
   outside the two clock impls in sim paths.
2. Wire `traceLockstep` into the CI scenario suite for every room
   archetype (tdm/ctf/nuggets/dm + creature-heavy + structure-heavy).
3. L2 invariant probe module inside detTrace's tick loop.
4. L3: hash the client prediction state vs server snapshot in e2e.
