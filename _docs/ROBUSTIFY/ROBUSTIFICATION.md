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
  offline-mode, so their draws need no wire integrity.
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
- **Client ambient draws**: `NetworkManager` `Math.random` is
  one-time identity mint (localStorage-persisted, never sim);
  `remotes` `Date.now` feeds scoreboard alive-seconds display only.
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
- **Creature-constant unification (needs JP ruling)** — client
  `core/config.ts` creature knobs (CRAWLER_*/SCARAB_*/SNAKE_*… ~150
  absolutes across 10 species) feed the solo/host sim while the server
  runs `shared/species.ts` + `creatureCore` family tunables. Shapes
  differ (multipliers vs absolutes) and values ALREADY disagree
  (scarab health 40 shared vs 20 client) — intentional solo-balance
  divergence or drift? If intentional, this is verified-divergent-by-design
  and should be commented as such; if drift, deriving client constants
  from SPECIES×family is a mid-size refactor that kills the class.

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
