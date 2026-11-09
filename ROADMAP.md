# KRIBES — Living Overhaul Plan (Devin's brain)

**Standing order:** continue overhauling the project — server and client — toward a
real game the size of Tribes Ascend / Krunker / Narrow.One. Maximal extensibility,
cleanliness, robustness, performance, low running cost. Massive changes allowed
when research supports them. Commit per settled topic, changelog.txt one line each,
never push.

Read this file first each session. Update it as things land and as better ideas
surface. Detailed research lives in `_docs/reports/`; this file is the current truth.

## North-star architecture

- **shared/ is the game.** Sim, combat math, wire codec, species kits, teams.
  Client renders + predicts; server validates + fans out; P2P host runs the
  same modules embedded. Any logic that exists in two languages/places is debt.
- **Rooms are matches.** (Landed 2026-09-26.) `Room` owns all per-match state;
  `GameServer` dispatches. Lobbies/matchmaking = `roomFor(name)` + a lobby API.
- **Authority split is one model.** Server sims/decides every interactive
  outcome; client predicts everything locally visible (shells, FX,
  hitmarkers — WYSIWYG feel) and server declares results. Combat claims
  are refused on dedicated (`claimsAccepted=false`) — fire is an intent,
  not a claim. Client: presentation, prediction, cosmetics.
- **One world model.** (Landed 2026-10-08, `shared/worldModel.ts`.) Every
  entity kind declares its wire shape once; emits generate, decode
  consumes, inbound packets/intents/envelopes are shape-checked, replica
  hashes generate from the same table, and a conformance suite pins the
  three together. Drift between lanes is unrepresentable.
- **Cheap to run.** Binary wire everywhere hot; delta suppression + interest
  tiers already proven (~6-8Hz effective at 20Hz tick). Every cost decision
  should survive 32 players on a $5 VPS.

## Status board

### Done
- Binary wire codec + position/tick frames, delta suppression, interest tiers
- Server validation layer + per-type rate limits + session-token reconnect
- Grace-period reconnect, idle reaper, force-send windows on knockback
- Offline play end-to-end (localAuthority, bot damage funnel, match restart)
- Modes: nuggets / ctf / tdm (kill-confirmed) / dm / duel / rabbit (T2
  rules: no flag until first blood, carrier-only damage, bottom-feeder
  open season) — every advertised map×mode pair builds + ticks
  (scenarios/modes.test.ts); offline mirrors all six via TeamBots +
  CtfBridge/RabbitBridge
- Conquest pilot (2026-10-19): UT-Onslaught-style node lattice, procedural
  — map span split NxN (3-5 by span), corner cores, touch-to-build 10s,
  4-adjacent linked frontier, presence-raze or blast to neutral, cores
  end matches; nodes cannot be severed. Lives behind the new mode-module
  registry (`server_bun/src/modeModules.ts` — a mode is one file + one
  line: sims/wire/objectiveFor/reset/onSpec/onTerrain/telemetry), so
  experimental modes add/remove without touching the core. Node-linked
  respawns ride the existing teamSpawns picker; bots get objectives via
  `objectiveFor`; wire = node kind + nodeUpdate roster feed; client
  `net/nodes.ts` draws rings + beams + territory link lines.
- P2P over WebRTC DataChannel w/ server relayed handshake + embedded authority
- Ball sim rubberband fixes: grid-locked replay, closed-form inert legs,
  renderOffset blending, settle threshold, server wall-clock catch-up
- Env-driven server config (FPS_*) + `GET /metrics` (tick lag! per-room stats)
- Room/match model groundwork — verified live (arena2 vs default isolated)
- `?room=` client param → join handshake; chat (T to open, room-scoped
  relay, rate-limited 4/s, 200-char cap, textContent rendering)
- Species instancing, AI LOD, keybinds menu, spectator fly, cloak skill,
  secondary weapons, remote-player anim overhaul, SnapshotBuffer tests
- pvptest E2E harness: --test…--test5, staleprobe, ballreplay

- Persistent identity: playerId claims are HMAC-signed (FPS_SECRET env;
  random per boot if unset). localStorage-backed on the client — names
  survive restarts and can't be stolen by id knowledge alone.
- Lag compensation: per-player 400ms position history; hitscan + AOE
  validated against target rewound by clamped shooter ping (≤250ms).
- Load spot-check: 19 players (16 orbit bots + devs) — tick lag flat at
  ~11ms avg / 29ms max, no degradation vs 3 players. Empty named rooms
  now dispose themselves (ballSim.stop + map delete; 'default' immortal).
