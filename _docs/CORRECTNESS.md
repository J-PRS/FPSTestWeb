# Correctness by Design

Why: the whackamole cycle (bug → telemetry → fix → next bug) happens when
truths live in reviewers' heads. This file is the standing rulebook; the
mechanisms below make each rule executable, so a regression fires a named
violation instead of a symptom hunt.

## The rules

1. **One measurement, one accessor.** Two sides of a comparison must read
   the same source. `pos.y` IS the eye point — measure burial with the
   sim's own `eyeHeight` (`moveSim.eyeOf`), never a class table a refit
   may have left stale. (The 1-rescue/sec unbury loop was class-eye vs
   sim-eye measuring the same body.)

2. **Rendered things floor on the drawn surface.** The mesh the player
   sees is the clipmap chord, not the bilinear field — flat triangles
   bridge gullies above it and dip below it on convex ground. Server
   truth that clients render must use `max(hmHeight, hmChord)`; client
   presentation uses `terrain.getRenderedHeight`. Bots, nuggets, blob
   shadows, remote lifts all obey this now — any new "thing that stands
   on ground" joins the same convention, no exceptions.

3. **shared/ is pure.** No `Date.now`, `performance.now`, `Math.random`,
   `process.env`, fs — shared code reads `sharedNow()` and injected RNG
   (`shared/env.ts`, `botRand.ts`; `strictRng` throws on ambient draws
   in deterministic harnesses). Client prediction only converges if both
   sides run the same step on the same input (Colyseus determinism
   contract: same inputs, same elapsed, no outside reads).

4. **Every prediction gets a verdict.** A claim the server refuses must
   answer back — `shotRejected`, `claimDropped`, `tickNack` — or the
   client's ledger ghosts forever. If you add a claim, add its verdict
   path in the same change; a silent decline is a ghost-hit bug by
   construction.

5. **Violations are named, counted, and survive.** `inv(name, holds, ctx)`
   (shared/invariants.ts): throws under `setStrictInvariants` in tests,
   counted via the host sink in prod (server `inv:*` health counters /
   client glitch census → alt+q dump). Assert truth, not representation;
   name the bug class, not the line. A hot-path invariant never crashes
   the match — it makes the dump say exactly what broke.

5a. **NaN passes every `>` gate — check `isFinite` before comparing.**
   `NaN > x` is always false, so a non-finite value sails through
   `dist > MAX`, `reach > cap`, `health <= 0` untouched. Every untrusted
   number needs its own finite gate at ingest AND at the write site —
   a validator upstream doesn't protect a path that writes around it
   (the teleport claim fed `lastValid*` directly, past the gated
   `updatePosition`; `healPool`'s `min(cap, NaN)` = NaN; NaN damage
   made a player unkillable because `health <= 0` was never true).
   Closed sites: move-claim anchor+sim, slam landing, deploy plant,
   hit-claim legality, knockback wire+shove, damage chokepoint,
   reconnect seat, healPool, shot/contact ingest, energy grant/drain,
   deployable hurt, clientStats renderLag, clampPing/rewindPos,
   pushRewindSample, remote roster (hit/join/diff-heal), deployHp.

   Sticky variant: `Math.max(0, NaN) = NaN` — a poisoned pool never
   self-heals. Pools also need a finite *recovery* at the tick clamp
   (energy drains to 0 and regen rebuilds; local health snaps to max).

6. **Render can lie, but every lie is watched.** Prediction, interp
   smoothing, corpse physics may diverge from wire truth — each divergence
   budget gets a census counter (render-blend, seg-div, nugrest, dmg-echo,
   remote-buried, anim-bind). New cosmetic divergence ⇒ new counter at
   birth, or the next "sometimes looks wrong" report has no instrument.

## Audited — verified state (2026-10-10)

- **Determinism (rule 3): clean.** `movement.ts`, `projSim.ts`,
  `combat.ts`, `heightfield.ts`, `ballSim.ts` hold zero ambient reads
  (`Math.random`/`Date.now`/`performance.now`). `MoveSim` integrates at
  fixed 60Hz with a step accumulator — same-step determinism on both
  sides. Ambient draws live only in bot brains (`botDisposition`,
  `botGoals`, `botHunt`, `botBrain`), which clients never predict —
  prod-legal by the rule's own letter.
- **Wire-row coherence:** `wire-row-finite` + `wire-row-coherent`
  (alive ⇒ hp>0) at the tick egress; `wire-vel-sane` magnitude cap at
  client ingest. No upper bound on hp — seeded pools legitimately
  exceed class max.
- **Above-floor postconditions:** `spawn-above-ground`,
  `teleport-above-ground` — both seed paths for "body under terrain"
  name the violation at birth.
- **Verdict-complete:** every WIRE table claim returns a verdict or
  reject; the three silent shotFired declines (dead shooter, dry belt,
  spawn refuse) now reject with shotId.
- **Drawn-surface floor (2026-10-10):** every rest/contact read floors on
  `max(hmHeight, hmChord)` — bot shadows, nuggets, dropped flags,
  deployables `groundY`, all creature families + spawn. Left on
  `hmHeight` deliberately: human movers (client predicts on it) and
  bot-routing LOS/lip probes (navigation, not rendering).
- **Corpses hold no channels:** server strips status/ski/jet at the kill
  edge; `corpse-no-channels` inv on egress rows; `applyStatusVisuals`
  zeroes dead rows' status words; `playDeath` clears auras + decloaks
  (covers bots via botEnergy, which bypasses the wire path).
