# KRIBES — Living Overhaul Plan (Devin's brain)

**Standing order:** continue overhauling the project — server and client — toward a
real game the size of Tribes Ascend / Krunker / Narrow.One. Maximal extensibility,
cleanliness, robustness, performance, low running cost. Massive changes allowed
when research supports them. Commit per settled topic, changelog.txt one line each,
never push.

Read this file first each session. Update it as things land and as better ideas
surface. Detailed research lives in `_reports/`; this file is the current truth.

## North-star architecture

- **shared/ is the game.** Sim, combat math, wire codec, species kits, teams.
  Client renders + predicts; server validates + fans out; P2P host runs the
  same modules embedded. Any logic that exists in two languages/places is debt.
- **Rooms are matches.** (Landed 2026-09-26.) `Room` owns all per-match state;
  `GameServer` dispatches. Lobbies/matchmaking = `roomFor(name)` + a lobby API.
- **Authority split is explicit.** Server: hit claims, health/death, respawns,
  movement plausibility. Client: presentation, prediction, cosmetics.
- **Cheap to run.** Binary wire everywhere hot; delta suppression + interest
  tiers already proven (~6-8Hz effective at 20Hz tick). Every cost decision
  should survive 32 players on a $5 VPS.

## Status board

### Done
- Binary wire codec + position/tick frames, delta suppression, interest tiers
- Server validation layer + per-type rate limits + session-token reconnect
- Grace-period reconnect, idle reaper, force-send windows on knockback
- Offline play end-to-end (localAuthority, bot damage funnel, match restart)
- Modes: nuggets / ctf / dm / classic + 5v5 team bots (shared/teams.ts rules)
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
   defaults; examples swarm/duel/nugwar/ctf). Server bots populate
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
   `terrain` ref landed: maps/<file>.bin
   heightfields per room (lazy, cached, shared). Shared brain landed:
   shared/botBrain.ts drives offline GameBots AND server bots — one
   personality, both runtimes.
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
- Bots as legal players (2026-10-01, per _docs/2026.10.01-bots-as-players.md):
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
  spec (roomFor strips -N: nugwar-3 → nuggets mode/bots/terrain — was
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

## Non-goals
- No engine rewrite, no ECS framework, no server authoritative physics yet.
- Don't touch JP's in-flight client files (check `git status` before edits;
  the file list drifts — speciesKit/context/main/etc. have been hot).

## Working agreements (from JP, painful lessons)
- Verify myself via the E2E harness — never ask JP to confirm a fix.
- Watch `logs/client.log` (POST /client-log) for real client evidence.
- `bun --watch` does NOT reload `shared/` — server restart needed for
  shared changes; check uptime via /metrics before concluding.
- exec cwd doesn't persist — cd inside every exec; bun needs PATH export.
- `.old` soft-delete; comments explain WHY; commit per settled topic.