- 35-player multi-room load test: 19 in default + 16 in loadb, ~25s
  sustained — tick lag avg 11.2ms (unchanged vs 3 players; it's this
  box's baseline setInterval drift, not load), max 36ms, 0 rejected.
  Second BallSim spun up cleanly per room. `GET /rooms` lobby listing
  + bot `--room=` flag for split-fleet tests.
- Scenario test suite (2026-10-03): `tests/scenarios/*.test.ts` — one
  file per staged interaction (duel, creature bite, baneling detonate,
  flag cap/return/drop, projectile hit + spawn-protection, FFA kill score,
  gem bank, turret fire + wall-LOS, creature wall-pen, mine boom, respawn,
  friendly-fire, totem beam, multi-species mix, roller/snake/gnat bite
  chains, joiner/spectator bootstrap, spawn shield, respawn state, ffa
  score, ctf win funnel, tdm tag confirm, ambient-decor rule, arena push,
  pickup decay, edge fanout, deploy TTL, destroy-claim ownership) over a
  shared `harness.ts`
  (flat field, mkRoom, pin = resync+protectedUntil=0, deterministic
  step() for CreatureSim, broadcast watch). Already paid off: caught
  CreatureSim-never-ticked-in-tests, the sendTo/broadcast tap split,
  a real gameplay bug (banelings orbited ~10m and could never reach
  fuse range — fixed with terminal homing inside 12m + FUSE_D2 4.2²),
  and a stale-position flag drop (tickFlags' dead-detector dropped the
  flag without refreshing pos — now lands on the corpse). Sim-time ≠
  wall-clock is the standing trap: protection/timers never lapse in
  fast tests; raw position writes get stomped by moveSim — pin() instead.
- Agent docs (2026-10-03): AGENTS.md (verify commands, invariants,
  boundaries) + .devin/rules/{netcode,testing,determinism-perf}.md.
- One-world-model refactor (2026-10-08): `shared/worldModel.ts` declares
  every entity kind's wire shape once — generated emits/hashes,
  shape-checked inbound packets+intents+envelopes, conformance suite
  (44 checks) pinning declaration↔union↔codec. Combat claims refused on
  dedicated; fire is an intent + server-side rewind/spawn. P2P hosts run
  RoomMoveSim + RoomWeaponSim so peer reports are judged. God-object
  splits in the same stretch: Room 1182→989, serverSenses 1035→345,
  PlayerModel 1456→625 (gun/anim/mats/collider/LOD controllers).
- Claimless combat (2026-10-01): 'shot' wire claim deleted end-to-end —
  shotFired intent is the only path, all bodied weapons server-simmed via
  RoomProjectiles (burst pellet-index echo binding; proxy/satchel server
  sticks); only true hitscan (melee/LG/repair/healbeam/slam) + armed
  deployables remain on claims.
- Demo verification pipeline (2026-10-14): `_tools/verify.ts` replays a
  demo's input stream through MoveSim on the embedded hmap trailer and
  verdicts the trajectory (real run passes ~0.9m worst; +30m doctored
  frame flags impossible-trajectory at that frame). Tiers: spawn-dice
  parity (`shared/spawnDice.ts` seeded stream per Spawned event),
  map-identity binding (hmap trailer srcHash, full-res terrain eps
  2.5m→0.5m), projectile legs replayed ballistically per leg, ball
  targetEvent legs through stepBall, score recomputed from the event
  stream, hit↔shot linkage flags unbacked kills. Residual honest limits:
  creature-behavior rolls still ambient (spawn/event determinism is the
  contract), ~6% ball-leg divergence from unrecorded blast knocks,
  ~20% projectile-leg divergence on networked demos is the documented
  server-truth class.
- Leaderboard pilot (2026-10-14): signed match receipts (Room mints HMAC
  ResultToken over the bus event-hash chain at matchEnd, broadcast +
  journaled; demo carries it as SECTION_TOKEN trailer), `POST
  /leaderboard/submit` verification gates (format → matchToken sig →
  stat recompute) appending ranked rows to logs/leaderboard.jsonl,
  `GET /leaderboard` best-per-player per mode, `GET /challenge`
  server-signed seed bound to runSeed at boot with spawn-dice parity
  before ranking, ranked-solo e2e proven (`_tools/e2e/_ranked.ts`).
  Still a pilot: JSONL store, no auth/rate-limit/moderation; recorder is
  interest-limited (see DEMO-OMNISCIENT-AUDIT P0s: server-side recording
  decision + snapshot seek index).
- Bot capping (2026-10-13/14): nav pilot — runner+route legs ride the
  flood carrot every think (pure pursuit), steerer beelines routed hops
  at any range (capRun 0 caps/480s → grab@108s, cap@~176s; dunes grab
  115s→50s after closing the 3-4m face-plant dead zone). Energy metrics
  pin the real deficit as retention not propulsion (grabV 12-22 m/s vs
  T:A 40m/s+; peakE proves the bank works, approachE bleeds between
  banks). Reverted dead ends recorded: crest-aiming (kata 0 caps),
  runner-priced flood (corridor flips chaotically, 133↔413s) — wander
  lives in the staging layer, not the flood. Open: extend routed
  commitment to `running` transits, retire ~100 lines of orbit
  compensation, offline bots have no flood.
- Bot capping (2026-10-15): the arrival-speed deficit is *retention*, not a
  cap — mid-route the capper already reads 40-61 m/s; it dies at the stand
  because the tank is empty there and the aim limit-cycles in the last 40 m.
  Bank the tank (`botMoves` vetoes every discretionary burn in the bank leg,
  `strikeBankGd` 200→320) and latch the pass-through aim (`passCommit` in
  `botRouting`). 3 maps × 5 seeds: grabV 19.1→22.4 m/s, grabT 69.5→44.3 s,
  carries improved, every T2 map now caps 2 runs in 3. Back-to-back works on
  katabatic (3/3 both seeds, best leg grabV 36.6). Scoreboard:
  `_tools/sweeps/capStat.ts` (`--repeat N` = back to back) and
  `approachProbe.ts`; reference in `_docs/2026-10-15_CAPPER_STRIKE.md`.
  Open: churn, not speed — on the *easiest* map (oasis, 166 m) a grab still
  takes 7-139 s and some runs drop the flag near home and never score. Two
  live anti-churn layers buy caps with arrival speed (both confirmed on
  disjoint seed sets): `botLines`' stall escape is the caps/run lever
  (0.73→0.85), `botGraph`'s bend-brake is the carry lever (85.7→61.9).
  `running` means "carrying" (measured 225/225 thinks), so that escape is
  live. Best structural lead left: `botMoves.hints` applies the
  *grab*-orbit park brake to a carrier at its own stand (measured neutral
  when gated, but a real carrier can park 20-32 m short of home).
- Capper tuning was at a **plateau** (2026-10-15b; superseded 11-05 —
  MPC arrival-impact pricing in `botMpcSearch` broke it, see Done
  above): the surface is
  discontinuous — `runnerStale` 3-120, the graph brake 1.3-2.2, a carrier
  brake gate and a time-based stall meter all landed inside noise on three
  disjoint seed sets (126 runs). Pick on one set, confirm on two unseen
  sets; <0.05 caps/run or <2 m/s grabV is noise. Next gain must be
  structural (near-stand churn, drop-and-never-score), not another
  threshold. Protocol + numbers: `_docs/2026-10-15_CAPPER_STRIKE.md`.
- Seek checkpoints (2026-10-14): recorder marks every 30s ride a
  versionless SECTION_SNAP trailer (timestamps only); seek/reverse
  replays the tail window through the clip-window synthesis instead of
  replay-from-0 — match-length scrubs are O(interval). Design in
  _docs/2026-10-14_DEMO_SEEK_CHECKPOINTS.md; server-side recording stays
  the later end state for authoritative tournament evidence.
- Netcode hardening wave (2026-10-23 → 11-07, the biggest landed theme —
  see `_docs/2026-10-18_NETCODE_DEEP_DIVE_2.md` …
  `_docs/2026-10-19_NETCODE_DEEP_DIVE_9.md`,
  `_docs/2026-10-27_NUCLEUS_NETCODE_REFERENCE.md`):
  - Wire lanes went binary end-to-end: WIRE_BATCH per-conn tick
    coalescing, WIRE_HIT playerHit (~160B JSON → ~20B), binary claim
    lane, S→C binary event family, binary projectile edges + batched
    ball segments (32-seat client 57→35 KB/s), per-conn tick arenas —
    the shared frameArena was a REAL wire-corruption bug (every queued
    frame aliased the last-encoded one). Plus evScratch ring, chord-
    lattice terrain cache, rewind sample pool, in-place JSON ev stamp,
    publish-fanout de-alloc: 64-socket CPU 50.1%→36.8% (~175 CCU/core).
  - C1 sub-tick input edges (ageMs u16 stamps, legacy frames still
    decode). C4 remote edge replay was piloted then REMOVED 11-08
    (2f17566d): walked back to facing-only, and facing-only proved
    unobservable — MoveSim never integrates yaw — so the lane produced
    literally zero output for a per-remote MoveSim + volatile fanout.
  - Record-cap fairness: spatial index, strained-conn halved cap
    (STRAN_RECORDS=16), mutual-engagement x0.02 boost (the guy shooting
    you never loses the cap), edge relay distance-gated ~400m, stop-
    tier far+static replication, spawn pacing + intro graduation.
  - Correctness: claim-driven shell birth + muzzle origins (Quake-style
    pos.y=eye), lag-comp honesty during dead reckoning, phantom-dead
    ghost fix, client-ready spawn hold, WYSIWYG hit capsules (midpoint
    sphere → true segment-vs-capsule), rewind-entitlement bounded by
    server-observed transit.
  - Interp WYSIWYG pass (11-07): out-of-order records dropped on
    unordered lanes, symmetric interp-delay deflate, anim stall
    recovery carries cycle fraction — 90s UDP ghostsoak at 5% loss +
    120ms jitter held rg max 1.9m, zero POS-JUMP/ghost-hit
    (`_tools/udpShim.ts` SHIM_LOSS/SHIM_JITTER_MS is the impairment
    harness).
- Capacity + ops (2026-10-23 → 11-07): 1v1 capacity report landed L1
  (empty-world duel mode), L5 (phase marks every 10th tick), L6 (frame
  arenas — see above): 32 duel rooms ×64 players = ~259 CCU/core.
  Capacity knee measured ~350-370 seats/process — fanout O(N²) in CPU,
  intro seats bypass the record cap (`_docs/2026-10-31_CAPACITY_KNEE.md`).
  OCI box autopsy: Caddy TLS is the top process, ~1000 CCU today,
  Bun-native TLS est. 1.3-1.5k (`_docs/2026-10-31_OCI_CAPACITY_INVESTIGATION.md`).
  WAN: 240-bot stress green (62s seating), live netbot battery, nft
  DDoS guards + per-IP unseated-socket cap + garbage-strike close.
  Transports decided (11-07): WT→WS is the dedicated ladder, RTC off
  auto, **no TURN ever**; raw-UDP volatile lane for the native shell
  (Electrobun spike verified); P2P duels reframed as LAN duel.
  servers.html public server browser + standing duel-1/headhunt-1
  lobbies + /rooms `active` flag.
- Moat + launch (2026-10-29 → 11-08): prod client bundle provably
  excludes the P2P authority layer + dev tooling (static
  `import.meta.env` gates, not runtime checks — `_moatcheck.mjs` fails
  check.sh on client→server_bun imports outside the allowlist).
  Licensing shipped: LICENSES.md + licensing/ registry +
  client/public/ATTRIBUTION.txt. Launch audit (`_docs/2026-11-04_LAUNCH_AUDIT.md`)
  — remaining: one legal item, infra provisioning, live-verify debt,
  thin moderation. Tech-debt audit `_docs/2026-11-08_TECH_DEBT_AUDIT.md`.
  Cycle ratchet counts runtime cycles only (madge skipTypeImports):
  client 99→2, server 36→1; break passes landed 11-02.
- Weapons + content (2026-10-28 → 11-07): weapon registration
  consolidation landed (marker fields + derived sets — the
  `_docs/2026-10-30_WEAPON_REGISTRATION_PLAN.md` blast radius is now
  the checklist; `_docs/2026-10-29_WEAPON_ARCHITECTURE.md` is the layer
  map). New weapons: HealBeam (wid 24), Blaster energy sidearm (wid 41 —
  jet energy IS the magazine), PlasmaGun ammo-pool pilot (clip+regen).
  Server-authoritative spread landed (per-player bloomSeq + shared
  jitter01/coneDir — kills the shotId nospread hole); chaingun bloom
  residue drains unconditionally across swaps; weapon swap draw lock
  (0.28s draw, firePending rides through). Rocket viewmodel rebuilt.
  New maps: buttes, terraces, crucible, wyrd (preset 9 arcane),
  screefall, lagoon rework; terrainPresets to 9; sim-sculpted terrain
  pipeline (simrock/simwater/simsand/simcellular), structSurface
  building treatment, skyEnv per-map IBL, directionalFog.
  Juggernaut/dreadnought class rigs via the SDF→surface-nets pipeline
  + gunmetal wear bake. Announcer callout density plan
  (`_docs/2026-11-04_ANNOUNCER_CALLOUTS.md`). Retro palette-quantize
  post effect.
- Bots (2026-10-31 → 11-07): path-free drive research + measured bench
  (`_docs/2026-11-01_PATH_FREE_BOT_DRIVING.md`,
  `_docs/2026-11-01_BOT_DRIVE_BENCH.md` — greedy 41.6-68.4 m/s vs MPC
  36.7-41.0 at ~25× cheaper decide cost; hybrid deep-solve is the
  recommendation). Weapon-use audit: 16 commits, pinned bench board
  (`_docs/2026-11-05_BOT_WEAPON_USE_AUDIT.md`). Offline brain now feeds
  its full ctx contract (flagPos/markDeath/pickupVal/moveSkill/
  desperate/convoy/spillSoon were silently dead-channeled).
  **Capper broke the plateau** (11-05): MPC arrival-impact pricing —
  beam children accumulate predicted fall damage, IMPACT_DEATH=0.45
  hard-veto; plus passFlag refuses backward handoffs. capRun green on
  all three maps incl. katabatic (was 0 caps).
- Client/anim/tooling (2026-10-31 → 11-08): clip-strip migration wired
  (scout pack/kevdev/UAL maps; named unclosed gap: scifisoldier/vexa/
  polyart have no non-loco bone map — `_docs/2026-11-07_CLIP_STRIP_MIGRATION.md`).
  NOTE (2026-11-09): this gap is LEGACY DEBT ONLY. Shipped body rigs are
  scout/brawler/brute (M2M trio) which ride scout's 32-clip set; the three
  legacy rigs are not user-facing. Do not prioritize this as a player-facing
  bug.
  **model-stretch root-caused + fixed** (11-08): non-unit bone quats
  self-amplified into 1e10m skeleton stretch on extreme aim pitch —
  `.normalize()` after procedural quat writes; trap doc
  `_docs/traps/2026-11-08_quat-runaway-aim-pitch.md`, repro
  `_tools/_stretchprobe.ts`. Hook rope cylinder capped. MP4 recorder
  SOTA: AV1/L1T3, ~0 frame cost measured (`_tools/e2e/_vidprof.ts`).
  maplab regen autopsy: the 1.9s stall is all gen.ts field math;
  Alt+Q prof ring + Python numba sidecar bench
  (`_docs/2026-11-07_MAPLAB_REGEN_PERF.md`). kindMake factory pilot
  (upheaval C5, ball kind). Commit scope gate (>12 files/>4 areas
  forces a decision). TTS/DTS cold-boot reference
  (`_docs/2026-10-26_TTS_DTS_REFERENCE.md`).

### Perf review 2026-10-01 — heaviest paths, ranked plan

Server tick (20Hz, measured ~11ms/50ms under 16p+80b+creatures):
1. **MoveSim shadows** — every human runs a full client-physics sim per
   tick (gravity, jet, ground clamp w/ hmHeight, resolveBody vs all
   structure colliders). Biggest single-tick cost; legit work but
   structure broadphase is linear-in-colliders. → spatial hash the OBB
   set once per map (cell ~8m); resolveBody + segSolidHit then test ~4
   cells not N. Same index shared by solidWorld/projectiles/blasts.
   LANDED (e6f63d0): ColliderIndex XZ grid shared by move sims, ball
   bounces, projectile sweeps, blast occlusion — server + client.
2. **Bot senses** — losClear() marches heightfield every 3m per enemy
   candidate at 3Hz/bot, plus pickFightPos re-scores rings (LOS ×
   candidates × other-enemies). Bounded already (3Hz, mem). → per-bot
   stagger exists; next lever: LOS memo per (bot,enemy) pair valid ~1s,
   and early range-reject before marching (already by dist).
   LANDED (195af85): losClear memoized on 1.5m-quantized endpoints, 0.8s TTL.
3. **fanoutRecords** — O(P²) distance sq per tick; fine at 16p, quadratic
   at 64p. → cheap win available: bucket players into coarse cells once
   per tick, tier by cell not per-pair. Only needed past ~32/room.
4. **BallSim + CreatureSim** — predictive terrain probes landed; creature
   brains already id-bucketed. nearestPlayer scans are O(balls×players)
   but planar-squared, ~80×20=1.6k muls/tick — trivial. Leave alone.
5. **RoomProjectiles** — sphere rejects landed (e0df0e3). Remaining:
   getWeaponStats lookup per proj per tick (map hit) — could cache stats
   on LiveProj. Micro.
   LANDED (195af85): stats resolved once at spawn, stored on LiveProj.
6. **TickLoop buildRecords** — already alloc-free (in-place snapshot).
   encodeTickPlayer per unsuppressed player per tick — unavoidable.

Client frame (SwiftShader distorts; phase marks exist):
1. **sweepBall sub-steps** — was the worst: 0.1m march × balls × shells.
   Sphere-reject landed; residual cost only in actual near-miss cones.
2. **RemotePlayer interpolation + PlayerModel anim** — per remote per
   frame; anim mixer cost scales with bone count. → throttle anim to
   distance tiers (update far remotes at 15Hz, skip off-screen), same
   trick as species LOD. Worth real fps in big fights.
   LANDED (0728b5f): far remotes burst-tick the mixer at 15/30Hz,
   accumulated dt keeps playback speed correct.
3. **Terrain getHeight calls** — species ground clamps, projectile
   samples, LOS probes, bot brains all re-evaluate bilinear lookups.
   → cheap win: per-frame memo cache (x,z)→h at ~0.5m cell granularity.
   Risk: none, heights are static within a map.
   REJECTED on correctness grounds (2026-10-01): a cell-keyed memo returns
   a neighbor's height (slope×cell error), and getHeight feeds prediction
   ground clamps — a wrong clamp = sim divergence → rubberband corrections.
   The bilinear is already ~20 ops; LOS memo + LOD tiers took the callers'
   volume instead.
4. **Census/healthbars/minimap** — already sweep-budgeted (9afdb5c).
5. **Ribbon trails** — per-projectile vertex updates each frame; only
   cosmetic, cheap enough. Skip.

General principle now applied everywhere: *predictive scheduling* —
solve when a check can possibly matter, skip provably-dead ticks; plus
*sphere rejects* before exact solves. Both preserve exact outcomes.

### Next (audit priority order)
1. ~~Lobby UI~~ — landed: LOBBY button polls /rooms (live scores +
   winAt now shown per row), joins via ?room=NAME reload, create-room
   input, NUGGETS/CTF/DM quick-play buttons → `GET /join?mode=` picks
   the emptiest live match or spins `<mode>-N` (ad-hoc names inherit
   maps/<mode>.json). Own room + mode shown in the panel; mid-match
   room switching is in-place now (switchRoom message → fresh gameState
   rebuild, URL stays shareable, reload is the offline fallback).
2. **Movement re-sim** — LANDED (judge mode): shared/movement.ts MoveSim
   drives client physics AND a per-player server shadow (RoomMoveSim) fed
   by inputMove. Divergence >8m now sends a real correction to the client
   (witness→judge; 400ms throttle; sim keeps its own truth, no resync-
   ping-pong). Jetpack thrust is inside the sim (inputMove 'jet' bit) so
   jetting doesn't false-positive; knockback impulses feed the shadow.
   The shadow now models the energy economy too (shared/movement.ts
   ENERGY table = client skills.ts source): jet drain/regen honor the
   declared perk (featherjets/overcharge), cloak/shield/mend antes and
   per-sec drains ride the inputMove status bits, shield soak and gem
   refills burn/refill the same tank — infinite-jet claims get gated.
   **Authority mode landed** behind FPS_MOVE_AUTHORITY=1: the sim OWNS
   player truth — reports degrade to aim/ping/liveness hints, the tick
   commits sim pos+vel into the player record (broadcast + rewind buffer
   see sim state), divergence tolerance tightens to 1.5m at 100ms ack
   throttle so prediction converges. No heightfield = auto judge
   fallback. Client needs zero changes (3-tier correction reconcile).
   Seq-anchored input replay landed (b7ac7d2): corrections carry the
   server's last consumed inputSeq; client rewinds the sim and replays
   journaled inputs — convergent corrections instead of blind blends.
   Respawn epoch fix (2026-10-03): resync() stamps resyncSeq/resyncAt —
   stale-epoch reports skipped outright, 500ms drain grace covers the
   RTT where the client honestly reports the corpse spot; respawn sets
   correctionGraceUntil so the snap-to-spawn no longer reads as a
   speedhack reject. Authority mode soak-verified live (38 respawns,
   0 rejects, worst pre-snap gap 3.1m).
3. ~~Map format~~ — landed: `maps/<room>.json` (mode, ball population,
   spawn anchors, bases/objectives, bot count — all clamped with
   defaults; examples swarm/duel/erg/ctf). Server bots populate
   matches AND play objectives (flagGoal: grab exposed enemy flag, run
   home as carrier, escort teammate carriers, intercept thieves, return
   dropped own flag; plated bots anchor defense at their stand).
   Server-owned CTF flags landed (RoomFlags: touch pickup, drop on
   death, planar capture ring, flagUpdate broadcast); live-verified
   bot flag grabs over the wire. `botFill` spec keeps a room at N total
   bodies — spawns/retires bots as humans come and go (dead bots retire
   first); `teamUpdate` wire msg + bot-only rebalancing on leaver skew.
   `ambient` species mix landed (43ea91b): per-species cap table flows
   spec → gameState/mapUpdate → setAmbientCaps; maps/infestation.json is
   the proof (crawler40/scarab24/rakk12/gnat30 layered ecology).
   Server-authoritative species landed (e0be55b/eeb408f): `creatures`
   spec field → shared/creatureSim.ts deterministic melee sim (crawler
   pilot) replicated exactly like balls — wire carries only committed
   edges (spawn/retarget/windup/pounce/bite/die + target snapshot, seeded
   LCG), clients replay the identical hop stream between edges in
   netDriven Crawler instances. Distance-tiered fanout: players <80m get
   every edge; far players + spectators ride every 4th as a resync beat.
   Rule going forward: `ambient` = client-side DECOR only; anything
   interactive must live under `creatures` / the server sim.
   Flyer family landed (0275111): shared SimFlyer (orbit→windup→dive→
   climb, seeded LCG + committed snapshots) reuses the same edge kinds —
   windup=fold, pounce=dive launch, bite=claw contact. Rakk is the pilot
   (server-authoritative on infestation, rakk:4); CreatureSim holds a
   SimBeing union dispatched by family. Roll family landed (6e8b01b):
   SimRoller — continuous XZ steer at committed snapshot + contact bite;
   no telegraphs, bite-only edges. Gnat closed the flyer family
   (2687bc7): dart maps onto dive, seeded cooldown replaces the flock
   nipGate. Five species server-owned on infestation (crawler:6,
   scarab:8, rakk:4, roller:3, gnat:10) — verified on the wire.
   Slither landed (f540aa7): SimSlither coil→lunge→bite chain. Kamikaze
   landed: SimBaneling — roller chassis, fuse/life clock emits the new
   'detonate' edge, Room maps it to the AOE funnel (mineBlast) + noise
   so bots hear the pop; shot-deaths detonate too. Seven species
   server-owned on infestation (crawler:6, scarab:8, rakk:4, roller:3,
   gnat:10, snake:4, baneling:4) — verified live (detonate edge seen).
   Totem landed (e8e6324): SimTotem aim→charge→fire / blink cycle — the
   beam LOCKS a committed point (target snapshot + terrain clip, solved
   identically on both ends), 'fire' is display-only while the authority
   sweeps live players along the line (totemFireTargets); 'blink' edges
   carry the DESTINATION so a far client that missed the decision still
   teleports. Eight species server-owned on infestation (+totem:3).
   Every species family now has a server-authoritative core — the
   remaining ports are new species data, not new plumbing.
   Structure fairness (2026-10-03): totem LOS + beam lock clip through
   segSolidHit on both ends (d0a8ec0); melee bites gate on creature→chest
   wall LOS server-side (e15b06d); botBrain LOS sense tests structures
   via BrainCtx.solids/solidIndex — bots stop shooting into buildings on
   server and client (89380f6). Creature motion clips too (3ace038):
   clipMotion sweeps each move leg vs OBBs — hops bonk into walls and
   drop, ground families stop at faces; deterministic on both ends.
   ballSim predictive terrain probes (3c12a28): parabola-scheduled gy
   sampling — resample at ~60% of predicted impact, on ~2m horizontal
   drift, or any velocity discontinuity; deterministic, bounded clip.
   Deployable predation (3398ff0): CreatureSim extraTargets/targetPos
   surfaces RoomDeployables as `dep:N` candidates — bites drain the same
   hp pool the blast sweep does, so wildlife raze a stand on dedicated
   rooms exactly like the offline kit (depGnaw scenario proves it).
   `terrain` ref landed: maps/<file>.bin
   heightfields per room (lazy, cached, shared). Shared brain landed:
   shared/botBrain.ts drives offline GameBots AND server bots — one
   personality, both runtimes.
   Per-map LOOK landed (2026-10-15, native maps — no T2 port):
   `terrainPreset` widened 0..6 (snow/volcanic/badlands/coast live in
   world/terrainPresets.ts, spliced into the terrain frag shader) plus
   two new MapSpec blocks — `weather` {dust,embers,ash,snow intensity}
   (ABSENT = the old dust+embers+ash trio, so pre-weather maps render
   byte-identical) and `atmosphere` {rayleigh,mie,sunIntensity
   multipliers + absolute starIntensity on the procedural sky} -
   threaded spec → Room/roomStructures/MessageHandler → gameState/
   mapUpdate → client MapSnapshot/world.ts. Four new rooms: whiteout
   (snow, ctf), caldera (volcanic, ctf), hoodoo (badlands, dm), lagoon
   (coast, ctf). `_tools/mapbake/genmap.js` is the field generator
   (domain warp, ridge, tileable tilt, mesas, crater, rim ring, sea
   sink) with terrainstats.js + hillshade.js as the measurement loop —
   authoring a field that MATCHES the T2 relief profile (sd 20-30m,
   mean slope 29-33deg, energy from ~20m to ~200m) is the whole game;
   the first cut measured sd 7-18m and read as a flat plate. Verified
   by `_tools/e2e/weather.ts` (uniforms + per-layer draw ranges per
   map) because check.sh's visual gate only ever shoots ONE map.
4. ~~Server-owned teams/score~~ — landed: rooms assign alpha/bravo on
   join (before spawn — team-base spawning), teamScore/matchEnd/
   matchStart broadcast, match journal → logs/matches.jsonl + /matches.
   Server-owned nugget pickups landed: creature kills drop gems
   (RoomPickups, touch-to-bank, TTL 30s) — 'nuggets' scoring is now
   fully server-observed — the {type:'bank'} claim message was removed
   end-to-end (protocol, validation, handler, client sender). Powerup
   drops landed (2026-09-29): creature kills roll heal/armor/regen/dd in
   every mode (shared/pickups.ts weighted table); armor pool absorbs 80%
   of a hit server-side; regen/dd are timed server-owned status bits so
   clients can't claim them; buff msg + armor on playerHit; HUD armor
   bar + buff chips + remote aura tells.
   CTF classic rule: own flag must be home to cap; carrier disconnect
   drops the flag. Spawn protection (2s, breaks on fire), friendly-fire
   gate (damage only — splash still boosts teammates), heal claims in
   team rooms need gem credit, teleport capped 3/s, PROTOCOL_VERSION=4.
   Ops: GET /stats lifetime leaderboard off matches.jsonl; match clock
   + overtime + draw resolution + 60s warning; spectate joins
   (watch-only socket, full-rate ticks). Respawn-gated class swaps
   (2026-10-03): classUpdate banks the pick server-side, respawnPlayer
   applies tier+maxHealth, shadow scale re-reads on resync, wire
   playerRespawn carries armorClass for remote silhouette rebuild;
   client mirrors via armorClass(chosen)/appliedClass(sim) split —
   before, a mid-match pick desynced the sim permanently (local scale
   changed, server's never did).
- TDM mode: kill-confirmed scoring — frags +1 and drop a scoopable dog
  tag (either team banks it). Quicksand arena map: dome barrier,
  server-side RoomArena boundary pushback.
- Map structures landed: box/wall/pillar/ramp specs render client-side,
  balls ricochet off them (shared sphere-vs-yaw-OBB in stepBall —
  identical server + client prediction), arena domes fade in <80m.
- Admin API (FPS_ADMIN_TOKEN): /admin/reload hot-swaps a live room's
  map spec + mapUpdate broadcast, /admin/kick, /admin/end, /admin/rooms.
- Tribes-style base compounds (2026-10-03): _tools/mapgen/gen.py emits
  a proper T1/T2-ish compound per base — flag pedestal + cover walls +
  approach ramp, main base shell (wall segments w/ doorway gap, slab
  roof, gen-room divider), 24m watch tower w/ crow's-nest platform +
  parapet, annex hut, scattered midfield cover — pos.y sampled from the
  map's own heightfield per piece (terrain isn't flat anywhere). New
  maps stonekeep (henge.bin) + bastion (slagheap.bin) in rotation.
  Solid layer landed (259c617): shared/solidWorld.ts resolves capsule-
  vs-OBB inside MoveSim — tops are floors (getHeight reports them),
  walls push out laterally below a 0.55m step-up, undersides act as
  ceilings. Server FieldSurface + client TerrainSurface share it;
  bot brains fold structureTop into groundY (walls read as raised
  terrain) and a 2-window stuck streak escalates to a jet escape.
  Soak: 0 stuck warns, 9 corrections, converging.
  Projectile occlusion landed (8ba1bb3): segSolidHit sweeps yaw-OBBs;
  server RoomProjectiles + client Projectile pop on walls (stickies
  glue), ray-burst beams stop at faces, and hit/AOE claims validate
  the ballistic arc can't pass through a structure to its end.
- Weapon registry rework (2026-09-30): client/src/weapons.ts SLOT_DEFS is
  the single weapon table — index is the wid, each def carries
  weaponType/rate/config/kick/kind(auto|fan|beam). The four hand-aligned
  parallel arrays are gone; combat dispatches fire by def.kind. New weapon
  = one def entry. Alignment invariants pinned in weaponTables.test.ts.
- Sticky launcher (WeaponType 18): bombs glue to terrain/structures/
  targets, 3s fuse at 0.8s cadence (3 live max), detonation chain-cooks
  sibling stickies in radius — stacked cluster = one overlapping boom.
- Shot validation hardening: muzzle origin rewound by shooter ping,
  rewind buffer cleared on respawn/teleport.
- GET /serverinfo: host card (name/region/tick/rooms) for a future
  CS/Quake-style server browser; FPS_SERVER_NAME/_REGION env.
- Demo system v3 (MP-aware): header stamps room/mode/playerName; roster +
  remoteFrames sections record remote players at 20Hz and replay them as
  real RemotePlayer replicas (production snapshot interpolation, not a
  second smoothing path). Server-ball spawn/bounce/die recorded via
  netBalls hooks. world.playbackMode freezes the whole live wire during
  replay (no sends, no corrections, no live entity mutation) and hides
  live remotes. v1-v2 files still deserialize.
- Dispatch-table sweep (2026-09-26): every big switch became a
  Record<type, fn> — server validateMessage (c83), server fetch routes
  (c60), MessageHandler (c24→dispatch + shared roomEcho), client
  netHandlers split into game/net/ domain modules on a shared NetCtx
  (match/flags/pickups/players/projectiles/world). Species: Seeker,
  Totem, Strifer use static STATES tables — Gnat/Rakk/Crawler audited
  and skipped (2-branch state checks, a table would be ceremony);
  Snake/Roller/Overlord are timer-driven, leave be.
- Complexity sweep (2026-09-26): every oxlint-flagged function split —
  gameLoop loop (c38) → simTick/fxTick/hudTick, tickRoom (c41) →
  buildRecords/fanoutRecords/rollupMetrics, tickRemotePlayer (c29) →
  ensure/status/tint/cosmetics, updateProjectiles (c28) →
  prune/intercept/chain, Room ctor (c29) → wireModeFeatures/registerSims,
  ThreatTable.update (c26) → decay/drop/pick. Remaining warnings are
  factory-length only (createGameLoop/createCombat/createRemotes are
  composition roots — cohesive, not complex).
- Maps (2026-09-26): crossfire (CTF, diagonal axis + mid plateau),
  slagheap (FFA dome bowl, ramps as ski lanes), pit (45m duel ring).
  Spec-JSON structures + arena + spawns — heightmaps now wired
  end-to-end (see below).
- Terrain pipeline (2026-10-01): spec.terrain names maps/<file>.bin →
  room's BallSim AND RoomMoveSim attach it (moveSim.attachField honors
  deferred authority) → gameState map.terrain + mapUpdate carry it →
  GET /maps/<file>.bin serves the bytes → client loadHeightfieldBin +
  Terrain.reloadHeightmap hot-swaps the field mid-session. Both ends
  sample the identical bytes — prediction and server truth agree.
  Authoring: _tools/mapbake/png2bin.js (PNG→bin via headless Chrome;
  verified byte-identical to server_bun/heightmap.bin) and genfield.js
  (procedural tileable noise + flat pads at authored spawn/base coords).
  Every spec now ships its own maps/<name>.bin — pads ~1.5m, hills ≤45m.