- **Dead-claim gates:** every claim path refuses corpses —
  inputMove/teleport, shotFired (verdict), melee/slam, env credit/burst,
  deploy plant, flag throw. `respawn` is the deliberate exception.
- **Respawn pipeline:** all kills converge on `creditKill` → `schedule`;
  reconnect/restore re-arms via `ensure`/`ensureScheduled`; timer body
  try/catch so a throw can't strand a corpse; held (die+spectate)
  honored; `respawnNow` can't skip a live countdown; `tick()` drains
  dueAt for non-networked drivers.
- **Damage funnel:** `damage-finite` inv asserts finite + non-negative at
  `applyHit` entry; armor soak bounded by `min(armor, …)` so it can't
  over-drain; health clamps at 0 on kill.
- **Encoding:** positions pack i32×0.04 with explicit clamp (±85Mm — the
  ±1310m "parked" desync is the documented prior bug); vel/rot/health
  all clamp; `handleTeleport` reseats `lastValid*` so a resync can't
  resume from a corpse-side anchor.
- **NaN-floor containment:** `hmHeight`/`hmChord` stay poison-in/poison-
  out (sim parity); every consumer gates — a NaN floor isn't a floor.
  ~40 sites: spawn/teleport/flag/pickup invariants, bot unbury rescue,
  remoteDeath bounce, flag rabbit drop+tumble, botSheep/brain/spawnSpot,
  crawler spawn/emerge/land, ballRage, Baneling land+steer, ball spawn,
  deployables ground, pod land/attach, Grub, nugget, ballSpawn.
- **Wire-ingest lanes:** player rows (pos+vel+rot+t), balls, crawlers,
  pickups, flags, deployables — all drop non-finite with warns; the
  roster-join vs per-tick asymmetry that leaked `deployHp` is closed.
  Presence lane sealed too: `onRemoteTeleport`, `onPlayerRespawn`
  (local + remote), jump/jetpack effects, `onMineBoom`,
  `onSentryShot`; `net.push` covers the update lane. Roster/reconcile
  lanes: gameState remote reseat, sensorPing targets, teamScore/
  ffaScore scoreboard state, roster match-meta (scores/ffaScores/
  matchEndsAt), restored yaw/pitch on local reseat.
- **Radius-skip NaN shape:** `if (d >= radius) continue` is FALSE on a
  NaN distance — the guard fails into the write. Every blast/knock
  funnel now finite-gates its center at entry: `processAOE` (one gate
  covers splash/plate/heal/flag/pickup/prey fan-out), `RoomFlags.
  throwFor`/`loose`/`knock`, `RoomPickups.knock`, `CreatureSim.knock`,
  `ballCombat.knock`. `RoomDeployables.applyBlast` already guarded the
  dmg line; client leaves (`applyKnockback`/`applyPull`) gate at the
  impulse write.
- **Spawn/shadow seeding:** `pick()` results finite-checked at join and
  respawn (fallback: lastValid anchor / mid-map drop — a NaN spawn
  broadcasts an invisible player). Shadow-state writes sealed:
  `applyImpulse`, `resync`, reseat `setState` all drop non-finite at
  the write — the sim-pos/sim-vel invs stay monitors, not fixes.
- **Trust boundary:** `MoveSim.setInput` clamps forward/right to [-1,1]
  finite and coerces booleans — doctored magnitude can't speedhack.
- **Clock domains:** `SimMs` vs `WallMs` audited — `forceSendUntil` read
  on the sim clock fixed (perma-forced/stale sends under warped time).
- **Cadence:** per-weapon `fireWindows` gate restored — the dead-write
  class (gate written only in a `.old` file) that let a 2s-interval
  mortar claim ~13 shots/s.
- **Damage-write family closed:** `damage-finite` at `applyHit`,
  `deployable-hurt-finite`, `creature-damage-finite` (all four kinds),
  `ball-damage-finite`, `bot-damage-finite` — a NaN dmg made its target
  unkillable because `hp <= 0` was never true.
- **Anti-cheat lanes verified:** `plausible()` rejects >50m/>300m/s,
  seq>lastSeq monotonic (not zeroed at death), transit =
  min(clientEma, serverEma+slack) two-channel, input seq-journal cap 8,
  env claims finite/self-only/capped/proximity/cadence/healCredit.
- **Impulse ingest:** `applyKnockback`/`applyPull` finite-gate wire
  `force` before it enters `vel`; `ExplosionTracker.addExplosion`
  drops non-finite pos/force (gib impulse math reads it at kill).
  Client blast fan-out sealed at the funnel: `applyExplosionForce`
  drops non-finite pos/radius/force before it sweeps every Forceable
  (player shove, balls, creatures, nuggets, remotes, deployable splash).
  Write sites gated: `remoteInterp.predict` (NaN seed → NaN ghost vel
  on a cleared buffer), `Nugget.serverRest`/`applyKnockback`/`applyPull`,
  `parity.noteShellFate` (NaN srvAt poisoned divergence diffs). Every
  creature `applyKnockback`/`applyPull` write site gates too — 14
  species + Totem's blastPush/blastPull (Mine is a no-op stub).
