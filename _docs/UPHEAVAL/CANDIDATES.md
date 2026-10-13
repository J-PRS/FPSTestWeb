# Upheaval Candidates Ledger

Ranked architectural-change candidates. Accepted ≠ shipped — it means the
argument held; implementation is a separate decision. Rejected entries stay
recorded so they're not re-argued without new evidence.

## Authority models in the game (the map)

| Concern | Who sims | Who decides | Wire shape |
|---|---|---|---|
| Movement | server (`RoomMoveSim` shadow) | server | inputs up, tick/correction down |
| Remote replicas | server | server | tick/interp, no claims |
| Projectiles (local) | client | **client claims, server validates** | shot/aoeShot claims + ledger |
| Deployables/pickups/flags/creatures | server sims | server | state edges + replica hash |
| Heals/env-damage | client claims | server validates | claim + verdict |

The outlier is local projectiles: the only interactive outcome the client
still *decides* rather than predicts.

## Candidates

### C5 — One world model: every entity kind is a shared sim + declared lane (UPHEAVAL MAX)
- **Status**: PROTOCOL SPINE LANDED (2026-10-08) — the wire half of the
  end state is done: all seven entity kinds declared in
  `shared/worldModel.ts`, every server→client payload generated from
  declarations, inbound intents+packets+rosters+envelopes shape-checked
  at dispatch, replica hashes generated from `kind.fields`, conformance
  suite (44 checks) pins declaration↔union↔codec, and `claimsAccepted=
  false` refuses remaining combat claims on dedicated. P2P hosts run
  RoomMoveSim + RoomWeaponSim so peer reports are judged, not trusted.
  What remains of the end state: the client-side mirror — replicas
  still hand-build objects from wire rows rather than consuming the
  declaration (generated `kind.make()` + replayed sim = the
  "Room-as-replica" lead below). Server-side claim layer is residual:
  ~50 lines of rewind util + skill adjudication, all combat claims
  refused at the gate.
- **Status (prior)**: RANKED #1 under "effort doesn't matter, end state must be
  maximally clean + robust" (2026-10-07). Subsumes C1 (entry slice) and
  C4 (the lane registry this makes non-optional).
- **The end state**: `shared/` holds the sims for EVERY interactive
  entity kind — players, projectiles, balls, creatures, deployables,
  pickups, flags, heals/damage. The server runs the authoritative `Room`.
  The client runs the same `Room` as a predicted mirror: local entities
  predicted, remote entities replayed from edges, everything presented
  from one codepath. Nothing interactive is client-decided; nothing
  visual is wire-decided.
- **One wire vocabulary for all kinds**: each kind declares itself ONCE —
  `{ simFields, edgeFields, echoFields, spawn edge, gone edge, localMap }`.
  sim/edge/echo channels already exist as a concept in
  `FIELD_CHANNELS` (stateHash.ts) — C5 makes the declaration the *only*
  implementation. Spawn/tick/gone/hash/diff are generated per kind from
  the table; no per-kind protocol fields, no per-kind hash body, no
  per-kind compare block.
- **What dies (counted)**:
  - The entire claim layer — ~2,750 lines (server 1,906 + shared ~350 +
    client ~500): shotClaims, combatAoe, combatBlast, claimLedger×2,
    envClaims, CombatHandler, combatCharge, impact.ts claim senders.
    Every reject-warn class measured in the census dies with it — the
    code can't express a client-outcome claim anymore.
  - Five hand-written replica lanes (~200 lines × seams): one
    kind-table + one generated compare/diff/report replaces
    stateDebug's five blocks, stateHash's five bodies, TickLoop's five
    computations, protocol's parallel hash/fields slots.
  - The "Nth copy of a lane-drift bug" class (changelog 2.156, 2.160,
    2.161, 2.163, 2.165–2.169 — eight entries in one week, same class).
  - The claim-vs-sim authority asymmetry: movement's predict/reconcile
    becomes the ONLY model in the game.
