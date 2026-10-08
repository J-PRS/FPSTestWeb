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
10. **Future-cost debt** — structures that bill at scale, on low-end
    devices, or on bad networks: O(players^2) or O(rooms x players)
    work, per-frame/per-tick allocations that only hurt on a weak
    GPU/GC, wire chatter that multiplies with roster size, reconnect-
    storm amplification, single-owner state that blocks a second
    instance, giant flat structs standing in for a state machine, and
    "solved locally" patterns that should be one shared mechanism.
    Ask: what does this cost at 10x, on 4GB + integrated graphics, and
    when the link drops every third packet?

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

### 2.76 hpFrac missing from offline enemy entries (2026-10-08)

Last field in the enemy-list mirror. Server `ServerParties.of` feeds
`hpFrac` on every player entry — the burst-orbit pick (§2.74's
`preferredRange`) prices the hp left on the target, and every future
wounded-priority read will want it. The client's `enemyList` built
entries with id/pos/vel/alive/aimY only, so the orbit always priced a
full-health target. Local-player and bot entries now carry real hp
fractions (wire remotes legitimately stay undefined — the server marks
them the same way).

That closes the ctx/enemy mirror field-by-field: every sense the shared
brain reads is now either fed identically on both ends or deliberately
server-only (squad orchestration, influence map, human-chat notices).

### 2.77 enemy bodies mirror — client saw only the nearest creature (2026-10-08)

Server `ServerParties.of` pushes the ENTIRE bodies roster into
`enemies` (every ball `b:${id}`, every crawler `c:${id}`), while the
client `enemyList` injected a single `nearestCreature` result — so
offline bots could never weigh a far beast against a near one; nearest
won by list position, not by the brain's own pick. `SenseHost` now
carries the live `targets` roster and every `!dead && !scoreless` entry
lands as a `creature:${id}` enemy, matching the server's unfiltered
channel (scoreless decor stays out — the server's roster is
pops-declared creatures only; the `targets` list also carries ambient
birds, hence the filter where the server needs none).

Same sweep caught a class-10 churn sibling one call away:
`enemyBotsForLocal`/`enemyBotsForTeam` allocated a fresh array + entry
literal per call, and deployable scans (`foesFor`, rocket fan,
revenge-owner `some()`) call them per deployable per tick. Both now
fill pooled scratch (`_foePool`/`_foeOut`, count-based like §2.67) —
every consumer reads the list synchronously before the next call.

### 2.78 Deployable foe scans pooled (2026-10-08)

Same class-10 shape one frame later: `Deployables.foesFor` built a
fresh `{pos, vel, alive}` literal for every creature in the world on
EVERY deployable scan — turrets, drones and mines each rebuild the list
per think-tick, so a base with 3 sentries and 40 wildlife paid
~120 object allocs per scan pass on the frame budget. Creature entries
now come from `_foePool` (count-indexed, `playerId` cleared — bot foes
keep pushing their own pooled refs from §2.77's `_foeOut`).

### 2.80 RoomNoticer missed the rekey migration (2026-10-08)

Stale-key / duplicate-notice find: `TeamBots.rekeyBot` (the botMatch
jersey swap) migrates every per-id cell — thinkAccum, ctxCache,
ffaScores, dmgPool, senses, sheep — but not the §2.73 `RoomNoticer`.
Its `seen` receipt map stayed keyed on the old id: the defector could
react to the same room event twice under its new id, and a pending
notice kept pointing at the dead actor id. `RoomNoticer` gained
`rekey(oldId, newId)` (carries the seen stamp, re-points
`pending.actorId`) and `rekeyBot` calls it — pinned at the shared-owner
level since serverSenses shares the class.

### 2.81 Per-tick record encode allocations (2026-10-08)

The last steady-state alloc in the tick fanout: `encodeTickPlayerV3`
built a fresh ArrayBuffer + two views per record per tick (~640 tiny
allocs/s at 32 players). `encodeTickPlayerV3` now takes an optional
`TickEncodeScratch` (exported `tickEncodeScratch()` factory +
`TICK_PLAYER_V3_BYTES`); each pooled `scratchRecords` slot owns one and
the returned view aliases it until the next encode — safe because
records are consumed by `encodeTickFrame` inside the same tick.

Same suite run surfaced a stale pin from §2.73: `botUntrack.test.ts`
still read `sense.noticed` (the map RoomNoticer replaced) — updated to
peek `notices.seen` so the untrack purge covers the new owner.

### 2.79 Drowned-client drain never triggered on binary-only traffic (2026-10-08)

Bad-network find (class 10): the drown drain only ran inside the JSON
send paths (`sendToPlayer`/`broadcast`). Both binary lanes bypassed it:
`broadcastBinaryReliable` sent ball segments blind with no buffered
check at all, and `sendBinaryToPlayer` shed at 256KB but never fed the
clock — so a stalled reader pulling mostly binary traffic lingered
forever below `DROWN_BYTES` and was never closed, parking megabytes of
stale truth per socket on a dead room. Both paths now call
`drownCheck`: segments skip drowned sockets (reclaim's ballRoster
reseeds ball truth, so the skip is honest) and backlogged tick sends
feed the same 5s hysteresis. Pinned: binary-only stalled reader closes
with 1011 after the window.

### 2.75 Courage dropped from the offline pick (2026-10-08)

Same block, residual drift the §2.74 factory couldn't see: the senses'
`pickBotWeapon` call omitted `courage`, so every offline bot drew as if
its nerve were the default 0.5 — fearless heavies played timid and
skittish lights played brave. `botFire.resolveShot` (the actual draw)
already passed `bot.skill?.courage`, making the drift a senses-vs-gun
mismatch, not a shared default. Both pick closures now pass
`this.brain.skill.courage` — the senses' pick, the aim-skill pick, and
the fired pick all agree on the bot's nerve.

### 2.74 Weapon-sense hook mirror (2026-10-08)

Fourth mirror-drift find, the most concrete yet. The server senses feed
the brain ctx seven pick-based weapon hooks (speed, reach, fuse, arc
drop, orbit, cadence, splash); the client composition carried only four
and had *already drifted*: `weaponSpeed` used `speed || 60`, erasing the
hitscan 0 — offline beams led targets like shells, the exact bug the
server hook's own comment documents fixing online. Missing `weaponRange`
meant offline bots hosed air past a 55m beam; missing `fireInterval`
flattened every gun's trigger rhythm to a generic 0.45s; missing
`preferredRange` dropped the burst-fan orbit table.

All seven hooks now come from `botWeaponHooks(pick, lo)` in
shared/botWeaponHooks.ts — ONE factory both ends call, so the formulas
can't hand-drift a third time. `aimSkill` stays bespoke (its signature
carries the skill matrix). Remaining unmirrored senses are
orchestration-only by nature (posted/marshal/wave/runner = server squad
planner; imap* = server influence sim) — the offline roster has no
squad layer to feed them.

### 2.73 Room-event notice mirror (2026-10-08)

Third find in the mirror-drift lane. Server bots hear a `notice` sense —
flag grab/cap/return/drop, a teammate's line, match end — and the shared
brain turns it into a chatter reaction. The client ctx never filled the
field at all: solo bots were *deaf to room events*, not just half-deaf
like §2.71. The flag edges already surfaced on the client via
`onFlagEvent` (cue + explosion VFX) but carried no actor, so there was
nothing to mirror from.

Ported properly, not duplicated: the notice queue + per-bot side
translation moved into `RoomNoticer` in shared/botTaunts.ts — one owner
both ends call (server keeps `notice()`/`forget` wrappers). Flag events
now carry `actor {id,team}` at every callsite so `mine` can resolve
cheer-vs-groan; taken/dropped/returned/captured map onto the chatter
kinds. `reply` (bot spoke) and `gg` (match end) pings mirrored too —
the whole server notice surface, not just flags.

Human-chat notice kinds stay server-only by nature: solo has no chat
room to classify.

### 2.72 huntCreatures mirror drift (2026-10-08)

Class 9 again, same lane as §2.71. Server `huntCreatures` =
`mode==='nuggets' || any creatureSim.pops>0` — any map declaring
creature spawns turns the farm instinct on. The client mirror was
`mode==='nuggets'` only, so offline bots on creature maps ignored
wildlife entirely. Client now mirrors via a new `hasCreatures()` hook
(`entities.targets.some(!t.scoreless)` — scoreless ambient decor and
gnat fodder correctly don't count).

### 2.71 Noise-TTL mirror drift (2026-10-08)

Class 9 (drifted mirror) — server `Room.NOISE_TTL` was 2000ms but the
client `recentNoises` gate read `age > 1.5`, and a client test PINNED
the wrong constant ("age gate is 1.5s"), which is exactly how mirror
drift survives refactors. Offline bots heard 25% less than online ones.
`NOISE_TTL_MS` now lives in shared/wire.ts beside SERVER_TICK_MS; both
sides and the test derive from it.

### 2.70 Test writes into live logs (2026-10-08)

Found via the every-3rd-round log read: `client_warning.log` was
1300+ lines of identical `[WARN] probe` — `clientLogThrottle.test.ts`
drove the real route, which appended ~1400 probe lines per suite run
into the ops logs. Real warns were unreadable inside the flood (the
route worked correctly; the test just aimed at the live dir). The
route's log dir is now injectable and the test writes to a temp dir.
fastSoak audited clean — its appends only fire under FPS_SHEEP_LOG.

### 2.69 Threat-sense result arrays (2026-10-07)

Class 10, server think loop. `shellsNear` rebuilt `idx` + `idx.map(...)`
arrays per call — 2 allocs × per bot per think (~10Hz each) in the
threat sense. Result scratches now pooled on the manager (`shellIdx`/
`shellOut`); sole consumer `incomingNear` reads it synchronously.
Server side pushes live pos refs, so no §2.68-style alias exists —
noise/threat senses return live objects, never pooled writes.

### 2.68 Sense-pool slot aliasing (2026-10-07)

Real bug, pooled-scratch class. `recentNoises` rewound `_vecUsed` after
writing, so `incomingNear` — called immediately after in `fillSenses` —
reallocated the SAME pool slots, mutating the vec objects `ctx.sounds`
still referenced: a bot with a nearby threat heard blasts at the
projectile's position instead of the true noise. The rewind is gone;
`_vecUsed` resets per-think in `enemyList`, so sounds/threats entries
now occupy distinct slots for the whole synchronous consume. Other
sense arrays audited clean: `enemyList`/`alliesOf`/`bodyScratch`/`ctxCache`
all pool correctly.

### 2.67 Separation-sense capsule churn (2026-10-07)

Class 10, client frame loop. `Bots.update` rebuilt `bodyScratch` with a
fresh literal per live bot per frame AND called `classCapsule` twice
per bot — ~3 allocs/bot/frame (~3.6k/s at 20 bots, GC churn on
low-end). Entries now pooled per index (length trimmed only at end).
Audited clean first: `enemyList` was already pooled (`_enemies`/
`nextBot`/`nextVec`), `ctxFor` reuses its scratch, `othersScratch`
pushes live refs not copies.

### 2.66 Flag tick prevPos snapshot (2026-10-07)

Class 10 + 9 (drifted sibling): `RoomFlags.tick` ran the IDENTICAL
per-player `{...position}` prevPos alloc RoomPickups had — the sweep-
segment pattern's two implementations. Same field-wise reuse fix.
No other prevPos/prevSeg snapshot sites remain — lane closed.

### 2.65 Pickup tick alloc churn (2026-10-07)

Class 10, third cut in the same shape. `RoomPickups.tick` allocated a
roster array copy plus one `{...position}` snapshot PER PLAYER per
tick (~20Hz). Now iterates the live map and reuses the stored `prevPos`
Vec3 with field-wise writes (it must stay a snapshot, not an alias).
Audited clean while hunting: rewind ring (~8-entry shift is bounded),
tick decode pool, blast/AoE sweeps are per-event, drainCommands early-
exits, effStructures is O(spec) and boot/join-only.

### 2.64 Field-wise anchors in moveClaims (2026-10-07)

Class 10, same shape as §2.63. `plausible()` spread-allocated
`lastPosCheckPos` on EVERY position report (~20Hz/player) and the
authority path spread `player.rotation` per report — field-wise
writes now. Rare paths (teleport/resync/correction commits) keep
their spreads for readability.

### 2.63 In-place writes on the position ingest (2026-10-07)

Class 10 (future-cost debt). `PlayerManager.updatePosition` spread-
allocated 3 objects per report + 3 more per seq advance — the
server's hottest ingest (~N players × report Hz × 3-6 short-lived
objects). Same shape as the §2.11 flag-carrier storm. Field-wise
writes now mutate `position`/`rotation`/`velocity` and the
`lastValid*` triple in place; no reference-identity consumers exist
(swept). Verified by predictionChaos + reseedChaos, which drive this
exact path.

### 2.62 Echo frames out of the reclaim journal (2026-10-07)

Class 10 (future-cost debt). `sendToPlayer` journaled every frame —
including the `yourHealth`/`yourCharge` per-player echoes (~2Hz each
while active). At a full roster that's ~N journal pushes/s burning a
fixed 1024-frame replay window: ~64-128 pushes/s churns the window to
~8-16s of history, so a >10s grace reconnect silently loses broadcast
truth (kills, flag edges, chat) — `reclaimGap` fires, events are gone.
New `NO_JOURNAL_TYPES` skips journaling both echoes: a dead socket
can't consume them, gameState reseeds health on reclaim, and live
echoes self-repeat at 2Hz. Journal churn in a healing-heavy room
roughly halves; broadcast history per byte doubles.

### 2.61 windowAllow — one sliding-window throttle owner (2026-10-07)