- **Roster sink:** `upsertRemotePlayer` drops non-finite pos/rot/vel
  patches at the write — covers tickUpdate/join/respawn/roster-heal
  edges in one place. `netCrawlDie` falls back to replica pos when the
  wire die position is NaN (dust/demo feed). Ball/crawler spawn+seg+evt
  lanes already finite-gate at `netBalls`/`netCrawlers`.
- **Pools bounded:** `pool-positive` (correct formula yielding ≤0 max
  = a spawn-kill), `energy-bounds`/`local-energy-bounds`,
  `local-health-finite` with NaN recovery, belt-charge economy (every
  decrement behind a sufficiency check; regen `min(BELT_MAX,+1)`-capped),
  armor min/max-clamped at every write.
- **Projectile trails:** emit lead measures the emitter's real per-frame
  travel, not `vel*dt` — interp/shadow hosts no longer leave a head gap.
- **Deploy-plant lane:** kind/cap checks, `badpos` finite gate,
  `MAX_PLANT_DIST` bounds, belt economy, `groundY` reseats claimed Y.
- **Team-flip coherence:** `players.setTeam` + `moveSim.setTeam` fire
  together at rebalance; all game-logic reads are live `p.team` (FF,
  flag grab/cap); the deployable team-stamp at plant is deliberate
  (gear fights for its planting team).
- **Score attribution:** self-frag excluded before any award; CTF
  zone-kill pays before the `ptsPlayerKill` gate; damage economy chains
  the hit *event* so self/friendly/env never land; `dmgPool` keeps
  sub-100 remainders across lives; `dropPlayer` removes the row and
  re-echoes the board; `awardPersonal` in team rooms can never end a
  match (honor column).
- **Heal credit (by design):** team rooms refuse `heal` claims — gems
  heal server-side AT collect (the collect is the intent; a claim could
  be dropped). `healCredit` only exists for the refused lane; free-form
  heal stays live in non-team rooms.
- **Join/roster coherence:** `hasReceivedPosition` gates in-world
  membership (unreported joiners spawn no ghost mesh); `joinAnnounced`
  once-per-record; wireIds ship inline in the join snapshot.
- **Ordering (verified):** stale `tickUpdate` racing `playerLeft` can no
  longer resurrect a phantom remote — `onPlayerUpdate` requires a roster
  record (upsert always precedes it for live rows). Membership edges
  (joined/respawn) mint by design and are ws-order safe.
- **Lifecycle/leak hygiene (verified):** `RemoteSet.remove`/`prune`
  dispose + fire onRemove; stamp ledgers all bounded (`recentKb` 8,
  `selfBlastStamps` 8, `dmgEchoes` 32+900ms, `shellFates` 64+15s,
  interp buffer time-windowed); `lastWeaponByPlayer` cleans on
  playerLeft; server `onPlayerDisconnected` purges every per-player
  map (fire/lastHeal/envCredit/healTicks/chargeBank/warn/drop keys).
- **Mutation during iteration (verified):** every entity list sweeps
  backwards for in-place removal (`updateDeadList`, balls, species
  loop); spawns land before the sweep, never inside it; `speciesAggro.
  _candList` clears before refill; `lodAcc` is a WeakMap — entries die
  with the entity, no leak on any removal path.
- **Room-switch lane:** dead players denied before `roomFor` (can't
  dodge respawn or churn map specs); cooldown; `correctionGraceUntil`
  mutes in-flight stragglers; pending class/perk rides; session
  re-seated; `markReseated` arms shadow drain.
- **Session reclaim:** server-issued token checked before the connected
  test; new socket registers BEFORE the zombie is evicted so its close
  can't re-mark disconnect; missed reliable events replay before the
  handshake reply; restored-dead re-arms respawn.
- **Replay/decode baseline:** `replayTo` skips `seq <= fromSeq`,
  honors only/exclude + volatile TTL; room-wide `introSeq` stamps ~1s
  of full records on reclaim (documented — records are shared),
  500ms nack cooldown blocks storms.
- **Server ray lanes:** `dir` normalized at both beam/repair call sites
  with `|| 1` fallback; muzzle derived from `rewindPos` not claimed;
  bounded range; 30/s flood gate.
- **Spawn selection:** authored anchors lifted to `groundAt`, scatter
  re-floors finite, `spawn-above-ground` inv at pick, camped points
  excluded via `foeClearance > CAMPED_R`, team pools isolated.
- **Per-life reset (`respawnPlayer`):** banked class/perk applies only
  at new life; `health-pool-formula`+`pool-positive` invs; status/
  ski/jet zeroed; `lastSeq` preserved (zeroing reopens seq gate to
  corpse-regression — documented); `lastValid*` reseated.
- **Map/lifecycle hygiene:** `dropPlayer` clears cadence maps
  (`lastFireNotify`/`simmedFireTimes`/`fireWindows`/`lastHeal`/
  `lastEnvCredit`/`chargeBank`/`healTicks`), `untrack`
  frees sim shadows, room removal deletes wireIds+lastSentPositions;
  v4 wireId remint can't inherit masked fields (remove evicts byId);
  entity lists all prune via `updateDeadList`; snapshot journal sorted-
  insert with `latestT` never rewinding; flag-carrier coherence swept
  20Hz; repair lane re-derives range/LOS/team/rate server-side; deploy
  ticks skip `isDead`; contact bodies read gated positions only.
