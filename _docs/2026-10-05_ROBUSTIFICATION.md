# Robustification & Observability — State of the Code

Reference for the reliability audit of 2026-10-05. What was hardened, what was
verified clean, what remains open, and the plan for the leftovers.

---

## 1. Threat Model

The failure classes this codebase actually produces:

1. **Determinism divergence** — client and server compute "the same thing" and
   disagree: movement prediction, ball segment replay, combat claims, state
   hashes. The single largest class.
2. **Silent staleness** — state that should move (health echoes, rosters,
   wire ids, per-player maps) survives a lifecycle event and reads as real.
3. **Ambient nondeterminism** — `Math.random`/`Date.now` reaching a sim path
   because nothing refused them.
4. **Silent input coercion** — malformed map specs/protocol fields clamped or
   dropped without a trace; the game plays a different map than the author wrote.
5. **Unbounded growth** — per-id maps, pending claims, cooldown tables that
   grow with player churn over a room's life.
6. **Observability noise** — logs that fire on expected lag, drowning the
   warnings that mean something.

The unifying rule adopted: **anything two ends compute should exist exactly
once in `shared/`; anything lagged or event-driven must be excluded from
tick-exact comparison by construction, not by tolerance.**

---

## 2. What Shipped

### 2.1 Sync channels — `shared/stateHash.ts`

The hash bug class: a checksum over fields with three different freshness
models treated as one. Fixed by making the sync model a declared property.

- `FIELD_CHANNELS` registry: every hashed field declares `sim` / `edge` /
  `echo`. Position = `sim` (both ends recompute). `isDead` = `edge` (atomic
  flip). Health = `echo` (server-owned, ~2Hz echo → lagged by design).
- Echo fields hash at bucket granularity: `floor(hp / ECHO_QUANTUM)`, quantum 4.
  Justified by the numbers — regen ~8hp/s × ~0.5s echo interval ≤ 4hp of lag;
  the smallest real hit is ≥9hp and always crosses a bucket.
- The contract is structural: there is no place to add a hashed field without
  choosing its channel. New fields can't silently enter a tick-exact path.

