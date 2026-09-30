# Project Development Context

## Current State
- **Project:** KRIBES — browser multiplayer FPS: Tribes gameplay, Krunker
  performance/accessibility. Skiing, jetpacks, spinfusor, base assets.
- **Architecture:** Client (Three.js) + Bun server (WS + WebTransport + WebRTC
  DataChannel tiers, auto-probed) + `shared/` deterministic sims run on
  BOTH ends (movement, ballistics, creature families, bot brains).
- **Server-authoritative sims:** players (MoveSim shadow/judge/authority),
  balls (BallSim segment events), creatures (CreatureSim edge stream —
  crawler/scarab/roller/snake/baneling flyer's gnats rakk/totem families
  all ported), flags, pickups, deployables, bots (virtual clients).
- **Networking:** edges + committed snapshots, not position streams;
  distance-tiered fanout; players are the only always-on stream (20Hz).
  PROTOCOL_VERSION=4. `ROADMAP.md` is the living manifesto — read first.
- **Testing:** `server_bun/tests/` 448 bun tests incl. `tests/scenarios/`
  one-file-per-staged-interaction suite (harness.ts); client vitest (99);
  `server_bun/tools/netBot.ts` wire-level soak bots — full client-verb
  coverage, real claim ledger, objective farming (+ `bun run soak`,
  `rtc:relay`, `rtc:punch` scripts);
  `_tools/e2e/` real-browser E2E (headless, locked-PC safe): smoke /
  duo / duo_p2p / lobby / reconnect / perf — `bun _tools/e2e/all.ts`,
  CI runs it on every push; `_tools/pvptest/soakreport.ts` headless
  fleet+server audit.
- **Recent Changes:**
  - `_tools/e2e/` suite + `.github/workflows/ci.yml` — real Chrome vs
    real server: connect/gameState/tick frames/corrections/chat on ws,
    p2p host+guest over a DataChannel, open-lobby quick-join, grace
    reconnect reclaim, frame-time + JS-busy perf baseline diffing
  - Open p2p lobbies: `?lobby`/`HOST OPEN` lists the room at
    `GET /rtc/lobbies`; `?p2p=quick`/`QUICK` joins the oldest — the
    friend-play path needs no code swap
  - VGS menu (V + chords) on the real chat wire: tactical cats team-only,
    VG* global — verified live multiplayer
  - Team chat on Y (`chat{team:true}`), global on T; green `[T]` lines
  - Doppler: one-shots pitch-bend at trigger, sustained loops per-frame
    (listener velocity counts; ±45% clamp)
  - Bot taunts on the real chat wire (kill/death/env-death/spree, delayed
    1.5-3s like typing; `shared/botTaunts.ts`, injectable rng)
  - MoveSim judge: journaled-input segment replay + `min(live, replayed)`
    divergence — soaks now read 0 WARN under full churn
  - netBot legality hardening: corpse-target claims skipped, stale-claim
    expiry, real-airtime claims, respawn/death silence, per-room reset
  - HUD zone-slot contract: every element anchors a named stack slot —
    no overlapping anchors possible
  - Server creatures raze deployables (`dep:N` targets + gnaw hp pool)
  - Scenario suite: teleportGrace/healthTotals/roomHop/claimLedger/
    teamChat/spawnContract/tickSeq regressions all covered
  - Light wildlife packs on crossfire + stonekeep (PvPvE on real maps)

## Technical Context
- **Dependencies:**
  - Client: Three.js 0.184.0, Vite 8.x, TypeScript
  - Server: Bun runtime, no npm deps except `@types/bun`