- Bot pathing lite (2026-10-01): shared/botBrain.ts contour-slide +
  stuck-break detour — slope probes deflect >6m/4m climbs sideways, no
  progress in 1.5s → perpendicular sidestep. 3 vitest cases.
- Kill feed (2026-10-01): HUD rows "shooter [Weapon] ▸ target" on every
  playerKill (weapon threaded through applyHit/processAOE end-to-end),
  6-row cap, timed fade, gold edge on own frags, red on own death.
- Server turrets (2026-10-01): deploy claims reach the server on pod
  attach (sendDeploy); RoomDeployables sims sentry fire — nearest hostile
  in 42m every 1.25s through CombatHandler.turretAttack (shared applyHit
  funnel: kill credit, friendly gate, spawn protection). turretShot
  broadcast paints the rocket on every client; remote deployables render
  via remoteSpawn/remoteRemove + join-time roster reconcile.
- Mines + pads server-side (2026-10-01): proximity fuse trips a mineBlast
  through the shared AOE funnel (falloff, knockback, friendly gate,
  owner splash); mineBoom broadcast for blast FX. Stations heal
  friendlies in a 9m envelope at 9%/s of maxHealth.
- Drones server-side (2026-10-01): escort shadow anchors to owner +2.5m,
  35m scan, 1.6s plink for 9 via turretAttack; dies with its owner.
  Deployables arc complete: all four kinds server-owned end-to-end.
