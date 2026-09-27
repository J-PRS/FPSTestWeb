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
- **Testing Requirements:** `bun test` in server_bun/ (139 tests — rooms, CTF flags, DM scoring, match clock+OT, bot fill, hit claims, rate limits); `npx vitest run` in client/ (48 tests); `_tools/pvptest/` live E2E (`--test*`/`--watch`/`--balls`), `record.ts`+`replay.ts` wire capture/replay
- **Security Considerations:**
  - Server must be authoritative for movement
  - Rate limit critical messages
  - Validate all client inputs

## Current Task
- **Objective:** Continuous overhaul toward Tribes-scale MP (see ROADMAP.md — the living plan). Now landed: multi-room match model (maps/<room>.json: mode/balls/spawns/bases/bots/botFill/ballMix/terrain), server-owned teams+score+CTF flags+nugget pickups+DM frags, match clock w/ overtime+60s warn, match journal→/matches, lobby picker + /join quick-play, server bots w/ shared brain, join throttle + identity cap, wire record/replay harness.

## Recently Completed
- **Explosion rendering:** Additive blending on particles so overlapping layers glow instead of darken
- **Demo download:** Right-click on cool shot tiles in ESC menu downloads the `.demo` file (local or from server)
- **Horizon blending:** Sky sphere camera follow, segment increase, height fog, hard cutoff, unified colors
- **Fog research report:** `_reports/fog-sky-blending-research.md` documents root causes, Three.js forum findings, techniques used, and ideal future solution

## Next Tasks
- **Post-processing fog pass** (medium complexity) — depth buffer → reconstruct position → apply sky-gradient fog per pixel. Eliminates all color sync issues permanently. See `_reports/fog-sky-blending-research.md` for details.
- **MP team scoring** — modes' shared/teams.ts rules exist client-side; server needs a `teamScore` broadcast to enforce nuggets/ctf/dm scoring for real players.
- **w4 mortar palette** — authored albedo near-black; normalization lifts but it stays darkest. JP's call.
- **Remote fire events for anim** — projectileSpawn drives muzzle flash/shoot pose already; richer (weapon type) could pick per-gun poses later.
- **Remove deprecated files** — `server/` old Node.js server, `.deprecated`/`.old` files — user's call when to remove
