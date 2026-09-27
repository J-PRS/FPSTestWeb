# Architecture overhaul — plan + running log (2026-09-27)

Commissioned by JP: "If you have any plan to overhaul the project, architecture etc to make everything easier, write it down and do it."

## Diagnosis

The codebase already has the right *shape* — factory modules with injected deps (`createEntities`, `createCombat`, `createGameLoop`), no god-object singleton, clean client/server/shared split. The actual pain is **size concentration inside factories**: a handful of files each mix 3-6 concerns, so any edit scrolls 1000 lines and unrelated changes collide in the working tree.

Line counts (client/src):

| file | lines | mixed concerns |
|---|---|---|
| game/entities.ts | 1113 | species lists, targeting registry, wander/aggro AI, spawn placement, per-species update + AI LOD, nugget lifecycle, remote-player helpers |
| game/combat.ts | 1067 | per-weapon fire handlers (13), projectile spawn, explosion processing, AOE force, self-damage, hit claims to server, gib routing, remote hit application |
| entities/Player.ts | 918 | movement integration, jetpack/ski/dash/blink/slam state, health/damage/respawn, input plumbing, animation hooks |
| entities/ViewModel.ts | 790 | 13 weapon mesh builders, sway/bob/recoil spring sim, muzzle anchor math, baked-mesh swap |
| entities/balls.ts | 779 | shared ball sim client replay, segment consumption, render extrapolation, shard visuals |
| projectiles/Projectile.ts | 732 | per-weapon projectile types, flight, collision vs terrain/balls/players/obstacles, explosion fx |
| ui/hud.ts | 711 | DOM tree, ammo/health widgets, kill feed, damage vignette, scoreboard |
| core/sfx.ts | 706 | whole procedural bank — weapons, movement, enemies, UI, telegraphs |

Secondary issues:

- **Dep-bag getters everywhere** — `deps.player()`, `deps.terrain()`, ... callable indirection exists to break init-order cycles, but it's applied uniformly even where construction order doesn't require laziness. Noise, easy to misuse.
- **netHandlers.ts / gameLoop.ts** are fine structurally but will benefit from the same context object once it exists.
- Server side is healthy (~3.6k lines, 12 focused files). Not touching.

## Plan — executed in slices, each committed separately

Each slice is: extract cohesive block → new file → rewire imports → `tsc --noEmit` + `oxlint` + vitest → commit. No behavior changes.

### Slice 1 — entities.ts split (done → pending)
- `game/targeting.ts` — TargetRegistry, candidate gathering, wander/aggro steering.
- `game/spawning.ts` — ringPos + RANDOM_SPAWNS placement.
- `game/entityUpdate.ts` — updateSpecies LOD loop, updateNuggets, per-species tick order.
- entities.ts keeps list ownership + the returned interface.

### Slice 2 — combat.ts split
- `game/combat/weapons.ts` — the 13 fire handlers + spawnProjectile + FireArgs.
- `game/combat/explosions.ts` — processProjectileExplosion, applyExplosionForce, self-AOE.
- `game/combat/hits.ts` — hit-claim resolution, playerHit/knockback application, gib routing.
- combat.ts re-exports a composed `createCombat` (callers unchanged).

### Slice 3 — Player.ts split
- `entities/player/physics.ts` — jetpack/ski/dash/blink/slam state machine (movement.ts already holds ground math).
- `entities/player/health.ts` — damage intake, death, respawn timing.
- Player.ts becomes the orchestrating facade; public API unchanged.

### Slice 4 — ViewModel.ts split
- `entities/viewmodel/weaponsGeo.ts` — the per-weapon mesh builders (bulk of the file).
- `entities/viewmodel/motion.ts` — sway/bob/recoil/kick springs.
- ViewModel.ts keeps the public facade + baked-GLB swap.

### Slice 5 — sfx.ts split (per family)
- `core/sfx/weapons.ts`, `movement.ts`, `enemies.ts`, `ui.ts`, `telegraph.ts` — one internal bus module they share; `sfx.ts` re-exports the flat API so call sites don't move.

### Slice 6 — hud.ts split
- `ui/hud/dom.ts` (tree + templates), `widgets.ts` (per-widget update fns). hud.ts keeps HUD class shell.

### Slice 7 — GameContext (dep-bag flatten)
- `game/context.ts` — one object carrying refs (`player`, `terrain`, `scene`, ...); fields that genuinely need lazy wiring keep `() => T` but get named `lazy*` so intent is visible. Migrate factories one at a time, lowest-risk first (entities → combat → gameLoop → netHandlers).

### Explicitly NOT in scope
- Rewriting the state model (WorldState is fine).
- Server refactor (already small/focused).
- Behavior changes, perf work, new features — this is pure structure.
- JP's in-flight ballSim/NetworkManager refactor files — avoided until they land.

## Execution log

- Slice 1 (entities): targeting/spawning/entityUpdate extracted.
- Slice 2 (combat): fire handlers → `game/combat/fire.ts`, lightning gun →
  `game/combat/lightning.ts`; shared blast path stays in combat.ts and is
  handed to submodules as a `processExplosion` hook. combat.ts 1067→~640.
- Slice 3 (Player): adapted — jetpack etc. live in `movement.ts` already,
  so extracted the skills state machine (bounce/blink/dash/slam/warp
  beacon) to `entities/player/skills.ts`. Player.ts 918→706.
- Slice 4 (ViewModel): all 13 weapon mesh builders →
  `entities/viewmodel/weaponsGeo.ts` (`buildWeaponMeshes`,
  `buildHandAndFlash`). ViewModel.ts 790→431.
- Slice 5 (sfx): per-family modules in `core/sfx/` (util/beam/weapons/
  player/explosions/world); `sfx.ts` is now a 10-line re-export barrel —
  zero call-site changes.
- Slice 6 (hud): stylesheet + DOM tree + selector wiring →
  `ui/hud/dom.ts` (`createHudDom()` returns the element bag). hud.ts
  711→~450, keeps all behavior/widgets.
- Slice 7 (GameContext): `game/context.ts` defines `GameContext` — the
  shared lazy-getter surface both `CombatDeps` and `EntitiesDeps` now
  extend. All callable dep getters renamed `lazy*` across the codebase
  (`deps.player()` → `deps.lazyPlayer()` etc.) so laziness is visible at
  every call site; eager fields stay plain.

## Post-plan extensions (2026-09-28)

- Projectile.ts: geometry/material caches + mesh/glow/ribbon construction +
  updateMesh → `projectiles/visuals.ts` (732→622).
- hud.ts second cut: player-indicator projection/lifecycle →
  `ui/hud/indicators.ts` (`PlayerIndicators` owns the div map + scratch
  vectors). hud.ts → 362.
- main.ts: the `player.on*` wiring block (combat routes + skill FX) →
  `game/playerHooks.ts` (`wirePlayerHooks(ctx)`). main.ts 537→476 — the
  composition root now reads as construction order.
- Left alone deliberately: entities/balls.ts (JP's in-flight ballSim
  refactor), entities.ts's remaining 737 lines (a uniform per-species
  registry — further splitting would scatter it, not clarify it).
