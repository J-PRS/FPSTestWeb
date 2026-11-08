# Tech Debt Audit — 2026-11-08

Full-tree audit run with the repo's own tooling. Every number below names
the command that produced it. Warnings are debt *candidates*, not proven
bugs — verify before deleting anything knip flags.

## Scoreboard

| Area | State | Evidence |
|---|---|---|
| Client vitest | green | `vitest run` — 685 pass, 9 skip, 0 fail |
| Server bun test | 6 watch-gate fails, all on other agents' uncommitted WIP | `bun test` — 1593 pass, 13 skip |
| Client eslint | 0 errors, 244 warnings | `npx eslint src` (client/) |
| oxlint base (all src) | ~1,070 warnings | `npx oxlint client/src server_bun/src shared` |
| oxlint type-aware audit | **broken — crashes** | `.oxlintrc.audit.json` → tsgolint panic |
| jscpd duplication | clean | 2 clones, 0.03% of 148k lines |
| knip dead code | advisory lists below | `npx knip` (client/) |
| dashWatch | red only on 3 dirty WIP files | `bun test tests/dashWatch.test.ts` |
| sizeWatch | green after pins | `bun test tests/sizeWatch.test.ts` |
| Git hygiene | **4,492 unpushed commits**, 50 uncommitted paths | `git log origin/master..HEAD`, `git status` |

## 1. Complexity debt (the biggest pile)

Two linters measure it differently; both agree it's the dominant debt.

> **Campaign progress (same day, later):** ~55 functions extracted to
> ≤15 across ~30 commits; tiers c16/c17/c18 fully cleared, c19-20 mostly
> cleared. Headline offenders retired: `wireIn.binary` 160→0 (dispatch
> table), `SessionManager.handle` 45→orchestrator, `checkStall` 45→5
> helpers, `applyMapSnapshot` 35, `deployTicks` trio, `applyTerrain`
> (also killed its max-params + promise warnings via a `TerrainReq`
> options object). `world.ts` and `deployTicks.ts` are now
> complexity-clean. What remains is the >20 authority core —
> `tryPropel` 90, `pickDest` 77, `roomDemo.onBroadcast` 54,
> `RoomMoveSim.tick` 50, `wireKnockback` 34, `applyMovement` 31,
> `bakeSource` 26 — each needing a focused session with determinism
> proof, not batch extraction. Pattern that worked: move whole comment
> blocks with their code; the lintratchet blames the *whole function*
> on any touched line, so editing a call site inside a monster forces
> its decomposition in the same commit.

- **eslint sonarjs/cognitive-complexity** (client only, cap 15): **212 warnings**
- **oxlint `eslint(complexity)`** (cyclomatic, all src, cap 15): **319 warnings**

Worst cognitive-complexity offenders (`npx eslint src --format json`):

```
160  client/src/networking/wireIn.ts:218      binary wire dispatcher if-chain
 83  client/src/effects/debugPins.ts:221
 82  client/src/entities/PlayerModel.ts:770
 82  client/src/main.ts:617
 68  client/src/game/flagRun.ts:363
 68  client/src/game/net/projectiles.ts:372
 64  client/src/game/gameLoop.ts:346
 63  client/src/core/stateDebug.ts:941
 62  client/src/game/net/players.ts:232
 62  client/src/game/parity.ts:213
```

`wireIn.ts:218` is the headline: ~500 lines of `if (data[1] === WIRE_X)`
branches — every new wire event adds another. A dispatch table
(event byte → handler) collapses it and simplifies adding events.

oxlint's other big buckets (all-src): `max-depth` 94, `no-plusplus` 59,
`no-nested-ternary` 58, `max-params` 56, `max-lines-per-function` 43,
`explicit-module-boundary-types` 35, `import(first)` 35,
`no-rest-spread-properties` 32, `no-unused-vars` 29.

## 2. Dead code (knip, advisory)

`npx knip` in client/:

- **Unused files (6):** `src/demo/demoTables.ts`,
  `src/demo/leaderboardSubmit.ts`, `src/gunstats.ts`, `src/maplab.ts`,
  `src/maplab/gen.ts`, `src/modeldump.ts` — verify entry-point/dynamic
  references before deleting; `maplab/` and `gunlab/` are dev tools that
  may be intentionally standalone.
- **Unused deps (3):** `@three.ez/instanced-mesh`, `xatlas-three`,
  `xatlasjs`; devDep `spectorjs`; unlisted `@stryker-mutator/api/core`.
- **Unused exports (~183):** dominated by `src/core/config.ts` constants
  (ball/creature tuning rows) — many are likely consumed via namespace
  or kept as the tuning surface; treat as review list, not delete list.
- **Unused types (16), namespace members (4), duplicate export (1).**

## 3. Gate/watch state

- **dashWatch** (`tests/dashWatch.test.ts`): committed offenders cleaned
  2026-11-08; still red on `remoteVis.ts`, `game/bots/index.ts`,
  `game/net/nodes.ts` — all have uncommitted WIP, owner should fix.