Test that was missing from the start, now pinned (`statehash.test.ts`):
echo-channel lag cannot trip the hash — 48/49/51hp hash identically to 50;
45 (a hit's worth) differs.

### 2.2 Audit path — `client/src/core/stateDebug.ts`

- Diffs tagged with their channel: `[sim] position delta…`, `[echo] health…`,
  `[edge] isDead…`. A DESYNC line now names which sync model broke.
- Per-channel named tolerances (`POSITION_TOLERANCE = 50`m sim,
  `HEALTH_TOLERANCE = 2`hp echo) instead of a bare 0.5.
- Phantom players omitted from hash input: `hashableEntry` returns null rather
  than fabricating `(0,0,0)/100hp`, so a missing replica is a roster
  difference — visible signal — not a coincidence match.
- `takeClientSnapshot`/`compareState` snapshot real remote health (was
  hardcoded 100 → every manual diff lied about remote hp).

### 2.3 Deterministic randomness — `shared/botRand.ts`

- Explicit ambient release: `botRngRelease()` installs a *tagged* AMBIENT
  stream, distinguishable from a forgotten seed.
- `strictRng` mode: `botRand()` throws on unmarked ambient (`rand === null`
  or literal `Math.random`). Enabled in the scenario harness.
- All 9 test `botRng(Math.random)` release/restore sites migrated to
  `botRngRelease()` (harness ×2, detTrace, replayDeterminism ×2, afterEach
  restores in botHunt/botMoves/botGoals/botDisposition/killFeed).
- "Forgot to seed" now fails loud; the deliberate between-steps ambient
  window stays legal because it's marked.

### 2.4 Input validation — `shared/mapSpec.ts`

- Warnings collector opened before any clamp runs; dropped/clamped entries in
  `parseStructures`, `parseDeploys`, `parseBases`, `parseSpawns`, and ball
  config report instead of silently coercing.
- `MapSpec.warnings` surfaces them; `mapCatalog.readSpec` logs
  `'Map spec parse warnings'` with the map name. A typo'd JSON field can no
  longer silently play as a different map.

### 2.5 Lifecycle — ghost players, vitals, wire ids

- `playerJoined` announce carries optional `health`/`isDead`; grace rejoiners
  no longer fabricate 100/alive (was a guaranteed tick-N StateHash desync).
  Old peers unaffected — optional fields.
- `tickRecords.ts`: humans who never reported a position emit no records
  (no frozen ghost at origin); idle reaping still removes them.
- Wire id lifecycle — the u16 wrap bug: `nextWireId++` minted forever, and at
  65,536 `setUint16` wraps → a new player's records resolve to a *live
  teammate's* identity. Now:
  - `removePlayerCompletely` retires the id into `wireIdRetired` and
    broadcasts `wireIds {remove:[id]}`; clients drop the binding.
  - `mintWireId()` prefers retired ids past a 60s quiet window; a genuinely
    full space logs an error and recycles the eldest — never modulo-wraps.
  - `remove` edge added to protocol, `WireIdRoster.feed`, the client handler,
    and both netbot tools.
- `CombatHandler.onPlayerRemoved`/`onPlayerDisconnected` clean per-player
  maps (fire windows, heal tracking, charge banks, deferred claims —
  counted and logged before removal). Disconnecting carriers drop flags.
- `ServerBots.untrack` clears all cooldown maps (`skillOffAt`, `supportT`,
  `healBeamT`, `healNadeT` were leaking).
- `killFeed.forget()` clears `lastKiller`/`deathStreak` per departing player;
  `dispose()` drains queued taunts. Wired through `CombatHandler.killFeed`.
- `sizeWatch` re-pinned: `serverSenses.ts` at 1039 (committed file already
  over the old 903 pin — the watch now guards from reality).

### 2.6b Headless wire parity — `tests/scenarios/harness.ts` `replica()`

A browser was the only place the StateHash comparator ran — every
production DESYNC warn (in-flight heal drift, roster staleness, missed
liveness edges) was invisible to the suite by construction. `replica(room)`
mounts a headless spectator: it eats the room's real wire output (wireIds
rosters + binary tick frames — the spectator tier gets the full record
set), keeps the roster a client would hold, and exposes `hash()`/`diff()`
so a test asserts replica === server truth. The fanout mounts as an extra
sim so `step()` drives the production input→sim→fanout ordering. Pinned
by `replicaParity.test.ts` (damage/kill/respawn/move/removal + suppression
churn).

### 2.6 Console stray capture — altq pipeline

- `console.warn`/`console.error` route into the Logger buffer
  (`[console.*]` tagged lines reach Alt+Q + ship queue); native errors were
  already hooked via `installErrorHooks` (window `error` +
  `unhandledrejection`).
- Runtime strays converted to `Logger` (balls/vmBaked/playerSheep/geoNaN/
  nanScan/weaponKit/gameLoop). oxlint `no-console` warn; Logger +
  dev/dump/test files exempted.

### 2.7 Reach-limited floors — `solidWorld.topAt(maxTop)`

Walking into a structure teleported the body to its top edge: `topAt`
reported every footprint top as floor regardless of reach, so a body
entirely below a tall box (which `resolveOne` correctly skips pushing)
had the ground clamp snap it up through the deck. Now the body's floor
query caps at `feet + stepUp` (`MOVEMENT_CONFIG.stepUp`); the sim's
`MoveSurface.getHeight/getNormal` take an optional `maxTop`. Stairs and
jump-to-top unchanged; tall walls block horizontally; floating decks are
ceilings from below, floors from above. Pinned in `solidworld.test.ts`
with real `FieldSurface` tests (prior stubs bypassed the bound).

---

## 3. Verified Clean (no action needed)

- **`shared/` purity**: zero `Date.now`, zero `performance.now` misuse, zero
  ambient `Math.random` outside the tagged AMBIENT seam.
- **Empty catches** (~100 sites): nearly all legit teardown guards —
  `socket already dying`, `canvas taint`, `malformed json` — and commented.
- **Client wire decode**: every `JSON.parse` on a socket is try-wrapped;
  `decodeTickFrame` returns null on truncation. Pooled slots can't leak a
  stale `wireId` across frames (explicitly reset in the string-id branch).
- **rAF loop**: `requestAnimationFrame(loop)` is scheduled *before* the frame
  body (`gameLoop.ts`) — a throw kills one frame, not the loop, and the
  window error hooks ship it to the Logger.