- **Session lifecycle (veil + reclaim):** while veiled the loop renders
  the scene but skips sim/input — warmup draws burn off shader/texture
  compile hitches before the player drops in; veil drops only after
  gameState lands AND ~45 stable (<26ms) frames (180-frame cap, 8s
  failsafe). Server reclaim grants ~2.5s `protectedUntil` — the
  restored body is unkillable during warmup by a real game mechanic,
  not hidden under the curtain. A reclaim is NOT a respawn: the seat
  keeps its record, so the shield is stamped at the reclaim point
  (`SessionManager`), not at spawn.
- **Session/transport lanes (all verified sealed):** input journal
  bounded 128 + seq-ordered + drop-on-resync; `dropInputJournal`
  precedes `sendResync` so corrections hard-snap instead of replaying
  the hidden interval; spawn dedup via `byId.has(id)` on balls and
  crawlers (dead-ctor never registers so roster respawn can retry);
  map-swap serialized through `terrainSwap` chain with wanted-key
  dedupe and abort-before-commit; spectators are read-only — the
  `specRooms.has → return` gate precedes ALL game dispatch, binary
  included; roomSwitch cooldown bounded + dead-hop denied pre-roomFor
  + straggler reports muted via `correctionGraceUntil`; fire cadence
  windows rolling-1s per weapon, purged on disconnect; `tickNack`
  double-gated (500ms room cooldown + no re-stamp while a full
  window pays out).
- **Tick fanout / wireId lifecycle (verified sealed):** retired u16
  ids reissued only after a quiet window; a fresh mint forces a fresh
  `v4Last` basis AND a full record — a masked record could otherwise
  hand receivers the departed owner's hp/flags (documented in-code).
  Per-player maps (`wireIds`, `v4Last`, `lastSentPositions`,
  `chatPace`) all purge on removal; `introSeq` full-window reseeds
  decode baselines on seat/reclaim/nack.
- **Flood control + buff fields (verified sealed):** `rateLimiter.check`
  gates every message type (muted chat echoes back grayed, warn
  throttle can't itself flood, per-type hb counters). Every
  playerId-keyed server map purges on disconnect — including
  `rateLimitWarnings`. Buff/timer fields (`regenUntil`, `ddUntil`,
  `charge`, `armor`) are server-owned: pickups/blast grant under
  POWERUP caps, death zeroes, no claim path writes them.
- **Claim lanes (verified sealed):** deploy-plant gated end-to-end
  (dead check, kind whitelist, cap-0 denied, finite, belt cost,
  MAX_PLANT_DIST reach, server-decided `groundY`, per-player cap
  recycle, team stamped at plant); chat routes on the sender's
  roster team never the claimed flag, text re-truncated, VGS
  regex'd; beam intents (lightning/repair/melee) flood-gated 30/s,
  muzzle rewind-derived not claimed, dir finite-gated once at :337
  then normalized, ranges are server constants.
- **VFX ledgers (verified sealed):** live explosions capped at
  `MAX_LIVE_EXPLOSIONS` 48 (oldest retires early); scorch/splat decals
  self-expire on `age/LIFETIME` and insta-die when the tab hides;
  BallDebris shards carry per-shard life budgets + deadlineMs
  resumable updates; all swept by `updateDeadList` backward-splice.
  Push volume is bounded upstream by rate-limited wire events.
- **Remote projectile lifecycle (verified sealed):** a lost
  `projectileDestroyed` edge can't leak — every replica carries a
  fuse/terrain death of its own and `onExploded` releases the
  `remoteProjectiles` entry whichever way it dies. The wire edge
  only improves blast accuracy (`snapToContact` to the authority's
  contact point); the map entry is unmapped at destroy-time, not
  fade-end, so dead records can't accrue.
- **Session-edge world reset (verified sealed):** `gameState` purges
  volatile FX in place (splice — debug ctxs hold the array by
  reference), removes remotes the new roster doesn't name (ghost
  bodies) or that read non-finite, reseats every interp anchor
  (serverMs is per-room — stale anchors froze remotes mid-rubber-
  band), and reconciles pickups/deployables/flags/map snapshot
  rather than leaving old-room residue.
- **Deployable roster reconcile (verified sealed):**
  `reconcileDeployables` evicts stale id-collision replicas (deploy
  ids are per-room counters — a previous room's replica can sit on a
  reused id), reaps ids the snapshot doesn't name, adopts
  pre-record-window spawns into the demo ledger, applies roster hp
  to own plants without double-rendering them, and culls the own
  lane the remote reconcile can't see. `remoteSpawn` drops
  non-finite wire positions at the write site.
- **Pickup roster lanes (verified sealed):** `addPickup` drops
  non-finite spawn pos; a recycled id hosting a different kind is
  collected out rather than patched (kind is constructor-fixed —
  patching desyncs the pickup hash lane forever); a re-spawn on a
  live id is a blast-knock rest spot (`serverRest` — itself
  write-gated). `reconcilePickups` reaps ghosts the gone edges
  missed; `pickupGone` fades the replica and bounds the belt grant
  at `BELT_MAX`; `onBuff` finite-gates health/armor and a NaN
  `until` fails safe (buff never displays).
- **Flag wire lane (verified sealed):** `applyFlagUpdate` drops
  non-finite pos/home at the entry; `reconcileReplicas` reaps
  teams absent from the roster (mesh, marker, HUD diamonds,
  flagStates all cleaned); 'dropped' streams ease toward
  `wirePos` rather than snap mid-flight; match-reset →home
  transitions hush via `flagHomeHush` so `flags.reset()` can't
  fake cap/return callouts.
