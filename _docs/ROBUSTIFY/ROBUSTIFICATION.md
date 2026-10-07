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
7. **Boundary-value drift** — a tolerance/bucket/quantization meant to
   absorb noise also absorbs real divergence (the 4hp health bucket hid a
   genuine echo loss; judge drift by persistence, not magnitude).
8. **Ordering / skip-tick** — authority spends a tick on bookkeeping the
   replay can't model (retarget: re-aim consumes the tick, no sim step,
   wire carried no marker). Any `continue`/early-return inside a step
   loop is a suspect; the wire must carry the post-skip anchor or a count.
9. **Architectural redundancy** — parallel implementations of one concern:
   same-shaped maps/caches in sibling modules, re-derived helpers a shared
   util already owns, layer crossings (UI in sim, server logic in wire
   decode), orphaned subsystems, copy-pasted validation that has drifted.
   Each duplicate is a latent divergence: when they differ, one is wrong.
   Hunt = enumerate every implementation of a picked concern, quote the
   bodies side by side, collapse into the single owner.

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

### 2.8 Observability tiers — `logger.ts`

Server base output is warn+error only (JP's ruling: faults, desync,
rubberbanding — nothing periodic). The periodic chatter moved from
`info` to `debug`: Status rosters, Bot mobility, Tick bandwidth, Room
health, Snapshot-requested hash dumps, Sheep-meter-high, Bot skill on,
Pickup banked, Creature killed, and the per-hit ledger line. Kills and
one-shot events (joins, caps, lifecycle) stay `info`; warns/errors
unchanged. Default level is `warn`; `LOG_LEVEL` overrides outright and
`FPS_VERBOSE=1` is the debug alias. The boot banner prints
unconditionally (a silent boot looks dead; once-per-process can't spam).
`soakreport.ts` runs `LOG_LEVEL=debug` so its log audit keeps the
telemetry lines it greps.

**Warn burst suppression** (2026-10-06): identical `warn` messages
inside a 5s window collapse to every 8th with a `×N` count — a hot
fault path (claim rejections, unconfirmed predictions under sustained
packet loss) emitted one line per event, a flood not a signal.
Distinct messages always land; alternating messages unaffected.
Pinned by `warnBurst.test.ts`.

### 2.9 Offline-chatter timer lifecycle — `botSay` drain (2026-10-06)

The offline bot's `botSay` ran on bare module-global `setTimeout`s —
`TeamBots.dispose()` removed the bodies but the 1.2–3s taunt timers
(plus VGS combo tails) kept firing into whatever feed was live next:
dead-roster taunts landing in the next match or after menu return.
Class-2 staleness, same shape the server's `killFeed.pending` +
`dispose()` already closed. Now mirrored client-side: `sayTimers`
tracks every queued line, `botSayDrain()` runs first inside
`TeamBots.dispose()`. Pinned by `client/src/__tests__/botSay.test.ts`
(head delivery, drain kills pending lines, drain kills the combo tail
independently, hidden-tab drop).

Same round, audited clean: `killFeed` combo tails already ride the
tracked `pending` set with a speaker-gone check; `liveVoice`/
`boundaryCache`/`pendingSelf` are speaker-bounded or capped;
`RateLimiter` mute state dies in `removePlayer`; the sheep-meter
`bleed` warns in the live log are per-bot 10-min-cooled real verdicts
(repeats traced to dev-watch restarts, not refire); `Position rejected`
387 m/s is a one-warn-per-streak real anomaly with correction sent.

### 2.10 Sheep-meter bleed mislabeled transit (2026-10-06)

A `matchSim` soak put half the roster at the sheep cap with `bleed`
200–600pts dominant — and the channel's own comment said "a body
sliding to a deadstop bleeds once". The gate only tested the drop, not
the landing: any E loss with no foe charged, so every uphill leg of a
legit ski route bled. Now requires landing near a deadstop
(`mech < 12.5` ≈ <5m/s): transit decel reads as routing, not sheeping.
Post-fix soak: FOX 480→89, VEKTOR 253→1.9; SABLE's residual 435 is
real repeated deadstops (a stuck bot — the channel now discriminates
stuck from skiing). Pinned: transit decel above 5m/s can't bleed;
deadstop still does (`botSheep.test.ts` 13 tests).

### 2.11 Per-tick flag-carrier allocation storm (2026-10-06)

The heal/plate/propel bot scans ran `[...flags.flags.values()].some()`
(or `.map().find()`) per *ally* per bot per tick — an array allocation
plus full flag-map walk for every candidate scored. All three sites now
use `Room.flagCarriedBy` (early-exit loop, zero allocs) or an equivalent
plain loop. Same answers, no per-tick GC churn on the bot-think path.

Soak residual finding (gameplay, not robustness): 3-min CTF sim, 12
bots, **0 flag grabs** — kills happen (21) but cappers never reach the
stand. Charged to §4.8 rather than silently absorbed.

### 2.59 evictEldest — one bounded-eviction owner (2026-10-07)

First class-9 (architectural redundancy) round. The "cap a map at N,
drop the oldest" concern was hand-rolled ~10 times and had drifted:
`joinIps`, `invalidWarnAt`, `lastKiller`, `deathStreak`, `specMisses`
still used wholesale `clear()` — the amnesty bug fixed piecemeal in
three earlier rounds (a flood past the cap resets the cooldown/window
for every live entry). New `evictEldest` helper owns the pattern; all
nine sites route through it (`claimLedger`'s tombstone-side-effect
evictions and `groundMemo`'s pure-memo clear stay local). Drift class
closed: a future cap can't re-introduce clear() without review seeing
the helper exists.

NOTE: `server_bun/src/moveJudge.ts` + `RoomMoveSim.ts` carry uncommitted
user WIP (gapAt/INPUT_GAP_DEFER_MS defer window, FieldSurface.fromField)
— the soakChaos tail-p95 failure this run (10.67m > 5m bound) matches
correction starvation from the defer window, not this change.

### 2.58 Arrival floor on the fire-window law (2026-10-07)

Shot-claim cadence trusted client stamps: one giant `timestamp` poisoned
`win.lastTs`, making every later stamped gap negative → lenient admit →
cadence law permanently dead for that weapon key (only the 40/s flood
bucket remained). Detecting the forgery via arrival-vs-stamp deltas is
impossible — honest batched delivery after a stall looks identical —
so the rolling-second arrival bound now counts EVERY claim, stamped or
not (stamps govern the pellet/violation law; arrivals are the only
stamp-proof evidence). Pinned: giant stamp + 15 rapid stamped claims →
the 16th rejects.

### 2.57 Finite-guard on env/heal claim handlers (2026-10-07)

Server-side NaN sweep: wire decode validates every claim field
(`validateVec3`/`validateBody`/`isFiniteNumber` throughout `wire.ts`,
fuzz-pinned in `wireFuzz`), and the claim handlers sign-clamp
(`Math.max(1, …)` — negative/zero can't invert a heal into damage or
vice versa). Residual hole: `handleEnvironmentDamage`/`handleHeal`
trusted decode — `Math.max(1, Math.round(NaN))` is `NaN`, so any
non-wire caller (or a future decode bypass) writes `NaN` health into
the tick broadcast. Both handlers now reject non-finite amounts as
`gone`; pinned in `envClaims.test.ts` (NaN envDamage, Infinity heal →
no health write, no hit). The handler is the trust boundary, not the
parser.

### 2.56 Finite-guard on ball + creature net edges (2026-10-07)

NaN-ingress lane, second half: the four decode funnels that feed the
replay sims — `netBallSpawn`, `netBallSegment`, `netCrawlSpawn`,
`netCrawlEvt` — accepted non-finite position/velocity/tp components. A
malformed edge poisons the ballistic/ballistic-adjacent sim the same
way §2.55's authority vectors do. All four now drop+warn. That closes
the local-sim NaN-ingress surface: every wire-decoded vector that
seeds or anchors sim state is finite-checked.

### 2.55 Finite-guard on authority state vectors (2026-10-07)

NaN-ingress lane: the two paths that write wire-decoded vectors straight
into the local sim — `onCorrection` (hard snap + journal rewind) and
`restoreLocalPlayer` (gameState reconnect reseat) — accepted non-finite
components silently. A malformed authority vector (server fault, hostile
p2p peer) would poison the movement controller with NaN — the failure
nanScan exists to hunt. Both now finite-check and drop+warn. Remote-
player visuals were left alone (interp is display-only; SnapshotBuffer
windowing limits spread).

### 2.54 Film chase-cam teleport reseats the pos-jump watch (2026-10-07)

Same class as §2.41 — a designed teleport logged as a physics snap.
The soak read surfaced `POS JUMP 286m → (160,200,160)` warns from
`?film=1` runs: `flagRun`'s chase-cam seat writes `player.pos` every
frame along the TAS dot without `noteLocalSnap()`. The recording aid
now reseats the watch after each seat. That was the last unwatched
local-player teleport site — the class is closed.

### 2.53 Sim tick quantum unified (2026-10-07)

Duplication lane: `0.05` (one sim quantum) was hardcoded in six places —
`BallSim.TICK_DT`, `CreatureSim.TICK_DT`, `creatureBrain.TICK_DT`, plus
client literals in `netCrawlers` (the `sk` skip deduction), `netBalls`
(segment replay + rubberband probe phase), and `netMelee` (netAcc
quantum). All now derive from `SIM_TICK_DT = SERVER_TICK_MS / 1000` in
`shared/wire.ts` — a tick-rate change can't split server sim from
client replay anymore (the exact class-8 drift the constant guards).

### 2.52 sk monotonicity pinned + class-8 sweep clean (2026-10-07)

Ordering/skip-tick lane: audited every `continue`/early-return inside
the sims' step loops. `creatureBrain.stepAll` — retarget is the ONLY
quantum-consuming path (windup/pounce/bite/fire edges emit after
`stepBody` ran; detonate kills so nothing accrues). `movement.ts` and
`ballCollide.ts` continues are symmetric broadphase guards, identical
computation on both ends.

Pin catch worth noting: the first draft asserted `sk` increments +1 per
observed retarget edge and *failed* — sk hit 4 before any edge was
seen. Not a code bug: with `sendTo` set, non-4th edges go only to near
players (FAR_SKIP), so watchers legitimately see sk jump by up to 4 per
broadcast. The shipped pin asserts the real contract — `sk` is
cumulative and non-decreasing per creature across FAR_SKIP gaps, which
is exactly what makes far-client replay deltas idempotent.

### 2.51 Tick-record quantization pinned (2026-10-07)

Boundary-value-drift lane probe: tick player records encode positions
on an i16 × `POS_Q`=0.04m grid (±1310m range). Traced the consume path —
`decodeTickFrame` → `applyTickPlayerUpdate` → `upsertRemotePlayer` →
remote interp only; self is excluded and nothing seeds sim state from
these records, so the ≤2cm error is safe *today*. Pinned anyway: a
vitest case asserts decode error ≤ POS_Q/2 at origin, off-grid, and
near-range coordinates — if any future path routes records into a
reconciling consumer, the contract breaks loudly in the suite, not
silently at 2cm/frame.

### 2.50 Sheep log dedupe (2026-10-07)

Soak read found `FPS_SHEEP_LOG` files repeating identical why-lines —
`newlyMaxed` is edge-triggered, but a bot hovering at meter=100 dips and
re-maxes within the same sim second, re-firing the warn. The 600s
cooldown uses `core.now` (sim ms), which a fast-forwarded soak burns
through, so the file fills with verbatim duplicates carrying zero
information. The append is now skipped when the emitted line is
identical to the bot's last (`lastMaxLine`, cleared in `clear()`).
Observed: `run/soak.log` tail had the same `idle=5.2 bleed=36` line 6+
times consecutively per bot.

### 2.49 ExplosionTracker prefix-trim (2026-10-07)

`cleanup()` expired entries with `shift()` per entry — O(n) per add
under a burst, same class the logBuffer TRIM_GRACE fix closed. Now
splice-trims the whole expired prefix at once (entries are append-ordered
by timestamp). Audited clean alongside: `remoteProjectiles`/`registry`
maps reap on explode + destroy echo + dead sweep, `flagMarkers`/
`flagStates` are 2-key bounded, `playerUal` maps are manifest-keyed,
`lastWeaponByPlayer` evicts on player-left.

### 2.48 SnapshotBuffer bound pinned (2026-10-07)

`snapshotBound.test` pins the interp queue's window contract: a 2000-push
stream at 20Hz leaves ≤32 snapshots (the 1s history floor + 2-snap
interp minimum), and the buffer never drops below 2. The remote hot path
audited clean alongside it — SnapshotBuffer is pooled + windowed,
indicators are value-guarded per key, remoteAnim scratch is pooled,
RemotePlayer interp allocates nothing per frame.

### 2.47 Ball retarget-skip contract pinned authority-side (2026-10-07)

Balls have the same retarget-skip structure as creatures — a due
retarget `continue`s `stepAll` without a `stepBall` step — but their fix
is architectural, not a counter: the retarget's own `bounce` segment IS
the wire anchor, carrying post-skip state, so replays never model a
missing quantum. `ballRetargetSkip.test` wraps
`broadcastBinaryReliable`, decodes every segment for 400 ticks (493
asserts incl. retarget bounces), and asserts segment position ===
post-step roster truth. If `stepAll` ever steps through a retarget or
emits a stale anchor, the pin fires.

### 2.46 Scoreboard rows throttle to ~4Hz (2026-10-07)

`updateScoreboard` rebuilt the whole roster — Set + filter + map + sort —
on EVERY rendered frame while the board was open (~60 rebuilds/s for a
display that can't be read past ~4Hz). Now throttled to 250ms with an
immediate pass on the open edge. Audited clean alongside: remotes frustum
scratch is pooled, shipQueue is capped (§2.45), Logger ring buffer is
bounded and pin-tested.

### 2.45 Ship-queue cap for never-flushed warn lines (2026-10-07)

`Logger.shipQueue` grew on every WARN+ push but only drains when
`initShipping` ran — offline-vs-bots sessions queued every warn forever.
Capped at 2000 (eldest dropped), same contract as the ring buffer.
Verified clean alongside: `applyNetEdge` staleness can't desync
(WebSocket ordering), species update loops allocate only at spawn not
per-tick, all `markTeleport` sites reseat the pos-jump watch.

### 2.44 Offline teleports reseat the pos-jump watch (2026-10-07)

Live soak caught `POS JUMP 286m` — a legit offline respawn
(`reviveLocal`) and the Flag Run first-spawn seat in `main.ts` teleported
`player.pos` without `noteLocalSnap()`, so the forensic watch logged a
designed teleport as a physics snap. Both paths now reseat the watch;
`net/players.ts` was already covered. Verified-clean alongside: shared/
has zero wall-clock reads outside `env.ts`, server `Math.random` is
injectable-default everywhere, pickups `rollCreatureDrop` callers all
pass room rng.

### 2.43 Cumulative skip counter closes the far-client residue (2026-10-07)

§2.39's fix skipped one quantum per retarget EDGE SEEN — but far clients
only receive every 4th edge (FAR_SKIP), so they still ran ahead 3
quanta per 4 retargets, unboundedly, on exactly the timers the state
hash compares. `crawlEvt` now carries `sk` — the cumulative retarget-skip
count since spawn — and the replay subtracts `0.05 × (sk − applied)`
per edge, converging fully on whatever edge arrives next (idempotent
under loss, reordering and FAR_SKIP; pre-`sk` servers get the old
per-edge fallback). `appliedSkips`/`skipCount` both reaped on death.
Full-suite verification alongside: **379/379 scenario tests green** —
the long-standing moveJudge WIP failure is resolved.

### 2.42 Retarget-skip contract pinned authority-side (2026-10-07)

`retargetSkip.test` pins the invariant §2.39's client fix mirrors: on
the tick a `retarget` edge fires, the creature's post-tick roster
position still equals the edge's snapshot — the brain spent the tick
re-aiming, not stepping. If `stepAll` ever steps through a retarget
again, both the pin and every client's replay pacing break loudly.
Audit lane around it (silent-coercion angle): `JSON.parse` on all five
client inbound paths is catch-wrapped, `maxPayloadLength` is set on the
ws server, wireIds roster resets are lifecycle, pickups reconcile via
roster cull.

### 2.41 Untrack funnel coverage widened (2026-10-07)

`botUntrack.test` peeked at only 5 of the 18 maps `untrack()` drains —
`gearLobT`, `suppressT`, `quiet`, `skillOffAt`, `supportT`, `healBeamT`,
`healNadeT`, `deadSet`, and the five `sense.*` maps (noticed/routeHold/
routeFailed/routePrefs/waitSpot) had no coverage; a regression in any of
them re-leaks per-bot state silently. The pin now asserts all 17 maps +
the deadSet. Full audit around it: `senses.forget()` is wired
(ServerBots:170), `dmgPool`/`ffaScores` delete on seat loss, pickups
reconcile via roster, `RateLimiter`/`ConnectionManager` delete per
player, `/client-log` is 512KB+throttled, shared RNG is strictRng-fenced.

### 2.40 Warn/error side-logs skipped mid-run rotation (2026-10-07)

`client.log` got mid-run rolling in §2.24 but its fan-out siblings didn't
— `client_warning.log`/`client_error.log` appended unguarded on the same
throttled path. On a warn-heavy client they grow exactly as fast as the
main log. Both now roll past 32MB on the same `rotateLogIfBig` guard.
(`server.log` stays boot-rotate-only — `logger.ts` is browser-embedded
and can't import `node:fs`; §2.24's caveat stands.)

### 2.39 Retarget-skip tick: replay ran ahead of authority (2026-10-07)

Found while chasing the §2.38 wild desync: `creatureBrain.stepAll`
spends a creature's whole tick on a due retarget — the creature takes NO
sim step that tick. The client replay had no model of the skip, so it
accrued one extra 50ms quantum per retarget edge — its sims ran
permanently ahead of authority on exactly the timers the state hash
compares. A `retarget` edge now stands in for the skipped step
(`netAcc -= 0.05`). Far clients (every-4th-edge FAR_SKIP) still
under-correct; resync edges bound the residue — the §2.38 field diff
will say whether this was THE diverger.

### 2.38 Creature-hash field attribution (2026-10-07)

The §4.7 creature hash CAUGHT a live desync in the 2026-10-07 soak —
`CREATURE DESYNC tick=433 … persistent across 12 checks` on all 6 ids —
but the warn could only list ids, not which lifecycle field diverged
(state? targetId? stranded?). `stateHash` now carries `creatureFields`
(the per-id `[id, species, state, uber, targetId]` the server hashed,
~30B/creature); on a miss the client diffs them and the warn names the
diverging fields (e.g. `diff=#3:state wander/chase #5:stranded`). The
next soak answers instead of asking. Root-cause candidates queued:
retarget-skip ticks the client can't model, far-client FAR_SKIP edge
drops, or a hash-input skew.

### 2.37 Bot-chatter cooldown churn amnesty (2026-10-07)

`lastSpoke` (per-bot speak cooldown) and `lastKillOn` (per victim-pair
repeat-kill mute) capped at >256 with wholesale `clear()` — one boundary
crossing under bot churn reset every bot's cooldown at once, a
mass-chatter burst exactly when a crowd of fresh bots was speaking most.
Both now eldest-evict. `losMemo`'s clear() is a pure LOS cache (recompute
only — benign by design); `wire.ts`'s id reset is lifecycle, not a cap.

### 2.36 envSeen first-claim dedupe amnesty (2026-10-07)

`envClaims.envSeen` (the first-env-claim-per-player warn dedupe) capped
at >512 with a wholesale `clear()` — under id churn, one crossing could
re-fire the "first claim" warn for every live player. Eldest-evict like
§2.35; consequence was mild (a repeated marker line) but the class is
the class. `moveClaims.lastTeleport`/`lastTeleportWarn` (both evict on
removal) and `roomEvents.subs` (unsub closure) audited clean.

### 2.35 Switch-cooldown churn amnesty (2026-10-07)

`RoomSwitcher.cooldowns` capped at >1024 with a wholesale `clear()` —
under player-id churn, one boundary crossing reset the switch cooldown
for every live hopper at once (the `postIps`/`invalidWarnAt` class).
Now evicts the eldest entry; the per-hopper window survives. The entry
still deliberately outlives the player — the cooldown must survive the
hop it is guarding.

### 2.34 Empty-room guard pinned (2026-10-07)

`roomEmpty.test` pins the guard that drives TickLoop teardown: a
bots-only room is empty (bots exist to serve humans — they'd otherwise
tick forever), but a spectator keeps it alive (disposing under a watcher
would strand the replica feed). The rooms lifecycle audit that prompted
it verified every map cleans up: empty named rooms dispose+delete,
`tickErrStreak`/`tickQuarantined`/`playerRoom`/`specRooms`/`spectators`
all evict on their teardown paths.

### 2.33 Claim-sweep warns flooded under sustained ack loss (2026-10-07)

`claimLedger.sweep()` warned per expired pending claim — with acks dead,
every waiting entry expired with its own interpolated line (hundreds/s
of console warns). The census keeps per-kind counts; the log now emits
one aggregated line per sweep pass with the kind histogram + oldest age.

### 2.32 `.jsonl` ledgers rolled at 32MB mid-run (2026-10-07)

The `client.log` mid-run roll (§2.26) generalized: `rotateLogIfBig()`
lives in `logRotate.ts` (import.meta/dir-free — clientLogs is not safe
to import outside the server graph; pulling it into matchJournal broke
the client typecheck) and now guards `matches.jsonl` and
`weaponstats.jsonl` appends — both only rotated at boot before, growing
for the server's life. `logger.ts` (server.log) is the deliberate
exception: it is browser-embedded and cannot import node:fs at top
level; it keeps boot rotation. The suite run also caught a real test
trap — `weaponStats` is a shared singleton, so bounds tests on it are
order-dependent; the class is now exported and the test is hermetic.

### 2.31 Stats-table folding pinned (2026-10-07)

`weaponStatsBounds.test` pins the three bounds on the client-shaped
stats tables: >64 source keys fold into `other`, >512 death cells into
`far`, >64 mode names refuse. The audit that prompted it found the
folding already implemented — the gap was coverage.

### 2.30 `lastRepair` keys outlived departed players (2026-10-07)

Repair-cooldown keys are `playerId:itemId` — they were cleaned when the
*item* died, but a departing player left entries behind, and on immortal
base gear those entries lived for the room's life. `clearOwner` (which
already runs on the removePlayerCompletely funnel) now also purges the
owner's repair keys — same churn-keyed-map class as `invalidWarnAt`
(§2.24) and `postIps` (§2.27).

### 2.29 AOE claim airtime bounds pinned (2026-10-06)

`aoeClaimBounds.test` pins `validateAoeClaim`'s legality window: negative
airtime, airtime beyond wall-clock age + slack, and a blast beyond
ballistic reach all reject; an honest in-window claim passes. The
numeric-claim sweep that prompted it found power already clamped
(0.2–1.8) and airtime bounded — the gap was coverage, not code.

### 2.28 `projectileId` accepted unbounded strings (2026-10-06)

`optShotId` caps its nonce at 40 chars but `projectileId` — a
ledger/record map key — took any string the 1MB frame could carry:
512 capped ledger entries × ~1MB keys is ~half a GB of attacker-shaped
key memory. `optProjId` (≤64) now validates it at all three sites
(shot, aoeShot, projectileDestroy); oversized rejects outright.

### 2.27 `postIps` wholesale clear reset every live throttle (2026-10-06)

Same class as `invalidWarnAt` (§2.24): when `postIps` exceeded 1024
entries the map did `clear()`, resetting the 60s window for every live
IP — under address churn that is a throttle amnesty. Now evicts the
eldest entry instead. `clientLogThrottle.test` pins the invariant: churn
must not amnesty a live throttled IP.

### 2.26 `client.log` grew forever within a server run (2026-10-06)

`rotateLogs()` only ran at boot — a long-lived server accumulated one
unbounded `client.log` (512KB posts × IP-throttled rate still adds up
over days). The append path now rolls the file when it passes 32MB;
posts stay IP-throttled so the statSync per post is cheap.

### 2.25 Unlimited datachannels per RTC peer (2026-10-06)

The offer cap (64 peers) bounded connections but not channels — one
accepted RTC peer could mint unlimited `adapterOf` entries + adapter
attachments by spamming datachannels. Legit flow opens exactly two
(game + ctrl); `pc.onDataChannel` now refuses channels past 4 (closed,
not attached).

### 2.24 Forged-ownership destroy warns were unthrottled (2026-10-06)

`projectileDestroy rejected` logged per claim — a forged-destroy spammer
could emit up to the 40/s flood limit of unique warns. The per-player+kind
2s coalescing throttle was extracted from `reject()` into `rejectWarn()`
and this path routed through it (`${playerId}:destroy`). No behavior
change for legit traffic — one warn per 2s per offender, with the
suppressed count attached.

### 2.23 Per-reject position warns flooded the log (2026-10-06)

`Position rejected` warned on EVERY rejected report — position claims
run ~20-30Hz, so a diverging player emitted ~20 warns/s until the
force-accept, each with unique interpolated text (defeating the
burst-collapse). The warn now fires on streak-start only, alongside the
correction it narrates; per-reject signal stays in the hb counters.
Force-accept still warns (it's the streak's own headline).

### 2.22 CoolShots panel repainted behind a closed overlay (2026-10-06)

The 1s "time ago" interval rebuilt ~20 DOM nodes whenever shots existed —
including while the overlay sat at `display:none`, a 1Hz layout pass
nobody sees. Now skips when the overlay is hidden or the tab is
backgrounded.

### 2.21 Stall watchdog interval idled forever after disconnect (2026-10-06)

`NetworkManager.stallTimer` armed once per page (`??=` in `connect()`) and
was never cleared — after a deliberate `disconnect()` the 1Hz watchdog
fired forever on an intentionally-offline socket. Harmless load-wise
(checkStall early-returns) but the whole teardown class it belongs to
says timers die with their owner. `disconnect()` now clears it;
`connect()` re-arms on the next session.

### 2.20 `invalidWarnAt` throttle entries outlived their socket (2026-10-06)

The malformed-frame throttle minted a `playerId` key on first garbage
and never cleaned it — `onClose` had no eviction. Entries lingered until
the map's 4096 wholesale `clear()`, which also resets the gap for live
spammers (mute reset as a side effect of garbage churn). `onClose` now
deletes the entry on every teardown path. Pinned: `invalidWarn.test`
asserts the key exists after a seated garbage frame and is gone after
`onClose`.

### 2.19 Unknown `weaponType` skipped every per-weapon gate (2026-10-06)

Wire validation checked only `isFiniteNumber` on `weaponType`. An
out-of-table index (`weaponType: 9999`) sailed through validation, then
`WEAPON_FIRE_INTERVAL_S[9999]` was undefined → **cadence law skipped**,
`BELT_THROW_WEAPONS.has(9999)` false → **belt cost skipped**, and
`getWeaponStats` silently defaulted to BoltLauncher stats — a fire-rate
and cost bypass dressed as a legal claim. `optWeaponType` now requires
any supplied id to be an integer present in `WEAPONS` (which covers all
35 enum values — verified); unknown ids fail validation at the boundary.

### 2.18 `speedBin` unbounded keyspace (2026-10-06)

`weaponStats` kill-speed bins minted one key per 5 m/s with no ceiling —
every other table in the file folds overflow ('other', 'far', 512-cell,
MAX_MODES/MAX_SOURCES) but `r.shooter`/`r.victim` accepted arbitrary
magnitude keys forever. Now folds to `'150+'` past the legit envelope
(jet cap + dive conversion top out near ~150); pinned by
`speedBin.test.ts`. The `'prejoin'` shared throttle (malformed frames
from many unseated sockets collapse to one warn) pinned by
`invalidWarn.test.ts`.

### 2.17 Orphaned grace timer on session re-begin (2026-10-06)

`SessionRegistry.begin` replaced a live session record without clearing
its armed `graceTimer` — the roomGrace count was swept but the countdown
wasn't. A player who disconnected (grace armed) then re-joined another
room inside the window got a fresh seat while the dead session's timer
still fired `removePlayerCompletely` on their playerId — a zombie reap
of a just-seated player. `begin` now `clearGrace`s the prior record;
pinned by `sessionRebegin.test.ts` (expiry never fires post-rebegin,
fires exactly once otherwise).

### 2.16 Error-level bursts unthrottled (2026-10-06)

`logger.error` had no burst collapse — `warn` suppressed identical
repeats (every-8th with a count inside 5s) but a hot error path (a
per-tick send failure, a flapping lane) wrote every line to console +
disk unthrottled. The collapse is now shared: `error` dedupes on the
same rule as `warn`, distinct messages still always land. Same-lane
sweep: `playerRoom`/`specRooms`/registry teardown verified complete in
`onClose` + `removePlayerCompletely`; wire input coercion verified
(`jet`→bool, `status` masked bits only, `inputDirection` normalizes so
oversized forward/right can't over-thrust); every position field on the
wire passes `validateVec3`.

### 2.17 structKit hull parity pin — caught real drift on first run (2026-10-06)

The new `kind:'kit'` collision channel is architecturally right — pure
data in `shared/`, both ends consume the same table — but the comment
itself admitted the risk: "a builder tweak that forgets KIT_HULLS is
the only drift risk left." Builders emit `userData.hulls` sidecars, so
a client vitest (`kitHulls.test.ts`) now diffs authored hulls vs the
server table through the REAL `KIT_BUILDERS` map. First run caught
actual drift (class 1 — server collided where the visual doesn't):

* wallrun + wallgate + bunker walls: table centered at y=2.3 spanning
  0–4.6; authored hull centers at 2.1 spanning −0.2–4.4 → the server
  ran ~0.4m of phantom collision above every wall top.
* flagtower walls/stubs: 2.4→2.2 centers and 4.6→4.8 heights.
* arch feet: table guessed ENDPOST slabs; authored are leaning
  2.6×7.4 slabs at y=3.7 — a different shape entirely.
* shard footprint: 4.1 vs authored 4.08.
* `endPost` emitted NO sidecar — compound pieces had post meshes with
  zero authored hull (the table's ENDPOST guesses were unverifiable
  until now). Given the sidecar; the table entries proved correct.

Also this round — two stale-contract fixes on user WIP:

* `optProjIdOpt` (the new oversized-id gate) rejected `projectileId:
  null`, a documented legal claim value ("most recent spawn of that
  weapon") — silently malformed every null-id hit claim. Null now
  passes; pinned by `p2pHost` shot-claim test.
* `deployRules` fixture used pre-rename team id `'a'` → `'alpha'`;
  `demoPlaybackAudit`'s flat terrain stub lacked `terrain.heightU`
  (new swarm blob-shadow uniforms) — stubbed with a 1×1 black map.
* `botBrain` no-progress test asserted a blind perpendicular sidestep —
  `pickDetour` has been a route-cost heading fan since 654dc716, so on
  flat ground goal-forward is the correct detour. Test now blocks the
  goal line so the fan deflects sideways.

Verified: client vitest 476/476 (was 18 failures), scenario suite
373/373, both `tsc` clean.

### 2.16 Live networked bot match — judge input-gap race (2026-10-06)

First full wire-level soak: real GameServer on :8001 + 16 netBots
(RTC data channels) on a katabatic CTF match, ~4 min, room-hopping
across 5 maps (81 joins, ~900k messages received). Client-side
telemetry clean end to end: 0 corrections, 0 below-ground, 0 ball/
crawl warps, 0 errors/closes, tick gaps 0 with max ~105ms, ping
p50 ~35ms. Three findings:

* **Judge input-gap race (fixed).** `Movement cheat detected` burst —
  7 warns inside one batch right after the join wave, dist 60–95m.
  Cause: reports stamp `inputSeq` past every received input while the
  first inputMove is still in flight (netbots heartbeat inputs at
  400ms; 30Hz reports burn gapStreak 3 in ~100ms). Judging raw against
  an input-starved shadow banks teleport-scale severe strikes on pure
  queue latency — the cheat latch fired on honest joiners. Fix:
  `Shadow.gapAt` stamps the streak start; uncovered reports defer for
  INPUT_GAP_DEFER_MS (600 = slowest legal input lane + RTT) and only a
  SUSTAINED gap resumes raw judging — a forger can't hold the frontier
  past the window, and the window bounds correction starvation.
  Re-soak: join-wave warns dropped from 7/burst to 3 sporadic over 80s;
  the residual correlates with sustained-gap episodes under RTC load
  (logged in §4.4 — same class, deeper tolerance question). Pins:
  `in-flight input gap defers judging` test; the stale-epoch and
  authority-correction scenarios updated to express the defer window.
* **Reject-warn flood (verified already fixed).** ~200 `Shot rejected`/
  `AOE rejected` warns per 4 min — stress bots fire at arbitrary
  500–1000m targets, every verdict warned. §2.12's `rejectWarn`
  coalescing + disconnect cleanup covers it; the re-soak shows
  `(+N suppressed)` annotations working live. `implausible spawn`
  rejects ride the same throttle.
* **WT port collision (fixed).** Second instance on `FPS_PORT=8001`
  hit `webtransport-native E_INTERNAL AddrInUse` — the WT endpoint
  defaulted to a fixed 9443 regardless of FPS_PORT. Default is now
  `FPS_PORT + 1443` (8000 → 9443 unchanged for the canonical config);
  `FPS_WT_PORT` still overrides.

### 2.15 `recentKills` double-record (2026-10-06)

`hitLedger.recordKill` pushed the shooter into `recentKills` twice per
self-frag (once inside the self-branch, once unconditionally). Harmless
to the `some()` trade check but halved the 256-entry window's effective
coverage. Collapsed to a single trade-check + push; the dual-direction
batch semantics are unchanged.

### 2.14 Self-kill debug probes unbounded (2026-10-06)

`selfKillImpactDist/Pos/Prey/FoeDist` are module-global arrays pushed
once per self-frag with no trim — a long-lived room grows them
linearly forever (they're soaked-postmortem probes, not live state).
Now tail-capped at 256 through `probePush`, same shape as
`recentKills`. Full-server churn/bounds sweep this round verified
clean: every player/bot-keyed map is purged on `untrack` /
`onPlayerDisconnected` / `removePlayerCompletely`, or hard-capped
(`seqStates` 32, `cooldowns`/`invalidWarnAt` 4k, `duelStart` 512 +
age prune, `spent` swept). Cap pinned by `probeCap.test.ts` — 300
self-frags leave the arrays at exactly 256.

Second sweep (entity ids + memos + caches) also clean: `retargetAcc`/
`resyncAcc`/`edgeSeq`/`confuseGhosts` all drop on despawn,
`losMemo` TTL-sweeps + hard-caps, `serverParties` is a per-tick
rebuild, `getAllPlayers()` returns the live map (no per-tick clone),
wire validators reject out-of-range rather than silently clamping.

### 2.13 Malformed-frame warns bypassed the throttle (2026-10-06)

`invalidWarnAt` only gated schema-invalid messages — unparseable JSON
and unknown binary frames each warned per frame, so a malformed-flood
client skipped the bound that exists specifically for garbage floods.
Both paths now route through a shared `invalidWarn` (same 5s-per-sender
gap + 4096 cap); pre-join floods key on `'prejoin'` instead of
`undefined`. Churn-map sweep this round verified clean end to end:
`seqStates` bounded at 32, `cooldowns`/`invalidWarnAt` capped, every
bot subsystem's maps covered by `untrack`.

### 2.12 `lastRejectWarn` hopper entries (2026-10-06)

The reject warn-throttle map was never cleaned — `onPlayerDisconnected`
purges `lastDropNotify` keys for the player but skipped
`lastRejectWarn`, an identical key shape. Each leaver who had ever
been rejected left a permanent entry; over a long-lived room the map
grew with cumulative player churn, not live roster. Now cleaned with
the same prefix sweep. Both throttles pinned by
`rejectWarnCleanup.test.ts`; the deferred-claim disconnect drop pinned
by `deferredClaim.test.ts`; the `untrack` funnel (every bot-keyed map
empties on retire) pinned by `botUntrack.test.ts`; the module-global
LOS memo bound (expiry sweep, then hard clear, worst live size cap+1)
pinned by `losMemo.test.ts` via a `losMemoSize()` test seam.

---

## 3. Verified Clean (no action needed)

> **Scope of this list — read before trusting it.** "Clean" means
> *classified against the six threat classes* by pattern-level audit
> (map/cap/evict shapes, ambient-draw greps, funnel traces). It does NOT
> mean bug-free:
>
> 1. **Method limit** — sweeps match structural failure shapes; they do
>    not re-derive every file's logic. A wrong-but-consistent
>    implementation passes this lens.
> 2. **JP's WIP is out of scope** — ~125 dirty client files plus
>    `shared/mapSpec.ts` and `server_bun/src/Room.ts` are excluded by
>    rule (no commit of files I didn't touch). Live-but-uncommitted
>    hunks (`killFeed.forget`, the Room.ts VGS hookup) are outside every
>    commit and every green-suite claim.
> 3. **Limited measurement** — a 10-min 8v8 heap probe (RSS + every
>    reachable Map/Set size per sim-minute) showed plateau, not climb:
>    rssMB 90→~270 settles, all per-id series fill to roster size then
>    flat (`duelStart` fluctuates with the pair window, `groundMemo`
>    stays under its 32k cap). Still not continuous profiling — a leak
>    with an unusual shape could hide elsewhere.
> 4. **Coverage gaps** — the suite proves what's asserted; untested
>    paths are unverified, not clean. Narrowed 2026-10-05: the only two
>    modules with real guarantees and zero direct coverage — influenceMap
>    (splat ring, decay, queries, resize) and matchJournal (ring bound,
>    leaderboard rows) — now carry scenario tests. Remaining untested
>    files are thin wrappers or covered indirectly via room scenarios.
> 5. **Known leftovers** — sizeWatch `Room.ts` pin (JP's WIP), lobber
>    trio numbers (JP ruling), the gradual-deslop oxlint warn backlog.
>
> Honest weakest links beyond this list: test coverage gaps and
> unmeasured runtime growth — not the six classes themselves.

- **`shared/` purity**: zero `Date.now`, zero `performance.now` misuse, zero
  ambient `Math.random` outside the tagged AMBIENT seam.
- **Empty catches** (~100 sites): nearly all legit teardown guards —
  `socket already dying`, `canvas taint`, `malformed json` — and commented.
- **Client wire decode**: every `JSON.parse` on a socket is try-wrapped;
  `decodeTickFrame` returns null on truncation. Pooled slots can't leak a
  stale `wireId` across frames (explicitly reset in the string-id branch).
  Coverage thickened 2026-10-05 after Stryker showed the codec executed
  but barely asserted (~0.2% score): flag-bit isolation, v3 wireId roster,
  multi-record offset drift, truncation bounds, NaN/absurd rejection —
  `wire.test.ts` now kills the survived-mutant classes.
- **Client ambient draws**: ~50 Math.random sites are all cosmetic —
  spread cones, splat radii, gib scatter, ambient critter spawn. None
  feed a field the server computes: replay sims live in shared/ (RNG
  free), predicted projectiles are visual-only. Client bots are
  offline-mode, so their draws need no wire integrity. Re-audited
  2026-10-06: the Ball constructor's variant-0 color pick was the one
  ambient draw inside a replicated entity's construction path — it ran
  even for `netSpawn` balls before the wire `colorIdx` overwrote it.
  Now the pick only runs for offline spawns; net-driven balls take the
  wire colorIdx directly and the redundant post-spawn override is gone.
- **Wire-boundary coercion**: every client message passes
  validateMessage (per-type finite-number/vec3 validators) →
  reject+metric+throttled-warn before dispatch; NaN/malformed input
  can't reach position/damage consumers. `?? -1` sentinels downstream
  read already-validated fields.
- **Clock drift**: server TickLoop feeds MEASURED elapsed dt (the 18%
  setInterval drift fix); client estSimNow = last wire stamp +
  EMA-corrected wall clock, lead age banked not stepped so replay stays
  on the 0.05 grid; isStaleSeg guarantees anchors only move forward.
- **Map/Set order determinism**: the replayed sims (ballSim, movement,
  creatureCore) hold no insertion-ordered collections at all. Bounded
  caches (losMemo 4096+TTL, taunt maps 256) are keyed lookups — order
  can't reach sim output. botSheep deletes per-id on lifecycle.
- **Iteration/splice hygiene**: every entity-list splice runs inside a
  backwards `for (i--)` loop (balls, nuggets, beams, playback lists, fx
  budget tails); one-off removals use indexOf. Id-keyed mirrors
  (netBallById, playbackBallById) delete with the splice, and
  netBallRoster reconciles orphans against the server roster.
- **Empty-catch surface**: ~40 bare/commented `catch` bodies across all
  three trees are teardown guards — dead sockets, gone RTC peers,
  detached audio nodes, log-shipping, quota/private-mode storage. None
  hide a fault that should surface; all keep their WHY comment.
- **localStorage/JSON surface**: settings reads go through the typed
  schema (no JSON.parse); lastRoom is try-wrapped both ways; gunlab
  falls back to `__gunlab`; every socket parse is guarded. recPlayer's
  bare parse is a dev tool — fail-loud on a malformed .rec is correct.
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
- **Floating promises** (~40 `.then` sites, both ends): every chain either
  catches internally (`loadField` → null, `loadNd` → null+flag,
  `loadIndex`/`reconcileIndex`/`saveIndex` try-wrap) or ends in a real
  `.catch`. One genuine gap fixed — `DemoStorage.ensureDir` floated a
  bare `mkdir` (unhandled rejection, no reason logged); it now reports
  like its siblings.
- **Type-safety suppressions**: zero `as any`/`@ts-ignore` in shared/ +
  server src; the six `!` non-null sites all assert same-expression or
  just-inserted keys (`botGraph.fields.get` can't evict its own fresh
  goal — inserts land at the map tail, evict removes the head).
- **2026-10-05 re-sweep** (post-§4 drain): `claimLedger` bounded
  (MAX_SPENT + per-player cleanup), `clientLogs.postIps` capped,
  `botKill`/`bots` ambient draws are client-only cosmetics (never reach
  shared sim paths), spectator lifecycle has id-claim eviction +
  onClose delete + registry terminate. Nothing new to classify.
- **Per-id lifecycle maps**: `aliveSince` was the one offender (fixed —
  pruned vs roster). `ServerBots.untrack` already funnels brains/
  loadouts/thinkPhase/roster/sheep/arsenal/foeNear/gearLobT/suppressT/
  deadSet/quiet/skillOffAt/supportT/healBeamT/healNadeT/watchdog/
  `sense.forget` (noticed, routeHold, routeFailed, routePrefs,
  waitSpot) + `moveSim.untrack`. Client `lastTintOf` evicts via the
  `onRemove` hook; `sharedGroundYCache` is a terrain memo bounded by
  visited cells.
- **Wire encode coercions** (`shared/wire.ts`): sheep uint8 clamp,
  status mask, segKind fallback — encoder-side saturation, values
  can't exceed field width; not silent input-hiding.
- **Chat/VGS reaction path**: player chat → `chat` event →
  `chatKindFor` (16-way spectrum) + `vgsCommandFor` (command chords)
  + `nameIn` → `bots.notice` → squad reply via `chatter()`
  cooldown — same channel as botSpoke replies. netBalls maps clean:
  `netBallById` reconciles on roster; `rbLastWarn`/`rbSuppressed`
  bounded by warn frequency.
- **Hidden-tab chatter path** (2026-10-06): `botSay` was the one queue
  that deferred transient work past a hidden window — its 1.2–3s delay
  timers (plus combo tails and their TTS) fired and piled into the feed
  on return. Now drops when `document.hidden`, matching the fx
  constructor gates (debris/splat/scorch). `pendingSelf` already
  64-capped; feed rows bounded by MAX_LINES; wire-delivered lines are
  immediate (no queue) so no counterpart bug online.
- **Dead-id accumulators** (2026-10-05): `BallSim.retargetAcc`/
  `resyncAcc` and `CreatureSim.edgeSeq` seed per entity but `kill()`
  only dropped the body — both fixed. `CombatHandler` evicts all five
  per-player maps in its teardown; `lastWeaponByPlayer` evicts via the
  client `onRemove` hook.
- **Client decode**: `decodeTickFrame` bounds-checks every read and
  drops malformed frames whole; `?? []`-style defaults are empty-roster
  handling. `remoteProjectiles`/`projectileRegistry` evict on destroy.
- **Warn-level noise**: `net/players.ts` warns are real-anomaly
  detectors (hit-on-corpse moves kill credit; `yourHealth` can only
  rise through the heal channel — a drop is a real wrong-door write).
- **Growth caps**: `world.explosions` force-kills past
  `MAX_LIVE_EXPLOSIONS`; all dead lists reap dispose+splice per frame.
- **Client bot maps** (`thinkAccum`/`ctxCache`/etc): session-owned —
  bots only rename or dispose wholesale, no dead-id accumulation.
- **ConnectionManager**: journal capped at 1024 frames with
  `journalDropped`/`reclaimGap` counters (eviction reports itself);
  volatile cue types TTL'd at 3s so stale effects don't replay on
  reclaim; tick backlog gated at 256KB; drowned sockets closed after a
  5s hysteresis and counted via `onDrowned`; `unregister` evicts.
- **Claim surface** (move/env/shot/heal): every clamp reports itself —
  drops heartbeat distinct reasons, only true rejects count; out-of-
  order claims defer rather than eat; `clampPing` is a documented
  anti-forge bound; `seq ?? 0` only fills the correction echo's
  match-tag.
- **Determinism**: one `MoveSim` in shared/ — `moveJudge` shadows and
  client prediction both wrap it; same for ball sim (§4.3) and wire
  decode. `moveClaims`/`combatCharge` teardown covered.
- **`remoteDeployables`**: `byId`/`remote` both evict on `remove()`,
  roster reconcile drops snapshot-absent ids, weld beams expire at
  250ms, sensor pings TTL at 3s, `dispose()` drains all lists.
- **`TickLoop`**: `tickErrStreak`/`tickQuarantined`/`faultedRooms`/
  `phases` are room-name keyed — bounded by live rooms, evicted on
  room teardown, eldest evicted at cap.
- **`stateDebug.firstSeenAt`**: reconciles against the live id set
  every pass (stamps fresh, deletes absent) — join-grace bookkeeping
  can't accumulate dead ids.
- **Client FX layer**: `damageNumbers` 48-cap + oldest-drop + glyph
  pool; `ballTrails` dot pool + slot freelist; `deployAdopt` dead
  items → `killItem` dispose+remove; `deployRockets` dead rockets
  splice-reaped per frame; `netTelemetry` ping history capped +
  tick window time-bounded; `sfxWorld.remoteLoops` capped at 6 with
  silent-slot eviction + `remoteMoveAudioGone` in the onRemove
  funnel; `effects.ts` beams/particles reap into capped pools,
  empty instanced buckets retire, `deadP`/`beamPool` trim to KEEP.
- **Server module tail** (full 79-file `server_bun/src` sweep):
  `respawn` timers+dueAt evict on cancel/fire/dispose; `influenceMap`
  no per-id state; `deployTicks` dead-owner removal + bolt ttls;
  `serverAttacks` stateless; `clientLogs.postIps` 1024-cap;
  `matchJournal` call-local; `spotBoard` cloak-evict + SPOT_MS TTL;
  `serverParties` rebuilt per call; `RtcRelay` room-keyed evict;
  `roomSwitch` cooldowns 1024-cap; `DemoStorage` MAX_DEMOS=100
  oldest-evict; `SessionManager` claimedIdentities 10k oldest-first,
  joinWindows 1024 two-phase evict, specRooms delete on join;
  `roomScore`/`roomFactory`/`roomArena`/`Room*`/`MessageHandler`/
  `GameServer`/`mapCatalog`/`superBot`/`healPool`/`ballCombat`/
  `projContact`/`spawnPicker`/`tickHelpers`/`validation`/`rewind`/
  `roomMatch` — roster/room-keyed or call-local.
- **`shared/` tree**: `botSheep` evicts all 9 per-id maps in one
  `forget` path + rekeys on id change — meter semantics pinned
  2026-10-05 (`botSheep.test.ts`: unproven=100, 30/s drain cap, 20s
  proven grace, dest/excused charge tiers, 5s coverage debit,
  deadstop bleed, clear/rekey lifecycle, newlyMaxed/crossedHigh
  edge-only semantics); `botLos` memo TTL + 4096-cap;
  `botGraph` evicts oldest; `botHunt` caps at 6; `solidWorld.cells`
  is spatial-hash geometry; `flagGoals`/`weapons`/`botClasses` are
  static tables. `botSkill` pinned 2026-10-05 (`botSkill.test.ts`:
  private mulberry32 never touches botRand — green under armed
  strictRng — same spawn same matrix, axis clamps, tier/mix
  resolution, weapon-axis map, still/moving blend, form drift
  bounds + gate). `vgsTree`/`deployItems`/`species` shipped-data
  validity pinned (`sharedData.test.ts`: chord walk — labelled
  leaves, all-chat lines VG-only; plantable⇒cost>0 vs authored
  cap-0; species family/bite/blast sanity + hop fallback).
  `creatureCore` pinned 2026-10-05 (`creatureCore.test.ts`: carried
  LCG stream identity, 200-step replay determinism, species-row
  scaling, commitTarget snapshot semantics, clipMotion face parking,
  windup→pounce→bite edges, authority-only pendingBite, stun/death).
  Ambient draws in `botRand`/`env`/`pickups`/`ballSim`
  are the strictRng-gated seams themselves; remaining `Math.random`
  defaults (`rollVariant`/`spawnRng`/`deps.rng`) are documented with
  all callers passing seeded rng.
- **Chatter stack determinism**: `tauntDelayMs` now draws from
  seeded `tauntRand` — the last ambient `Math.random` in the stack;
  `killFeed`'s own four draws converted earlier. Chatter fully
  deterministic under strictRng.
- **Test harness**: replica `held`/`roster` evict on wire `remove`;
  the `tauntRng`/`strictRng` hooks are the deliberate seams the
  tests exercise.
- **Leaver-map key domains**: `killCounts`/`lastWeaponByPlayer`/
  `aliveSince` correctly stay sibling maps — their key domains span
  `'local'` + client fill bots + self, not RemoteSet members; the
  `onRemove` funnel is the right shape for mixed-domain keys.
- **Client unbounded growth** (2026-10-05): all 44 `new Map/Set` files
  swept — every site is domain-bounded (scene/team/variant/const key,
  owner-lifetime, or per-call scope) or evicts (`chainRamp` 32+window,
  `projectileRegistry` dead-entry sweep each update, FX pools retire
  when empty, `coolShots` ≤20 filter, registry journal caps).
- **Server unbounded growth** (2026-10-05): all 13 `new Map/Set`
  files in `server_bun/src` swept — connection/player/ratelimit maps
  delete on disconnect, roster roles/classes delete on bot removal,
  everything else is a per-call working set or static constant.
- **Server ambient draws** (2026-10-05): all 20 sites in
  `server_bun/src` classified — rng sites injectable-seeded
  (`CombatHandler`/`spawnRng`/`rollVariant` ambient default is
  production-only, never wire-visible), `performance.now` is
  stageProf metrics, `Date.now` confined to `wallClock`/`simClock`
  choke points.
- **Console bypassers** (2026-10-05): all `console.*` sites outside
  `Logger.ts`/tests classified — server boot banner + fault paths,
  client gunlab report surface, dump/profiling tools, `.old` files,
  one debug-flagged bake log. Nothing bypasses the log tiers.
- **Ball netcode — end-to-end pinned** (2026-10-05):
  `ballStaleSeg.test.ts` (`isStaleSeg` boundary + `applySeg`
  re-anchor/simT rewind), `ballTickNet.test.ts` (0.05-cell stepping,
  simNow gate, 0.5s stall-breaker + bank cap, ballistic remainder,
  parked settle), `ballPredictAt.test.ts` (probe bounds: simNow clamp,
  simT+8 cap, live-sim isolation), `ballRubberband.test.ts` (watch
  gates: unreplayed-stamp suppression `a3a77034`, replayed-divergent
  warns, parked/stale-leg suppressed), `ballClock.test.ts`
  (`makeBallClock` EMA rate/no-rewind/age clamps,
  `pruneNetBalls` ghost eviction).
- **`creatureTotem` pinned** (2026-10-05): `creatureTotem.test.ts`
  (17 tests) — registry row, uber twin constants, refire/range gates,
  charge→fire edge with authority-only `pendingBite`, all three
  relocation triggers (MIN_RANGE / shot budget / lost line — a
  feet-level target on flat ground legitimately fails line-clear and
  relocates), blinkOut snap + blinkIn 'land' with seeded cooldown,
  mid-blink intangibility, stagger pin, chain-escape cooldown,
  committed beam geometry (unit dir, terrain clip, structure clip),
  live-position sweep, 400-step twin replay. Creature families now
  fully covered.
- **`botGraph` + `botTuning` pinned** (2026-10-05):
  `botGraph.test.ts` (10 tests) — origin wrap, flat-ground progress,
  wall circumvention (priced not forbidden), danger deflection off a
  hot blob, `routeNearGoal` back-off, 120m goal bucketing, bounded
  flood cache, connected grids never null, twin-instance replay, and
  shipped-shape tripwires on `BOT_TUNING` (finite keys, `thinkS=0.3`
  comment-pinned — 0.5 broke beast-awareness + replay).
- **Rate-limiter lane audited + pinned** (2026-10-05): every spam-able
  wire type has its own bucket or shares the bounded 120/s default —
  no free lane; `ping` stamping lastSeen is deliberate liveness for
  non-moving clients (idle-reap targets silence, not low activity).
  `ratelimiter.test.ts` (5 tests): window rollover, ARRIVAL-time
  windowing (late-drained backlog doesn't burst), default-bucket
  sharing across unlisted types, per-player isolation, removePlayer
  teardown.
- **`roomSwitch` audited + ordering fix** (2026-10-05): `switchTarget`
  built the target room (`roomFor` = full map-spec build) before the
  dead-player denial — a dead spammer could churn a fresh room every
  cooldown window. Denials that don't need the room now run first.
  Rest classified clean: same-room no-op early, cooldown marks attempts
  (denied paths stay throttled), pending class/perk ride the hop,
  correctionGrace + markReseated arm the new shadow's drain window,
  cooldown map capped at 1024.
- **`envClaims` pinned** (2026-10-05): `envClaims.test.ts` (10 tests,
  fake host) — untagged env damage clamps [1,40], nearby named attacker
  keeps the 80 cap, a distant named attacker is a forge (attribution
  drops to 'environment', cap halves, heartbeat beat), `bot:` tags skip
  the range gate, dead/missing → 'gone'; heal caps at 25, refused heals
  don't consume the 1.5s cadence, team-mode draws healCredit only,
  over-cap clamps at maxHealth.
- **Join/reclaim atomicity audited** (2026-10-05): grace reclaim checks
  the session token BEFORE the connected test (a zombie socket can't
  lock out its owner), registers the new socket BEFORE evicting the old
  (onClose sees the seat already owned — the generation check at
  GameServer.ts:245-246 double-covers sockets seated pre-registry),
  stamps lastSeen so a >60s grace seat isn't idle-reaped, and last-
  writer-wins for racing reclaims is deterministic. Second 'join' on a
  seated socket drops at the WIRE guard; spectator squat evicts via
  specRooms before seating. Rejection paths send sessionRejected before
  close so stale-token clients can't reprobe-loop. Pin coverage:
  reconnect/graceZombie/joinGuard/flagGraceDrop/teleportGrace.
- **TickLoop containment holes closed** (2026-10-05): empty-room
  `dispose()` ran outside the per-room guard — a throwing dispose
  escaped the interval uncaught (process kill for every room) and a
  permanently un-disposable room retry-looped every tick. Dispose now
  sits in the same streak → quarantine → drain path, and quarantined
  names are skipped at the top of the room loop. Also fixed stale
  `errPhase` misattribution: a pre-tick throw (match clock, hibernation)
  logged whichever phase a previous room died at — now tagged 'pre'.
- **`botTaunts` pinned + `netchannel` reviewed** (2026-10-05):
  `botTaunts.test.ts` (10 tests) — per-bot 20s cooldown shared across
  event kinds, silent rolls don't stamp, repeat-victim 90s window flips
  to the dominance pool, match-mute kills all gameplay taunts, endTaunt's
  own high roll bypasses cooldown, VGS chord → canon text, chatKindFor
  human-spectrum classification (specific beats generic), vgsCommandFor
  acks request families only. `netchannel` is a pure type interface
  (25 lines, no logic) — the lane-drop contract is enforced in wire.ts.
- **`fieldSurface` + `vgsTree` pinned** (2026-10-05):
  `fieldSurface.test.ts` (8 tests) — structure top face wins over
  terrain as floor, `maxTop` bounds deck-overhead claims, flat-up
  normal over solids, pure-terrain passthrough without a SolidWorld,
  resolveBody wall push-out; VGS chord walk (every leaf labelled
  non-empty, VG* all-chat `team:false`, cats carry only children).
- **`teams`/`constants`/`env` pinned** (2026-10-05):
  `teams.test.ts` (7 tests) — mode table sanity (label/winAt/clock,
  teams XOR ffa, flags only where declared, exact mode key set),
  pickTeam deterministic alternation, bank/winner threshold edges,
  flag rule constants ordered; capsule geometry derivation (cylinder
  height, eye inside, radius can't eat the capsule); setSharedEnv
  merge semantics; sharedNow quiet-by-default epoch-0.
- **`botRand` gate pinned** (2026-10-05): `botRand.test.ts` (6 tests)
  — strictRng throws on unblessed ambient (`botRng(Math.random)` is
  the "forgot to seed" case) yet honors `botRngRelease()` (tagged
  blessed ambient for harness windows); injected stream controls
  draws; taunt stream is independent of the behavior stream;
  dist3/distSq agreement.
- **`species` registry pinned** (2026-10-05): `species.test.ts` (6
  tests) — every row's family resolves to a real SPECIES_FAMILY sim;
  positive health/bite/all overrides (zero stat = ghost or pillow);
  blast required exactly on baneling-family rows; totem sessile (no
  speed); orbit params only on fly; unknown names → 'hop' fallback,
  case-sensitive.
- **`status` bitmask pinned** (2026-10-05): `status.test.ts` (5
  tests) — every bit a unique power of two >=4 (no movement/death
  collision), STATUS_MASK is exactly the claimed bits,
  CLIENT_STATUS_MASK keeps toggles but strips server-owned REGEN/DD/
  CHARGED (the forged-buff seam) without reaching outside the lane,
  shootRevealed boundary included, mend rate sane.
- **`perks` table pinned** (2026-10-05): `perks.test.ts` (6 tests) —
  PERK_ORDER covers every PerkId exactly once; every mod a finite
  non-negative number in a sane band (0 or 5× = balance typo);
  unknown/absent ids fall back to the ZERO row; perkMods returns a
  fresh copy (mutation can't corrupt the table); plated's underdog
  resist only below 80% max; isPerkId case-sensitive wire gate.
- **`botClasses` gate pinned** (2026-10-05): `botClasses.test.ts`
  (7 tests) — light/medium tier locks are EXACT-class, heavy is a
  floor; unknown class → medium default everywhere (fire gate, mass,
  capsule); `minClassForWeapon` floor-is-ceiling for light-only; every
  tier mass < jetForceUp/|gravity| (pack always lifts the chassis);
  tier ordering (health/radius/mass up, speed down); capsule geometry
  (center below eye, non-negative half); model scale consistent with
  eye heights.
- **`botLoadouts` table + weapon pick pinned** (2026-10-05):
  `botLoadouts.test.ts` (7 tests) — every shipped kit is fireable by
  the class `botClassForLoadout` assigns (classCanFire gate — a bad
  row is a bot dry-pulling a holstered gun forever); resolution order
  ordnance > exact-lock > perk; range bands; HealBeam never drawn at
  enemies; nonAoeOnly never returns a launcher; self-blast discount
  splits cautious vs bold; wounded gate holsters aoe only inside
  blast reach-back (60m standoff keeps the launcher).
- **`ballSim` state machine pinned** (2026-10-05): `ballSim.test.ts`
  (10 tests) — variant table derivation, ground settle is not a
  segment, stall-clock wake-up needs a target, drift-past-MAX_DIST
  enrage spring, enrage pull accel, enrage timeout → teleport
  authority-only (predictor lets it fly and waits for the segment),
  bounce elasticity, overspeed half-elasticity thud, applySimDamage
  death edge + impulse. ballCaps already pins the speed ceilings.
- **Wire contract drift tripwire** (2026-10-05): `protocol.test.ts` —
  a `satisfies`+`Exclude` compile-time check fails tsc the moment the
  `ClientMessage` union grows without a WIRE entry (silent-drop class:
  unmatched types fall to the 'unhandled' heartbeat only); runtime
  asserts every type validates, every entry except join (sessions-owned
  handshake) and switchRoom (GameServer-intercepted) carries a room
  handler, and no orphan WIRE keys exist outside the union.
- **`movement` sim pinned** (2026-10-05): `movement.test.ts` (13
  tests) — cloak-drain curve + clamps, fixed-step accumulator parity
  (0.1s lumped == 10×0.01s split, sub-step remainder carries),
  MAX_DT stall cap, jet force/mass (heavy climbs slower), terminal
  velocity airborne-only, stop-threshold friction, ski momentum
  preserved above walk speed, overspeed bleed decays not clamps,
  body-contact separation + mass-weighted bump + self skip +
  y-overlap gate, autoHop repeat landings.
- **`botBrain` head pinned** (2026-10-05): `botBrain.test.ts` (11
  tests) — contact/lost chatter edges fire once, fear-vs-hero wound
  roll, heal re-arms the edge, underfire/bored latches, belt mid-range
  window + 9s cooldown + knife/far exclusions, utility goal pick
  (committed runner 3.5-weight holds the objective while an idle bot
  takes the nearer pickup — the arc belongs to the line planner, the
  commitment lives in `goalS.goal`), and twin-instance think replay.
- **Wire field-width wrap + lane parity** (2026-10-05): audited every
  binary field in `shared/wire.ts` — packPos/packVel clamp-and-quantize,
  health/ping/sheep/id lengths clamped, yaw wraps by design, record
  count u8 unreachable (maxPlayers 32). **Found+fixed**: `decodePosition`
  enforced isFinite + the 8192m position bound but skipped
  `validateBody`'s 1000 m/s velocity bound — a binary position frame
  could claim velocity the JSON lane refuses, and that claim anchors
  moveJudge divergence math. The codec now rejects |v|>1000 like the
  JSON lane; `posMagnitude.test.ts` gained the parity case.
- **`weapons` derivations pinned** (2026-10-05): `weapons.test.ts`
  (11 tests) — airtime ramp ±0.5s steps, cap, non-scaled ignore,
  unknown type 0, directHitAoeBonus launcher-only, beltThrowCost
  satchel-2/flat fallback, Sticky belt-exempt, MAX_HIT_CLAIM_DMG
  re-derived from the live table (ceiling must fit the widest legal
  claim), getWeaponStats fallback, cadence sanity + every keyed
  weapon existing. The wire-authoritative table's derived ceilings
  can't drift silently.
- **Map/Set iteration-order determinism** (2026-10-05): every Map/Set
  in `shared/` audited for order-dependent iteration on a sim path —
  `stateHash` is a commutative per-player sum (roster order can't
  alias), `flagGoals` sorts ids before role election, `losMemo` and
  `botGraph.fields` are pure-function memos (eviction order can never
  change an answer), `pickups.WEIGHTS` is static-literal order with
  seeded rolls, the rest are keyed lookups with no order-dependent
  writes. Insertion-order divergence can't reach a sim output.
- **`botEscape` pinned + orbit-streak fix** (2026-10-05):
  `botEscape.test.ts` (13 tests) — dodge range/step/momentum-side,
  runner <80m exemption, posted leash clamp + half hop, hero senses;
  stuckBreak fast-window pinned streak, posted exemption, slow-window
  orbit detection, escalating jet burst, gain-reset. **Found+fixed**:
  the slow window incremented `stuckStreak` but the fast window's
  displacement-reset erased it in the same call — an orbiter's
  `1.1+streak*0.7` escalation sat at 1.8s forever and the ≥4
  wander-forfeit never fired (the treadmill the slow window exists
  to catch). Split `orbitStreak`: pinned streak keeps displacement
  reset, orbit streak only resets on real goal gain or posted hold;
  forfeit checks either.
- **Observability noise** (2026-10-05): every `logger.warn`/`error`
  across client + server audited — all fire on real anomalies with
  throttling: camera spinout 0.5s cooldown, anim misses deduped per
  variant:name, stall once per model, ball rubberband per-id +
  suppressed-fleet rollup, model-load warn→error escalation; server
  warns cover drowned sockets, out-of-range claims, missing addons,
  parse faults, per-episode bot-stuck latch. Per-frame paths use
  gated `debug`. Zero warn on expected lag/reconnect paths.
- **`botLines` pinned** (2026-10-05): `botLines.test.ts` (13 tests) —
  steerer close-out rings (plain + runnerDirect), mid-range fan roll,
  commit-window hold, in-cone goal-drift tolerance, all-sheer veto →
  empty roll, downhill-pocket bias, stagnation latch → orbit arm →
  remembered-pass pick → `orbitFails≥2` beeline, runner dive-glide at
  the objective, flow-field consult on gd>140 legs only, 40-step twin
  replay. Note: pass-filing calls tick the stagnation meter — a pass
  banked mid-leg can arm the latch sooner than staleLimit raw rolls.
- **Edge idempotency** (2026-10-05): wire edges are pure overwrites of
  committed state (`applyNetEdgeSim` writes pos/vel/target verbatim,
  `applyNetEdgeTotem` commits the blink destination) — a duplicated
  edge is a no-op. Transport can't duplicate (WS = ordered TCP);
  reconnect restore is `gameState`/roster full snapshots. The one
  re-triggerable surface (`onSimFire`/`detonate` flash) is the
  deliberate single funnel for predictor + edge by design.
- **Edge-vs-snapshot ordering** (2026-10-05): every wire edge is
  self-contained — `crawlEvt` carries pos/vel/committed `tp`/`t`
  (blink carries the committed DESTINATION), `WireBallSegment` packs
  the whole leg (pos/vel/tp/et/slowT/damp/t), `flagUpdate` broadcasts
  the full flag snapshot, kill/drops resolve server-side. No message
  references a snapshot that could arrive later, so intra-tick and
  cross-packet ordering can never replay an edge against a stale base.
  The "state edges + committed snapshot" rule kills the class.
- **`creatureBaneling` pinned** (2026-10-05): `creatureBaneling.test.ts`
  (13 tests) — blast-required registry rows, uber ×4/×2/×1.7 scaling,
  TOPSPEED cap + wide-aggro homing, 20% out-of-aggro throttle, stun
  coast, 3D-fuse `detonate` + dead flag with no `pendingBite`, LIFE_S
  self-detonate, same-step fuse crossing, distant-no-pop, terrain ride,
  clipMotion, counterplay lethal damage, 300-step twin replay.
- **Cross-engine float determinism** (2026-10-05): 162
  `Math.sin/cos/atan2/hypot/exp/pow` calls across `shared/` audited.
  ECMAScript leaves transcendental precision implementation-defined, so
  Bun(JSC) vs Chrome(V8)/Firefox(SpiderMonkey) replays can differ in
  ulps — the architecture already tolerates it: replicas re-anchor on
  committed snapshots + edges (error never accumulates across an edge),
  the state hash quantizes positions to ~1m and health to 4hp buckets,
  so ulp drift can't cross a quantum. No bit-identity check exists that
  could false-positive. Residual: creature/ball replicas have no hash
  coverage at all — logged §4.7 as optional.
- **`angles` pinned** (2026-10-05): `angles.test.ts` (5 tests) —
  `wrapAngleDelta` shortest-arc in (-π,π], exact-π convention,
  multi-turn collapse, pole discontinuity, `lerpAngle` short-arc
  across the ±π seam (t=1 endpoint is angle-equivalent, not literal —
  documented), exact endpoints.
- **Client-inbound coercion defaults** (2026-10-05): every `??`/`||`
  fallback in `client/src/game/net/*.ts` audited — all are either
  display-side (scoreboard `?? 0`, beam glow color, HUD readouts) or
  trusted-absent handling of optional wire fields (`roster ?? []`,
  `pickups ?? []`, `p.kind ?? 'gem'` — `kind` is declared optional in
  `protocol.ts` and the server fills it from its own registry). None
  feed a sim write; absent ≠ malformed on a server-authoritative wire.
- **`creatureFlyer` pinned** (2026-10-05): `creatureFlyer.test.ts`
  (14 tests) — registry rows + gnat overrides, seeded orbit state,
  committed-prey gate (raw target without tgtValid never folds),
  windup→dive→climb→orbit cycle edges, abort clock, authority-only
  `pendingBite`, seeded cooldown re-roll on land, spawn-home anchor
  fallback, terrain floor, clipMotion mid-flight, 400-step twin replay.
- **Disconnect lifecycle — two-phase teardown** (2026-10-05): audited
  every per-player store against socket-close vs full-removal. Disconnect
  reaps per-connection state only (respawn timer, flag carriage,
  fire/heal throttle maps, pending claims, rate-limit warn keys) so a
  grace rejoin keeps projectiles. `removePlayerCompletely` is the single
  funnel for kick/reap/hop/retire: bots.untrack, flagCarrierDied,
  deployables.clearOwner, projectiles.clearOwner, players.removePlayer,
  scoring.dropPlayer, ledger.removePlayer (live + spent + clientIds),
  killFeed.forget, sessionTokens, rateLimiter, sessions.terminate (kills
  zombie grace timers), wireId retire. Lag-comp `history` rides the
  player object itself — dies with removal, cleared on respawn.
  No orphan path found.
- **`creatureRoller` pinned** (2026-10-05): `creatureRoller.test.ts`
  (12 tests) — registry rows, uber ×3.4 health, no-target coast,
  TOPSPEED cap while pursuing, 20% idle-drift throttle past aggro,
  stun skips steer, contact invuln window (one edge per BITE_CD,
  authority-only `pendingBite`), terrain ride, clipMotion parking,
  300-step twin replay.
- **Wire-ingest NaN/magnitude gates** (2026-10-05): all 25 client
  message types in `wire.ts` audited — every vec passes `validateVec3`/
  `optVec` (finite numbers), `validateBody` adds velocity+position
  magnitude bounds (1000 m/s / 8192 m — lag-comp history can't be
  poisoned), every scalar passes `isFiniteNumber`, ids are non-negative
  integers, `heal`/`environmentDamage` amounts clamped downstream
  (25 / 80-tagged / 40 plain per claim), every lane rate-limited.
  NaN cannot reach a sim write. Table-indexed sweep 2026-10-06: every
  field that indexes a lookup is strict-checked — `weaponType` must be a
  `WEAPONS` key (§2.19), `kind` in `DEPLOY_KINDS`, `armorClass` is
  literal light|medium|heavy, `perk` is `isPerkId`; no remaining
  isFiniteNumber-only index claims.
- **GameServer/Room churn-keyed maps re-swept** (2026-10-06): every
  playerId/socket-keyed structure on GameServer (`playerRoom`,
  `specRooms`, `invalidWarnAt` post-§2.20) and Room (`sessionTokens`,
  `lastSentPositions`, `chatPace`, `wireIds`/`wireIdRetired`) evicts on
  the removal funnel; `mintWireId` recycles retired ids past a 60s
  quiet window and fails loud on u16 exhaustion (eldest-recycle pinned
  in `ghostRecords.test`). Per-tick fanout path (`healthTick` 15s,
  `unburyTick` 0.5s, tickFlags, buildRecords) allocates nothing
  unbounded. Server `Math.random` sites are all injectable-rng defaults
  (`room.rng` = seeded `botRand`, `PlayerManager.spawnRng`,
  `CombatHandler.rng`, `rollVariant`) — harnesses seed them; production
  ambient is by design since the server is sole authority.
- **Client/server timer teardown swept** (2026-10-06): every
  `setInterval`/`setTimeout` with a lifecycle audited — client reconnect
  timers (`tiers`, `WebSocketConnection`), session veil, chat fades,
  throw wind-ups all clear or are app-lifetime singletons; server
  `killFeed.pending`/`respawn.timers` dispose with their room, and the
  removal funnel cancels a pending respawn + clears held-corpse state
  (chain now fully pinned in `graceZombie.test`: timers AND `held`).
  §2.21 was the only gap found.
- **`creatureSlither` pinned** (2026-10-05): `creatureSlither.test.ts`
  (13 tests) — species registry derivation, uber ×4 health, live LCG
  seed, out-of-aggro speed bleed, weave→coil→leap→bite state machine
  edges (windup/pounce/bite), once-per-leap pass-through bite with
  authority-only `pendingBite`, touchdown rearm, damage-breaks-strike,
  300-step twin-replay, deterministic animT weave, clipMotion on the
  weave leg.
- **Id-space collisions** (2026-10-05): every replicated id mint
  audited — creature `nextId++` and projectile `sp-${nextId++}` are
  per-room monotonic, never reused; pickup/ball ids same shape. FIXED:
  `botFire`'s `bot-${shooterId}-${wallNow()}` was ms-granularity —
  a multi-weapon tick could mint one id twice → client registry
  overwrite; now suffixed with a monotonic seq (`MessageHandler.ts`).
- **`client/src/game/net/` handler tail** (2026-10-05): the
  un-dirty files swept (mapAssets/projectiles/RemoteSet/pickups/
  resync/deployables/lastRoom/ctx; flags/match/playerKill/players are
  JP's WIP, excluded) — `remoteProjectiles` deletes on end events,
  `RemoteSet.active` `Date.now` is the correct wall-clock domain for
  feed staleness (not sim), `glbCache`/`_canonMats` bounded by the
  finite asset set, `resync` `performance.now` measures real tab-hidden
  time, every catch reports (sky warn) or names its fallback
  (mats→baked look, localStorage→boot default).
- **Event-listener lifecycle** (2026-10-05): all ~158
  `addEventListener` sites classified — global targets
  (`window`/`document`) live exclusively in boot-once builders
  (`wireOverlayInput` → `buildKeysMenu`/`wireLoadoutBar`, `vgs`/`chat`/
  `input` constructors, `Logger`, `renderer`, `InputTracking`); no
  global listener registers inside a per-open or per-reconnect path.
  Per-connection listeners ride the `dc`/`pc`/`ws` object itself —
  GC'd with the socket. Per-element listeners die with rebuilt DOM.
  Only `keybinds` re-registers, and removes first.
- **Timer lifecycle** (2026-10-05): ~55 `setTimeout`/`setInterval`
  sites both ends classified — server: `respawn` dueAt map cancels on
  fire/dispose, `killFeed` pending-set drains, `sessionRegistry`
  graceTimer cleared on every transition, join-deadline + RTC
  stale-guard are scoped one-shots, `TickLoop` intervals cleared on
  `stop()`. Client: `stallTimer`/`tickTimer`/`reconnectTimer`/`lobby`
  poll all `??=`-once singletons or cleared on cancel; the rest are
  DOM-element life timers (feed rows remove themselves) or dev-tool
  polls (`posedump`, `renderScan`). No orphaned intervals, no
  per-id timer maps that could outlive their owner.
- **Room-hop residue** (2026-10-05): `world`/`remotePlayers` are
  created once in `main.ts`, but a fresh `gameState` is authoritative —
  `dropVolatileWorldFx` purges the volatile layer, `applyMatchMeta`
  clears rather than leaves the old match, `reconcilePickups`/
  `reconcileDeployables`/`onFlagUpdate` fire either-way on empty
  rosters, and `cleanupRemotePlayers` prunes wire ids absent from the
  new roster (`onRemove` → killCounts/aliveSince/lastWeaponByPlayer
  deletes). Local `bot:`/`dummy` bodies are correctly exempt — they
  own their own lifecycle. Remaining per-id maps key on live ids and
  are reaped through the same onRemove funnel.

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

Follow-up (warn-metric false positive, 2026-10-05): the residual ~17m
heartbeat warns were not sim divergence — `check` runs BEFORE
`applyNetSegment` per event, so when two segments for one ball drain in
the same frame (stall backlog, hidden-tab catch-up) the second event
measures a sim JUST re-anchored (`simT == legT0`, zero steps between)
against truth one spacing ahead — err reads segment spacing (~17m at
ball speed), not prediction drift. `gated` now suppresses events whose
stamp the sim hasn't replayed through (`simT < m.t − 0.05`); real
desyncs — sim replayed past the stamp and still off — still warn.

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
- ~~**netbot `wsFight` load-sensitivity (infra flake)**~~ — *closed*: new
  `untilProgress` in helpers — while the progress metric (shots +
  gameStates) keeps accruing, the deadline extends 5s/beat up to a
  38s hard cap; a real stall still fails at the 20s base deadline.
  Engagement window is now starvation-aware, not wall-rigid; test
  timeout raised 30→45s to cover the cap.
- ~~**Ball rubberbands still suppressing 80-300m corrections**~~ — *closed
  as metric bug*: the fleet counter was fed err for teleport/spawn/lunge/
  enrage events, where err measures the correction's own size — a retarget
  ~200m away can't be "predicted wrong", it was unforeseeable by design.
  Metric now counts only path-continuation events (segment/bounce/stall)
  where prediction could have tracked; path-changing corrections log at
  debug. If real drift remains, it now surfaces unmasked.
- **Jet-cap tuning regression (found+fixed, 2026-10-06)** — `jetMaxFwdAccel`
  40 clipped the bots' 44 m/s re-blast hops → capper energy-starved and
  wandered on kata (capRun bisected it to commit 9625682). Raised to 50:
  above the bot propel ceiling, still kills the unbounded forward pump.
- ~~**matchSim drop-cause blindness**~~ — *closed*: the carry ledger now
  correlates `playerKill` (targetId) within 1.5s before a carried→dropped
  edge and classifies `died` vs `threw` — "carrier killed on the doorstep"
  and "carrier tossed it alive" were indistinguishable drops. Printed as
  `drops=N (died=x threw=y)` and per-grab `→died+1s`. Verified on a 2-min
  8-bot kata soak: the lone grab read `a@27s→died+1s`.
- **Sheep idle-max is honest (audit, 2026-10-01)** — the same soak maxed
  4/8 bots with `idle` dominant (51-72pts). Verified `atPost` (hasDest &&
  within 14m of the claimed dest → trickle charge) already exempts posted
  guards; the maxed bots are genuine zombies — same competence finding as
  §4.7b, not a metering bug.
- **Residual `Movement cheat` warns under sustained input gaps** —
  post-§2.16 the join-wave burst is gone, but a 16-RTC-bot soak still
  logged ~3 warns/80s at dist 60–99m. Hypothesis: RTC congestion holds
  an inputMove gap past the 600ms defer window, so raw judging resumes
  while the shadow is still starved — a lag blackout then banks strikes
  exactly like a teleport. Options if the rate bothers real clients:
  count strikes only when `gapStreak === 0` (edge recovered and the
  report STILL diverges — the strongest cheat signal), or scale
  SEVERE_M by gap duration. Needs a reproducer that holds an input gap
  ~1s under live RTC before picking.
- **Creature-constant unification (needs JP ruling)** — client
  `core/config.ts` creature knobs (CRAWLER_*/SCARAB_*/SNAKE_*… ~150
  absolutes across 10 species) feed the solo/host sim while the server
  runs `shared/species.ts` + `creatureCore` family tunables. Shapes
  differ (multipliers vs absolutes) and values ALREADY disagree
  (scarab health 40 shared vs 20 client) — intentional solo-balance
  divergence or drift? If intentional, this is verified-divergent-by-design
  and should be commented as such; if drift, deriving client constants
  from SPECIES×family is a mid-size refactor that kills the class.

### 4.4b Echo-channel desync spam — *closed*

Live logs showed `[StateHash] DESYNC` on `[echo] health` at ~96% mismatch
rate (client=114 vs server=125 etc). Not data loss: `recordSuppressed`
already force-sends on `p.health !== lastSent.hp`, so every mutation
echoes — but under sustained combat (playerHit ~2Hz per victim, 14-30hp
each) the in-flight delta always exceeds the 4hp bucket. An echo field
cannot be hash-checked mid-flight. Fix is in the diff path
(`stateDebug.ts`): per-player `healthDriftStreak` — a health divergence
must persist across consecutive detailed checks (≥5s apart, and past
the heal-adoption that runs in the same pass) before it warns. Transient
echoes log at debug and are NOT adopted (adopting an older server echo
over fresher client data would heal backwards). A genuinely dropped
event diverges permanently → still warns.

### 4.5 Video export resolution — *closed*

Staged 1920×1080 export canvas in `VideoRecorder` (`start(fps, staged)`):
the live canvas blits in contain-fit with letterbox bars via `pump()`,
driven from `renderFrame` inside the same rAF (the GL readback caveat —
drawImage on a WebGL canvas is only live within the frame it rendered,
no `preserveDrawingBuffer` needed). Output is fixed 16:9 regardless of
window size; fullscreen stays for the view-during-record benefit.

### 4.6 Verified-flake record

Full suite: 822 pass / 1 fail — the sizeWatch grandfather pin on
`Room.ts` (grown to 1061 vs pin 909×1.15; JP's in-flight edits, not a
suite regression). Scenario suite alone: 334/334. Net suite: 37/37,
deterministic. Typechecks clean on both ends.

### 4.7b CTF capper last-250m stall — *localized 2026-10-06, needs gameplay ruling*

`matchSim --mins 3 --bots 12` (katabatic, flags 1060m apart): 21 kills
but **zero flag grabs** — the elected capper never converts. Sheep
meters confirm real stall (post-§2.10 bleed gate, residuals are true
deadstops). Two seeds identical — systematic, not variance.

`.devin_capdbg.ts` probe (forced capper, 260s sim): flagD closes
1000→256m fine, then the bot **orbits ~250m out indefinitely** — wp
thrashing across a ±100m scatter, orbitFails→3 without escape, hp 20
constant (no combat involvement), flag stays home. Long-leg routing
works; the failure is the stand APPROACH — the stand sits inside a ~3m
dais (FLAG_STAND_LIFT mounts via climb/jet gates) and neither the flow
field nor the orbit-escape converts proximity into the mount move.
Competence bug, not a six-class bug — queued for the gameplay pass JP
is already working (jet-cap fix landed 2026-10-06 and didn't move it).

### 4.7 Replica-coverage gap in the state hash — *closed (balls + creatures + deployables + flags + pickups)*

The checksum covered players only; non-player replays had no cross-engine
desync signal. **Ball fleet now hashed** (2026-10-01): `ballHash` rides
the existing `stateHash` broadcast — `computeReplicaHash` over
(id, variant, enraged, targetId) per ball. These are mirrored edge
fields, not positions: raw positions would phantom-fire under latency
(100ms × 40m/s = permanent ~4m false diff), so trajectory drift stays
the fleet rubberband metric's job and this channel catches what nothing
else did — a stranded, dropped, duplicated, or stale-lifecycle replica.
Client-side a `ballDriftStreak` gate (≥2 consecutive mismatches → warn,
else debug) eats lifecycle edges in flight at the check boundary, same
shape as the health-echo persistence gate.

**Creatures covered the same way** (2026-10-01, same round): `creatureHash`
over (id, species, state, uber, targetId) — every field mirrored from
spawn or wire edges, so latency can't phantom it. `main.ts` feeds
`stateDebug` the 8 net-driven species lists via a `netCreatures` ctx
accessor (`banelings` added to the entities return for reachability);
same persistence-gated warn.

**Deployables covered too** (2026-10-01): `deployHash` over
(id, kind, owner, team) — pure spawn edges; hp/armor deliberately
excluded as echo-channel (deployHp ticks would phantom-fire the check at
heal cadence). Catches a deploySpawn/deployGone edge that never landed.
Client `netEntries()` covers both lanes: remote spawns plus our own
plants once `serverId` arrives.

**Flags + pickups covered** (2026-10-06): `flagHash` over
(team, state, carrier) — the flagUpdate edge fields, so a grab/return/
drop that never echoed surfaces instead of leaving a flag announcing a
stale state; `pickupHash` over (id, kind) catches a pickupSpawn or
pickupGone that never landed (a collected gem still shimmering, or a
hole where one should be). Client flag state reads `world.flagStates`
+ `flagMarkers.carrier`; pickup replicas are shared via
`world.netPickups` (net/pickups owns the map). Same persistence-gated
warn. Every long-lived edge-driven roster now has a fidelity signal —
only projectiles remain uncovered, short-lived enough that a stranded
replica is cosmetic. Hash stability pinned by `fidelityHash.test.ts`:
order-independence plus a perturbation per mirrored edge field.

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
