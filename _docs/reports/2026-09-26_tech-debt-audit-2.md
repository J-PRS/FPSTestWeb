# Tech Debt Audit #2 — Worst Offenders (2026-09-26)

Re-audit after passes 1–3 (hit-claim validation, wire typing, handshake
hardening, main.ts slimming, frame-loop perf). This ranks what remains.

## Critical

### 1. `aoeShot` is not bound to any projectile — detonate-anywhere grief vector
- **File**: `server_bun/src/MessageHandler.ts` `handleAOEShot`/`processAOE` (~L336)
- **Evidence**: the server sanity-checks only "explosion within 200 m of the
  shooter's last position". Unlike `shot`, it never links the claim to a
  `TrackedProjectile` — no trajectory check, no airtime check, no
  fire-rate check beyond the generic rate limiter.
- **Impact**: a modified client can place max-radius explosions on anyone
  within 200 m at message rate, ignoring weapon travel time entirely. This
  is now the cheapest cheat in the game — worse than the `shot` path we
  just closed, because there's no flight model to satisfy at all.
- **Fix**: spawn server-side tracked projectiles for AOE weapons too (they
  already go through the same `shot`-spawn broadcast), require `aoeShot`
  to name a `projectileId`, and recompute `origin + v·t + ½g·t²` legality
  for the claimed blast position. Reuses `validateHitClaim` machinery.
- **Effort**: Medium (the plumbing exists).

## High

### 2. Module-level mutable globals shared between combat.ts and netHandlers.ts
- **File**: `client/src/game/combat.ts` exports `pendingLocalProjectiles`,
  `localProjectileById`, `pendingProjectileTimestamps`; `netHandlers.ts`
  mutates all three.
- **Impact**: the two modules are secretly one object split across files —
  invisible coupling, impossible to instantiate twice (reconnect/demo
  switch), and any import of combat.ts drags live gameplay state with it.
- **Fix**: move the three maps into a small `ProjectileRegistry` object
  created in main.ts and passed to both factories — same dep-injection
  pattern as `remotePlayers`/`projectiles`.
- **Effort**: Small–Medium.

### 3. The four 450–800-line god-files
- **Files**: `client/src/projectiles/Projectile.ts` (786 — mesh lifecycle,
  trail emission, collision, wake math, demo keyframing),
  `client/src/entities/Player.ts` (741 — input, movement, skills,
  health, model),
  `client/src/demo/DemoManager.ts` (657),
  `server_bun/src/MessageHandler.ts` (550 — dispatch + every handler).
- **Impact**: every edit risks unrelated regressions; nothing is unit
  testable without constructing half the game. Projectile.ts in
  particular mixes render-resource caching with hit geometry.
- **Fix**: extract the pure/math halves (collision+wake in Projectile,
  skills timing in Player, message-dispatch table in MessageHandler) and
  leave the render/state halves behind.
- **Effort**: Large each — do one at a time, Projectile first.

### 4. main.ts is still the implicit game-state container
- **File**: `client/src/main.ts` (~430 lines): ~20 top-level `let`s +
  shared arrays (`projectiles`, `explosions`, `scorches`, …) fed to six
  factories through getter closures.
- **Impact**: ordering-sensitive init (a dep getter called too early
  returns undefined); no way to reset the world for demo↔live switching
  without reload; the wiring reads as a bidirectional graph.
- **Fix**: introduce a `WorldState` (or `GameWorld`) object holding the
  entity arrays + late-bound singletons, created once; factories take it
  directly instead of 20 arrow getters. Also unlocks a real reset path
  for demo transitions.
- **Effort**: Medium–Large.

## Medium

### 5. Zero client-side tests
- Server has 88 tests (`bun test`); client has none — all the hot math
  (interpolation Hermite, wake radius, reconciliation tiers) is untested.
- **Effort**: Medium to start (vitest + extract pure fns per #3).

### 6. Dead adapter tree still in `client/src/networking/`
- `.old`/`.deprecated` files (FastAPI/Naia/Colyseus/Tribes2/WS/UWS
  adapters, MoveManager, StreamManager, BitStream, EventManager,
  msgpack-lite.d.ts) — JP's WIP deletes are already staged in git status;
  finishing that cleanup removes ~1,500 lines of confusing parallel
  history from the package.

### 7. CoolShotsPanel `innerHTML` with interpolated fields (line 53)
- Values are numbers/derived strings today; becomes a stored-XSS hole the
  day a demo description or player-chosen name lands in a shot record.
- **Fix**: build with textContent like the scoreboard already does.
- **Effort**: Small.

## Verified clean since last audit
- Hit claims: server-validated (`validateHitClaim` + tracked projectiles).
- `projectileDestroy`: ownership enforced.
- Join handshake: required, typed (`ClientMessage` union member).
- Wire boundary: `send()`/`onMessage` fully typed, no `any` left outside
  `.old` files.
- Per-frame DOM rebuild + 60 Hz position logging removed.
- `playersBeingCreated` dead ceremony removed; respawn timers tracked.
- `shared/weapons.ts` single-sources all gameplay stats.

## Priority order (if continuing)
1. aoeShot→projectile binding (closes the largest remaining cheat)
2. ProjectileRegistry extraction (#2) — unlocks MessageHandler/Projectile splits
3. Projectile.ts split (#3a)
4. WorldState container (#4)
