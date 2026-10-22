# T2 Interiors — Handoff (2026-09-30)

Status: pipeline built end-to-end, terrain/positions verified numerically,
but a live headless verification of in-scene structures is still pending —
the last runs were confounded by stale/orphaned dev processes.

## What works (verified)

- `.dif` → GLB: `_tools/dif2glb.py` + io_dif + Blender 5.2 headless.
  26 unique interiors converted to `maps/t2/dif/*.glb` (gitignored).
  Blender 3.5 fails on a renamed shader input — must use 5.2.
- Map specs carry `interiors` (file, pos{x,y,z}, rot axis-angle, scale{x,y,z})
  — escalade 33, equinox 9, invictus 7, surreal 15.
- Server→client wire confirmed: a bare `bun` ws join to a FRESH server
  (`join {room:'escalade'}`) returns `gameState.map.interiors` = 33 entries.
- `resolveMapSpec` parses interiors (verified: `bun -e` prints 33).
- `/maps/` route serves `.glb` (nested, traversal-safe, CORS *).

## The half-tile bug (FIXED, in t2map.py)

T2's terrain square is centered on world origin; our heightmap UV is
`u = fract(x/1500)`. That's a half-tile (1024m T2 / 750m ours) phase offset.
Terrain + baked albedo shared the offset so they stayed consistent, but
`.mis` placements (bases, interiors, spawns) landed displaced by half a map —
"buildings not on terrain".

Fix: `half_shift()` rolls every grid-derived export by half width on both
axes — terrain.bin, albedo.png (res/2), matmap.bin, alphas.bin. Positions
are unchanged (U→x mapping was already correct). Verified numerically:
tower/bunker pos.y now lands within ~4m of sampled terrain; bridges sit
+24..41m over ravines as expected (origin is deck height, not ground).

## Coordinate facts (hard-won, don't re-derive)

- `.ter` layout is v-major: `raw[v*256+u]`, u16 LE, meters = raw/32.
- World↔grid: u_texel = (U + 1024) / 8; U = world.x / XZ_SCALE (XZ=1500/2048).
- Our world maps T2 (u,v,w-up) → (x=u·XZ, z=v·XZ, y=(w-lo)·125/relief).
- Client interior transform: M = T(pos) · D(scale) · SwapYZ · R(axis-angle) · G
  where G undoes Blender's Y-up export. SwapYZ is a reflection → materials
  forced DoubleSide in `applyInteriors` (client/src/game/net/world.ts:404+).

## Open problem: stale-process trap (PARTIALLY FIXED)

`env.ts upStack()` health-checks the port, not the process — an orphaned
listener (killed npx wrapper leaves the vite/bun child alive on Windows)
passes the check while our spawn dies on EADDRINUSE. Runs kept attaching to
pre-interiors code:

- First run: PID 56800 held :5300 (vite), PID 39952 held :5399 (stale vite).
- After kills: still `mapKeys=mode,bases` from :8478 — signature of OLD
  mapSpec.ts (old parseTerrain dropped depth-2 `t2/...` paths AND had no
  interiors field).

Fixes applied to `_tools/e2e/env.ts`: after waitHttp, `proc.exitCode !== null`
→ treat as ghost-owned port, keep probing. NOT yet verified — the next run
was interrupted before the new guard exercised.

## Diagnostics left in place (revert or keep)

- `world.ts` — `logger.warn('gameState room=... mapKeys=...')` and
  `logger.warn('applyInteriors: list=...')` + `.catch` on the call.
- `browser.ts` — page `response` >=400 logged; console filter now passes
  type 'warn' (puppeteer reports console.warn as 'warn', not 'warning').
- `mapshot.ts` — prints stack ports/URL, unambiguous `groupExists` field,
  and a direct-ws probe of `gameState.map` keys BEFORE the browser launches
  (was mid-run when interrupted — probe also shows whether the spawned
  server or the client is dropping interiors).

## Unexplained residue

Last full run: fresh vite 5399, `connected:true`, but gameState had
`mapKeys=mode,bases` — bases = escalade's own (126.7,68), so the spec parse
kept bases but dropped terrain/terrainTex/sky/interiors — consistent with
PRE-fix shared/mapSpec.ts (old parseTerrain rejected depth-2 paths) OR an
entirely different spec. With the env.ts guard added, re-run and watch the
probe line; if probe shows interiors but client doesn't, the gap is
client-side (unlikely — `data.map` passes through raw).

## Concurrent edits to be aware of

User refactored mid-session: `ModelFx` import was dropped from
PlayerModel.ts (restored — `import { ModelFx } from './modelFx.js'`).
Player.ts split out playerStatus.ts/playerEmit.ts; weaponsGeo split into
weaponKit/weaponsGeoEnergy/weaponsGeoSidearm; gameLoop fx jobs renamed to
named tuples + MAX_LIVE_EXPLOSIONS=48; bots.ts sheepSimMs moved to
per-frame accumulation. If odd runtime errors appear, suspect missing
imports from this refactor wave first (the `ModelFx is not defined`
pageerror was exactly that).

## Next steps

1. `bun _tools/e2e/mapshot.ts escalade` — probe should print
   `interiors: 33`; diag should print `groupExists:true, interiors:33`.
2. Read `_tools/e2e/shots/map_escalade.png` — check buildings sit on
   terrain, rotation chirality (flip axis-angle sign if backwards),
   vertical offset (pos may anchor dif-center not dif-base).
3. Then: kill the debug warns, run gates (tsc, `cd server_bun && bun test`).
4. DIF interiors are VISUAL only — collision is still the simplified
   `structures` boxes. Real BSP collision is a future task.
5. 3 referenced difs are missing from the local install (siege.dif,
   dbunk_nef_invbunk1.dif, dmisc_nefflagstand2.dif) — warned+skipped.