- Bots as legal players (2026-10-01, per _docs/2026-10-01_BOTS_AS_PLAYERS.md):
  Phase 1 done — brains emit move hints (ski/jet/jump from slope probe,
  speed, airborne) not destinations; ServerBots drives RoomMoveSim shadows
  (faceYaw + ordered setInput + commit stepped state). Bots ski/jet for
  real, burn the shared energy tank, reseat on respawn via deadSet.
  Phase 2 done — RoomProjectiles (shared/projSim.ts swept ballistics)
  gives bots real PlasmaGun shells with velocity lead; hits run through
  botAttack + trusted serverBlast. botFire = creature path + fallback.
  Phase 3 done — brains read the shadow tank (BrainCtx.energy/healthFrac),
  gate jets on energy, claim real STATUS bits (MEND hurt/unpressured,
  SHIELD in a fight) through CLIENT_STATUS_MASK, and lob Grenade shells
  on a ~9s cooldown in mid-range hunts.
  Phase 4 done — per-bot loadouts at spawn: a perk (featherjets/
  bombardier/plated/overcharge — maxHealth + jet economy as-declared)
  plus a range-band weapon table: Chaingun <15m, primary mid, Rocket
  >40m. All four phases complete: bots are virtual clients end to end.
  Observability (2026-10-02): ServerBots stuck watchdog logs 'Bot stuck'
  at 2m/5s (2.5s for flag carriers) with hunting/carrying/pos — plus the
  root fix it caught: ski-held-at-standstill skipped ground physics in
  shared MoveSim, freezing bots (and could freeze a human) on hills.