- **sizeWatch** (`tests/sizeWatch.test.ts`): green; `GameServer.ts` (930),
  `vfx.ts` (906) pinned at breached size, `main.ts` re-pinned at 1450.
  Pins alarm again at +15% — real splits still owed.
- **perks**: `projSpeedCap` bound fixed 2026-11-08.

## 4. Oversized files (wc -l, all src)

```
1817  client/src/game/net/mapAssets.ts
1757  server_bun/src/Room.ts        (oxlint max-lines: >1000)
1718  client/src/entities/PlayerModel.ts
1569  client/src/core/stateDebug.ts
1527  client/src/gunlab.ts
1450  client/src/main.ts
1438  client/src/networking/NetworkManager.ts
1377  shared/botTaunts.ts
1362  client/src/maplab.ts
1295  client/src/game/combat/impact.ts
1265  shared/wire.ts
```

`Room.ts` also trips `max-lines-per-function` (constructor 182 lines,
`handlerInfo` 170) and `max-params` (7 > 6) — the room is the authority's
god-object and the highest-value split candidate.

## 5. Broken tooling

- **Type-aware oxlint audit — FIXED same day**: root cause was path
  resolution, not version skew — oxlint looks for `tsgolint` at
  `<cwd>/node_modules/.bin/tsgolint`, but the toolchain only exists
  under `client/`. `_tools/lintaudit.mjs` now runs the client-installed
  oxlint from the repo root with `OXLINT_TSGOLINT_PATH` pointed at the
  right `.bin` shim; `npm run lint:audit` works end-to-end (~1.7s).
  First real census: **5,621 warnings** — ~3k type-assertion noise
  (mapSpec JSON validation), 837 `no-unnecessary-condition`, **56
  `no-floating-promises`** (transport/demo/debug fire-and-forget),
  **44 `unbound-method`** (sampled: mostly factory-destructure +
  static-class false positives). 11 floating promises fixed
  (`.catch` honesty + `retryBinLane` extraction); the rest are
  judgment calls, not mechanical.
- **`_scratch/` = 29 MB** of session debris; `_tools/e2e/shots` = 65 MB
  (shotwebp sweep handles aging).

## 6. Process debt

- **4,492 commits unpushed** — the local master is the only copy of a
  month of work. Highest-severity item on this list is not code at all.
- **50 uncommitted paths** — mix of other agents' WIP (remoteVis,
  bots/index, nodes, weaponsGeo cluster, ServerBots unstick,
  RemotePlayer revive) and scratch probes. Nothing committed wholesale;
  each needs an owner.
- **13 skipped tests** (server) + **9 skipped** (client) — mostly
  `FPS_SOAK`-gated netbot/sessionFuzz suites that only run with the env
  flag; they rot silently between runs.

## 7. Fixed this session (for the record)

- Dead C4 edge-replay lane removed end-to-end (`2f17566d`, −361 lines) —
  client vitest went 6-fail → fully green.
- hudStats `tick` complexity 40 → split into per-section tickers
  (`9662a69c`, `70951f78`).
- dashWatch/perks/sizeWatch gate repairs (`08c16564`).
- eslint namespace errors resolved (`9eef5499`).
- **wireIn.ts oxlint-clean**: `binary()` 160→dispatch table +
  `message`/`handleGameState`/`drainPendingWidEvents` extractions —
  the repo's worst offender retired (`3f68ea39`, `18199127`).
- **Type-aware lint revived** (`7df87faa`, `9af11f57`, `50b56a2c`).
- **Wire codec fuzzing** (`df351fa0`): 18 codecs × truncation/random/
  bit-flip — caught 3 real decoder holes (OOB reads + NaN/Inf poison).
- **Parity canary** (`d66f12ad`, `96e90aed`): local+prod GLITCH census;
  caught a real `parity-nugrest` divergence → `p.tacc = 0` fix
  (`ff11b833`).
- **~55 complexity extractions** (see §1 progress note): c16-c18 tiers
  cleared; monsters `SessionManager.handle` 45, `checkStall` 45,
  `applyMapSnapshot` 35, `deployTicks` trio, `applyTerrain` retired.

## Suggested order

1. **Push the repo** — 4,492 commits is the only real emergency.
2. ~~`wireIn.ts` dispatch table~~ — DONE (`3f68ea39`).
3. `Room.ts` split (god-object, authority core) — still open; now the
   biggest remaining structural item.
4. ~~Fix tsgolint version skew~~ — DONE differently: path wrapper, not
   version alignment (`7df87faa`).
5. Unused-vars sweep (31 eslint + 29 oxlint, verify against WIP first).
6. knip verification pass → delete genuinely dead files/deps.
7. ~~Top-10 complexity extractions~~ — DONE and then some (~55
   functions; see §1). Remaining >20 tier needs focused sessions:
   `tryPropel` 90, `pickDest` 77, `onBroadcast` 54, `RoomMoveSim.tick`
   50, `wireKnockback` 34, `applyMovement` 31, `bakeSource` 26.