Class 9. The `{count, start}` 60s-IP-window rate limiter was
hand-rolled identically in THREE files: `SessionManager.joinWindows`,
`clientLogs.postIps`, `serverRoutes.joinIps` — and had already
drifted: only SessionManager dropped expired windows before
evicting; the other two's §2.59 conversions evicted eldest blindly.
`windowLimit.ts` owns the whole contract now (reset-or-count,
stale-sweep then eldest-evict at cap); loopback bypasses stay
per-site.

### 2.60 finiteVec — one NaN-guard owner (2026-10-07)

Class 9, second cut. The §2.55/2.56 NaN-ingress fix introduced the
finite-vector check as a hand-rolled local in FOUR client files
(`net/players.ts`, `net/world.ts`, `netBalls.ts`, `netCrawlers.ts`) —
the exact driftable duplicate the class hunts. `finiteVec` now lives
in `shared/wire.ts` next to `WireVec3`; all four funnels call it.
(The server's `validateVec3` keeps its own contract — it returns
error strings, not a bool.)

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
- ~~**Residual `Movement cheat` warns under sustained input gaps**~~ -
  *closed (2.135)*: the soak's hypothesis confirmed and fixed - an open
  gap past the defer window now scales the severe bar by the
  starved-input deficit (speed x gap age, capped 2s). Divergences and
  corrections unchanged; strikes wait for a divergence the credit can't
  explain. Pinned in roomMoveSim.test: ~70m at 30 m/s inside a ~0.6s gap
  banks nothing; 300m still latches.
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

### 2.82 Rotated log archives grew unbounded + root-clutter gate (2026-10-08)

`rotateLogIfBig` bounds the live file at 32MB but every roll landed in
`OLD/` forever — a spamming appender filled the disk through the roll
itself, which defeats the point of rotation. `OLD/` now keeps the
newest 16 archives per dir (`pruneOld`, mtime-ordered). Verified:
20 rolls leave exactly 16.

Second half is prevention, not a fix: `_rootcheck.mjs` gates repo-root
clutter — wired into client's `npm run check` ahead of tsc/oxlint/
vitest, failing on any root entry outside the allowlist (scratch
probes, captures, stray dumps). 45 `.devin_*` probe files moved to
`_tools/devin_scratch/` rather than deleted; 27 user-owned strays
(`1`, `1000`, `tas_film*.mp4`, `anyshaz.*`, `names.md`, root
`package.json`/lock, `.rebase_*`, `.cpu_check.ps1`, `.tas_*.log`,
`overview_v*.py.old`, `__RUN.bat`) stay flagged until each gets a
home or an allowlist entry.

### 2.82 - end

### 2.83 distSq drift — two local copies of the brain-family helper (2026-10-08)

Class 9: `distSq`/`dist3` live in `shared/botVec.ts` precisely because
files kept carrying private copies — and two more had regrown anyway:
`botGoals.ts` shadowed `distSq` (byte-identical 3D — now imports the
owner) and `botHunt.ts` shadowed BOTH, with its `distSq` silently 2D
(x,z only) under the shared name — a name collision that makes the next
"just import the helper" fix *change behavior* by pulling altitude into
orbit-reach checks. `botHunt` now imports shared `dist3` and its
horizontal helper is renamed `distSqXZ` so the semantic difference
can't hide behind the shared name again � then promoted into botVec
itself when the same inline `(x) ** 2 + (z) ** 2` expression turned
up twice more in `botSteer` (separation gather + memory-prune). Its
signature takes `Pick<BotVec,'x'|'z'>` so 2D records typecheck.

### 2.83 - end

### 2.84 RTC adapter reported only the ctrl lane's backpressure (2026-10-08)

Same class as §2.79's binary drain, one layer down: the RtcServer
adapter multiplexes every peer over two datachannels — 'game'
(unordered, all WIRE_TICK fanout) and 'ctrl' (ordered, JSON + ball
segments). `getBufferedAmount()` read `ctrl ?? game`, so while a stalled
peer's game channel ballooned with 20Hz tick frames the drown drain
saw ctrl's ~0 and never fired. It now reports `max(game, ctrl)` — the
worst lane is the one that matters.

Same pass found `send()` wrapping every binary frame in
`new Uint8Array(msg)` � msg already IS a Uint8Array, so each
sendMessageBinary copied the whole frame for nothing (~20Hz � peers �
~200B of pure churn on the tick fanout). Passes the buffer through now.

### 2.84 - end

### 2.85 Zero-guarded XZ normalize — five hand-rolled copies (2026-10-08)

Class 9, same family as §2.83: the `Math.hypot(dx, dz) || 1` →
`dx/l, dz/l` pattern was hand-rolled in five places (botDisposition ×3,
botEscape ×2). `dirXZ` now owns it in botVec. One site was quietly
WRONG beyond duplication: the pickup-projection divided an XZ vector
by a 3D distance (`dist3`), so a pickup on a different floor shrank
the unit vector and made the onRoute gate stricter than intended —
the shared helper normalizes properly on XZ, a mild semantic fix.

Second wave found five MORE clones the first pass missed
(botLines �2 escape/homing dot-products, botSteer sway heading,
botHunt shooter-motion projection + retreatDest). Same collapse;
the scalar-reuse sites (standoff `sd`, dodge `tl`, steer `al`,
disposition `od`/`ptd`) correctly keep their hypot.

### 2.85 - end

### 2.86 Guarded 3D normalize — the same family in the creature files (2026-10-08)

Third wave of the normalize family: `Math.sqrt(dx²+dy²+dz²) || 0.001`
appeared in creatureFlyer and creatureTotem with a subtly DIFFERENT
guard than the `||1` convention — on sub-millimeter separations the
0.001 guard scaled the "unit" vector by d/0.001 (a 0.5mm gap produced
a half-length direction). `dir3` in botVec owns it now with the `||1`
guard, which keeps tiny inputs unit-length. ballSim's two `||1`
magnitude-ratio uses (bounce speed preservation) correctly stayed —
they need the scalar, not a direction.

### 2.86 - end

### 2.87 Rubberband warn-receipt maps grew unbounded (2026-10-08)

Stale-key class: `rbLastWarn`/`rbSuppressed` are keyed by ball id, but
the warn closure can't see the roster prune (pruneNetBalls lives one
scope out) — a long match churns ids and both maps grew for the
session's life. Evict-oldest cap at 512 receipts; a dropped receipt
just re-arms one warn line instead of growing memory. Bound map is
the file's own convention (server cappedSet/§2.59 evictEldest, same
shape).

### 2.87 - end

### 2.88 RekeyBot missed five id-keyed meter owners (2026-10-08)

Same drift family as §2.80: a jersey swap migrates every per-id meter
through rekeyBot, but five owners had no rekey hook at all —
botFire.lastShotAt (fresh cadence), BotWatchdog's logic/render/anchor/
stuck/stalled (dead-id samples + warn re-arm), ctfFlags.roles (a
rekeyed specialist was read as unassigned and re-rolled a generic
role), CtfBridge.lastTouchPos and FlagRunBridge's lastTouchPos/V
(touch-velocity receipt continuity). Each owner now has rekey() and
rekeyBot fans out to all of them — the migration can't drift a
fourth time.

### 2.88 - end

### 2.89 Flag event logs grew for the room's life (2026-10-08)

Stale-buffer class: capLog/grabLog/retLog accrete one entry per flag
grab/cap/return forever — matches are seamless so a long-lived room
never bounds them. Every reader windows by `at >= runStart`, so the
match-end reset now wipes all three: prior-match rows only ever read
as noise anyway. (Old logs also hid a subtler issue — a test reading
`capLog` across rounds could silently pass on a previous match's
capture.)

### 2.89 - end

### 2.90 Rekey fan-out pinned component-by-component (2026-10-08)

Pin class: §2.88 proved rekeyBot's fan-out rots — four id-keyed
registries had drifted out of it — but the fix itself had zero test
coverage, so the next map added without a `rekey` hop would fail
silently the same way. `botRekey.test.ts` now asserts each component's
rekey migrates its private maps (BotFire cadence, BotWatchdog
samples/anchors/warn sets, BotSenses foeSeen cache, CtfFlags roles,
FlagRun touch meters, RoomNoticer receipts + pending actor). Server
side was already pinned by botUntrack.test.ts; this closes the client
mirror.

### 2.90 - end

### 2.91 Depart funnel pinned — room registries purge on removal (2026-10-08)

Pin class, server mirror of §2.90: removePlayerCompletely is THE
player-depart funnel (kick, idle reap, room hop, bot retire all land
here) but only the BOT half was pinned — wireIds/sessionTokens/
lastSentPositions/chatPace/rateLimiter cleanup had no test. A new
player-keyed map added without a delete would re-leak silently the
same class §2.58-§2.90 kept fixing. departFunnel.test.ts seeds the
receipts then asserts every registry purges on removal.

### 2.91 - end

### 2.92 Flag-reset log wipe pinned (2026-10-08)

Pin class: §2.89's match-boundary wipe of capLog/grabLog/retLog had no
coverage — the reset test checked flag state only, so the wipe could
silently regress (or a new log could be added without a reset hop).
Extended roomflags.test.ts: seed the three logs, reset, assert empty.
RoomFlags consumers window by runStart so wipe-at-reset is the only
bound the logs have.

### 2.92 - end

### 2.93 Client depart funnel pinned — wire-player receipts purge on remove (2026-10-08)

Pin class, client mirror of §2.91: remotePlayers' onRemove is the
client depart funnel (wire leave, roster prune, idle reap) — it
deletes aliveSince/killCounts/lastWeaponByPlayer and forgets HUD
indicators + health bars, none of it previously covered.
remoteRemove.test.ts drives the real createRemotes hook chain and
asserts each receipt dies with the id. aliveSince itself is
module-private but has pruneAliveSince as a second line of defense.

### 2.93 - end

### 2.94 Offline match-boundary funnel pinned (2026-10-08)

Pin class: resetMatch zeroes over/scores/ffaScores/dmgPool, re-arms
ctf/rabbit/flagrun, respawns the dead and re-proves the living — all
previously unasserted. resetMatch.test.ts stubs MatchHost and checks
every receipt drains; a new per-match map added without a reset hop
now fails a test instead of leaking the last match's meters into the
next one.

### 2.94 - end

### 2.95 Combat-side disconnect funnel pinned end-to-end (2026-10-08)

Pin class: onPlayerDisconnected purges seven per-player maps — only
the two warn throttles had coverage. fireWindows/healTicks/lastHeal/
lastFireNotify/chargeBank.ramp were unasserted; a new keyed map added
without a delete hop would regrow silently per leaver. Extended
rejectWarnCleanup to seed every map then assert all empty. Also
verified the remaining entity-death lanes (CreatureSim edgeSeq/
skipCount, BallSim resyncAcc/retargetAcc) delete on death.

### 2.95 - end

### 2.96 Spectator depart funnel pinned (2026-10-08)

Pin class, last funnel: departSpectator collapses four stores (room
spectators, connections, specRooms index, registry seat) but had no
coverage — the audit-added funnel could silently regress to the old
dual inline paths. specDepart.test.ts drives a real spectate join
through GameServer, departs, asserts all four purge plus the player-
seat refusal. Broadcast/serialization lane audited clean first:
serialize-once in frame(), journal bounded, drown checks on all
three send lanes, snapshot buffer pools its reclaim path.

### 2.96 - end

### 2.97 Respawn tick-vs-wall-timer double-fire (2026-10-08)

Real correctness bug hiding in the timer audit: RespawnManager.tick
consumed dueAt/timers entries but left the armed wall setTimeout — the
callback fires unconditionally, so sim-paced drivers (demo/fast-forward
rooms) broadcast playerRespawn twice per death. tick now clearTimeouts
the timer it consumes; both orders are safe (wall-first deletes
bookkeeping, tick skips). The full lifecycle is now pinned: deadline
fires exactly once, second-death replaces (no stack), cancel drains,
held corpse lapses silently until respawnNow, respawnNow can't skip an
unheld countdown, ensure re-arms a reconnecting dead player, dispose
drains everything with the room.

### 2.97 - end

### 2.98 Room-mint cap (2026-10-08)

Class-10 DoS bound: joins may name any room, so a script cycling fresh
names grew `rooms` forever — hibernation stops the sim cost, not the
memory (a Room is ~200KB+ of sims) or the per-tick map iteration.
CONFIG.maxRooms (256, FPS_MAX_ROOMS) bounds it: past the cap, minting
recycles the eldest audience-less room (getHumanCount==0 && no
spectators — an empty room loses nothing, its name remints on next
join); only a roster of genuinely live rooms refuses the mint.
roomFor/quickRoom now return Room|null; join closes 1013 'Server
full', switchRoom sends a matchNotice, the /quickroom HTTP route 503s.
roomCap.test.ts pins all four branches.

### 2.98 - end

### 2.99 Recycle-path dispose pin (2026-10-08)

§2.98's recycle calls room.dispose() — verified the chain actually
reaches the wall-clock edges: Room.dispose → messages → combat →
respawner.dispose drains pending respawn setTimeouts, so a recycled
bot-corpse room can't fire playerRespawn into a world nobody reaches.
roomCap.test.ts fifth pin: a bot corpse with an armed respawn timer,
recycle, timers drained to zero. Audit along the way: spectate joins
were already per-room capped (maxPlayers), MapCatalog's name-keyed
maps all cap+evict (roomMapName 256, specMisses 512, specs bounded by
disk), the pre-join socket path is bounded by the 15s join deadline +
per-IP join throttle, and auto-quality/localStorage write paths are
event-only. The unbounded-input lane is clean.

### 2.99 - end

### 2.100 playerRoom index pin (2026-10-08)