- **What stays**: server authority over every outcome (invariant);
  client prediction of everything local-visible (WYSIWYG mandate);
  per-kind *content* (a flag isn't a ball — the table declares the
  difference, the machinery doesn't).
- **Costs (honest, even when effort is free)**:
  - Every entity kind must now satisfy `shared/` determinism — no
    ambient time/RNG, seeded everything. Kinds that currently cheat
    (client-decided projectile spawns, any Math.random in sim reach)
    must be made deterministic or declared non-sim. This is the real
    gate, and it's also the benefit: determinism becomes enforceable,
    not aspirational.
  - Client CPU grows: full local mirror of the world sim. Soak-proven
    for 16 bots; needs a measured budget for full-lobby scale.
  - Wire shape changes — a protocol generation boundary. Old
    clients/servers can't mix across it; the game ships client+server
    together so this is a versioned cut, not a compat problem.
  - Predicted-mirror adds a desync surface movement already manages
    (correction/replay) — C5 inherits that machinery for every kind,
    which is exactly why it's robust: ONE correction path, not N.
- **Sequencing**: C1 is the first slice of C5 — BoltLauncher through
  `RoomProjectiles.spawn` proves "server-sims + client-predicts" for the
  hardest kind (fast, bouncy, player-owned). Then kind-by-kind table
  adoption; claim-layer modules deleted last, when nothing calls them.
- **Falsifier**: if any interactive kind turns out to *need*
  client-decided outcomes (a latency argument prediction can't cover),
  C5's universal claim is falsified — that kind stays a declared
  exception in the table, and the table still wins.

### C1 — Kill the combat claim layer (server-simmed projectiles)
- **Status**: ENTRY SLICE OF C5 (upheaval-max) — still the first thing to
  build; under "end result above all" it's step 1 of the world-model
  unification, not a standalone candidate.
- **Model collapse**: projectiles join movement's predict/reconcile —
  client predicts a shell locally on fire intent, server sims truth,
  outcomes broadcast. One sim, no adjudication.
- **Pain surface (measured, 2026-10-07 run)**: ~1,900 lines server-side
  (shotClaims 301 + combatAoe 236 + combatBlast 356 + claimLedger 304 +
  envClaims 113 + CombatHandler 531 + combatCharge 65) plus ~350 shared
  claim-validation lines and ~500 client claim-side lines (impact.ts 501,
  claimLedger 176). Warn census from the user's live log: `projectileId:
  invalid or oversized` (recurring), `flight blocked by structure`,
  `end ~1000m beyond reach`, `no known projectile — spawn claim never
  arrived` (+16 suppressed), `fire rate (flood: 4/s)`, `dropped deferred
  claims`. Every one of these categories is a claim-model disagreement
  that cannot exist when the server sims the shell.
- **Feasibility confirmed**: `RoomProjectiles.spawn(ownerId, weaponType,
  origin, dir, ownerVel)` already sims owner-class shells authoritatively
  and already broadcasts `projectileCreated` — bots ride it today. The
  human pilot is a re-route, not a new system.
- **What dies**: `shot`/`aoeShot` claims, claimLedger (both ends),
  deferrals, `validateAoeClaim`, projectileId plumbing, every reject-warn
  class, the shotId nonce pairing.
- **What stays predicted (WYSIWYG mandate)**: local shell spawn/arc/
  blast, blast knockback on everyone, self-splash, hitmarker+numbers.
  Only the *outcome declaration* (damage/kill/exclude math) moves to the
  server sim — feedback fires on predicted contact and reconciles.
- **Costs**: hit-confirm ≤ half-RTT (predicted feedback covers it);
  server CPU sims all live shells (bounded, soak-proven); predicted→server
  shell reconciliation keyed on the spawn echo.
- **Pilot**: one weapon class (BoltLauncher) server-simmed end-to-end —
  human `shotFired` → `RoomProjectiles.spawn` → outcomes broadcast;
  client keeps its predicted shell + feedback, drops the `shot`/`aoeShot`
  senders for that class only. Observable verdict: shot/AOE reject warns
  for that class reach zero; `shotRejected` can't exist for it.
- **Rollback cost**: low — claim path stays wired, gate per weapon class.
- **Ponytail/ultra pass (2026-10-07)**: pilot shrunk to three gates —
  (a) server `shot` handler: BoltLauncher → `room.projectiles.spawn`,
  skip validation; (b) client: BoltLauncher → skip sendShot/sendAOEShot,
  predicted shell unchanged; (c) ~15 lines stamping the
  `projectileCreated` id onto the nearest unmatched predicted shell.
  No flag config, no reconcile framework, no pairing ledger — the nonce
  existed to join two claims and there's only one shell now. Everything
  else in the claim layer stays loaded but dead-for-Bolt until the pilot
  proves out; then it's deletion, not migration.

### C4 — One replicated-lane implementation (unify the 5 hash channels)
- **Status**: SUBSUMED BY C5 (upheaval-max, 2026-10-07). Under effort-
  free ranking the "wait for the next bug" laziness argument flips: the
  kind-table is no longer speculative dedup, it's the canonical shape of
  the world model — every lane *must* declare itself once or it isn't a
  kind. C4's evidence (five live drift fixes in a week) stands as proof
  the hand-written-lane approach can't stay.
- **The duplication (measured)**: five near-identical implementations of
  "server edges → local replica map → lane hash → streak-hysteresis →
  per-id diff → warn". `shared/stateHash.ts` has 5 ~15-line hash bodies
  (~85% identical FNV-sum, differing only in field selection — correctly
  per kind). `client/core/stateDebug.ts` has five ~35-line
  compare-and-report blocks (lines 328–480, ~170 lines, differing only in
  local-map extraction + diff formatting). TickLoop repeats the five
  computations; protocol.ts carries 5 parallel `*Hash`/`*Fields` slots.
- **Why the class is live, not theoretical**: changelog 2.156 (deploy
  hash semantics fabricated client-side), 2.160/2.161 (deployGone/cull
  missed own plants — two separate lane copies), 2.163 (deployFields diff
  added to one lane at a time), 2.167 (ballFields added as the fifth
  copy). Every fix lands on ONE lane's copy of the pattern — the bugs
  re-bloom on the next lane.
- **The upheaval**: a lane *declaration*, not five bodies —
  `{ compute(map), extract(world), diffEntry(fields) }` per kind, one
  shared compare+streak+report loop, one wire slot shape (`replicaHashes:
  Record<kind, {hash, fields}>` instead of five named slots). Server side:
  one `emitReplicaLanes()` in TickLoop replacing five computations.
- **What dies**: ~200 duplicated lines across the four seams; the
  "add kind K" cost drops from touching 4 files/5 codepaths to one table row.
- **Costs**: per-kind diff formatters must survive as data (they're the
  semantic payload — e.g. creature `state` churn vs deploy `owner`);
  wire shape change needs a compat story or a protocol bump.
- **Pilot**: fold the two *most recently diverging* lanes (deploy + ball)
  onto a shared `checkLane` driver inside stateDebug only — proves the
  table shape without touching the wire, then expand.

### C2 — Full lockstep / GGPO input-only netcode
- **Status**: REJECTED — trades working authority-by-construction for a
  worse desync model (every desync becomes everyone's problem); the game
  already owns a stronger model on its busiest lane.

### C3 — Sim-in-a-WebWorker
- **Status**: REJECTED as upheaval — moves jank, doesn't remove a failure
  class; adds a serialization boundary on shared types.

## Open hunt areas (unscored leads)

- (Entity-kind unification was scored 2026-10-07 — it became C4, #2.)
- Room-as-replica: client runs a local `Room` for *everything*, not just
  predicted movement — server snapshot becomes a reconciliation source
  for the full world. Subsumes C1 but 5–10× the migration surface.
  PARTIALLY LANDED (2026-10-08): `client/src/game/replicas.ts` now owns
  the single roster-reconcile lifecycle every kind shares (live set →
  dead-evict → ensure → apply → reap) and the worldModel declarations
  exist to generate `kind.make()` — what remains is the replicas
  themselves consuming the declaration instead of hand-built classes.

### C5 — Navigation: route owns the runner, point-seek is escape-only
- **Status**: LANDED (pilot) 2026-10-13 — `runner`+`ctx.route` legs ride
  the flood carrot every think (pure pursuit); steerer beelines routed
  hops at any range. capRun 0 caps/480s → grab@108s, cap@~176s.
- **What dies when extended**: stale/orbitGd/orbitFails/traverseDir/
  passes (~100+ lines of orbit compensation in botLines.plan) shrink to
  "no-route fallback" only; seek-point becomes an escape hatch, not a
  navigation model. Next: `running` transits, then soak-verified retire.
- **Cost**: offline bots have no flood (`ctx.route` undefined) — they
  keep the old machinery; port a light flow field or accept it.
- **Ref**: `_docs/2026-10-13_BOT_NAV_ORBITS.md`
