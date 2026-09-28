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
   maps/<mode>.json). Next polish: show own room + mode in the panel,
   mid-match room switching without reload.
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
3. ~~Map format~~ — landed: `maps/<room>.json` (mode, ball population,
   spawn anchors, bases/objectives, bot count — all clamped with
   defaults; examples swarm/duel/nugwar/ctf). Server bots populate
   matches AND play objectives (flagGoal: grab exposed enemy flag, run
   home as carrier, return dropped own flag, defend while flag moves).
   Server-owned CTF flags landed (RoomFlags: touch pickup, drop on
   death, planar capture ring, flagUpdate broadcast); live-verified
   bot flag grabs over the wire. `botFill` spec keeps a room at N total
   bodies — spawns/retires bots as humans come and go (dead bots retire
   first); `teamUpdate` wire msg + bot-only rebalancing on leaver skew.
   Next extensions: species mix. `terrain` ref landed: maps/<file>.bin
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
   (watch-only socket, full-rate ticks).
- TDM mode: kill-confirmed scoring — frags +1 and drop a scoopable dog
  tag (either team banks it). Quicksand arena map: dome barrier,
  server-side RoomArena boundary pushback.
- Map structures landed: box/wall/pillar/ramp specs render client-side,
  balls ricochet off them (shared sphere-vs-yaw-OBB in stepBall —
  identical server + client prediction), arena domes fade in <80m.
- Admin API (FPS_ADMIN_TOKEN): /admin/reload hot-swaps a live room's
  map spec + mapUpdate broadcast, /admin/kick, /admin/end, /admin/rooms.
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

### Later / research needed
- Client prediction + reconciliation for self (currently trust + correct).
- Replay formalization — record.ts/replay.ts capture live wire streams and
  re-decode them offline (regression + decode-cost benchmarks landed).
  Remaining: replay through full client netHandlers, not just the decoder.
- ~~`ServerSim` registry~~ — landed as `room.sims`; bots/flags tick through
  it. Deployable turrets server-side are the next sim candidate.
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