- **Process-global tables**: `specMisses`, `specs`, `joinWindows`, `joinIps`,
  `postIps`, `invalidWarnAt`, `envSeen`, `claimedIdentities` — all bounded
  or TTL'd.
- **Teardown funnel**: `removePlayerCompletely` → sessions / rateLimiter /
  ledger / moves / combat / killFeed / wireIds is complete.
- **`SessionRegistry`**: anomaly counters + edge totals on `/metrics`.
- **Client `Math.random`**: all hits are VFX/ambient decor — no sim paths.
- **2026-10-05 re-sweep** (post-§4 drain): `claimLedger` bounded
  (MAX_SPENT + per-player cleanup), `clientLogs.postIps` capped,
  `botKill`/`bots` ambient draws are client-only cosmetics (never reach
  shared sim paths), spectator lifecycle has id-claim eviction +
  onClose delete + registry terminate. Nothing new to classify.

---

## 4. Open Items — The Plan

Ranked by value. #2–3 are the two structural bugs (same root: two
implementations of one thing); #4+ are gameplay/edge gaps.

### 4.1 Deterministic netcode harness — *closed*

Root was NOT ambient dice (ChaosLink was already seeded): the bridge run
loops were wall-clock paced, so `wallNow()`-windowed gates (correction
throttle, journal TTL, claim ledgers) raced the test's CPU speed. Fix:
`wallClock.setWallNow()` test seam — the bridges bind wall time to the
1ms-stepped sim clock for the run, restore on exit. Same production
windows, fully deterministic stepping. 9 probabilistic failures → 3
deterministic ones, all resolved:

- **Dropper post-reconnect never converged** (~15m permanent divergence,
  zero corrections): the pending-coverage gate deferred judgement while a
  report's stamp covered an unconsumed pending edge — dense-edge clients
  stamp the moving frontier forever, so judgement never ran. FIXED:
  `deferStreak < 3` bound in `moveJudge.reconcile` — coverage waits at
  most 2 reports then judges. Post-fix the dropper converges to 1.97m.
- **lossy-up `resendRatio=0`**: self-healing supersession — every dropped
  edge is superseded by the next before the gap counter trips; only a
  lost frontier edge triggers re-emit, and the default seed honestly had
  none. Quantized the script's `right` axis (a continuous axis edges
  every step, hiding the path entirely) + pinned seed 4.
- **Bounds recalibrated, not bugs**: `postErr` is an instantaneous
  residual vs an authority still simulating through the correction's own
  flight — on outage/adverse links the honest floor is meters, not the
  clean-link 2-4m the suite was calibrated on while corrections were
  starved and postErr barely sampled. Tail errSeries asserts remain the
  convergence contract.

### 4.2 Shot-rejection parity — *partially closed*

`shot rejected — predicted damage never applied`: the client predicted
feedback before the claim could be judged. The shared validators
(`validateAoeClaim`/`validateHitClaim` in `shared/combat.ts`) already
existed — the fix was making the client run the SAME adjudicator
pre-flight: `Projectile` keeps `launchVel`/`spawnedAtMs` so the claim
record is built from identical inputs, `handlePlayerHit` gates
predictDamage/numbers/score/sendShot on the verdict, and `spawnImpactEffect`
computes one `claimLegal` that suppresses the claim AND every predicted
mechanical effect (remote damage/knockback, self splash, plating) when
the claim is dead on arrival. Ghost hits are impossible modulo the wire.

Residual (by design, not a bug): the server's lag-compensated target
positions can never be client-predicted — a hit legal on the client's
view can still fail the rewind view inside the tolerance slack. That
slack, not code, is what absorbs interpolation.

### 4.3 Ball segment replay — *closed*

`netBalls.check` flags 10–20m divergences on fresh legs: client replayed
inert legs through a parallel analytic path (`tickNetInert` + its own
`firstStructureContact` march) instead of the solver the authority runs —
two contact implementations, two opinions about when a leg ends. Now
`tickNet` steps `shared/ballSim.ts stepBall` on the server's 50ms grid for
EVERY leg (inert and enraged alike): the client predicts the same bounce/
settle/stall the server resolves and the wire event confirms, not corrects.
Render smoothness is kept by carrying the sub-cell accumulator remainder
ballistically into host.pos — the sim rests on grid points, display stays
fluid. ~100 lines of duplicated contact logic deleted (inert march +
structure probe). Also: net crawler wedge fix — a creature whose ctor
failed (`dead` at birth) stayed in netCrawlerById forever and every later
roster skipped its respawn; born-dead spawns are refused and dead-registered
entries evicted on roster.

