# Project Development Context

## Current State
- **Project:** Browser-based multiplayer FPS (Tribes-inspired)
- **Architecture:** Client (Three.js) + Bun WebSocket server
- **Client:** Three.js rendering, custom atmospheric sky, terrain with height fog, demo recording/playback, cool shots panel
- **Server:** `server_bun/` — Bun runtime, WebSockets, FastAPI-style HTTP routes for demo upload/download
- **Networking:** Binary bit-packed messages (position, shot, jump, jetpack, ski, death), JSON join handshake
- **Security:** Server validates damage/positions with lightweight checks (distance, rate, sanity); client-driven feel prioritized
- **Recent Changes:**
  - Additive blending on explosion particles (grenades/rockets no longer look dark)
  - Right-click download on cool shot demo tiles in ESC menu
  - Horizon/sky blending overhaul: sky sphere follows camera, 64x32 segments, height fog in terrain shader, hard fog cutoff at 200 units, unified fog color `0xbbd0e8` across scene.fog / scene.background / sky shader / terrain shader
  - `scene.background` set to fog color (Three.js requirement for seamless horizon)

## Technical Context
- **Dependencies:**
  - Client: Three.js 0.184.0, Vite 8.x, TypeScript
  - Server: Bun runtime, no npm deps except `@types/bun`
- **Key Components:**
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
- **Testing Requirements:** No unit tests currently (add as priority)
- **Security Considerations:**
  - Server must be authoritative for movement
  - Rate limit critical messages
  - Validate all client inputs

## Current Task
- **Objective:** Horizon/sky fog blending — seamless Tribes 2-style haze
- **Status:** In progress — colors unified, hard cutoff at 200 units implemented, still refining visual match
- **What's done so far:**
  - Sky sphere follows camera each frame (no edge visible)
  - Sphere segments increased to 64x32 (no polygon edges at horizon)
  - Sky fragment shader: wide haze band at `h=0`, `hazeColor = vec3(0.7333, 0.8157, 0.9098)` = `0xbbd0e8`
  - Terrain shader: height fog + hard cutoff at 200 units forcing 100% fogColor
  - Terrain `fogColor = 0xbbd0e8`, `fogDensity = 0.030`
  - `scene.fog = FogExp2(0xbbd0e8, 0.030)`, `scene.background = 0xbbd0e8`
  - `renderer.setClearColor(0xbbd0e8)`
  - `ambientColor` raised to `(0.38, 0.45, 0.55)` to reduce dark tint on distant terrain
- **Remaining issue:** Subtle visible seam — terrain still slightly darker than sky at horizon
- **Ideal next step:** Post-processing depth-based fog pass (one ShaderPass reads depth buffer, applies sky-gradient fog to whole frame — eliminates all color sync issues)

## Recently Completed
- **Explosion rendering:** Additive blending on particles so overlapping layers glow instead of darken
- **Demo download:** Right-click on cool shot tiles in ESC menu downloads the `.demo` file (local or from server)
- **Horizon blending:** Sky sphere camera follow, segment increase, height fog, hard cutoff, unified colors
- **Fog research report:** `_reports/fog-sky-blending-research.md` documents root causes, Three.js forum findings, techniques used, and ideal future solution

## Next Tasks
- **Post-processing fog pass** (medium complexity) — depth buffer → reconstruct position → apply sky-gradient fog per pixel. Eliminates all color sync issues permanently. See `_reports/fog-sky-blending-research.md` for details.
- **Refactor `main.ts`** (low priority) — currently large monolithic file; split into Game.ts, Renderer.ts, etc.
- **Remove deprecated files** — `server/` old Node.js server, `.deprecated`/`.old` files in `server/src/` — user's call when to remove