- **Combat ingest lanes (verified sealed):** `onPlayerHit` drops
  non-finite damage/health (armor separately guarded), warns on
  hits-to-corpses; `onShotRejected`/`onYourHealth` finite-gated,
  yourHealth also warns on heal-channel hp drops (wrong-door
  write tell); `onKnockback` gated + deduped against self-blast
  stamps + `recentKb` (bounded 8) so an echo can't double-shove;
  `onCorrection` drops non-finite authority vectors before
  rewind+replay, clamps journaled segment dt ≤0.25s;
  `onRemoteTeleport` gates before `teleportTo`; `onYourCharge`'s
  ungated scalar fails safe (NaN > 0 is false everywhere).
- **Match lifecycle lanes (verified sealed):** `onTeamScore`/
  `onFfaScore` finite-gate before writing `teamScores`/`ffaScores`
  (a NaN score would poison `Math.max` lead math); matchEnd/
  ffaMatchEnd scores are display-only — chat text + banner, no
  state writes; the scoreboard auto-pin only releases what it
  pinned (deliberate Tab never hijacked); `onMatchStart` resets
  lead/milestone filters + killStreak + `flagHomeHush` so the new
  round can't inherit stale announcements.
- **Kill wire lane (verified sealed):** `onPlayerKill` derives
  kill/death counts from the server edge only (no client-side
  double-count path); the victim's roster record flags dead
  immediately so per-frame sim can't resurrect; streaks reset on
  own death + match boundary + announce only on the crossing
  kill; gib impulse pulls from the finite-gated ExplosionTracker
  with `|| 1` length-division and `?? 10` force fallback;
  far-victim gibs take the instanced path (~120m budget) so a
  death spike can't hitch the frame.
- **Melee whiff lane (live-soak fix):** `hurtPlayer`'s reach gate
  measured strikes against the attacker's *interpolated* pos — a
  netDriven replica trailing server truth by ~10-20m read as a
  stationary attacker way out of reach, the whiff then DROPPED the
  env-damage claim (server-valid hits landing later as
  damage-from-nowhere). netDriven attackers now bypass the reach
  gate: their strike is the replica's own committed sim, and the
  claim re-adjudicates server-side regardless. Offline creatures
  (locally-authoritative sims) keep the gate.
- **Renderer context loss (verified sealed):** `createRenderer`
  catches WebGL context-creation failure and schedules a reload;
  `webglcontextlost` reloads immediately — a lost context is
  unrecoverable for three anyway (khronos: recreate ALL resources).
- **Outbound claim lane (verified sealed):** every `send*`
  (`shotFired`, `environmentDamage`, `deploy`, `slam`, `teleport`,
  `jump`, `crawlerHit`/`creatureHit`) carries only fields whose
  write sites are already finite-gated upstream, and the server
  drops/adjudicates anyway — `finiteVec` on `dir`, `isFinite` on
  slam position, ClaimVerdict on env damage. JSON's `NaN → null`
  means a stray claim nulls out server-side rather than writing
  NaN into sims.