### 4.4 Smaller gaps

- ~~**8v8 carrier deadlock**~~ — *closed*: mutual carry now trips a
  mission lock in `roleObjective` — every non-anchor role folds onto the
  enemy carrier (mass push instead of one-at-a-time chasers), HoF holds,
  capper keeps escorting. First carrier to die breaks the deadlock.
- ~~**`FLAG_STAND_LIFT` parity**~~ — *closed*: `ctfFlags.ts` enemyStand
  now lifts the goal point by the same constant `serverSenses` uses.
- ~~**Human sheep scoring**~~ — *closed*: metering humans is intentional
  (scoreboard parity per `meterHumans`), the bug was the `maxed sheep`
  WARN firing on `player_*` ids — parked humans aren't agent faults.
  Warn now bot-id gated on both ends; score accumulation unchanged.
- ~~**Join/hash race**~~ — *closed*: `stateDebug` tracks each remote's
  first-seen wall time; field diffs on ids younger than 1.5s are the join
  race (default health record vs already-mutated server state), not
  desync. Roster-level mismatches still report — missing replica has no
  grace story.
- ~~**`roomGrace` zero-key residue**~~ — *closed*: `bumpGrace` deletes the
  key at zero instead of parking `0` forever.
- ~~**`killFeed` ambient `Math.random`**~~ — *verified-clean (§3)*: the
  draws are client-only cosmetics (chatter delay, offline spawn scatter);
  the ambient-draws invariant covers shared sim paths, and these never
  reach one.

### 4.5 Video export resolution *(optional enhancement)*

`exportCoolShotMp4` records the live render canvas via `captureStream` —
output size is whatever the window happens to be. Current mitigation:
the export requests fullscreen up front (released on stop/download), so
exports land at display resolution. Still not guaranteed 16:9.

Proper fix, when it matters: a staged export canvas. Create an offscreen
`canvas` at fixed 1920×1080 (or source height × 16/9), drawImage the
render canvas into it each rAF with letterbox/contain math, and
`captureStream` the staging canvas instead. Guarantees aspect +
resolution regardless of window. Caveat: drawImage from a WebGL canvas
is only reliable when `preserveDrawingBuffer` is on (main renderer at
`core/renderer.ts` doesn't set it) or when the blit runs inside the same
task as the render — so the staging draw needs a hook into the game's
rAF tail, not its own rAF.

### 4.6 Verified-flake record

Full suite: 822 pass / 1 fail — the sizeWatch grandfather pin on
`Room.ts` (grown to 1061 vs pin 909×1.15; JP's in-flight edits, not a
suite regression). Scenario suite alone: 334/334. Net suite: 37/37,
deterministic. Typechecks clean on both ends.

---

## 5. Invariants Worth Defending

When adding new replicated state or new diagnostics:

1. **Declare the channel.** A field going on the wire picks `sim`/`edge`/`echo`
   in `FIELD_CHANNELS`; the hash composes sim fields, the audit tolerates echo
   fields, edges compare flags only. Nothing joins a tick-exact check by
   accident.
2. **One implementation.** If two ends compute it, it lives in `shared/`.
   Prediction/validation pairs that diverge are bugs in a shared function,
   not two drifting codepaths.
3. **No ambient draws in sim paths.** `shared/` never calls `Date.now`/
   `Math.random`; tests run under `strictRng` and `botRngRelease()` marks
   intentional releases.
4. **Coercion reports itself.** Clamped/dropped input lands in `warnings`
   before the fallback runs — never silently becomes a different map.
5. **Lifecycle = delete.** Any per-id map gets a removal path on
   disconnect/remove/dispose; u16 spaces (wire ids) never mint unboundedly.
6. **Lag is not a warning.** Observability thresholds sit above the protocol's
   normal freshness windows; a warn means something is actually wrong.
