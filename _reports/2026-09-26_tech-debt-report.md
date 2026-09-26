# Technical Debt Report — 2026-09-26

## Executive Summary

- **Scope**: `client/src/` (~19.3k LOC), `server_bun/src/` (~2.5k LOC), `shared/`
- **Total findings**: 9
- **Top risks**: Hit registration is fully client-authoritative with only a coarse 200m sanity check — a modified client can claim kills at will. Combined with the expanding wake hitbox (up to 8m), cheat surface is wide. Second: no test coverage anywhere, in a codebase that has already shipped a client/server damage desync bug.

## Critical Issues

### 1. Hit claims are trusted with no trajectory validation
- **File**: `server_bun/src/MessageHandler.ts:188-259` (`handleShot`)
- **Severity**: Critical
- **Evidence**: A `shot` message with a `targetId` applies `directDamage` after only two checks: not-self, and shooter–target distance < 200m. The projectile's claimed origin/velocity/age are not validated (they aren't even sent for hit claims — `position`/`velocity` fields are only present on misses). The wake hitbox compounds this: `hitRadius` grows to 8m (`client/src/core/config.ts:43-45`), but the server has no concept of it — a client can claim a "direct" hit that was a wake graze, or fabricate a hit entirely inside the 200m window.
- **Impact**: Trivially scriptable aimbot/triggerbot territory — send `shot` with any nearby targetId. Wallhack-free kills at worst case every ~fire interval. Undermines every other validation layer.
- **Proposed fix**: Require `projectileId`, claimed `airtime`, and muzzle origin in hit claims; server recomputes max legal `hitRadius` from airtime (it's deterministic) and verifies target distance to the claimed trajectory segment. Reject claims missing them. Medium effort, closes the biggest exploit class without real server-side ballistics.
- **Effort**: Medium

## High Issues

### 2. Arbitrary projectile deletion by any client
- **File**: `server_bun/src/MessageHandler.ts:372-377` (`handleProjectileDestroy`)
- **Evidence**: `projectileDestroy` is broadcast verbatim for any `projectileId` — the server generates `proj_N` ids on misses but never records ownership, so any client can destroy every other player's projectiles in flight.
- **Impact**: Griefing vector; silently suppresses others' weapons.
- **Proposed fix**: Track `projectileId → ownerId` in a Map (cap size / TTL on destroy), validate sender owns the id.
- **Effort**: Small

### 3. Wire boundary is type-erased (`any`)
- **File**: `client/src/networking/NetworkManager.ts:43-44,153-308`, `client/src/game/netHandlers.ts:326`
- **Evidence**: All server-message handler payloads and the `onGameState` players array are `any`. `server_bun/src/types.ts` defines the protocol types, and `shared/protocol.ts` exists — but the client doesn't apply them at the boundary.
- **Impact**: The highest-value place for types is the protocol boundary, and it's the place without them. Refactors on the wire format won't be caught at compile time — exactly how desync bugs ship.
- **Proposed fix**: Type `handlers` as `Record<ServerMessage['type'], (data: Extract<ServerMessage, ...>) => void>`; replace `any[]` with `SnapshotPlayer[]`/`GameStatePlayer[]` from shared types.
- **Effort**: Medium

### 4. No automated tests; duplicated simulation logic between client and server
- **File**: repo-wide (`server_bun/tests/` exists but TASKS.md states no unit tests)
- **Evidence**: Damage falloff, knockback impulse math, and wake-hit geometry are implemented twice (e.g. `client/src/game/combat.ts:329` "Match server damage exactly"). `shared/weapons.ts` fixed stats sync but not *logic* sync — `shared/weapons.ts:7` notes a real falloff desync already shipped.
- **Impact**: Every combat-feel change risks silent client/server divergence; no safety net for the binary wire protocol.
- **Proposed fix**: Extract damage/impulse functions into `shared/` (pure math, importable by both); add vitest/bun-test on shared + server validation.
- **Effort**: Medium

## Architecture Issues

### 5. `main.ts` remains the orchestration god-module
- **File**: `client/src/main.ts` (623 lines)
- **Evidence**: ~25 module-level mutable lists/objects (`balls`, `projectiles`, `explosions`, `remotePlayers`, `killCounts`...) passed by reference into factory deps objects (`createCombat`, `createRemotes`, `createDemoLifecycle`). The frame `loop()` manually interleaves entity updates, demo gating, HUD, net ticks — update ordering is implicit and fragile. TASKS.md already lists the split into Game.ts/Renderer.ts as a next task.
- **Impact**: Every new feature touches shared globals; the `() => dep` closure pattern signals deferred-init wiring debt. Contained for now (files are well-factored underneath), so Medium not High.
- **Proposed fix**: Extract a `Game` class owning entity registries + the loop; keep `main.ts` as boot/wiring only.
- **Effort**: Medium-Large

### 6. Demo playback gates are scattered through hot paths
- **File**: `client/src/main.ts` (`updateBalls`, `updateNuggets`, `tickDemo`, `loop`), `demo/` subsystem
- **Evidence**: `demoManager?.isPlaying` checks pepper the loop and entity updaters — playback mode is a cross-cutting concern implemented as inline conditionals.
- **Impact**: Adding a new entity type means remembering every gate site; easy to leak a system that mutates state during playback.
- **Proposed fix**: Centralize a `mode: 'live' | 'playback'` concept; entity systems subscribe to the live-mode tick rather than self-gating.
- **Effort**: Medium

### 7. Orphaned timers for respawn/disconnect grace
- **File**: `server_bun/src/MessageHandler.ts:379-397` (`scheduleRespawn`), `server_bun/src/GameServer.ts:87-117`
- **Evidence**: `setTimeout` respawn timers aren't tracked per-player — a player killed, disconnected (grace), and rejoining can get a stale respawn firing on the new session; double-kill also stacks timers. Guards (`respawnPlayer` returning falsy) mitigate correctness, but timers are untracked and un-cancelled.
- **Impact**: Edge-case double-respawns / respawning a "different" session of the same player; no server shutdown path clears timers.
- **Proposed fix**: Track respawn timer per playerId on PlayerManager, cancel on disconnect/new kill; verify `respawnPlayer` checks session generation.
- **Effort**: Small

## Performance Issues

- **None blocking.** Largest client files (Projectile.ts 786, terrain.ts 685, DemoManager.ts 646) are under the 2000-line danger line; the per-frame loops are flat arrays with backwards-splice removal, which is fine at this entity count. Scoreboard DOM rebuild at 4Hz and per-entity health-bar divs will scale linearly — acceptable until player counts grow past ~64. Worth noting as a scaling cliff, not debt.

## Consistency Issues

### 8. `innerHTML` DOM paths rely on input charset, not escaping
- **File**: `client/src/ui/hud.ts:411`, `client/src/ui/CoolShotsPanel.ts:53`
- **Evidence**: Scoreboard rows interpolate `r.name` into `innerHTML`. Currently safe only because `playerIdPattern` (`^[a-zA-Z0-9_-]+$`, `server_bun/src/config.ts:42`) forbids markup chars — display names don't exist yet.
- **Impact**: The day player-chosen names land, this is a stored-XSS hole in a game that renders names on every client.
- **Proposed fix**: Build rows with `textContent`/createElement, or add an `escapeHtml` helper now — cheap insurance before names exist.
- **Effort**: Small

### 9. Settings persistence scattered in localStorage
- **File**: `client/src/entities/Player.ts:23-24,252-269`, `client/src/core/renderer.ts:45-52,256-273`
- **Evidence**: `fps-invert-y`, `fps-sens`, `fps-pixelated`, `fps-postpro`, `fps-bloom` read/written ad hoc across modules; no central settings store.
- **Impact**: Adding settings means inventing another key + load/save site; no validation of corrupted values beyond `parseFloat || 1`.
- **Proposed fix**: Small `settings.ts` with typed get/set and defaults.
- **Effort**: Small

## Prioritized Action Plan

| Priority | Issue | Effort |
|----------|-------|--------|
| Critical | Hit claims need projectileId + airtime validation (server recomputes legal hitRadius) | Medium |
| High | `projectileDestroy` ownership tracking | Small |
| High | Type the wire boundary (NetworkManager/netHandlers `any`) | Medium |
| High | Shared damage/impulse math + first test suite | Medium |
| Medium | `main.ts` → Game class extraction | Medium-Large |
| Medium | Demo playback gating → mode abstraction | Medium |
| Medium | Tracked respawn/disconnect timers | Small |
| Medium | Escape/route DOM string injection (pre-names) | Small |
| Low | Central settings store | Small |

## Metrics

| Category | Count |
|----------|-------|
| Critical | 1 |
| High | 3 |
| Medium | 5 |

## Note on strengths (things done right — don't "fix")

- `shared/weapons.ts` + `shared/wire.ts` as the single wire source of truth — genuinely shared via `../shared` tsconfig includes.
- Server-side validation layer (`validation.ts`) with finite-number guards on every message type, and per-type rate limiting (`RateLimiter`).
- Position plausibility checking handles the stale-baseline failure mode correctly (consecutive-report comparison, correction + force-accept resync).
- PROTOCOL_VERSION handshake, disconnect grace period, and the wake/direct hit distinction already being tracked for hit-accuracy metrics.
