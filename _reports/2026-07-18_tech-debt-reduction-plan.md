# Tech Debt Reduction Plan — Client and `server_bun`

**Date:** 2026-07-18  
**Scope:** `client/` and `server_bun/`  
**Goals:** Reduce maintenance burden while preserving low server cost, lagless client feel, and cheap server validation.

## Current State

| Area | Files | LOC | Health |
|------|-------|-----|--------|
| **Client** | ~45 TS files | ~5000+ | Monolithic `main.ts`, dead networking code, type duplication |
| **Server** | 10 TS files | ~800 | Well-structured, minor issues |

- Client is a Three.js + Vite project with `client/src/main.ts` as a 1741-line / 72 KB monolith.
- `server_bun` is a Bun WebSocket/HTTP server — well-modularized into `GameServer`, `MessageHandler`, `PlayerManager`, `ConnectionManager`, `RateLimiter`, `validation`, `DemoStorage`.
- Client `tsconfig.json` has `strict: true` but leaves `noUnusedLocals` / `noUnusedParameters` disabled.
- `client/src/physics/` is empty.
- Archived code exists in `_zzz/`, `_DEMO/`, and `zzz/`.
- Server has only 3 test files (`PlayerManager`, `RateLimiter`, `validation`); client has none.

## Guiding Constraints

Per project priorities:

1. **Low server cost** — do not add server-side physics simulation, lag compensation, or position history rewinding.
2. **Lagless client-driven feel** — keep client-side prediction and hit detection as the visual source of truth.
3. **Cheat prevention** — server validation stays cheap (distance, rate, sanity checks).

Any refactor that increases server CPU or memory per player should be rejected unless essential.

---

## Client Tech Debt

### C1. `main.ts` is a 1741-line / 72KB monolith (Critical)

`client/src/main.ts` contains the game loop, init, all networking callbacks, demo playback event handling, input/pointer-lock, projectile management, ball spawning, explosion processing, state hash comparison, and debug globals — all in one file.

**Proposed split:**
- `GameLoop.ts` — the `loop()` function and update orchestration
- `NetworkCallbacks.ts` — all `networkManager.on*` handler registrations (~200 lines)
- `DemoPlaybackHandler.ts` — the `onPlaybackEvent`/`onPlaybackSeek`/`onPlaybackStart`/`onPlaybackStop` logic (~400 lines)
- `InputController.ts` — pointer lock, overlay, keydown handling (~80 lines)
- `StateHashChecker.ts` — the djb2 hash comparison + snapshot diff logic (~120 lines)
- `DebugGlobals.ts` — `window.*` debug function exports (~120 lines)
- `main.ts` — just imports, scene/camera/renderer setup, and `init()` call

### C2. Dead/deprecated networking files — ~21KB (High)

Four `.old`/`.deprecated` adapter files + orphaned type declaration, none imported anywhere:

- `client/src/networking/ColyseusAdapter.ts.old` (6.9KB)
- `client/src/networking/NaiaAdapter.ts.old` (3.4KB)
- `client/src/networking/UWSAdapter.ts.deprecated` (5.7KB)
- `client/src/networking/WSAdapter.ts.deprecated` (5.4KB)
- `client/src/networking/msgpack-lite.d.ts` (134B)

**Action:** Delete all 5 files.

### C3. Tribes2 networking subsystem is dead code — ~58KB (High)

`NETWORK_BACKEND = 'fastapi'` in config. The entire Tribes2 stack is never activated:

- `client/src/networking/Tribes2Adapter.ts` (13KB)
- `client/src/networking/BitStream.ts` (10.5KB)
- `client/src/networking/EventManager.ts` (14.4KB)
- `client/src/networking/GhostManager.ts` (10.9KB)
- `client/src/networking/MoveManager.ts` (8.5KB)
- `client/src/networking/StreamManager.ts` (9.2KB)

Only `WebSocketConnection.ts` (8KB) is shared with `FastAPIAdapter` — keep that.

**Action:** Delete the 6 Tribes2-only files. Remove `'tribes2'` from `NetworkBackend` type and `NetworkAdapterFactory`. Remove Tribes2 constants from `config.ts`.

### C4. `NetworkManager.ts` — callback hell with 12+ public callback props (Medium)

`client/src/networking/NetworkManager.ts:27-40` — 12 public nullable callback properties. This is fragile and hard to extend.

**Action:** Replace with a typed event emitter pattern (`EventEmitter<NetworkEvents>`) or at minimum group callbacks into an interface.

### C5. `NetworkManager.ts` — unimplemented stubs (Low)

- `getPacketLoss()` returns 0 — "Not implemented yet"
- `getJitter()` returns 0 — "Not implemented yet"
- `ping` field is never updated (stays at 0)

**Action:** Either implement ping (send/receive timestamp) or remove the stubs and the HUD elements that display them.

### C6. `FastAPIAdapter.ts` — dead methods (Low)

`client/src/networking/FastAPIAdapter.ts:141-160` — `getPlayers()`, `updateLocalPlayer()`, `sendShot()` are never called by `NetworkManager`.

**Action:** Remove dead methods.

### C7. `Logger.ts` — `ChildLogger` uses `(Logger as any).context` hack (Medium)

`client/src/core/Logger.ts:143-146` — 15 `as any` casts. Mutates static state to pass context. Fragile pattern.

**Action:** Refactor `ChildLogger` to pass context as a parameter to `Logger.log()` instead of mutating static state.

### C8. `main.ts` — 16 `as any` casts (Medium)

Includes `(rp as any).isDead`, `(terrain as any).material`, `(rp as any).scale` — these indicate missing type definitions on `RemotePlayer` and `Terrain`.

**Action:** Add proper typed properties (`isDead`, `scale`) to `RemotePlayer`. Expose `material` on `Terrain`.

