# C5 pilot review — 2026-11-02

## Candidate

C5 — One world model: every entity kind is a shared sim + declared lane
(UPHEAVAL MAX). Status before this review: protocol spine landed (2026-10-08);
client mirror (replicas consuming the declaration) still hand-built.

## Audit findings

- `shared/worldModel.ts` declares 7 kinds (ball, creature, deploy, flag, pickup,
  player, projectile?) with field/channel declarations and spawn/gone/roster
  shapes. No `make` exists yet — the declaration describes data, not construction.
- `shared/stateHash.ts` provides `replicaHash` + `kindFieldDiffs` — the shared
  lane machinery is in place and already consumed by `stateDebug.ts` (all 5 lanes
  use the shared `laneCheck` driver). C4's pilot is effectively landed.
- `client/src/game/replicas.ts` provides the shared roster-reconcile lifecycle
  (`reconcileReplicas`); deployables, flags, nodes use it. Balls do NOT (they
  use netBallSpawn/Segment/Die/Roster in entities.ts). Creatures use netCreatures.
- `client/src/game/entities.ts` hand-builds `Ball` replicas from wire rows.
- Conformance suite: `server_bun/tests/worldModel.test.ts` (17 tests).
- Churn: worldModel.ts 14 touches/3wk, TickLoop.ts 10, stateDebug 4. The spine
  is still moving — high collision risk.

## Review

### End state
Client runs the same `Room` as a predicted mirror: local entities predicted,
remote entities replayed from edges, everything presented from one codepath.
Nothing interactive client-decided; nothing visual wire-decided.

### Falsifier
If any interactive kind needs client-decided outcomes (a latency argument
prediction can't cover), C5's universal claim is falsified — that kind stays a
declared exception in the table. Detect via: a kind whose outcome can't be
predicted from inputs + server edges alone (e.g. hitscan with no travel time).
Currently: melee/LG/repair/healbeam/slam remain claim-based (C1 residual ~50
lines). These are the declared exceptions.

### What dies, what stays
- Dies: hand-built replica construction per kind (~Ball ctor calls in entities.ts,
  etc.), per-kind hash bodies (already shared), per-kind compare blocks in
  stateDebug (already shared).
- Stays: server authority, client prediction of local-visible, per-kind content.

### Costs (honest)
- `make` cannot live in `shared/` (Ball ctor needs scene/terrain/deps). It must
  be a client-side factory registered by kind name, with the shared decl
  providing only the kind identity + field schema. This is a design decision,
  not a code change.
- Determinism gate: every kind involved must satisfy shared/ determinism.
  Ball sim already is (shared/ballSim). Player movement already is.
- CPU: full local mirror grows client CPU. Soak-proven for 16 bots; needs
  measured budget for full lobby.
- Wire: no change in pilot (compat preserved).
- Desync surface: inherits movement's predict/reconcile for every kind —
  more kinds = more correction paths, but ONE machinery.

### Pilot scope (smallest slice that proves the shape)
Take the **ball** kind (worldModel's stated pilot) and:
1. Add a client-side factory registry keyed by kind name, with `registerMake(kind, factory)` and `make(kind, row, ctx)`.
2. Register a ball factory that wraps `new Ball(scene, terrain, variant, ...)`.
3. Have `entities.ts` netBallSpawn path call `make('ball', row, ctx)` instead of
   `new Ball(...)` directly, behind the existing ensure path.
4. Keep the hand-built path as fallback until soak-proven.

No wire change. No deletion. Rollback = revert the factory call site.

### Rollback cost
Low — gate per kind; the old `new Ball(...)` path stays wired until the pilot
proves out. Deletion is a separate, later commit.

### Who else touches this
- `entities.ts` (Ball construction), `world.ts` (netBallSpawn/Segment/Die/Roster
  handlers), `replicas.ts` (lifecycle). Multi-agent: check git status before
  editing — these are high-churn seams.

### Determinism gate
Ball sim is already deterministic (shared/ballSim, ballCollide). No ambient
time/RNG in the construction path. OK.

## Pilot plan (NOT executed this session)

Reason for deferral: no soak budget available in this turn (skill rule: "No soak
budget available -> upheaval without soak verification is unsafe"), and the
multi-agent tree has in-flight edits on entities.ts-adjacent files. Implementing
the factory + wiring without soak verification would violate the skill's VERIFY
phase.

Proposed next session:
1. Implement the factory registry (additive, tsc-green).
2. Register the ball factory.
3. Wire netBallSpawn to use it (behind fallback).
4. Run `bun test` + `bun _tools/e2e/all.ts` (E2E_GPU=1) + a ballFuzz soak.
5. If falsifier holds and soak green, record + update CANDIDATES status.

## Falsifier check (not run — deferred with pilot)
Would require a kind that needs client-decided outcomes. Melee/LG/repair/
healbeam/slam are the declared exceptions. No new falsifier triggered by this
review; the universal claim stands pending pilot evidence.

## Status
REVIEWED 2026-11-02 — pilot plan written, not implemented (no soak budget).
Next: implement pilot in a dedicated session with soak verification.