- **Key Components:**
  - `client/src/game/bots.ts` — offline bot brains + GameBot (extends RemotePlayer); modes live in `shared/teams.ts` (`?mode=nuggets|ctf|dm|classic`)
  - `client/src/entities/RemotePlayer.ts` — networked/bot player visual; anim states idle/walk/run/jump/ski/hit/shoot/death (RobotExpressive clips)
  - `client/src/core/keybinds.ts` — source of truth for rebindable keys (`fps-keys` setting), consumed by Player input + KEYS menu
  - `_tools/pvptest/bot.ts` — headless WS client: `--fighter` sparring bot, `--test*` assertion suites, `--watch` passive probe
  - `_tools/vmdump/` — weapon bake pipeline: export.js (GLB dump) → bake.py (Blender unwrap+texture-baker maps+numpy composite) → shot.js (screenshots)
  - `client/src/world/atmosphericSky.ts` — custom sky sphere shader, follows camera each frame
  - `client/src/world/terrain.ts` — chunked terrain with custom GLSL shader (height fog, hard cutoff)
  - `client/src/world/scene.ts` — scene setup, fog, lighting
  - `client/src/core/config.ts` — all constants (FOG_COLOR, FOG_DENSITY, camera, sky, clouds)
  - `client/src/demo/DemoManager.ts` — demo record/playback, upload/download, cool shots
  - `client/src/ui/CoolShotsPanel.ts` — ESC menu cool shots tiles (click=play, right-click=download)
  - `client/src/effects/explosion.ts` — particle explosions with additive blending
  - `server_bun/src/server.ts` — Bun.serve entry point, HTTP + WebSocket
  - `server_bun/src/GameServer.ts` — game logic, player management
  - `server_bun/src/DemoStorage.ts` — server-side demo file storage
- **Integration Points:**
  - Client ↔ Server via WS / WebTransport / RTC-DataChannel (auto-probe)
  - JSON join handshake, then binary bit-packed game messages
  - Demo files: local memory OR server upload via HTTP POST /demos
- **Deprecated/Archive:**
  - `server/` — old Node.js server (deprecated)
  - `_zzz/` — old client prototypes (Babylon, Heaps, PlayCanvas)

## Development Guidelines
- **Coding Standards:** TypeScript with implicit any (strict mode not enabled)
- **Required Updates:**
  - Update changelog.txt after each task
  - Update architecture.txt for structural changes
  - Maintain TASKS.md for context
- **Testing Requirements:** `bun test` in server_bun/ (302 tests); `npx vitest run` in client/ (93 tests); `_tools/pvptest/` live E2E (`fleet.ts` honest-bot swarm w/ journal replay + correction metrics + deploy claims + `--drop=N` loss sim, `--test*`/`--watch`/`--balls`/`--spec`), `record.ts`+`replay.ts` wire capture/replay, `netReplay.test.ts` headless replay through real netHandlers, `_tools/poseshot/shoot.js` anim pose gallery on white bg
- **Balance telemetry:** `weaponStats` records per-mode weapon damage/kills (human/bot split), death heatmap (10m cells), duel TTK, flag lifecycle timers, kill-moment speed bins + air share, pickup funnel — `/weaponstats` JSON, `/weaponstats.html` dashboard, `logs/weaponstats.jsonl` rollup
- **Log hygiene:** `logs/*.log|*.jsonl` auto-rotates to `logs/OLD/<name>_<mtime>.<ext>` at server boot
- **Security Considerations:**
  - Server must be authoritative for movement
  - Rate limit critical messages
  - Validate all client inputs