- **Wire dispatch coverage (verified sealed):** the handler map is
  keyed on `ServerMessage['type']` — tsc won't compile with a
  declared-but-unhandled type; genuinely unknown types warn.
  Handler throws are contained per-message (a throwing tick at
  20Hz can't reconnect-loop the socket) with `handlerThrows`
  counting the half-applied-state hazard in the dump.
  `send dropped — no live lane` is the send-side counterpart:
  legit during the connect window, counted + lastType logged.
- **Ball sim-clock (verified bounded):** `estSimNow` is
  monotonic-clamped (never rewinds — extrapolation consumers read
  positions off it), re-anchors its floor on far-behind stamps,
  and EMAs the sim→wall rate only on Δarrival >0.2s samples so
  join bursts can't poison the rate. `ballEventAge` clamps 0.6s.
  The soak's `simT 2.4s > simNow` rubberbands were the leg
  free-run between sparse join-window segments — the documented
  catch-all regime, self-correcting per segment, not a steady
  divergence. Canary working as designed.
- **Wire epoch hygiene (verified sealed):** `lastTickSeq`/
  `lastHitSeq` reset on reconnect (`resetForReconnect`) AND inside
  `handleGameState` — a room hop without reconnect can't freeze
  remotes behind the old room's watermarks. `wireIds` +
  `tickPool.byId` cleared per epoch so a reassigned wireId can't
  inherit another player's decoded baseline. Protocol mismatch
  reloads with a storage-bounded budget (never loops).
- **Input stream lane (verified sealed):** client sends a
  change-only seq'd stream with the previous edge piggybacked
  (a single lost packet heals on the next edge); journal bounded
  at 128, resend re-emits the CURRENT input under a fresh seq
  (never replays stale edges), and `inputsAfter` re-seeds the
  held input for the correction gap so steady-key corrections
  don't hard-snap. Server gates against the pending tail AND the
  drained watermark (reordered stale edges can't append behind
  fresh ones), pending bounded 8, seqStates bounded 32.
- **Divergence→correction loop (verified sealed):** `reconcile`
  returns sim truth past tolerance → authority mode sends it back
  as a `correction`, reseats `lastPosCheckPos` at the corrected
  spot (else the client's snap reads as a speedhack reject) and
  mutes judges (in-flight pre-correction reports can't blip the
  streak). Judge mode deliberately never corrects — the snap IS
  the warp; divergence is an anti-cheat signal only. Plausibility
  anchors update even on reject (no reject-spiral), and NaN
  reports fail the `isFinite` gate before either mode touches them.
- **Hit-claim lane (verified sealed):** client claims carry INTENT
  only — melee sweeps derive their arc point from the server-rewound
  shooter origin + normalized dir (a forged position can't widen
  the arc); beam/repair ticks re-raycast server-side off the honest
  ray; and every path is bounded: 20/s flood gate, per-weapon
  cadence window (0.85× slack for loss bunching), class-locked
  weapons rejected, belt charge paid at intent time. No client
  number reaches damage math unverified.
- **Deploy-plant lane (verified sealed):** kind whitelist (cap-0
  kinds are map-authored only), `isFinite` pos gate, belt-charge
  economy, `MAX_PLANT_DIST` reach bound, `groundY` pins the
  claimed Y to the rendered surface (chord+terrain+colliders —
  no sky-forts, no buried claims), per-player cap recycles
  oldest, team stamps at plant time (a later side-switch can't
  desync gear loyalty), owner death clears items AND repair keys.
- **Pickup collect lane (verified sealed):** no client collect
  claim exists — the server sweeps swept-segment proximity per
  tick (a full-speed ski can't tunnel through the ring), armT
  grace skips still-flying gems, gem/tag kinds require a team,
  the grab is planar+6y (a jetpack flyover isn't a touch),
  reach scales with the pickup perk, and `prevPos` prunes
  departed ids so stale anchors can't span idle time.
- **Heal/repair lanes (verified sealed):** heal is self-only +
  `isFinite` + ≤25/call clamp + 1.5s cadence (a refused claim
  doesn't reset it); team rooms require `healCredit` the server
  granted at gem-touch (no free regen); `forceSend` keeps the
  health write from being delta-suppressed. Repair claims are
  rejected outright in simmed mode (`acceptClaims===false`) —
  the server re-casts the weld target off the honest ray, so
  the claim's targetId is never trusted.
- **Creature-hit claims (verified sealed):** `crawlerHit`/
  `creatureHit` reject unknown/dead ids, bound range at 600m
  (deliberately lenient — the shadow judge is the real
  anticheat), clamp damage to `MAX_HIT_CLAIM_DMG`, and the
  melee half is server-derived anyway (`meleeSweep`: rewound
  origin + reach + `MELEE_ARC_DOT` cone — the client claims a
  swing, never a contact).
- **Wire schema layer (verified sealed):** every claim type has a
  rate window tuned to the honest cadence (aoeShot 30/s — GL
  spam cap above the 24/s held-beam floor; slam 6/s, jump 10/s,
  shotFired 40/s) plus typed validation (`validateVec3`/`optVec`
  finiteness, weapon enums, id length caps) — malformed claims
  die at decode, before any handler. Teleport is deliberately
  un-limited (dropping a declared discontinuity just desyncs
  the client); its abuse is counted via `teleportSpam`, and
  position plausibility lives in moveClaims.
- **Meta claims (verified sealed):** `skillUse` carries no
  amount/id — the server re-derives the energy ante (a flood is
  harmless + rate-capped anyway); `throwFlag` carries no
  direction — the arc derives from the shadow's truth; class and
  perk swaps are enum-validated AND banked for next respawn (a
  mid-life apply would be a free heal + unsynced speed scale);
  `switchRoom` sanitizes to word grammar + clamps bots ≤24;
  `snapshotRequest`/`resync` (the expensive ops) capped at
  3 per 5s; respawn 3/s; chat length-capped + flood-limited.
- **Server tick loop (verified sealed):** sims take MEASURED
  elapsed dt clamped to `[TICK_DT, 1s]` — a fixed 50ms would
  drift ~18% behind wall under load (client replays overshooting
  every resync); the 1s cap prevents hiccup spirals. Per-room
  containment: a throwing tick is phase-named, streak-counted,
  and ~10 consecutive failures quarantine + drain the room
  (players get a close frame → reconnect to a fresh room, not a
  frozen world). `faultedRooms` bounded, streak keys cleared per
  name so a same-named room isn't born frozen. No-audience
  hibernation sleeps sims; unconditional frames every tick keep
  the client loss metric and `ackSeq` pruning honest.
- **Identity/session lane (verified sealed):** playerIds claim
  via `HMAC(playerId, secret)` tokens — a taken id can't be
  stolen by knowing it; reclaim resolves by server-known
  `roomOfPlayer` (never the claimed room — a mid-grace hop
  can't orphan the slot) and runs BEFORE the join flood guard
  (a flapping transport can't throttle the legit owner out).
  Pre-join keepalives swallowed (not session-killed), joins
  IP-throttled at 5/min, room + global player caps, spectator
  squatters evicted by real joins, reclaim stamps
  `protectedUntil` for the warmup window.
- **Flag lane server-side (verified sealed):** NO flag claim
  exists — grab/cap/return resolve in the tick's swept-position
  pass alone, so a client can only render the wrong visuals,
  never move the objective. `throwFlag` is payload-less (arc
  derives from shadow pos/vel/rot + finite gate); `loose`
  finite-gates the corpse vel; `knock` finite-gates the blast
  args at entry (the NaN skip-compare class, fixed earlier).
- **Command buffer (verified sealed):** client frames queue into
  `room.commands` capped at 2000 (excess counts `msgsRejected` —
  the metric IS the surface; per-drop logs would spam), each
  entry arrival-stamped so a stalled tick can't charge the whole
  backlog into one limiter window, and drain is per-command
  contained + arrival-ordered at phase 0 (sims see a
  deterministic input→sim→fanout order, never mid-frame
  mutations).
- **Outbound send lane (verified sealed):** tick frames shed at
  256KB socket backlog (drop-safe — peers extrapolate); reliable
  frames queue but ride the drown clock (4MB buffered starts a
  5s window, then close-1011 so the client reconnects through
  grace rather than rendering seconds-stale truth). The reclaim
  journal is bounded (1024, chunked evict), volatile cues
  (muzzle flash, knockback) expire after 3s so a reclaim can't
  replay phantom effects, self-repeating echoes (yourHealth/
  ping/stateHash/gameState) never journal, and evictions +
  reclaim gaps are counted (`journalDropped`/`reclaimGap`).
- **Tick fanout records (verified sealed):** egress chokepoint
  invariants `wire-row-finite`/`wire-row-coherent` (alive row at
  hp<=0 is a lie) /`corpse-no-channels` (a dead row claiming
  jet/ski means a write re-armed post-mortem). Delta basis
  follows the wireId, never the slot — roster shuffles can't
  misencode. Fresh wireIds + the ~1s intro window force FULL
  records (masked deltas are undecodable until the first full
  lands — a tier-skipped full would leave far clients' decode
  pools stale forever). Suppression windows break on any status
  transition; the two-clock discipline keeps `wallNow`
  (suppression/silence) and `simT` (regen/dd/forceSend) domains
  unmixed.
- **Client loop dt discipline (verified sealed):** frame dt
  clamps to `MAX_DELTA_TIME` with NaN/negative guards (a hitch
  is slow-motion, never a spiral); hidden tabs get a separate
  wall-clock `fxDt` (2s cap) so cosmetics expire on real time
  instead of stacking into an AFK overdraw bomb; the fps-cap
  skips only the render call (sim/input stay full-rate); boot
  and veil stability meters live next to the frame meter so
  the same `rawElapsed` sample feeds all of them.
- **Remote snapshot lane (verified sealed):** reordered packets
  insert at timeline position — `latestT` never rewinds, so a
  stale arrival can't snap the render backward; undeclared
  teleports (>8m or >90m/s × span) wipe buffer + DR state (no
  speed-ghost slide, no impossible DR launch); DR velocity is
  estimated from server-tick deltas (jitter-free), its trigger
  scales to the measured arrival cadence; and `clear()` on
  epoch change keeps a stale `latestT` from swallowing every
  fresh push.
- **Local energy economy (verified sealed):** jet drain/regen
  runs per-frame on `Player.ts` — NaN resets to 0, floor-clamps
  at 0, `inv('local-energy-bounds')` counts cap breaches, and
  hitting empty starts `jetLockT` (the lockout the server-side
  economy mirrors). Jet gating reads `energy > 0` at input and
  tick time — a stale frame can't claim a jet the meter can't
  afford.
- **Belt charge economy (verified sealed):** every write is
  bounded — throws/deploys check `beltCharges < cost` first,
  spends floor at 0, pickup/award `+1`s clamp at `BELT_MAX`,
  spawn resets to `BELT_MAX`. Server re-charges at claim intent
  (CombatHandler), so the local ledger is prediction that the
  server ledger shadows; `beltTimer`/`throwLockT` cadence the
  regen. No client charge can go negative or exceed cap.
- **Warp beacon lane (verified sealed):** the energy ante is
  paid at throw (a beacon you can't afford can't exist, so the
  release teleport is already paid); single-instance guard +
  post-warp cooldown; 6s max-life fizzle; landing clamps
  `max(beaconY+0.4, groundY+0.4)` — never inside terrain; and
  `markTeleport` declares the jump so the server's plausibility
  judge doesn't read it as a speedhack.
- **Demo recorder buffer (verified sealed):** `DemoRecorder`
  frames ride a `CircularBuffer` sized `bufferSeconds ×
  tickRate` — a recorder left running can never grow memory,
  oldest frames evict in place; playback re-seats indexes by
  `slice(lastIndex, count)` so a stalled seek can't re-emit
  events; stopping a clip hands the live map back before
  recording resumes (a clip's embedded grid can't leak into the
  next recording's HMAP trailer).
- **Settings ingest (verified sealed):** every `fps-*` key
  funnels through a typed schema — corrupted/NaN numerics fall
  back to defaults at read (`Number.isFinite` gate), writes go
  through `String(value)` so no object leaks in; storage-disabled
  browsers degrade to a memory fallback instead of throwing
  through the toggle path; identity keys live in sessionStorage
  so two tabs can't fight over the same player id.
- **Chat/VGS flood lane (verified sealed):** T2 flood control
  verbatim — 4 messages per 5s trips a 10s mute for that type
  (the line grays in place so the sender sees what died), text
  gated to 1-200 chars, team flag coerced boolean. VGS lines
  ride the same chat claim (keypath alongside, not a second
  channel) so the voice menu can't bypass the window.
- **Heightfield gain sync (fixed):** the collider reads
  `HSCALE * hmScale` while the shader reads an `hScale` uniform —
  two knobs that must move together. `bootPrimeTerrain` (solo
  `?map=` / saved-room probe) and the demo HMAP inject/restore
  set `hmScale` without re-syncing the uniform — vortex drew at
  1x while the sim stood on 1.5x. `applyHeightfieldScale()`
  pushes the resident gain/span into the uniforms; called after
  `new Terrain`, demo inject, and demo restore.
- **Creature targeting lane (verified sealed):** `AggroKit`
  candidates refresh per frame; dead/cloaked/spectating flags
  gate `alive`; remotes with no position update aren't valid
  targets; and `_candMap` prunes any id the roster no longer
  holds (departed-player ghosts can't draw attacks). Stalk/chase
  memory lives in a WeakMap — it dies with the entity, and the
  1.6×-leash give-up bounds how long a stale target holds.
- **Audio voice pool (verified sealed):** one-shots ride a
  capped voice pool — overflow steals the oldest
  strictly-lower-priority voice (world < self < UI/stinger);
  release disconnects the node AND `freeInput`s the positional
  chain (a freed voice would otherwise leave its lp/pan tail on
  the world bus — connected nodes aren't collectable); remote
  move audio is a pooled loop pair per remote, capped, evicting
  only silent slots.
- **Deployable wire lanes (verified sealed):** every ingest is
  finite-gated — `remoteSpawn` (pos+hp+armor), `mineBoom` (pos,
  warns on drop), `deployHp` (hp+armor, heal-beam src separate);
  roster reconcile evicts kind/owner mismatches on reused ids
  before the absent-id reap (stale replicas can't ghost a new
  room's counter); own plants get roster hp without a second
  visual.
- **DOM text ingest (verified sealed):** wire strings (chat,
  names, frag text) reach the DOM via `textContent` only, or
  through `innerHTML` with every interpolated piece wrapped in
  `esc()` (`&` first, then `<` — no tag can form, no entity
  double-decode). Remaining `innerHTML` writes interpolate
  numbers or static markup only. A crafted name or chat line is
  inert text everywhere it lands.
- **Creature replica edge lane (verified sealed):**
  `applyNetEdgeSim`/`applyNetEdgeTotem` write wire pos/vel
  ungated by design — every caller gates upstream: `netCrawlSpawn`
  (:96), `netCrawlEvt` (:122), `netCrawlRoster` (:191). The
  replay accumulator self-heals (`netAcc` NaN → 0, capped 0.5s —
  a corrupt edge can't wedge the loop), dead-ctor creatures
  never register (a wedged-invisible replica can't stale-skip
  respawns), and `sk` re-credits missed retarget quanta so
  clients that lost edges don't drift the replay clock.
- **Parity ledger bounds (verified sealed):** diagnostic rows
  cap at 24; `dmgEchoes` bound 32 + 900ms settle sweep;
  `shellFates` bound 64 + lazy 15s prune (fates older than the
  confirm window can't match a live echo); `noteShellFate`
  drops non-finite blast points at the entry — a NaN `srvAt`
  would NaN every divergence diff and render as a bogus "far"
  ghost in the dump.
- **Trail head lead (fixed):** the quarks batcher sims at 30Hz —
  deposits are ~2 render frames stale, so `emitSegment` leads the
  emitter by measured displacement ×2. On overshoot it now CLAMPS
  the measured lead to the cap instead of falling back to
  `vel·dt·2` — the fallback undershot pos-driven hosts (interp
  remotes, renderOffset decay) and the trail snapped behind on
  hitchy frames. The deposit-span judge below still re-seats on
  true jumps.
- **Display-name ingest:** `SessionManager.nameSpec` strips C0/C1
  control bytes AND Unicode format chars (bidi overrides, zero-width,
  BOM, word joiners) at the trust boundary — a name can't spoof
  direction or go invisible. Whitespace collapses, 24-char cap.
  Client renders names via textContent/esc() only (DOM ingest pass),
  so markup dies twice. Verified sealed, no fix.
- **Boot stability gate:** `gameLoop.whenStable()` resolves on ~45
  consecutive <26ms frames (4s cap). Offline starts wait on it — the
  player spawn anchor, deploys, balls, `setupOfflineMode` bot roster
  don't land mid-compile-hitch. Counter is total-frame-capped so a
  permanently-slow box can never gate forever.

## Remaining

- `shared/ballSim.ts:293` `applySimDamage` needs the same finite dmg
  gate (file in-flight, JP to fold).
- Armed canaries awaiting live evidence: `spawn/teleport/flag-above-
  ground` (residual bot-sink CINDER-11 seed), `corpse-no-channels`,
  `anim-bind` (T-pose census — needs live repro + alt+q dump),
  `pool-positive`, `energy-bounds`/`local-energy-bounds`,
  `sim-pos`/`sim-vel`, `impulse-finite`, `deploy-hp-finite`,
  `*-damage-finite` family, `teleport-spam`.
- JP open items: GL_INVALID_OPERATION sampler spam, melee-whiff,
  camera spinout, disk-space warning.
- `swarm.ts` (in-flight) fails tsc: `fogU` missing on
  `InstancedBlobShadows` — JP's file.

## When adding a system

- List the truths it must hold at its boundaries (position vs terrain,
  counts vs ledger, coverage vs visibility).
- Put `inv()` on the boundary that can violate it — cheapest place that
  still sees the truth every tick, not per-frame if a 2Hz sweep suffices.
- If a check duplicates an existing rescue/fix, the invariant names it
  and the rescue stays — invariants report, they don't repair.