§2.91 pinned the room-level depart funnel; the GameServer wrapper
above it owns playerRoom + ops.leaves, untested until now. roomCap
test drives a real join, calls the wrapper, asserts the playerId→room
index entry dies — a stale entry would route messages from a ghost id
into a dead room forever. Lane audit along the way: WS payload size
bounded (CONFIG.maxPayloadLength), every server setTimeout is
owner-tracked (killFeed pending, registry grace, RtcServer stale,
join deadline), demo remoteFrames prunes at the same rolling window as
the ring buffer, pendingClips merge + clear on record start.

### 2.100 - end

### 2.101 Spectate-cap pin (2026-10-08)

The per-room spectator bound (spectators.size >= maxPlayers → 1013)
existed but had no coverage. specDepart.test.ts now fills a room's
spectator seats to the cap and asserts the over-cap join closes 1013
with no seat, no specRooms entry and no registry record minted — a
silent cap regression would leak tick-fanout targets per forged
socket. Lane audit: client fx lists (debris, pdebris, scorches,
splats, implosions) are event-spawned with life + 1.5ms resumable
deadlines and distance gating; demo remoteFrames/events prune at the
rolling buffer window; server payload size bounded at transport.

### 2.101 - end

### 2.102 Command-buffer backstop pin (2026-10-08)

The room.commands 2000-entry cap was the last unpinned bound on the
wire path: a validated-message flood parking between drains would grow
the queue unboundedly and stall the cmd phase for the room. New
cmdBackstop.test.ts parks the buffer at the cap, sends a valid
message, asserts the drop + msgsRejected increment; a second test
proves normal traffic still lands. Lane audit: every wire type rides
the rate-limit table or the shared 120/s default bucket; claim/hit/
env/shot ledgers are all capped (spent 512, PROBE_CAP tail, kills 256);
moveSim shadows untrack on both disconnect and removal.

### 2.102 - end

### 2.103 Room-name grammar collapse (2026-10-08)

Class-9 drift collapse: the room/map/mode name grammar
(/^[\w-]{1,32}$/) existed twice — SessionManager.ROOM_NAME_RE for the
join handshake, a private `word()` in roomSwitch for hops. Identical
today, divergent tomorrow: join could mint rooms hop refuses. wire.ts
now owns ROOM_NAME_RE + roomWord(); both call sites share it. Also
fixed two latent tsc errors in the §2.98/§2.102 test files (readonly
CONFIG.maxRooms assignment → cast, commands msg:{} → as never) that
surfaced under a full-project typecheck.

### 2.103 - end

### 2.104 Recycled room name leaks tick fault state (2026-10-08)

Correctness hole inside §2.98's room-cap recycle: TickLoop's
tickErrStreak/tickQuarantined are keyed by room NAME, but the recycle
path only deleted the rooms entry — a remint under the same name
inherited the corpse's streak and could quarantine on its first tick
error (or be born quarantined if the recycled room was mid-fault).
RoomFactoryHost gained forgetRoom(name) delegating to a new
TickLoop.forgetRoom that drops both maps; faultedRooms stays since
that set is ops history, not sim gating. Pinned: a recycled 'a' with
a live streak+quarantine mints clean.

### 2.104 - end

### 2.105 /stats reparse-per-request bounded (2026-10-08)

DoS bound on a public route: /stats aggregated the lifetime leaderboard
by reading + JSON.parsing the ENTIRE append-only matches.jsonl on every
request — the file only grows, so a poll storm turns the server into a
JSON parser. Journal mutations are server-side only (recordEnd on match
end), so a cache keyed on file size bounds it to one parse per match.
statsCache is {size, rows}; a stat miss (no journal) skips caching.
Journal path is now constructor-injectable so the pin tests in a tmp
dir, not live logs/. Pinned: unchanged file returns the same rows
object; growth re-aggregates.

### 2.105 - end

### 2.106 /demos listing stat-sweep bounded (2026-10-08)

Same public-route class as §2.105: listDemos stat'ed every index entry
(existsSync x up to 100) on EVERY request — synchronous stat calls block
the loop, so a poll storm on /demos was real CPU DoS. A 5s listCache
bounds it to one sweep per window; uploads/evictions invalidate through
saveIndex so fresh clips still appear instantly. Pinned: repeat lists
return the same rows (stat sweep proven absent — deleted file still
serves until expiry), expiry re-sweeps, saveIndex invalidates. Rest of
the ungated route table audited clean: /maps TTL-cached 30s, /matches
ring in-memory, /rooms bounded by room cap, /join per-IP throttled,
/wthash + /rtcconfig constants, /health in-memory.

### 2.106 - end

### 2.107 Route guards pinned black-box (2026-10-08)

The HTTP route guards had zero coverage — a regression in any of them
silently re-opens a DoS lane: /join's per-IP mint throttle (the gate
§2.98's room cap depends on), the ops gate on /metrics /status
/weaponstats (leaks the "when is the server weakest" readout), and the
join mode/map validators. routeGuards.test.ts drives makeRoutes with a
fake HttpCtx and asserts: 5/mint budget per IP + localhost exempt, bad
mode and unknown map 400, ops 401 without token / 200 bearer-or-key,
dev-open when the token is unset.

### 2.107 - end

### 2.108 RoomNoticer extracted — botTaunts back under its size pin (2026-10-08)

The §2.73 noticer port pushed shared/botTaunts.ts to 1284 — 15% over its
sizeWatch grandfather pin (1099). Honest fix, not a pin bump: the
self-contained RoomNoticer class moved to shared/roomNoticer.ts
(bots.ts, serverSenses.ts, both test files re-pointed), leaving
botTaunts at 1237 — back inside the pinned +15% allowance. Same round:
a pin for claimedIdentities' 10k half-eviction (identityCap.test.ts) —
the last unpinned bound on the join path. Full-server suite gate:
everything green except the known soakChaos p95 from the committed
moveJudge WIP.

### 2.108 - end

### 2.109 Join-deadline extracted + pinned (2026-10-08)

The onOpen 15s join deadline — the bound that keeps a connected-but-
never-joined socket from sitting forever — was a bare 15000 literal,
untestable. Now CONFIG.joinTimeoutMs (FPS_JOIN_TIMEOUT_MS), and
joinDeadline.test.ts pins both halves: an idle socket closes
1000/'join timeout', a joined one rides through. Room-scoped
accumulator sweep alongside: outsideSince / RoomPickups.prevPos /
RoomFlags.prevPos all prune against the live roster per tick;
lastSentPositions / chatPace / wireIds purge inside removePlayer.

### 2.109 - end

### 2.110 Private-room contract pinned (2026-10-08)

Info-disclosure lane: the unlisted flag was guarded by two bare filters
(listRooms' !r.unlisted, quickRoom's continue) with zero coverage — a
dropped filter silently leaks private room names + occupancy to the
public browse, or lands a random quick-joiner inside a private match.
unlisted.test.ts pins all three edges: hidden from /rooms, skipped by
quickRoom, still joinable by name. Rest of the disclosure sweep: no
tokens/IPs on any ungated route; ffaLeader playerId is public match
state by design; /health stays open — its degraded detail only exists
when the failure is already visible in-game.

### 2.110 - end

### 2.111 Reconnect contract pinned (2026-10-11)

WebSocketConnection's reconnect machinery — the only thing standing
between a dropped tab and a dead session — had zero coverage across its
five guarantees: deliberate disconnect() must not resurrect via the
async close handler, a sub-5s session is a flap candidate and gets 4x
backoff, a long-lived session retries at base interval, the offline
queue caps at 100, and KEEP_NEWEST/binary lanes dedupe to the freshest
entry. wsReconnect.test.ts drives all five via a fake WebSocket + fake
timers. A formula slip or cap removal now fails a test instead of
silently storming the server or leaking queue growth.

### 2.111 - end

### 2.112 Wire limit table pinned (2026-10-11)

The rate-limit TABLE itself was unverified — ratelimiter.test.ts only
pins bucket mechanics, so snapshotRequest's 3/5s could silently loosen
to the 120/s default and reopen the reserialize DoS. wireLimits.test.ts
pins one-direction tightness bounds (never ALLOW more): reserialize
types stay <=3/5s, broadcast-churn types (throwFlag, chat) stay far
below the default with chat's 10s mute, and the default lane itself
stays <=120/s. A new expensive type landing on 'default' now fails a
test instead of shipping unbounded.

### 2.112 - end

### 2.113 Display-name sanitize pinned (2026-10-11)

The wire name lands verbatim in DOM text on every client (scoreboard,
kill feed, chat) — nameSpec's control-byte strip + whitespace collapse +
24ch cap was the only scrub and had zero coverage. nameSpec.test.ts
drives hostile names through the real join path: control bytes die,
a 10KB name caps at 24, and empty-after-sanitize stays undefined rather
than storing '' that downstream would render as a blank row.

### 2.113 - end

### 2.114 Private-room hop pinned (2026-10-11)

The unlisted contract had one unverified edge left: switchRoom carries
msg.unlisted into roomFor — a private-minting hop that dropped the flag
would leak the room into /rooms the moment it formed, and a regression
in targeted joins would strand friends outside. unlisted.test.ts now
drives a real hop: minting with unlisted:true yields a room hidden from
/rooms, and a second player hopping BY NAME lands inside — the flag
hides from browse, never from a targeted join. Reclaim/onClose gen-check
lanes audited already-pinned (reconnect.test.ts covers token reject,
zombie evict, replay window).

### 2.114 - end

### 2.115 Protocol-mismatch reload pinned (2026-10-11)

The stale-bundle escape (protocolVersion mismatch -> force one
cache-busted reload, capped at 2 via a sessionStorage budget) was
unverified on every edge: a dropped early-return would let a
mismatched gameState rewrite world meta, and a lost cap would
reload-loop the tab against a genuinely newer server. netHarness.test.ts
now drives the full lifecycle — mismatch bails before the swap,
counter climbs 1->2 and stops, clean connect resets the budget.

### 2.115 - end

### 2.116 Settings store survives dead localStorage (2026-10-11)

Every fps-* read/write funnels through core/settings.ts — and every
call hit raw localStorage. In Safari private mode or storage-disabled
embeds the API throws on read AND write: get() at boot would kill the
app outright, and set() on any toggle would crash mid-session on a
device that could otherwise play fine. A tiny store shim now try/catches
each op with a session-only Map shadow — settings still work for the
session, just don't persist. Pinned: settings.test.ts drives a
fully-throwing localStorage through set/get/has/remove.

### 2.116 - end

### 2.117 Last raw storage site wrapped (2026-10-11)

§2.116's sweep had one survivor: the fps-proto-reload sessionStorage
counter in handleGameState — a throwing storage (private mode) would
crash the handler mid-frame right when the client most needs the bail
path. The counter read is now try/catch (dead counter = budget spent:
warn + return), the setItem+nav block is wrapped, and the clean-connect
removeItem can't throw. Audit: lastRoom.ts already wrapped; identity
rides settings (safe since 2.116). netHarness.test.ts pins a
fully-throwing sessionStorage through the mismatch path — warns, bails,
no crash.

### 2.117 - end

### 2.118 Room-hop cooldown pinned (2026-10-11)

The 1500ms per-player hop cooldown is the only bound between a client
and room-mint spam: without it switchRoom name-spam churns roomFor at
message rate. It was implemented (mark-on-attempt, per-player key,
1024-cap evictEldest) but unverified — a dropped throttled() call would
silently reopen the lane. roomswitch.test.ts now drives the wire path:
a second hop inside the window is refused (player stays put, no room
mint), and a different player hops freely under the per-player key.

### 2.118 - end

### 2.119 Room hibernation pinned (2026-10-11)

The audience gate (no humans + no spectators -> dormant ball/creature
sims, skip the whole room tick) is what keeps a lobby full of empty
named rooms cheap — and what keeps a bot-only 'default' from simming
forever. It had zero coverage; a dropped `!audience` would burn CPU on
every empty room and silently grow crawler populations dumped on the
next joiner. hibernation.test.ts drives tickRoomGuarded: dormant with
no audience, live the tick after a human joins.

### 2.119 - end

### 2.120 Join seat caps pinned (2026-10-11)

Both join-refusal caps were unverified: the per-room seat count AND the
process-wide globalMaxPlayers budget — the number that actually protects
latency since rooms share one core. joinGuard.test.ts now drives each
to its cap and asserts the over-cap join closes 1013 'Server full'
with the roster unchanged. A dropped check reopens unbounded seating —
the flood throttle only gates mint RATE, not total bodies.

### 2.120 - end

### 2.121 Spectators count toward the process budget (2026-10-11)

globalMaxPlayers counted players only — spectators rode the per-room
cap alone, so a watcher fleet across many rooms could seat thousands
of tick-fanout targets while the process budget read 0 players. Every
entry path now counts players + specRooms against the budget:
SessionManager join + spectate close 1013, and RoomSwitcher.roomFull
denies the hop (SwitchHost gained specRooms). specDepart.test.ts pins
both spectator refusals; roomswitch.test.ts pins the hop denial.

### 2.121 - end

### 2.122 windowAllow primitive pinned (2026-10-11)

The sliding-window throttle behind /join, /demos/upload, /client-log
and the WS handshake had no direct coverage — endpoints pin the
5/min behavior but not the subtle part: under cap pressure it sweeps
EXPIRED windows first, then evicts oldest — a wholesale clear() would
grant every live flooder a fresh budget at once (the amnesty bug the
comment warns about). windowLimit.test.ts pins all three invariants:
window reset on fresh claim, expired-first sweep keeping live keys
throttled, and oldest-evict with no mass reset under an all-live map.

### 2.122 - end

