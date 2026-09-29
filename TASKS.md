# Project Development Context

## Current State
- **Project:** Browser-based multiplayer FPS (Tribes-inspired)
- **Architecture:** Client (Three.js) + Bun WebSocket server
- **Client:** Three.js rendering, custom atmospheric sky, terrain with height fog, demo recording/playback, cool shots panel
- **Server:** `server_bun/` — Bun runtime, WebSockets, FastAPI-style HTTP routes for demo upload/download
- **Networking:** Binary bit-packed messages (position, shot, jump, jetpack, ski, death), JSON join handshake
- **Security:** Server validates hit claims against tracked projectiles (ownership, ballistic reach, legal wake radius at claimed airtime) — see `shared/combat.ts` `validateHitClaim`
- **Recent Changes:**
  - Hit claims now server-validated against tracked projectile trajectories (shared/combat.ts); PROTOCOL_VERSION=2; weapon stats single-sourced in shared/weapons.ts; dead constants purged from config.ts
  - Additive blending on explosion particles (grenades/rockets no longer look dark)
  - Right-click download on cool shot demo tiles in ESC menu
  - Horizon/sky blending overhaul: sky sphere follows camera, 64x32 segments, height fog in terrain shader, hard fog cutoff at 200 units, unified fog color `0xbbd0e8` across scene.fog / scene.background / sky shader / terrain shader
  - `scene.background` set to fog color (Three.js requirement for seamless horizon)

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
  - Client ↔ Server via WebSocket (port 8080 default)
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
- **Testing Requirements:** `bun test` in server_bun/ (226 tests); `npx vitest run` in client/ (91 tests); `_tools/pvptest/` live E2E (`fleet.ts` honest-bot swarm w/ journal replay + correction metrics + deploy claims + `--drop=N` loss sim, `--test*`/`--watch`/`--balls`/`--spec`), `record.ts`+`replay.ts` wire capture/replay, `netReplay.test.ts` headless replay through real netHandlers, `_tools/poseshot/shoot.js` anim pose gallery on white bg
- **Balance telemetry:** `weaponStats` records per-mode weapon damage/kills (human/bot split), death heatmap (10m cells), duel TTK, flag lifecycle timers, kill-moment speed bins + air share, pickup funnel — `/weaponstats` JSON, `/weaponstats.html` dashboard, `logs/weaponstats.jsonl` rollup
- **Log hygiene:** `logs/*.log|*.jsonl` auto-rotates to `logs/OLD/<name>_<mtime>.<ext>` at server boot
- **Security Considerations:**
  - Server must be authoritative for movement
  - Rate limit critical messages
  - Validate all client inputs

## Current Task
- **Objective:** Continuous overhaul toward Tribes-scale MP (see ROADMAP.md — the living plan). Now landed: multi-room match model (maps/<room>.json: mode/balls/spawns/bases/bots/botFill/ballMix/terrain), server-owned teams+score+CTF flags+nugget pickups+DM frags, match clock w/ OT, match journal→/matches, lobby picker + /join quick-play, server bots w/ shared brain, join throttle + identity cap, wire record/replay harness — plus: bots-as-legal-players (shared MoveSim + BrainCtx senses, energy economy, real projectiles via RoomProjectiles), per-map heightfield pipeline (maps/*.bin → sims + client terrain hot-swap), map rotation, TDM kill-confirmed, server-owned deployables (turret/mine/station/drone), kill feed w/ weapon attribution, RemoteSet entity lifecycle, GameServer → TickLoop + SessionManager split, input-replay corrections + seq-anchored divergence probe + correction grace window.

## Recently Completed
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