## Current Task
- **Objective:** Continuous overhaul toward Tribes-scale MP (see ROADMAP.md — the living plan). Now landed: multi-room match model (maps/<room>.json: mode/balls/spawns/bases/bots/botFill/ballMix/terrain), server-owned teams+score+CTF flags+nugget pickups+DM frags, match clock w/ OT, match journal→/matches, lobby picker + /join quick-play, server bots w/ shared brain, join throttle + identity cap, wire record/replay harness — plus: bots-as-legal-players (shared MoveSim + BrainCtx senses, energy economy, real projectiles via RoomProjectiles), per-map heightfield pipeline (maps/*.bin → sims + client terrain hot-swap), map rotation, TDM kill-confirmed, server-owned deployables (turret/mine/station/drone), kill feed w/ weapon attribution, RemoteSet entity lifecycle, GameServer → TickLoop + SessionManager split, input-replay corrections + seq-anchored divergence probe + correction grace window.

## Recently Completed
- **Deployable predation:** server creatures target `dep:N` ids (CreatureSim extraTargets/targetPos), bites drain RoomDeployables hp; depGnaw scenario proves a turret gets eaten
- **Deploy refactor:** sentry rockets extracted to deployRockets.ts; RoomMatch extracted from Room; CombatHandler claimLedger; ServerBots watchdog; bots.ts watchdog/tickBots/resolveShot splits
- **All species families server-authoritative:** crawler/scarab/roller/snake/gnat/rakk/baneling/totem via shared sims + crawl* edges
- **Species-mix map** (): maps/infestation.json proves the ambient-cap channel end-to-end (spec -> gameState.map.ambient -> setAmbientCaps); nuggets room, layered crawler/scarab/gnat/rakk/seeker/strifer ecology + 6 bots on swarm terrain
- **Bot melee actually fires** (): band gate was 3D muzzle->aim (+1.4y made 3m unreachable, now planar 4.5m); botAttack read directDamage=0 for Melee (falls back to aoeDamage). Ledger: w10 11 hits/572dmg/1 kill in pit soak. Remote meleeFlash+swing path verified end-to-end.
- **Full bot kit:** sidearm band (Pistol/Revolver hold-out inside 8m) + melee punch inside 3m via the same combat funnel + broadcast swing — mains/sidearm/melee/belt/deployables/skills/perks/classes all legal paths
- **Perk swaps bank at respawn:** `perkUpdate` wire + `pendingPerk`/`appliedPerk` — mirrors the classUpdate respawn-bank so HP/energy caps can't desync mid-life
- **Gravity is a boolean:** `WeaponStats.gravity: true/false` vs world GRAVITY (-28) — no per-weapon fudge factors; all configs/client+server paths normalize
- **Sprinkler (wid 25):** plasma-cadence arced bolt hose, per-shot cone jitter, lime trail — full checklist wired
- **Class silhouettes:** all tiers wear UAL mannequin at CLASS_MODEL_SCALE 0.92/1.0/1.15; chibi knight dropped from gameplay cast
- **RemoteRailgun flat flight:** speed 40, gravity off — discharge ray tracks the throw line instead of sagging mid-flight
- **Validation arc (standing priority):** live fleet runs clean — 0 shot rejects, 0 sheep/stuck warns, server bots 100% ski/air; residual divergence class reduced to transient ~10m clips at contact events (self-correcting, non-accumulating)
- **Fleet honesty:** test bots replicate real client behavior — 30Hz sim cadence, correction snaps + journaled-input replay, knockback impulses, respawn reseat, correction metrics (count + worst pre-snap gap)
- **Known residual:** authority mode (`FPS_MOVE_AUTHORITY=1`) shows a steady ~2m phase-lag divergence on the synthetic fleet — report-vs-shadow tick offset; corrections bound it. Real clients converge via journal replay.
- **Demo download:** Right-click on cool shot tiles in ESC menu downloads the `.demo` file (local or from server)

## Next Tasks
- ~~**Replay through real netHandlers**~~ — DONE: `netReplay.test.ts` feeds committed `.rec` captures through `handleMessage`/`handleBinaryMessage` via a DOM-stubbed harness (`netHarness.ts`).
- ~~**WT tier in tests**~~ — DONE: `FPS_WT_PORT=19443` test server + `fleet.ts --tier=wt` ran 2/2 QUIC joins, 732 tick frames, kills through the claim funnel, 0 shot rejects.
- **Ops items needing JP's domain+VPS:** TURN server, CA cert for WebTransport — see `_docs/2026-09-28_deploy-netcode-v2.md`
- ~~**Post-processing fog pass**~~ — DONE differently: `world/directionalFog.ts` tints `scene.fog.color` + sky horizon + terrain fog by camera-vs-sun facing (sunward warm, away cool). Chosen over a depth-buffer post-pass because it works in every pixel-mode including the hard/medium/floyd paths that bypass the composer. Per-fragment sun direction would need patching every material's fog chunk — revisit if the flat-camera tint reads wrong in game.
- **w4 mortar palette** — authored albedo near-black; normalization lifts but it stays darkest. JP's call.
- ~~**Remote fire events for anim**~~ — DONE: `playerShot` relays hitscan/melee trigger-pulls with weaponType; observers get positional audio, recoil anim, weapon-tinted muzzle flash, LG beam flash.
- **Remove deprecated files** — `server/` old Node.js server, `.deprecated`/`.old` files — user's call when to remove