### 2.123 /client-log body pre-cap (2026-10-11)

The 512KB cap only ran AFTER req.text() buffered the whole body — an
honest giant POST paid full memory before rejection, while
/demos/upload already refused on the declared content-length first.
The route now checks content-length up front (lied/missing headers
still hit the real cap after buffering). clientLogThrottle.test.ts
pins both halves: declared-giant 413 without ever reading the body,
lied-header still 413 on the actual bytes.

### 2.123 - end

### 2.124 Rejected-join registry invariant (2026-10-11)

registry.begin() only runs on the success path — every reject
(throttle, bad handshake, denied claim, full seat) returns first —
but nothing pinned it. A future reorder leaks a 'connecting' record
that never seats and never reaps; worse, begin() on a live id
overwrites the real record with a fresh generation. joinGuard.test.ts
now asserts denied joins leave zero registry state AND that a denied
claim keeps the victim's 'active' seat untouched (a thief's begin
would have flipped it to 'connecting').

### 2.124 - end

### 2.125 Grace ledger balance pinned (2026-10-11)

roomGrace feeds Room.empty's per-tick dispose check — drift either
way breaks teardown: a leaked +1 keeps an empty room immortal, a
spurious -1 marks it empty while ghosts can still reclaim (and a
reclaiming player lands in a dying room). graceLedger.test.ts pins
the balance on every exit path: disconnect in, reclaim out,
terminate out, re-begin releasing the OLD room's count, and
independent counting across multiple ghosts.

### 2.125 - end

### 2.126 - Display names: strip unicode format chars
`nameSpec` scrubbed C0/C1 control bytes but left unicode format (Cf) chars
live: bidi overrides (`\u202a`-`\u202e`) render reversed text in
scoreboard/chat (name spoofing), zero-width chars (`\u200b`-`\u200f`,
`\u2060`-`\u2064`, `\u2066`-`\u2069`, `\ufeff`) make names invisible or
visually impersonable. The sanitize now strips them too. `nameSpec.test.ts`
pins the spoof cases + all-invisible stays `undefined`.
### 2.126 - end