- Room health heartbeat (2026-10-01): every room flushes a 15s INFO line
  `Room health {humans, shot, aoe, hit, dmg, kill, rej, rej.Shot, rej.AOE,
  diverge, gapMax, posrej, posrejSpeed, posforce, snapreq, ratelimit,
  unhandled, envdmg, envdmg.far}` — rubberbanding pressure, rejected claims,
  damage funnel and desync traffic readable at a glance without per-event
  archaeology. Environment-damage claims now get a melee-range plausibility
  flag (nearest live creature >15m = 'envdmg.far' + warn; damage still
  applies — a bugged client shouldn't be silently maimed). Server tsc gate
  green for the first time (latent strictness debt in src+tests fixed).
- Soak coverage complete (2026-10-03): every wire path now exercised
  over real sockets — nuggets economy (3 bugs fixed: grounded gem drops,
  huntCreatures target pass, kill→bank funnel), TDM quicksand (inverted
  arena pushback fixed), CTF crossfire (real cap), DM duel, multi-room
  isolation, reconnect/token reclaim, botFill (fillprobe.ts: retire/refill holds spec.botFill bodies across human join/leave), deployables lifecycle
  (deployprobe.ts: spawn/cap/distance validation, live mine trip +
  turretShot, leave teardown). Numbered ad-hoc rooms inherit their base
  spec (roomFor strips -N: erg-3 → nuggets mode/bots/terrain — was
  silently spec-less); --spec probe validates spectate joins (gameState
  + full tick stream, no roster entry); probe adopts server spawn +
  room terrain so --park doesn't self-inflict correction storms.
  + Full HTTP/API surface (apisoak.ts:
  all GET routes, /join gate, spectate join, admin 401/200 gate,
  end→matchEnd→/matches journal, kick→socket close, /client-log),
  P2P rtc relay (rtcrelay.ts: roles, shuttle, 1008 cap, peer-left),
  demo endpoints (demosoak.ts: v3 header craft, accept/reject,
  traversal 404, byte-identical round-trip). Divergence noise floor:
  count=1 crest clips only.
- Hitscan fire relay (2026-10-03): hitscan kinds (fan/beam) + melee send a
  cosmetic `shotFired` → server relays `playerShot` (rewind-stamped muzzle
  pos, claimed dir, 50ms gate, dead shooters dropped) — observers get
  positional shot audio, recoil anim, weapon-tinted muzzle flash, and an
  80m LG beam flash. Relays also feed the Room noise ring so bots hear
  chaingun fights. Pinned in combatorder.test.ts + noise.test.ts.
- Divergence seq journal (2026-10-03): every shadow journals the
  sim state captured per consumed input seq — a report stamped seq N
  behind the shadow now replays from that anchor to now (the live sim
  applied inputs the report predates; comparing stale flagged honest
  clients). Client-ahead reports still probe the live state forward.
  Transient count=1 crest clips demoted to INFO; WARN means repeat
  or blow-through now.
- Netcode v2 (2026-09-28): GameTransport seam w/ three real tiers —
  WebTransport (QUIC datagrams, cert-pinned via /wthash) → WebRTC
  DataChannel (game=unreliable binary, ctrl=reliable JSON, /rtcs
  signaling, /rtcconfig ICE servers from FPS_ICE_SERVERS) → WebSocket.
  Parallel probe picks the best live tier automatically; `?net=` pins.
  Verified end-to-end in Chrome + headless fleets (net.ts adapters,
  `fleet.ts --tier=`): WT 3/3, RTC 4/4 at full 30Hz. Reconnect re-probes.
  Scoreboard NET column shows each player's tier; /metrics tiers{}.
- Perf pass (2026-09-26): computeStateHash rolling-FNV (no sort/strings),
  tick fanout hoists, in-place snapshots, 2Hz roster polling, playerId→room
  O(1) index, room hibernation, global player cap (FPS_GLOBAL_MAX_PLAYERS).
- Frame profiler + budget scheduler (2026-09-26): perfHud marks now split
  the sim (balls/species/bots/proj) so LOW-FPS dumps name the guilty
  subsystem. `core/frameBudget.ts` generalizes the bucket pattern —
  each() chunks queue work under a ms quota across frames, sweep() runs
  periodic jobs phased by name hash. Brain buckets stagger decision
  accumulators by id%8 in BallSim/CreatureSim + client species LOD —
  same-tick spawns no longer spike one frame. Pilots: minimap 25Hz,
  census 10Hz. Opt-in rule: physics/hit-feedback stay per-frame;
  expensive non-subtle work budgets.

### Later / research needed
- ~~Client prediction + reconciliation for self~~ — DONE: corrections rewind
  the shared sim to server truth and replay the journaled input stream
  (net/players.ts onCorrection + NetworkManager.inputsAfter); yaw/pitch stay
  client-authoritative, <0.5m errors ignored, no-journal fallback snaps.
- ~~Replay formalization~~ — DONE 2026-10-03: `netReplay.test.ts` replays a
  real `.rec` capture (live duel room, fleet+server bots — hits, kills,
  projectiles, tick frames) through actual `handleMessage`/`handleBinaryMessage`
  headlessly; asserts remote roster + entity/HUD routing. Regression net for
  "decodes fine, handler drops it". Fixture: `__tests__/fixtures/duel.rec`.
- ~~`ServerSim` registry~~ — landed as `room.sims`; bots/flags tick through
  it. ~~Deployable turrets server-side~~ — DONE 2026-10-03: bot deploy
  intent landed (~45% of brains are builders; parked defenders plant
  turret/mine/station through the legal handleDeploy path on a 28-48s
  cooldown, hurting builders prefer stations; 'Deploy placed' INFO log
  proves every plant). Live-verified: BOT-* owners planting on crossfire.
- Voice/avatars/monetization — out of scope until core loops land.
- ~~URL redesign~~ — LANDED 2026-10-12: `/s/<room>` is the canonical
  shareable link (`?room=` legacy still reads); room-creation hints ride
  `fps-join-spec` settings, solo picks persist as `fps-solo*`, and a
  bare `/` boot with a remembered `fps-last-room` resumes the match.
  Prod static hosts need a `/s/*` → index.html rewrite.

## Non-goals
- No engine rewrite, no ECS framework, no server authoritative physics yet.
- Don't touch JP's in-flight client files (check `git status` before edits;
  the file list drifts — speciesKit/context/main/etc. have been hot).

## Simplification plan (long-term, 2026-10-03)

Complexity is the enemy now that the feature surface is wide. Long-term
simplification targets, ranked by leverage:

1. **Data tables over bespoke code.** Proven: MELEE_SPECIES (one row adds a
   species to server sim + wire + client replay), MODEL_BUILDERS (weaponsGeo
   16 builders), edge-tier tables. Next: merge species sims' per-family
   bits into one `SPECIES` table keyed by id (stats, hop/roll/fly mode,
   telegraph, fuse, bite) so a new creature is data, not a class.
2. **One entity lifecycle.** Spawn/tick/despawn/serialize now lives in
   per-type managers (balls, creatures, projectiles, deployables, remotes).
   `room.sims` is the registry core — finish it: every tickable registers
   {tick(dt), serialize(), deserialize()} so join/reset/save are one loop
   instead of per-type plumbing.
3. **Table-driven wire dispatch.** Client handleMessage switch + server
   handlers grow a case per message type; move to a `WIRE` table mapping
   type -> {validate, handler, rateLimit} so adding a message is one row
   and the validation surface is auditable in one file.
4. **Options objects at boundaries.** Constructor/param lists already
   migrated (debris pos, NetSeg, bind* pending); rule: >4 params must be
   an options object. Prevents the 17 max-params sites from re-growing.
5. **Harness as the spec.** Scenario files ARE the behavior spec now
   (~45 files); keep them small-per-file with shared harness helpers so
   new features land with a scenario, not a soak.
6. **Enforced ceilings.** oxlint rules (120-line fns, c15, depth 4, 6
   params) stay the gate; add a file-size watch (~900 lines) to flag the
   next Player.ts/CombatHandler.ts before it needs a burn-down.
   - 2026-10-15: `client/src/game/combat/impact.ts` (1145) pinned in the
     watch after the alarm tripped — burn-down target: split the
     ichor/corpse FX block and the cluster-bomblet block into their own
     modules, leaving the impact adjudication core.


## Working agreements (from JP, painful lessons)
- Verify myself via the E2E harness — never ask JP to confirm a fix.
- Watch `logs/client.log` (POST /client-log) for real client evidence.
- `bun --watch` does NOT reload `shared/` — server restart needed for
  shared changes; check uptime via /metrics before concluding.
- exec cwd doesn't persist — cd inside every exec; bun needs PATH export.
- `.old` soft-delete; comments explain WHY; commit per settled topic.