### C9. Empty `physics/` directory (Trivial)

`client/src/physics/` — 0 items.

**Action:** Delete.

### C10. `config.ts` — 197 lines of flat constants (Low)

No namespacing. Physics, weapons, rendering, networking, UI constants all at one level.

**Action:** Group into namespaces (`config.physics`, `config.weapons`, `config.rendering`, etc.) or split into domain-specific config files.

### C11. Large entity files (Low)

- `RemotePlayer.ts` (20KB) — likely mixes rendering, interpolation, networking, death animation
- `DemoManager.ts` (23KB) — recording + playback + seek in one class
- `Projectile.ts` (20KB) — physics + collision + rendering + trails

**Action:** Decompose when touching these files for other work. Not urgent but worth tracking.

---

## Server Tech Debt

### S1. `validation.ts` — 3 near-identical AOE validation blocks (Medium)

`server_bun/src/validation.ts:92-129` — `aoeShot`, `discAOEShot`, `grenadeAOEShot` have identical validation logic copy-pasted.

**Action:** Extract a `validateAOEShot(type, obj)` helper.

### S2. `GameServer.ts` — mixed concerns (Medium)

`server_bun/src/GameServer.ts` (303 lines) contains tick broadcast, hash broadcast, handshake/reconnection logic, and status logging.

**Action:** Extract `TickBroadcaster` and `HashBroadcaster` classes. Move reconnection grace logic into a `ReconnectionManager`.

### S3. No tests for `MessageHandler` or `GameServer` (High)

`server_bun/tests/` — only `PlayerManager`, `RateLimiter`, `validation` have tests. `MessageHandler` contains the core game logic (damage, AOE, kills, respawns).

**Action:** Add `messagehandler.test.ts` covering: shot validation, AOE damage falloff, self-damage rejection, distance checks, respawn scheduling.

### S4. Hardcoded magic numbers in `MessageHandler` (Low)

- `200` m/s speed limit (`MessageHandler.ts:128`)
- `40000` (200m²) distance check (lines 159, 223)
- `0.5` and `0.3` vertical impulse multipliers (lines 256, 260)

**Action:** Move to `config.ts` as named constants.

### S5. `GameServer.ts` — hardcoded delta thresholds (Low)

`server_bun/src/GameServer.ts:251` — `0.01` and `0.0004` movement/rotation thresholds.

**Action:** Move to `config.ts`.

### S6. Unused `input` message type (Trivial)

`server_bun/src/types.ts:41` — `{ type: 'input'; input: unknown }` handled as no-op in `MessageHandler`.

**Action:** Remove from `ClientMessage` union and validation.

---

## Cross-Cutting Tech Debt

### X1. No shared types package (High)

Client and server independently define `Vec3`, `Rotation`, message types. Config values (damage, radii, speeds) are duplicated and must be manually synced.

**Action:** Create a `shared/` directory with `types.ts` and `config.ts` that both client and server import. Alternatively, use a symlinked or workspace package.

### X2. Config value divergence risk (High)

| Value | Client `config.ts` | Server `config.ts` |
|-------|--------------------|--------------------|
| Rocket AOE damage | `ROCKET_AOE_DAMAGE = 15` | `aoeDamage = 15` |
| Rocket AOE radius | `ROCKET_AOE_RADIUS = 6.0` | `aoeRadius = 6.0` |
| Disc AOE damage | — (in `discConfig.ts`) | `discAoeDamage = 10` |
| Grenade AOE damage | `GRENADE_AOE_DAMAGE = 20` | `grenadeAoeDamage = 20` |
| Knockback force | `ROCKET_FORCE = 28.0` | `knockbackForce = 28.0` |

**Action:** Single source of truth in shared config.

### X3. Archived/alternative implementations clutter repo (Low)

- `zzz/` — 4 alternative client engines (Babylon, Heaps, PlayCanvas, RunDot)
- `_zzz/` — archived TS files, `GlobalFog.cs`
- `_DEMO/` — C# Unity reference files

**Action:** Move to a separate `archive/` branch or delete if no longer referenced.

---

## Recommended Priority Order

| Priority | Task | Effort | Impact |
|----------|------|--------|--------|
| **P0** | Delete dead networking files (`.old`, `.deprecated`, Tribes2 stack) | 30 min | -103KB dead code |
| **P0** | Delete empty `physics/` dir + `msgpack-lite.d.ts` | 1 min | Clean structure |
| **P1** | Add `MessageHandler` tests | 2-3 hrs | Server reliability |
| **P1** | Extract shared types/config package | 2-3 hrs | Eliminate divergence risk |
| **P1** | Split `main.ts` into modules | 3-4 hrs | Maintainability |
| **P2** | Refactor `NetworkManager` callbacks → event emitter | 1-2 hrs | Extensibility |
| **P2** | Extract `TickBroadcaster`/`HashBroadcaster` from `GameServer` | 1 hr | Server modularity |
| **P2** | Fix `ChildLogger` `as any` hack | 30 min | Type safety |
| **P2** | Deduplicate AOE validation in `validation.ts` | 30 min | DRY |
| **P3** | Move hardcoded magic numbers to config | 30 min | Config centralization |
| **P3** | Remove `FastAPIAdapter` dead methods | 15 min | Clean API |
| **P3** | Remove/implement `getPacketLoss`/`getJitter` stubs | 30 min | No false UI data |
| **P3** | Namespace `config.ts` constants | 1 hr | Readability |
| **P3** | Archive `zzz/`, `_zzz/`, `_DEMO/` directories | 15 min | Repo cleanliness |

---

## Recommended First Step

Start with P0: delete dead networking files and empty directories. These are zero-risk, immediate wins that remove ~103KB of dead code and clarify the active codebase before larger refactoring work begins.