### 2.127 - Demo download path guard pin
`/demos/:file` is a public unauthenticated read; `loadDemo`'s filename
check (no `..`/`/`/`\`, must end `.demo`) is the only thing between a
request and arbitrary local file reads. `demoDownload.test.ts` drives it
with a planted `../outside.demo` + separator/absolute variants and a real
clip load. A dropped guard fails the test instead of leaking disk files.
### 2.127 - end

### 2.128 - dropWarnKeys collapse
`MessageHandler` swept `rateLimitWarnings`' `${id}:${type}` keys with two
identical inline loops (onPlayerDisconnected + onPlayerRemoved) - the
second loop existed only because a comment explained why room-hops also
need it. Extracted `dropWarnKeys(playerId)`; both teardown paths share it,
so a future warn-key shape change has one owner.
### 2.128 - end

### 2.129 - specFor resolution pin
The room mint resolves room name + client mode/map claims through a
fallback chain (name -> numbered base -> map arg -> mode) with a legality
gate (`specModes(spec).includes(mode)` or the spec default wins).
`specFor.test.ts` pins the order, the swap gate (a dm request on a ctf
map keeps flag rules, never sprouts stands), bots override, and the
no-spec default. Also ran the FULL server suite: 1249/1250, only failure
the known soakChaos p95 regression from moveJudge WIP 00bc1f32.
### 2.129 - end

### 2.130 - botUntrack pin widened to delegated teardowns
`ServerBots.untrack` drains 19 structures but the pin only checked 17 -
the delegated arsenal (trigger/propelT/wasCarrying/lastShot/propels...)
and roster (roles/classes) teardowns were unverified; a dropped delete
inside `BotArsenal.untrack` or `BotRoster.forget` would leak silently.
The pin now seeds and asserts every delegated map too (26 structures).
Full map census: all remaining keyed maps audited clean (TeamId-keyed
senses maps bounded by team count; groundMemo bounded by stand count).
### 2.130 - end

### 2.131 - moveJudge young-gap defer: correct, do not starve

Commit 00bc1f32 deferred the WHOLE judge (compare, divergence banking,
and correction emit) while an uncovered input-seq gap was younger than
INPUT_GAP_DEFER_MS. Deferring strike banking is the right instinct - a
producing inputMove still in flight cannot be honestly judged - but
deferring the correction itself starved convergence: a legitimately
diverging client inside the window got no snap for up to 600ms.

Now the gate splits the two: gapYoung reports still compare and still
emit corrections (enforcement preserved, corrections anchor at
lastInputSeq so the in-flight input replays client-side), but
noteDivergence/noteSevere bank nothing until the edge is judged lost
or recovered.

Bisect note for the parked soakChaos regression: the defer was NOT the
mover - pre-WIP gate code on HEAD deps produces the identical tail-err
p95 (8.08). Commit 00bc1f32 itself measured 10.68; later commits
(likely 2.97's respawn-timer double-fire fix) recovered it to 8.08.
The residual vs the <5 bound is ~10% of the tail sitting in
post-reconnect recovery windows (dropEveryMs=4000/outageMs=1200),
elevated since the respawn-rule/struct-kits era - tracked as its own
follow-up, not a defer problem.
### 2.131 - end

### 2.132 - soakChaos gate measures healed error, not outage drift

The soak's tail-p95<5 gate sampled every client frame including the
1200ms outages: while a socket is dead the server shadow sims on stale
input so the two trajectories legitimately drift ~10m apart. ~10% of
the tail sat inside those [drop, reconnect+converge] windows, pinning
the bound red since the respawn-rules/struct-kits era (the
misattributed "defer window" blame died on bisect - identical p95 with
the pre-WIP gate). bridge.ts now records reconnectAt; the test filters
each outage + 1s heal grace out of the tail and keeps the <5 bound on
what it actually meant: connected, settled prediction. Healed p95 on
the current sim: 2.77m - prediction converges correctly after every
reconnect, the old bound just couldn't see it.
### 2.132 - end

### 2.133 - logRotate collision clobber + full pin coverage

rotateLogIfBig stamped archives with second-precision mtimes - two
rolls in one second landed on the same name and renameSync silently
clobbered the previous archive (up to 32MB of log history per
collision, right when a spamming appender was rolling hottest). The
name now bumps a _N suffix until free. New logRotate.test.ts pins the
whole contract: over-size rolls to OLD/ stamped, under/empty/missing
never roll, OLD/ prunes to 16 newest by mtime, and a failed rotate
never throws (appends can't be blocked by rotation).
### 2.133 - end

### 2.134 - sustained-RTT judge: transit staleness no longer rubberbands

The latency soak asked "does 150ms play" and the suite answered "no":
a position report is ~RTT/2 stale by the time the judge compares it,
so on a clean 75ms uplink the client's legit prediction reads
speed*transit off (~3.5m at ski speed) - over the authority mode's
1.5m tolerance every report past it re-fired a correction at the
100ms throttle cadence (117 corrections / 20s = a rubberband loop,
and each snap counted toward the divergence ledger). moveJudge now
credits the systematic transit band: tol += speed3d * rttMs/2, where
rttMs is the client's own ping measure riding the position frame,
capped at RTT_TOL_CAP_MS=300 so a forged multi-second ping can widen
the budget by at most speed*0.15 (~6m) - far under the SEVERE_M
kick trip. Plumbed position msg.ping through
moveClaims->Room.moveReport->RoomMoveSim.reconcile->MoveJudge.
New tests/net/latencySoak.test.ts drives the real bridge on clean
sustained links: 150ms RTT = 45 corrections/20s (was 117), post-snap
residual p95 1.72m; 300ms probe converges in a bounded ~5.7m transit
band instead of drifting. The 150ms global-play floor now works by
construction, not by hope.
### 2.134 - end

### 2.135 - gap-open severe bar scales by starved-input deficit

The 16-RTC-bot soak's ~3 Movement-cheat warns/80s at 60-99m were real:
past the 600ms gapYoung defer, raw judging resumed while the shadow was
still replaying stale input, so an honest client in a blackout drifted
speed x gapAge and banked teleport strikes. Strikes now wait for a
divergence the starved-input credit can't explain: severe bar =
SEVERE_M + speed3d x min(gapAge, 2s). A stopped body gets no credit
(stale input cannot move it); a real teleport arrives as a step
function, far past the linear credit. Divergence counting, corrections,
and inputSync hints are unchanged. Pinned in
tests/roomMoveSim.test.ts: 4 reports at ~70m/30 m/s inside a ~0.62s open
gap bank zero strikes; 3x 300m reports still latch cheated.
### 2.135 - end

### 2.136 - feed/vault memory bounds (fresh-code audit)

Round opened in logs per protocol: today's client log carried only the
benign KHR_parallel_shader_compile warn - no signal, moved to a
fresh-code sweep of the /clips work shipped this session. Two class-5
findings, both shipped:
- `prefetched` (coolShots) grew per swipe - consume deletes only the
  played clip, so fast skipping / deep-link jumps left every warmed
  DemoFile (~100-350KB) cached for the session. Now FIFO-capped at 4
  (the feed needs only neighbor clips warm).
- `DemoVault.evict` ran `getAll` on every put - deserializing up to
  ~35MB of clip payloads through structured clone just to find the
  oldest timestamp. DB bumped to v2 with a `ts` index; eviction now
  iterates the index and deletes by key without loading values.
Also audited clipRoute for injection (all user-controlled/meta fields
escaped) - clean.
### 2.136 - end

### 2.137 - demo upload filename collisions (data-loss)

Class-9 sweep of eviction/cap sites (evictEldest is canonical; the two
hand-rolled keys().next() sites need the evicted value, left as-is)
turned up a worse class-2 bug in DemoStorage.saveDemo: the minted
filename is second-precision ISO + 0.1s-rounded lifetime, so two
uploads in the same second with equal air-time produced the same name -
writeFile silently clobbered the first clip while the index grew a
second row pointing at the one surviving file. Two players at the
12/min rate limit collide routinely. Now suffixes _2, _3... until the
name is free on disk and in the index. New test freezes the clock to
prove the rename path deterministically.
### 2.137 - end

### 2.138 - moveJudge report-velocity clamp (authority hole)

Determinism probe found the ambient-draw boundary already test-guarded
(sharedAmbient.test.ts) - clean. Pivoted to a trust-boundary read of
moveJudge.reconcile and found a class-2 hole: the judge adopts the
client-claimed `vel` into the shadow (line ~195) BEFORE speed3d is
computed, and both lagTol and transitTol scale on it. The wire's
1000 m/s codec bound admits claims that buy ~150m of free transit
tolerance plus ~900m of throttled-client lag tolerance - a forged
report covers a real teleport. New REPORT_VEL_CAP=200 (terminal fall
caps at 100, disc+ski momentum tops ~150) clamps the claim before it
touches the shadow or the tolerance math. New test: 900 m/s claim +
150m blink still corrects and the shadow never absorbs >200 m/s.
(Full suite: one netbot wsFight flake - bots dealt 0 shots in 21s,
passes isolated; unrelated to the clamp, which only touches >200 m/s
reports netbots never make.)
### 2.138 - end

### 2.139 - clip feed stale-timer + dead-clip wedge

Trust-surface audit (wire bounds + demoReader counts already capped,
feed meta all textContent - clean) found two class-4/6 feed bugs:
- scheduleNext fired go(1) ~0.9s after a clip ended with no cancel -
  a manual swipe/arrow inside that window played the next clip, then
  the stale timer fired on top of it and skipped a second clip.
  Generation counter (clipGen, bumped per play()) voids stale timers;
  the same guard yields to a manual seek/pause (mode!=='idle').
- A clip that fails to start (evicted between /demos fetch and play,
  404, fetch error) emits no onPlaybackEnd - playAt is fire-and-forget
  so no signal exists; the feed stalled on the dead clip forever.
  Watchdog: 10s after play() with mode not playing/paused -> advance.
Both are feed-lifecycle correctness, not chrome.
### 2.139 - end
### 2.140 Broadcast transit lead - authority positions extrapolate by uplink-transit EMA (fixing ghost targets)
The shadow sim trails each client by one uplink transit (inputs land transit late). TickLoop's authority commit copied raw simState into p.position, so every observer and the hit-validation rewind aimed at where the player was ~ping ago - the felt "hits not registering". The commit now advances the broadcast position by vel x min(transitEma,300ms): the systematic offset re-centers instead of always lagging, and the rewind buffer (which stores player.position) stays consistent with what shooters saw. Transit estimate comes from the rttMs the position reports already carry (uplink half, EMA at 0.1, capped at TRANSIT_EMA_CAP_MS).


## 2.140 Feed auto-advance - 'paused' is overloaded: natural end vs manual pause

The lifecycle parks `dm.mode='paused'` when a clip ends naturally
(demoWire.ts) - the same mode a user pause leaves. The 2.139
scheduleNext guard "yield to a manual pause" therefore blocked EVERY
auto-advance: the feed froze on each clip's last frame (self-inflicted
regression caught this round). End-of-clip also parks the clock at
`duration`, so the guard now distinguishes: paused && clock < duration =
user holds; paused && clock >= duration = advance. Verified headless:
clip 1 ends -> counter flips to 2/N. (clipFeed.ts)

## 2.141 Demo upload: parseDemoHeader had zero bounds checks

saveDemo parsed attacker-controlled header offsets (gameVersion len,
description len, v2 lifetime field) with no bounds checks - a truncated
body or lying length field threw a bare RangeError that the route could
not distinguish from a storage fault (500 + internal error text echoed).
Also a crafted projectileLifetime=Infinity/huge passed the min filter
and would pin itself to the top of the sorted index forever (eviction
drops the lowest). Now: every read is bounds-checked (Malformed demo
header -> 400, internals no longer echoed), and lifetime must be finite
and <=300s. (DemoStorage.ts, serverRoutes.ts, demoHeaderBounds.test.ts)

## 2.142 P2P signalling: unguarded JSON.parse inside async listener

The signalling socket's message listener parsed the frame BEFORE its
try/switch - a malformed signal frame threw inside an async listener,
surfacing as an unhandled rejection and silently aborting the ICE relay
mid-handshake (host/guest pair left half-wired). Every other inbound
JSON.parse site (WebSocketConnection, tiers, tiersWebTransport,
GameServer) is already guarded - this was the only unprotected one.
Now parse-guarded with a null/object check before the switch.
(signalling.ts)

## 2.143 Clip feed pager: any throw in the transition stranded the feed

go() held `advancing` across `await resolveClip` + mountPaused with no
guard: an IDB get() rejection or a corrupt clip blob throwing in
player.load() would leave advancing set and the poster frozen over the
canvas - every nav input dead until reload. Now resolveClip never
rejects (catch -> null) and mount* return bool on failure, degrading to
the plain fetch path; the transition always completes.
(clipFeed.ts)

## 2.144 Prefetch cache consumed-on-read

resolveClipData read the warm prefetch slot without consuming it, so a
played clip kept its ~350KB stash slot until FIFO eviction pushed it
out - dead weight crowding the 4-slot cap. The prefetch now hands over
the buffer on use; replay falls back to vault/network as before.
(coolShots.ts)

## 2.145 Anim stall guard could not actually heal (seen in client log)

The stalled-cover guard re-enters the state via forceAnimationState, but
when the stalled clip is the SAME clip the state resolves to,
playAnimation's same-clip early return skipped the restart entirely -
the guard warned once ('Anim action stalled ... re-entering') then the
model stayed stopped/T-posed forever, re-entering every frame. The
early return now only applies while the action is actually running; a
stopped same-clip refire falls through to reset()+play().
(PlayerModel.ts)

## 2.146 Clip feed: mid-drag auto-advance double-committed

go() (wheel/keys/scheduleNext auto-advance) could fire while a touch
drag was armed - it ran its own slide while the finger still tracked
panes, and touchend's commit path then advanced a SECOND clip. go() now
cancels any live drag before sliding; touchend sees drag null and
returns. (clipFeed.ts)

## 2.147 Feed shuffle mutated the shared clip list

startClipFeed shuffled getCoolShots() in place - that returns the
manager's LIVE array, so every feed visit permanently re-shuffled the
Best Shots panel's best-first ordering. The feed now copies the array
before shuffling. (clipFeed.ts)

## 2.148 Vault list() structured-cloned every clip at boot

DemoVault.list() ran getAll on the clips store - ~35MB of DemoFile
payloads through structured clone on every rehydrate just to render
tile meta (id/timestamp/desc/lifetime/weapon/distance). New meta store
(keyPath id, ts index) written in the same tx as the clip row; list()
reads it; evict deletes from both in one tx. v2 rows backfill lazily on
first list() via a count drift check - async backfill inside the IDB
upgrade transaction would race its auto-commit. (demoVault.ts)

## 2.149 Cool-shot play race: last-resolve won, not last-click

playAt's vault.get is async - rapid tile clicks resolved out of order,
so a slower earlier request's playDemoData stomped the clip the user
actually picked last. playSeq generation guard: a superseded resolve
returns before touching playback. (coolShots.ts)

## 2.150 Feed wheel: per-event threshold dead to trackpads

The wheel listener required |deltaY| >= 40 per event. Mouse notches
arrive as ~120 so they worked, but precision trackpads stream many
small deltas (5-30px) that each failed the check - the feed could never
advance on a laptop touchpad. Wheel deltas now accumulate per direction
and commit at 40 total; acc resets on sign flip and cooldown.
(clipFeed.ts)

## 2.151 Clip appears twice when upload resolves after a server merge

fetchFromServer dedups server entries against coolShots by filename -
but a fresh local clip still carries its client-minted name while its
upload is in flight, so a server merge landing mid-flight merged the
uploaded copy as a second entry. The same clip rendered twice: once
local, once from server. On upload resolution the local entry now
filters any server entry carrying the assigned filename. (coolShots.ts)

## 2.152 Spawn claims omitted velocity inheritance - phantom "flight blocked" rejects

spawnProjectile flew the projectile at dir*speed + playerVel*0.5 (50%
inheritance, Tribes-style) but claimed dir*speed alone to the server.
The server-side TrackedProjectile therefore replayed a slower,
undeflected arc in arcBlockedAt: a shell that sailed over a wall on the
real flight clipped it on the claimed flight, producing 'AOE: flight
blocked by structure at ~0.2s' rejects on perfectly honest hits - the
dominant damage-error spam seen at 40-60ms ping, and it scaled with
shooter speed (worst while skiing). The sendShot claim now carries the
identical inherited velocity the Projectile sim runs (same expression
as the demo record two lines above). (fire.ts)

## 2.153 Corrections hard-snapped while holding steady keys

The input journal is change-only: an edge lands once and is pruned the
moment the server acks it. inputsAfter(after) therefore returned EMPTY
whenever the player was holding a constant input (the common case -
holding W, skiing a line) because the held edge was already consumed.
The correction handler saw journal.length===0 and took the blunt hard-
snap path with zero replay: full teleport-back every correction instead
of a converged re-sim. inputsAfter now takes gapMs (the correction's
round-trip window, passed as ping) and re-seeds the still-held input at
(now - gapMs) so it governs the gap - the CFWK replay finally covers
the steady-input case it was built for. (inputStream.ts, players.ts)

## 2.154 Reordered snapshots rewound the render clock + corrupted the buffer

SnapshotBuffer.push() did latestT = t unconditionally and appended the
snapshot -- but t is SERVER time and RTC/WT datagram lanes deliver out
of order. A stale packet (a) rewound the render-clock anchor, visibly
snapping the remote backward on each reorder, and (b) landed at the
tail of an array the sampler scans assuming monotonic t, so the
straddling-pair search read a corrupted window. The anchor now advances
only on the newest t (jitter stats track raw arrivals via a separate
stamp), snapshots splice into sorted position, and pruning keys off
latestT instead of the pushed t. Regression test covers the reorder.
(remoteSnapshots.ts)

## 2.155 NaN in netAcc froze net replicas in their last state forever

Both netDriven replay loops (updateNetSim + updateNetTotem) accumulate
frame dt into e.netAcc and step while netAcc >= SIM_TICK_DT. A non-
finite accumulator wedges that loop permanently -- NaN >= anything is
false, so one corrupt value freezes the replica's state machine in
whatever it last held until the entity dies. That is the exact
signature the soak's StateHash audit kept flagging: CREATURE DESYNC
with the client pinned in blinkOut for 30+ checks (~60s) while the
server cycled normally. The poison vectors were real: m.sk (the
server's retarget-skip counter) reached netAcc arithmetic with no
finite check -- only position/velocity/tp were sanitized -- and one
NaN dt was fatal the same way. Both loops now reset a non-finite
netAcc to 0 (self-heal, one bad edge costs at most a skipped window),
and the sk edge is gated by Number.isFinite before touching the
accumulator. (netMelee.ts, netCrawlers.ts)

## 2.156 Deploy-hash false desync: fabricated hash inputs

The soak's DEPLOY DESYNC persistent on ids=[2] was not a lost edge --
it was a hash-input asymmetry. The server feeds raw fields with ''
for missing (teamless base assets: owner 'base', team undefined via
teamOf -> ''), while the client fabricated d.owner ?? localId and
d.team ?? localTeam. A teamless seeded asset (the low ids are the
seeded base set) hashed 'alpha' client-side vs '' server-side forever.
Fabricated inputs can never match the server's real fields -- strictly
a false-positive generator. Client now hashes d.owner ?? '' / d.team ??
'' mirroring the server exactly; missing data hashes honestly as ''.
(stateDebug.ts)

## 2.157 SnapshotBuffer.clear() leaked the render-clock epoch

clear() recycled the snapshot list but kept latestT/latestArrive -- the
render-clock anchor. Server time is PER-ROOM (tickSeq x 50ms), so a
room hop or match restart rewinds it to ~0: every subsequent push then
compared against the stale epoch as "not newest", the anchor never
moved, renderTime stayed pinned past the buffer, and remotes rendered
on the extrapolation clamp instead of interpolating -- permanently
jittery remote motion until the new room's tick count passed the old
one's. clear() now resets the anchor pair + the arrival stamp (the
adaptive delay/jitter stats stay -- they describe the transport, not
the timeline). (remoteSnapshots.ts)

## 2.158 Regression test: render-clock re-anchor on a rewound server clock

Audit round found ~10 lanes clean (deploy wire edges, roster reconcile,
cap symmetry via shared DEPLOY_MAX, rate limits, ledger bounds, journal
cap, extrapolation clamp, solidColliders lifecycle, healthBump keys,
down-vs-dead hash semantics). Shipped artifact: a regression test
locking section 2.157's clear()-anchor reset -- old-epoch pushes, a
clear, then new-room pushes on a rewound tickSeq clock must interpolate
inside the new window, not extrapolate from the dead epoch. Fails
against the pre-fix code (anchor never re-arms). Also verified the
creature-hash audit branch diffs serverCreatureFields directly -- no
fabricated fallbacks like the deploy lane had. (remoteSnapshots.test.ts)

## 2.159 Verified-clean: deployable + claim-lane audit sweep

No code change -- documented so later rounds don't re-sweep. Covered:
deploy wire edges (spawn/gone/down/up/hp), roster reconcile culls,
shared DEPLOY_MAX cap symmetry (server recycles oldest-by-ttl, client
predicts insertion-oldest -- equivalent), wire rate limits (deploy 4/s,
repair 30/s; teleport intentionally unlimited, honor-and-count via
teleportSpam), repair claim validation (friendly rule, 1.5x range
slack, LOS, per-pair cooldown), plant distance (MAX_PLANT_DIST=40,
tested via 'toofar' case), claim-ledger bounds (server MAX_SPENT +
client 256-cap + tombstone dedup), per-player teardown funnel
(rateLimiter/limiter warns/deployables/projectiles/scoring/sessionTokens
/wireId retirement all swept in removePlayerCompletely), lastRepair key
sweeps on owner-leave and item-remove, wireIdRetired mint-time sweep.

## 2.160 Ghost deployable: deployGone never killed own plants

remoteRemove looked the id up in the remotes map only -- but own plants
are registered by server-id via ackLocal into byId, never into remote.
So a deployGone for OUR plant (server cap-recycle evicts the oldest, or
a blast kill) missed the lookup, skipped dispose, and left the item
alive in items forever: a ghost mesh on screen AND a phantom entry in
netEntries hashing against the server roster -- the deploy-hash lane's
real desync class. remoteRemove now also kills any items entry whose
serverId matches (via killItem for the proper fizzle teardown).
(deployables.ts)

## 2.161 Roster-cull covered the remote lane only

Same blind spot as 2.160, second door: reconcileDeployables culled
remoteIds() -- the remotes map -- so an own plant whose serverId fell
off the server roster (cap-recycle while away, lost blast edge) was
never culled at reconcile either. New Deployables.cullOwn(live) kills
own items with a stamped serverId absent from the roster; unacked
plants (serverId undefined) are untouched. Both doors of the own-plant
ghost class are now shut: edge path (remoteRemove) and reconcile path.
(deployables.ts, net/deployables.ts)

## 2.162 Verified-clean: deploy-lane symmetry + FX/HUD bound sweep

No code change -- coverage record after the 2.160/2.161 own-plant fixes.
Deploy lane now symmetric end-to-end: own items sit in byId so
applyDeployHp/down/up resolve them, reapDeadItems drops corpse
bindings, deployGone kills them (2.160), roster cull covers them
(2.161). Also swept clean: demo recorder (circular frame buffer +
roster-by-id dedup + event prune/freelist), creature lanes (server pop
caps per map spec, roster reconcile spawns missing AND culls extras,
dead-ctor wedge eviction), explosions (MAX_LIVE_EXPLOSIONS + per-entry
dispose/splice, far ones age out without buffer writes), killfeed (6
row cap), Projectile.solidIndex reset on BOTH the join and admin
hot-reload paths, movement/teleport wire surface (limits everywhere;
teleport intentionally unlimited via honor-and-count).

## 2.163 deployFields: deploy-desync warns now name the culprit

The soak's DEPLOY DESYNC ids=[1,2] has run 380+ checks without ever
saying WHAT diverged -- the warn printed only client-side ids, so a
server-only roster entry (missed spawn edge) was invisible by
construction. Mirrored the creatureFields pattern end-to-end:
protocol carries deployFields [id, kind, owner, team], TickLoop emits
them from the same snapshot that feeds deployHash, wireIn/NetworkManager
plumb them, and the stateDebug deploy branch diffs per-id on a mismatch
-- server-only names a lost spawn, client-only names a lost deployGone,
and a field diff names a kind/owner/team asymmetry. Next soak answers
instead of asking. Also logged this round: a stale-corpse signal
(isDead client=true server=false on BOT-BRICK-09) parked for a later
round. (protocol.ts, TickLoop.ts, wireIn.ts, NetworkManager.ts,
stateDebug.ts)

## 2.164 playerHit un-sticks a stale corpse record

The soak's isDead client=true server=false diff was a lost respawn edge;
the healRemoteLife safety net repairs it, but only on the next
hash-diff cycle (~seconds of stale corpse + wrong hash inputs). A
processed playerHit already proves the server holds the target ALIVE --
it never lands a hit on a dead player. The roster update now also writes
isDead: false, so the record self-heals at the next hit instead of
waiting for the diff cycle. Local-death state is untouched (local
player death is callback-owned). (wireIn.ts)

## 2.165 Phantom roster stubs from hits/kills on departed players

upsertRemotePlayer mints a stub row for ANY unknown id, and
handlePlayerHit / handlePlayerKill called it unconditionally -- a hit or
kill edge arriving for a player who already left (or whose join edge was
lost) created a phantom roster entry that then hashed client-only in
every state-hash check and sat on the scoreboard forever. Both handlers
now guard on the roster actually holding the target; respawn keeps its
create-on-unknown safety (a respawn edge legitimately reintroduces a
player). (wireIn.ts)

## 2.166 Missing-member heal for players the client never saw join

The connect-time desync storm (all 9 bots "on server but not client" for
10+ checks) had no repair path: the audit healed health/liveness only
for client-present entries, and nothing else mints a roster record for
a player whose join edge was lost or predates us. The audit now seeds a
missing member's roster record from snapshot truth (position/health/
isDead); the existing first-seen-update path spawns the entity when
live records land, and dead members stay unspawned by design. Also
explains the phantom 70-ball fleet in the same log: it was the client's
own netDriven fleet counted correctly -- the membership print only
lists local ids, so a field-level diff (enraged/targetId) still has no
per-id breakdown; ball-fields diff is the follow-up lane.
(stateDebug.ts)

## 2.167 ballFields per-id diff for the ball hash

The BALL DESYNC warn printed only local ids, so a field-level mismatch
(enraged/targetId churn on an identical roster) looked exactly like a
membership desync and could not name the culprit. stateHash now carries
ballFields [id, variant, enraged, targetId]; on mismatch the audit diffs
per-id (#id:missing / #id:stranded / #id:enraged / #id:tgt a/b) like the
creature and deploy lanes. (protocol.ts, TickLoop.ts, wireIn.ts,
NetworkManager.ts, stateDebug.ts)

## 2.168 Roster single-owner rule: edges patch-or-drop, feeds create

Research-confirmed (Quake/Source snapshot model, Unity Netcode: "RPCs
are one-off events, not persisted"): entity existence belongs to the
snapshot/roster feed; one-off events must never create persistent
state. upsertRemotePlayer minted a stub for ANY unknown id, so every
edge handler was a potential phantom-row source. New patchRemotePlayer
is the edge path -- patch-in-place-or-drop, returns false for unknown
ids. playerHit / playerKill / teamUpdate migrated; healRemoteHealth/
Life already refused to create. Create remains exclusively on the
membership feeds: remoteReset (gameState), tickUpdate, playerJoined,
playerRespawn, and the snapshot audit heal -- which is now the only
path that can mint a member from truth. The phantom-stub class is
closed by construction. (NetworkManager.ts, wireIn.ts)

## 2.169 Mirror-direction heal: retire client-only roster members

The audit healed health/liveness/missing members but a "client but not
server" diff warned forever with no repair -- a lost playerLeft edge
left a stale roster record (and its RemotePlayer entity) hashing
client-only on every check. The snapshot pass now retires both the
record (remoteDelete) and the entity (remotePlayers.remove) for any
id the server snapshot doesn't list. Symmetric with the 2.166 mint;
membership is now healed in both directions. (stateDebug.ts)

## 2.170 Audit pass: teardown funnel + edge-ownership sweep (clean)

Post-refactor verification sweep, no defects found: every replica lane
now obeys the single-owner rule -- players (2.168 patch-or-drop edges,
membership feeds create), creatures/balls (dedup spawn + roster cull),
pickups (spawn-edge create + reconcile cull), deployables (2.160/2.161
own-plant ghost fixes). Server teardown funnel verified complete:
fireWindows/lastFireNotify/lastHeal/chargeBank/pendingClaims/lastDropNotify/
lastRejectWarn/healTicks (both key orientations) all swept on disconnect;
HitLedger duelStart is age-pruned (60s) so orphan keys can't grow.
Foraged-stamp defense in fire gating verified (rolling arrival floor +
lastTs max-clamp). Entity-side revive visuals for a hit-flipped isDead
record stay hash-heal-owned (position needed) -- accepted gap, seconds
of stale visual worst case. (audit only)

## 2.171 Remote deployables dropped `owner` on most kinds

remoteDeployables.spawn() only stamped owner on the shield and beacon
item literals -- turret, generator/sensor/sentry (base assets), and the
generic mine/drone fallback built Items with owner undefined. The deploy
state hash reads Item.owner, so every remote turret hashed '' against
the server's real owner and desynced permanently (the ids=[2] warn that
persisted 217+ checks in client_warning.log). All branches now record
the wire owner -- the audit signal is meaningful again for the whole
roster, not just two kinds. (tsc + 500 vitest green)

## 2.172 Creature field drift now heals from the snapshot

The creature hash audit named a desync (#N:state blinkOut/X, #N:tgt A/B
persistent across 70+ checks) but never closed it: a lost crawlEvt left
sim.state/targetId stale and the warn just re-fired forever. The audit
now applies server creatureFields to the local sim (state + targetId;
species is constructor-fixed, uber has no per-creature writer) -- same
snapshot-heal doctrine as player liveness, matching the netCrawlEvt
precedent that already pokes sim.state on a windup edge.

## 2.173 DemoStorage ctor-reconcile vs saveDemo race

The constructor fires loadIndex().then(reconcileIndex) unawaited while
saves proceed: a demo file written mid-reconcile got adopted as an
'orphan' AND pushed by saveDemo -- the index double-counted it
(listDemos returned 3 for 2 uploads, caught by the suite). Both push
sites now check live index membership; the stale 'known' snapshot in
reconcileIndex is gone.

## 2.174 Melee on creatures is server-paid — the last big claim feeder dies

The melee swing was already an intent on the player side
(handleShotFired rewinds mpos, derives swing point, aoe on players)
but its creature half still resolved the old way: the client's
predicted cone called takeDamage, which minted a creatureHit/
crawlerHit claim per body — the largest remaining source of those
claims, and a duplicate truth about who got hit.

The Melee branch now emits a meleeSweep room event carrying the same
server-derived origin + dir; Room fans it to BallCombat.meleeSweep
(radial shove via the existing handleHit impulse args → 'hit' segment
edge rebroadcasts so the knocked ball's arc stays wire-truth) and
CreatureSim.meleeSweep (damage-only, matching the claim path it
replaces). The cone constants moved to shared/weapons
(MELEE_ARC_DOT, MELEE_CREATURE_DAMAGE = the flat 60 the claim used
to carry — player's own melee stays on the weapon-table aoeDamage=55)
so the shown set and the paid set can't drift. Client keeps the full
predicted feel — cone, flash, number, knockback shove — and passes
serverPaid when connected so netDriven takeDamage skips the claim
while keeping predicted health/flash. Balls' staged _netImp impulse
now rides the server's 'hit' edge instead of a claim. Mine/blast and
bite claims stay legitimately client-owned (server never simmed those
interactions). Also caught by the purity suite along the way:
warnOnce's Date.now moved to sharedNow (seeded clock) to keep
worldModel inside the env seam. (tsc + 502 vitest + purity green)

## 2.175 Lightning beam is server-resolved — the heaviest claim lane dies

The LG was the last per-tick claim generator: ~20 aoeShot claims/s on
players plus creatureHit claims on every beamed creature, all so the
server could re-derive what its own ray would have found. The beam is
now an intent like everything else: each shotFired tick carries dir,
handleShotFired rewinds the muzzle, and Room.beamSweep runs the honest
ray (segFieldHit terrain, solidIndex walls, classCapsule players,
ball/crawler sweeps — the same math botBeam.beamContact already used).
Earliest contact pays: player victims ride the existing ChargeBank
ramp/bank economy (step → lgTickDamage → bank → serverHit), creatures
tick through handleHit with their own ramp keys and bank withheld
charge on a per-creature map — a beam kill pops the bank at the
contact point, the same corpse-burst players get. The chain fork
resolves server-side too (nearest other live creature forward of the
contact within LG_CHAIN_RANGE, half tick). Client keeps every
prediction — beam, contact sparks, numbers, hitmarker, shroud,
predicted zap — and drops the claims: takeDamage serverPaid, the
per-tick aoeShot deleted, lgPop's blast claim suppressed when
connected. Constants moved to shared/combat (LG_RANGE, LG_CHAIN_RANGE,
LG_CHAIN_DMG_SCALE) so the shown set and the paid set share numbers.
30/s flood gate per player on the intent. Known gap: a non-beam
server weapon killing a charged creature doesn't discharge its bank
(beam-kill only) — noted for the next pass. (tsc both sides + 81
focused tests green)

## 2.176 Repair beam joins the intent model — the server names the weld

The last beam claim: every 100ms tick the welder claimed WHICH item it
was repairing and the server re-derived range/LOS/team/amount around
that name. Now the shotFired tick is the whole intent — same as the
LG: rewind the muzzle, pick the weldable deployable the ray actually
touches (same r=1.1 padded-sphere pick as the client's repairHit,
nearest entry wins), and route it into the existing deployables.repair
economy (hp to cap, overflow to armor, revive early). Friendly
filtering moved into a shared weldable() so the pick and the pay see
the same rule. 30/s flood gate on the intent. Client keeps its
predicted heal + beam FX; the sendRepair claim is gone. Bots were
already server-side for welds, so bot/ human repair now share one
code path end to end. (tsc both sides + 39 focused tests green)

## 2.177 Slam lands on a velocity shadow — the last skill claim dies

Slam's aoeShot was the odd claim: a position PLUS a client-computed
`power` multiplier off its own impact speed — the one payload field a
forged claim could inflate at will (max slam radius + damage on any
landing). Now a dedicated `slam` intent carries only the landing spot;
the server derives power from the move shadow's own velocity sample
(the claim lands while the pre-impact dive is still the freshest
reading), runs the same power-scaled blast, and plausibility-gates the
position against the shadow (60m). serverBlast learned an optional
power multiplier; client keeps the predicted slam FX + thud and drops
the claim when connected. (tsc both sides + 53 focused tests green;
protocol.test keeps the exhaustive-type pin honest)

## 2.178 Deployable-pop creature splash — the last connected claim mint

blastForce paid creature splash "serverPaid only when weaponType
defined" — a stale comment from before server deployables. Connected,
mine pops detonate in tickMine and pay creatures via preySplash, while
the client's predicted pop also minted a creatureHit/crawlerHit claim:
the same blast double-paid every creature it caught. Now splash on
creatures is server-paid whenever a connection exists — the verbs
stay for offline/P2P hosts where the claim IS the authority path.
(creatureHit/crawlerHit minting on a connected client is now
effectively zero: melee, LG beam, direct hits, and splash are all
server-paid.) (tsc + blastForce 13 green)

## 2.179 authoritySims() — claim suppression keyed on capability, not transport

Every claim-suppression gate keyed on isConnected(), but a P2P host
embeds the same server modules WITHOUT the sims (no RoomProjectiles,
ballSim, or creatureSim — deliberately absent per host.ts). Peers read
as "connected" so claims were suppressed AND the host's intents relayed
cosmetically: zero projectile blast, creature, and loot damage in P2P
rooms — a silent regression the claimless migration introduced.

New NetworkManager.authoritySims() = isConnected && tier not p2p/host.
All gates that mean "the authority owns this" switch to it: the aoeShot
blast suppression + projectileDestroy (impact), slam/LG-pop sendAOE
(projectiles, lightning), melee + zap + splash serverPaid (fire,
lightning, blastForce), the local-nugget loot guard (impact), and
serverBalls/serverCreatures ownership (netBalls, netCrawlers) so P2P
peers resume client-side species. Dedicated-server behavior unchanged;
the claim verbs stay live for the one authority shape that still pays
them. Residual P2P gaps noted: direct-hit 'shot' claims are dead wire-
side (kinetic weapons rely on aoeShot only) and LG/beam intents resolve
cosmetically on hosts lacking beamSweep. (tsc + p2pHost/blastForce 21
green)

## 2.180 — Claim verbs refuse on sim authorities (claimsAccepted)

The other half of authoritySims: suppression decided *what the client
sends*; this decides *what the authority accepts*. RoomInfo gains
`claimsAccepted` — Room's handlerInfo sets false (a sim-running
authority takes intents only); a MessageHandler built without roomInfo
(P2P host, offline) defaults true since claims ARE its outcome path.
wire.ts gates aoeShot/creatureHit/crawlerHit/repair/heal/
projectileDestroy at the handle: refused claims get a claimAck reject
('outcomes are server-simmed'), never adjudication — aoeSlam's
trusting msg.power, creature-hit range caps, the whole re-derive layer
stops being reachable from the wire on the dedicated server. protocol
gains claimSeq on aoeShot/projectileDestroy so the refusal can stamp.
Also folded in: the class lock moved above every fire intent (beams/
melee no longer bypass classCanFire) and every claim-driving scenario
test converted to intents — melee swing, slam power (now derived off
the velocity shadow, floor/ceiling pinned), LG beam ticks, heal
claims, forged aoeShot (claimAck refusal pin). healCredit/healRate/
roompickups re-pinned to refusal semantics; envClaims/demoCoverage/
combatorder kept as the claim-lane unit coverage. replicaParity +
capRun failures confirmed pre-existing on HEAD (stash-verified).
(tsc + 64 focused tests green)

## 2.181 — Tick rows patch records by declaration (rowPatch)

The last hand-mapped consumer: applyTickPlayerUpdate listed ten fields
the player kind already declares in updateFields — a declared field the
handler forgot to copy was a silent replica-drift lane. worldModel gains
rowPatch() (the verbPayload inverse: copy declared fields present on the
row, absent = keep stored), and the handler now spreads it — internalId
stays explicit since it lives outside updateFields. 0/false copy, ''
reads as absent. (tsc + 39 net tests green)

## 2.182 — P2P hosts run the weapon sims (ProjHost + authorityShells)

The last surface where claims were the outcome path. beamSweep/
beamChain extracted to beamSweep.ts as a free function over a world
slice (players/field/solids/optional rosters) — Room delegates, P2PHost
calls the identical cast. RoomProjectiles ctor now takes a structural
ProjHost (players/messages/broadcast/rng/tickSeq/mode/pushNoise +
optional roster sims, deployables, moveSim) — Room satisfies it
structurally, P2PHost passes itself. The host ticks the sim at 20Hz
and lazily attaches the loaded heightfield, so guest fire/beam intents
resolve exactly as on dedicated (class gate, fire-rate gate, belt
charge, lag-compensated muzzle all included). Client split: new
authorityShells() (any connected transport) gates the shell/beam
claim-suppression sites — aoeShot/projectileDestroy for simmed weapons
and slam — while authoritySims() stays the roster-species predicate
(creatures/deployables/repair keep claiming, the host adjudicates).
(tsc both sides + p2pHost 10/10: intent echo + beam kill pins)

## 2.183 — playerJoined/playerRespawn patch by declaration too

The last two hand-mapped member feeds: playerJoined listed its fields
by hand and had already drifted — `internalId` was declared but never
copied, so grace-rejoiner records missed it. Both handlers now rowPatch
from the spawn/event field lists; the isNew vitals guard and the
respawn revive (isDead=false/health=100/zero velocity) stay explicit
because they're policy, not field mapping.
(tsc + 22 focused tests green)

## 2.184 — P2P hosts reconcile movement too (RoomMoveSim on host)

Peers' moveReports were relayed verbatim — the host trusted every
position claim, the one adjudication gap dedicated never had. The host
now runs RoomMoveSim(field, authoritative): inputs queue on shadows,
reports judge teleports, energy/skill/slam-drain ride the same deps,
and attachField lands lazily once the heightmap loads. PlayerManager
energyBurn wired so damage energy-drain mirrors dedicated.
(tsc + p2pHost 10/10 green)

## 2.185 — Heal claims stay decoded (claim-gate scope corrected)

The claimsAccepted=false gate refused `heal` alongside combat claims —
but heals aren't combat outcomes: ambient pickups (nuggets in non-team
rooms) have no server entity to intent against, so the bounded claim
(25/call, 1.5s cadence, healCredit spend in team rooms) IS the designed
channel. Refusing it killed nugget heals on dedicated. The gate now
covers only combat-outcome claims (aoeShot, projectileDestroy, ballHit,
creatureHit, repair — all of which have real sim/intent paths); heal
runs handleHeal on every tier. Three tests re-pinned to the bounded-
accept semantics.

## 2.186 — P2P gameState carries the host's map

The host's roomInfo never filled map fields, so a guest's gameState
had map:undefined and the guest built its own saved map — host and
peer could silently live in different terrains. setMap() now feeds
the boot map (soloSpec ?? savedMap) into the host's RoomInfo, which
moved to a mutable field so the snapshot lands before any handshake.
(tsc + p2pHost 10/10 green)

## 2.187 — wireIn extraction broke the e2e test surface

The dispatch extraction privatized lastTickSeq and handleCorrection;
every e2e spec polls t.networkManager.lastTickSeq as the binary-lane
signal and wraps nm.handleCorrection to count corrections — both sat
undefined, so the whole suite timed out on entry. Restored the two
accessors: lastTickSeq forwards wireIn.tickSeq, correction dispatches
through a public nm.handleCorrection seam. (smoke: 10/10 green)

## 2.188 — declared wire types: inbound checks verify shape, not just presence

KindFieldDecl gained a `wire` tag ('num'|'str'|'bool'|'vec3'|'arr') on all
162 world-model field declarations. checkPacket now type-checks every
field that arrives: a string where a vec3 belongs used to pass the
presence check and poison the replica just as silently as a missing
field — now it warns once per field per 5s. Covers verb payloads, roster
rows (every declared container in a shared feed), and event fields.
(client tsc + worldModel/fidelityHash 46 checks green)

## 2.189 — wire types on the emit side too

verbPayload/rosterRow/eventPayload now type-check outbound values the
same way checkPacket checks inbound ones: a mistyped emit warns once
per field instead of writing a poisoned wire shape. Rotation got its
own 'rot' tag ({yaw,pitch} isn't vec3) — the check caught it plus a
false-positive on explicit-undefined emits within minutes.

## 2.190 — client intents declare wire types too

CLIENT_INTENTS fields carry the same wire tag now; checkIntent
type-checks present fields at dispatch, so a hostile/malformed client
sending position:"abc" or hold:"yes" warns instead of feeding a
poisoned shape into the sim. Both wire directions are now
presence+type checked from one declaration.

## 2.191 — stop sending claims the dedicated path always refuses

aoeShot/projectileDestroy/repair/crawlerHit/creatureHit now early-out
when authoritySims() is true (connected && not p2p/host). The dedicated
gate already refused every one with 'gone' — sending them was pure
dead-claim traffic plus a pointless ledger stamp per call. P2P keeps
the sends: the host still adjudicates claims as its outcome path.

## 2.192 — gameState envelope declares its own fields too

The roster sweep verified ROWS inside gameState but not the envelope's
own payload — room/mode/scores/map/matchEndsAt/wireIds could drop or
mistype silently. player.envelope declares all 17 message-level fields
(only players + protocolVersion are unconditional; the rest declare
absent since they're mode-conditional) and checkPacket verifies them.
The entire wire surface — verbs, events, rosters, envelopes, intents —
is now declared + shape-checked from one file.

## 2.193 — tickUpdate envelope declared too

updateEnvelope covers the ack watermarks (ackSeq/inputAck/tickSeq/count)
wrapping the row list — the last unchecked message-level surface after
the gameState envelope. Every wire message now verifies both its rows
and its envelope from one declaration.

## 2.194 — one gameState builder

sendWorldState and handleSpectatorHandshake each inlined the same
envelope construction (players + protocolVersion + roomEcho). A shared
sendGameState owns the base payload; the join path layers sessionToken/
wireIds/team/localPlayerState on top as extras. Two copies of the
envelope meant two places to drift — now the declaration and the
builder are each written once.

## 2.195 — null sentinel + projectileId mistype (first live catches)

E2E smoke flushed out the first real findings from the field checks:
null is the wire's absent sentinel (JSON drops undefined, so optional
fields ride as explicit null) — every check site now guards `!= null`
uniformly (packets, roster sweeps, envelopes, intents). And a genuine
decl bug: projectileId is a STRING id on the wire, declared 'num'.
The check caught it within one smoke run.

## 2.196 — one checkFields for every inbound surface

checkPacket had grown four copies of the field-check loop (packet,
cross-kind roster rows, roster envelope, update envelope) — the exact
shape the world model exists to delete. checkFields takes (fields,
packet, tag); the tag distinguishes rows/env in the warn key. Same
contract everywhere: absent-declared may omit, null is the sentinel,
else wireOk.

## 2.197 — one emitFields for every outbound surface too

The emit side mirrored the inbound one: verbPayload, rosterRow, and
eventPayload each carried the same warn-or-fill loop. emitFields owns
the contract now (skip idField, warn undeclared-missing, guard null,
fill sentinel). worldModel.ts is down to two field walkers total — one
per direction — over the same declarations.

## 2.198 — intents checked at send too, not just at dispatch

checkIntent ran server-side only, so a drifted send warned after the
packet crossed the wire — in someone else's log. NetworkManager.send
now runs the same check before serialize: the omit screams at the call
site that made it. Same declaration, same warn contract, one line.

## 2.199 — interface keys pinned to the declaration

GameStatePlayer is hand-written beside a generated emit — a field added
on either side drifted silently until a runtime warn caught it. The
conformance test now parses the interface and asserts its keys equal
the declared roster row (+id). Type-level drift fails at test time,
not wire time.

## 2.200 — inline roster rows pinned too

flags/pickups/deployables ride gameState as anonymous inline row types
— the same drift surface as GameStatePlayer. The conformance pin now
asserts each container's keys equal the kind's declared rosterFields
(+idField). Every wire row shape is pinned against the model.

## 2.201 — client replica record pinned too

RemotePlayerState is the wire's landing zone: a key with no declared
field is a dead slot, a declared field with no key can't land. Its
keys now pin to the spawn∪update∪roster union (+id). The replica
record, every roster row, and every interface is declaration-checked.

## 2.202 — SnapshotPlayer pinned too

The debug feed's row parallels the roster row + kill stats — it now
pins as a subset of the declared row (kills/deaths whitelisted as the
stats extras). Every hand-written wire row shape is pinned: join
roster, inline containers, replica record, debug feed.

## 2.203 — Health hash quantizes like the wire

The u16 health field lands on the replica as Math.round(truth); the hash
bucketed the raw float, so a truth straddling a 4hp bucket edge
(35.9 room -> 36 wire) desynced forever on live clients. The hash now
rounds before bucketing — the same transform the wire applies — and
replicaParity's busy-room spec (a long-standing known-fail) goes green.

## 2.204 — PlayerModel LOD block extracted

The far-LOD swap (lod state, lod1 fetch, baseGeo round-trip, smoothShade
crease cache) moves to playerModelLod.ts — the only self-contained seam
in the 1456-line monolith. setLod keeps its mannequin guard and delegates;
the gun/clip/pose blocks stay because their state is the external API
(setWeapon/gunMesh ride playerLoadout + modelFx callers). Mechanical
extraction, zero behavior change — tsc clean.

## 2.205 — PlayerGun extracted (PlayerModel gun block)

The hand-prop controller (gun group, ~20 mount/base fields, the
socket/palms/world/per-axis attach branches, the per-frame bone follow,
the baked-weapon geo swap + per-model material clones, muzzle anchor,
debugSetGunRot) moves to playerGun.ts — 311 lines out of PlayerModel.
ModelFx keeps reading through the unchanged ModelFxHost surface via
delegating getters; onGeoSwap is the one back-edge (wireframe recapture).
Dropped `socketGun` — write-only dead flag. tsc + 504 vitest green.

## 2.206 — PlayerDistal extracted (PlayerModel bone-LOD block)

The far-remote bone LOD (bone census, LIMB/HELPER expendable tables,
distal-bone compute, far-clip track filtering, frozen matrixAutoUpdate,
the same-phase action swap) moves to playerDistal.ts. PlayerModel keeps
capture/delegate seams: setFrozen returns the next action instead of
writing currentAction. tsc + 504 vitest green. PlayerModel 1204→1128.

## 2.207 — playerAnim extraction: the anim state machine leaves PlayerModel

The ~450-line clip-drive core (mixer, animations table, fade machinery, playAnimation, the locomotion-dir resolver, setAnimationState/forceAnimationState cascade, alignHipYaw, retargetUAL, the stalled-cover guard, and the pose.update call) moved to `client/src/entities/playerAnim.ts` verbatim. `PlayerAnim` reads the model through a `PlayerAnimHost` interface (variant/model/pose/distal/disposed — live getters, so the rig fallback's re-assignment stays visible); `pose`/`distal` went public as host surface. PlayerModel keeps thin delegates for every public signature and drops from 1128 to 755 lines (1456 at lane start). All behavior is identical code — callers (PlayerVisuals bracket `currentState`/`animations`, remoteAnim, gunlab, posedump) hit getters that forward to the controller.

## 2.208 — playerCollider extraction: the debug hitbox leaves PlayerModel

The collider-gizmo block (capsule geometry against the full visual scale, friend-or-foe hex, the debug/force visibility pair, the class-capsule restash, remove/reattach, dispose) moved to `client/src/entities/playerCollider.ts` as `PlayerCollider` — scale and feet offset pass per call since both can change without the gizmo knowing. PlayerModel keeps thin delegates (`setColliderCapsule`/`setColliderColor`/`setColliderVisible`/`removeColliderGizmo`/`addColliderGizmo`) and drops to 692 lines — under half its 1456-line starting size across the split lane.

## 2.209 — playerMats extraction: the material pipeline leaves PlayerModel

The mannequin reskin recipes (mannGunMat/mannJointMat module fns), the per-instance clone cache (ownMaterial/matClones — a shared-GLB material flash would tint the whole fleet), the flashMats emissive capture, and the debug wireframe set moved to `client/src/entities/playerMats.ts` as `PlayerMats`. `prep()` takes (mesh, mann, mannRev) at census time; `flashMats` stays reachable through a getter for ModelFx; `wireframeOn` went public on the controller for the gunCtl.onGeoSwap hook. PlayerModel: 625 lines — 43% of its 1456-line start.

## 2.210 — roomFlagPlacer extraction: the flag/deploy placement domain leaves Room

The placement cluster (rabbitFlagHome, flagStandTop, flagDeShelf, deployFloor, snapFlagBases, refreshFlagHomes — ~160 lines of walkable-surface math) moved to `server_bun/src/roomFlagPlacer.ts` as `FlagPlacer`, reading spec/field/flags/ballSim/mode through a host object and returning the two room-level effects of a re-snap via callbacks (collider re-attach + skinny mapUpdate; spawn-anchor re-seat). Room keeps the public `refreshFlagHomes` signature for roomFactory/tests and drops to ~1060 lines. Flag-snap and stand-resnap scenario tests green.

## 2.211 — roomStructures extraction: the structure-hull sync leaves Room

The structure domain (effStructures' authored+dais merge, kit ground-seating, sim collider re-attach, the emittedStands diff baseline, the skinny mapUpdate push, the setMap echo refresh) moved to `server_bun/src/roomStructures.ts` as `RoomStructures` — `eff`/`attach`/`pushUpdate`/`refreshPower`/`baseline`. The three sinks of "which stand hulls exist" (colliders, join echo, mapUpdate diff) now share one owner, so a re-snap can't update one and skip another. Room keeps the public `refreshPowerStructures` delegate for RoomDeployables. Room drops to ~989 lines.

## 2.212 — botRouting extraction: routing memory + flag goal leaves serverSenses

The squad's persistent movement memory (ring-entry incumbents, failure graveyard, route leans, wait spots, push-calls, TerrainFlow, per-team commanders) plus the 528-line flagGoal evaluator and its escortSpot/standThreat/thiefOf helpers moved to `server_bun/src/botRouting.ts` as `BotRouting` — the domain "where a bot wants to run and why" now has one owner, and a retired bot's whole routing footprint prunes through one forget(). The push-call post + throttle + counter moved together as postPush so the three can't disagree. serverSenses drops 1035 → ~345 lines and is back to being the sensorium it advertises; Senses keeps thin delegates for every consumer-facing signature (flagGoal, taskGoalFor, debugTasks, pushTarget, pushCalls, thiefOf via build). botUntrack's leak pin now reads the maps under sense.routing.

## 2.213 — structSinks pin: the three structure sinks can't drift

The roomStructures extraction's whole point — colliders, the mapUpdate diff, and the join-time setMap echo all read the same eff() — is now pinned by a scenario test: kill the generator and the alpha shield pane vanishes from ballSim colliders, exactly one skinny mapUpdate, and the echo in the same call; a gen-less team's pane survives any refresh; a settled refresh emits nothing. (Settling note: the first refresh legitimately diffs once — seatKits grounds authored pos.y on live terrain — so the silence assert runs after that settles.)

## 2.214 — deploy claims ground at the surface server-side

handleDeploy trusted the claim's y verbatim within the 40m plant ring: a forged or buggy pod could plant a turret/mine floating 30m up (or buried under the field) and the replica would echo it everywhere. Claims now snap to the supporting surface — highest structure top under the point via a downward solid cast, else terrain — inside a ±3m trust band so ramps and ledges keep their claimed y. Pinned: an airborne claim grounds at terrain, a band claim keeps its y, a genless shield survives refresh.

## 2.215 — gunlab.html gated: dev surfaces close on prod hosts

gunlab.html shipped ungated — anyone could open /gunlab.html on a public build and get the full weapon/asset inspector (scan tools, bake hot-swap polling, creature/deployable previews). The entry now bails on non-dev hosts (isDevHost — https means prod) with a closed sign, and the ESC-menu SIM LAB/GUN LAB buttons are removed on prod rather than left visible-but-dead. Same gate wireDebugTools and the spawn-script toggle already used; this was the last dev surface reachable without the flag.

## 2.216 — the whole dev-page class gated: 11 more tool pages close on prod

The gunlab hole was a class, not a page: 11 more standalone tool pages shipped open on a public build — aodump/posedump/sfxdump/vmdump (asset inspectors + headless-pipeline dump pages) and 7 inline-script pages (skytest, uvcheck, classlineup/fbxconv/modellineup/pickup_lineup/turretter tests). TS entries now bail on non-dev hosts with a closed sign; the inline pages guard their module with the same https-means-prod rule as isDevHost (no import needed). animgrid.html left alone — its /src/animgrid.ts entry doesn't exist anywhere, so the page is already inert; flagging it as a dead-file candidate for the owner's cleanup pass.

## 2.217 — prod debug handles gated: __scene/__renderer/__renderScan/geoNaN

The last ungated prod surface in the debug layer: wireDebugKeys installed every window handle unconditionally, so a public build exposed the whole scene graph (__scene), the renderer (__renderer), a render-cost scanner (__renderScan), and the geoNaN bounding-sphere watch. Those four now install only on dev hosts. __perf/__trailDump/__renderDump deliberately stay — the shipped watchdog diag dump reads them for crash-log context, so gating them would degrade production diagnostics.

(Scope note on 2.215/2.216: vite's dist ships only index.html — the tool pages were never reachable on a dist deploy. The gates close the exposure on builds that serve client/ directly — LAN builds, tunnels, co-hosted static — i.e. defense-in-depth, not a live prod hole. The __scene/__renderer gate in 2.217 does ship in the main bundle.)

## 2.218 — clip-feed lane + sinks sweep: CoolShotsPanel stored-XSS fix, console probes dropped

The least-audited code in the tree (the new clip feed) came back clean — generation-guarded timers, non-throwing clip resolution, trimmed queue, capped prefetch, FIFO vault — but the innerHTML sink sweep behind it found a real hole: renderShotItem interpolated shot.weapon, an uploader-controlled string riding server clip metadata, into innerHTML unescaped — a crafted clip was stored XSS in every viewer's panel. The row now builds textContent spans; a crafted name renders inert. The rest of the innerHTML call sites verified numbers/static-labels only (buff chips, entity counts, HUD skeleton), FragMessages already escapes, and no insertAdjacentHTML/outerHTML/eval sinks exist. Also dropped: the [standPlant] collider-vs-mesh console probe on the prod flag path (with its homeLogged marker field).

## 2.219 — deployBody: the jscpd sweep's one clone was a class

The whole-repo duplication audit came back 0.02% — one clone — but it pointed at a class: the tickUnfold/unfoldDone/heal/takeDamage bodies had been re-typed across DeployBeacon/DeployDrone/DeployShield/DeployStation/DeployTurret (~20 lines each, armor-soak + easeOutBack rules identical). client/src/entities/deployBody.ts now owns them as free functions over a structural DeployBody; each entity keeps thin delegates plus its per-kind hooks (turret mast rise, beacon pillar reveal, shield placed flag). unfoldT goes public on the five — it joins health/armor/dead already public on the same rows. Mine keeps its own takeDamage (detonate-on-hit, armor-eats-one). One vitality rule set for every placed deployable now.

## 2.220 — lint error sweep: keep-alive markers dead, audit suite found one dup class

The repo's own audit suite (audit:dup jscpd + oxlint error tier) ran: duplication is 0.02% and the one clone was the deployable vitality bodies (now deployBody.ts). The oxlint error tier held six live "keep-alive" marker statements — bare `scene;`/`vgs;`/`dmg;` lines people wrote to silence unused params — plus a useless spread in TickLoop's quarantine drain and `new Array(6)` ambiguity in ServerBots stage timers. All cleared (params renamed _scene, side-effecting news unbound, Array.from). WIP files (main.ts, botCommand.ts, lobbyPanel.ts) have the same warnings — left for the owner's WIP. Note: .oxlintrc.audit.json's type-aware pass needs the oxlint-tsgolint package — not installed; the base tier ran clean after fixes.

## 2.221 — floating promises: type-aware lint found live unhandled rejections

Ran the repo's audit config through oxlint-tsgolint (type-aware tier). ~29k findings collapse to ~40 floating/misused promise sites; most catch internally (fetchCoolShotsFromServer, loadTasGhost, Lobby boot). The real floaters: applyTerrain + applyInteriors on the mapUpdate path (a rejected terrain fetch was a silent unhandled rejection), saveLastRoomMap on both gameState and mapUpdate, requestPointerLock in demoLifecycle, roomFactory's loadField.then (a bad terrain file killed the boot with zero log), and DemoStorage's boot index load. All now catch into logger — same pattern applyInteriors already used.

## 2.222 — type-aware lint suite live; findings triaged to intent

`lint:audit` was broken in practice — oxlint-tsgolint was declared in client devDeps but never installed. Installed; the full type-aware pass now runs (~1.6k findings). Triaged: floating promises → real fixes in 2.221; unbound-method (28) → all verified safe (arrow destructures on NetCtx, .call-bound logger picks, `this`-free statics like lockedForClass); no-unnecessary-condition on wire paths → intentional runtime guards (types declare packet fields non-nullish but packets can lie — the declared-field check validates presence; the guards stay); non-null assertions → crash-on-wrong is the correct failure mode on literal tables/index math; the rest are style tiers (explicit-return-type, consistent-type-imports) left as-is.

## 2.223 — knip sweep: unused-export census triaged

knip (v6, already devDep) ran clean: 84 unused exports, 13 unused types, 1 duplicate export. Triaged to intent: the weapon/projectile `*_CONFIG` re-export tables and `DEPLOY_DEFS`/`ANIM_NAMES`/`MOVEMENT_CONFIG` are public tables; `auditScene`/`poolDump`/`trailStats`/`instPoolDump` are dev-window hooks knip can't see; `Logger|default` is a deliberate dual export (namespace + `import Logger` sites). Plausibly-dead remainder is a handful of tiny functions (weedTwigs, finishLoad, attachEdgeWear, seatOn, polar, setTerrainBlendSand, toggleLogPanel, auditHudOverlap, loadHeightmap×2) — left for the owner's cleanup pass rather than a speculative mass delete.

## 2.224 — claim-layer census post-audit: one real double-blast killed

Re-mapped the residual claim surface against the report's kill list. Dedicated is already claimless (25 simmed weapons, intents for melee/beam/repair/slam, combat claims refused at the wire); the client's predicted-shell reconcile (shotId → byShotId → linkOwnProjectile on projectileCreated) is fully landed. On P2P the host runs the full CombatHandler + RoomProjectiles + RoomMoveSim + beamSweep, so every weapon claim path is simmed or suppressed there too — except one: lgPop gated its death-burst on authoritySims() (dedicated-only), so a P2P guest claimed the pop AND the host's beamPay detonated the same banked charge. One corpse, two blasts; now gated on authorityShells(). The survivors are the surfaces a host structurally cannot sim: heal (ambient pickups), creatureHit/crawlerHit (no roster sims — inert on duel.json), repair (politely refused). The 2.223 dead-file guesses confirmed and cut: toggleLogPanel peek path (Alt+Q repointed long ago) and loadHeightmap() (Image-load loader superseded by injectHeightmapBytes on the wire path).

## 2.225 — P2P host collider + teardown parity: three silent-divergence gaps closed

The host's `setMap` re-pointed `roomInfo.bases` and the projectile collider set, but two more sinks kept the OLD map's colliders: the MessageHandler structure set (beam sweeps resolved hits against geometry nobody renders anymore) and the moveShadows' RoomMoveSim (guests who slide off a wall report a position the shadow can't reproduce — phantom resyncs on every map swap). All three sinks now re-point in one call, same pattern Room uses on its own swap. Teardown parity: `onClose` now calls `projectiles.clearOwner` before roster removal — a leaver's live shells used to keep flying and adjudicating hits for a player who no longer exists (Room.clearOwner already did this on dedicated; the host's RoomProjectiles instance just never got the call). Verified end-to-end: duo_p2p 6/6, focused struct/collider pins green, no regression across 1293 server tests.

## 2.226 — stateDebug lanes unified: one compare/streak/report driver for all five fidelity checks

C4's last live remnant: five hand-copied compare → streak → warn blocks in stateDebug (flag/pickup/deploy/creature/ball, ~170 lines) — the "a fix lands on one lane's copy and re-blooms on the next" drift class. All five now call one `laneCheck` driver owning match-reset / streak / perKey-persistence / warn-vs-debug escalation; per-kind code keeps only roster extraction + detail formatting (the semantic payload). Ball's per-key persistence (derived enraged/targetId churn at integrator boundaries) generalizes into the driver as `perKey`, so a future lane gets the right escalation by declaration. -118/+137 lines, all messages/behavior preserved. tsc + 504 vitest green.

## 2.227 — TickLoop lane emit unified: server side of C4 folded

The server's five replicaHash/kindFields computations (ball/creature/deploy/flag/pickup) were the same loop copied five times — the emit twin of the client lanes folded in 2.226. One `emitLane` body now hashes a roster + ships its per-id fields, both generated from the kind declaration; flag keeps its own line only because its roster is team-keyed rather than id-keyed. Adding a fidelity lane is now roster + one call on each end. -49/+24 lines, replicaParity green, full suite unchanged.

## 2.228 — stateHash wire shape folded: lanes ride a kind-keyed map

The fidelity lanes rode the stateHash message as eight parallel named slots (five *Hash + three *Fields) — the last place adding a lane meant touching the wire type, the emit, the dispatch, the handler signature, and the consumer. The message now carries `replica: Record<kind, {hash, fields?}>`; emit writes lanes by key, wireIn passes the map through, and stateDebug unpacks it once at the edge with per-lane tuple casts. A new fidelity lane is now declaration + emitLane call + laneCheck call — the wire, dispatch, and handler signatures don't move. Protocol owned end-to-end so no compat story needed; 504 vitest + replicaParity/tickSeqHash green.

## 2.229 — binary lane exception containment

onMessage's try/catch wrapped only the JSON branch — the binary hot path (28B position frames, the highest-frequency message on the wire) called handleGameMessage outside it, so a throwing handler on a binary frame escaped uncaught while the same throw on JSON cost only its sender's socket. The binary branch now runs the same containment: log player+type, close that socket with 1011. All three transports (WS, WebTransport datagrams/streams, RTC datachannel) funnel through onMessage, so the ingest edge is now uniformly contained.

## 2.230 — P2P host dispatch containment

Same gap as the dedicated binary lane, one tier down: P2PHost.dispatch called handleMessage unguarded, so a throwing handler escaped into the host's own event loop — on P2P the "socket layer" IS a player's game. A malformed-but-valid peer message could take down the host's session, not just their link. Dispatch now wraps the handler and closes only the offending peer's link on a throw. Ingest containment is now uniform across dedicated (JSON + binary) and P2P host.
