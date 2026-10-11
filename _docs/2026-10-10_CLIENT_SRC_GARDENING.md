# client/src gentle-gardening plan

**Status 2026-10-10:** deferred. Target is LLM legibility, not human
browsing — filename prefixes already carry the clusters, and the three
`AGENTS.md` Map sections now spell them out. Physical moves below stay
justified only where the cluster is a feature boundary (`shared/bot/`,
`server_bun/bots/`, `room/`, `combat/`); type-grouping moves
(`projectiles/configs/`, `shared/net/`) are off the table.

## Research: what actually helps LLM agents navigate

Web consensus (agent-first design guides, HumanLayer/AGENTS.md best
practices, a 2025 deterministic-anchoring study):

- **`AGENTS.md` is the single highest-leverage artifact** — the only
  file loaded into every session. Keep it <300 lines and high-signal:
  repo map, exact build/test commands, boundaries, hazards. Nested
  files in subdirs with different conventions (nearest-wins) — this
  repo already has root + client + server_bun, which is the right shape.
  Update it when clusters drift; treat it like code.
- **Descriptive filenames > folder depth.** Agents navigate by name
  search, not tree browsing — `botFire` is findable wherever it lives.
  Our `bot*`/`Room*`/`player*` prefixes are already this; the flat dirs
  cost nothing.
- **Feature-first folders beat type-first folders.** Grouping by a real
  boundary (`bots/`, `combat/`) means one `ls` shows the whole feature
  instead of speculative file opens. Grouping by type (`configs/`,
  `utils/` dumps, `net/`) is the same scatter plus an extra hop —
  neutral to negative.
- **Barrel/`index.ts` mazes hurt.** The agent lands on the re-export
  and still has to find the real file; deep nesting multiplies that.
- **Predictability compounds.** The anchoring study found structure
  helps mainly by making navigation reproducible: ~1.6 fewer search
  rounds and roughly half the run-to-run variance in where an agent
  looks — worth real structure, not worth churn for churn's sake.
- **Small files > big files.** Partial reads of multi-thousand-line
  files burn context; a split by responsibility pays off more than
  any folder move.

Sources: developertoolkit.ai agent file-organization guide,
agentpatterns.ai L0→L1, self.md agent-first design, HumanLayer
"Writing a good CLAUDE.md", ACM "Deterministic Anchoring" (2025).

Follow-up to the `game/bots/` move: the remaining flat-file clusters in
`client/src`, grouped so each move is one mechanical sweep — git mv,
import path updates, `tsc --noEmit`, `vitest run`. No behavior changes.

## Precedent

`game/bot*.ts` (7 files: botBrain, botCtf, botFire, botKill, botMatch,
botSenses, bots) → `game/bots/` with `index.ts` as the import surface.
Same recipe applies below: folder named after the cluster, `index.ts`
re-exports, external callers import from the folder — internal imports
drop a `../` level.

## Candidate moves, ordered by impact ÷ risk

### 1. `game/net*.ts` → `game/net/` (exists — trivial)

`netBalls`, `netCrawlers`, `netHandlers`, `netMelee` sit flat while
`game/net/` already holds wire decode (`projectiles.ts`, `world.ts`).
Four files, near-zero blast radius.

### 2. `projectiles/*Config.ts` → `projectiles/configs/` (~18 files)

`armornadeConfig`, `beltConfigs`, `boltConfig`, `bombardConfig`,
`cannonConfig`, `chaingunConfig`, `concConfig`, `discConfig`,
`flakConfig`, `glConfig`, `grenadeConfig`, `healnadeConfig`,
`lightningConfig`, `mortarConfig`, `mrvConfig`, `pistolConfig`,
`plasmaConfig`, `plasmagunConfig`, `proxyConfig`, `railgunConfig`,
`remotergunConfig`, `repairConfig`, `revolverConfig`,
`rocketLauncherConfig`, `satchelConfig`, `shotgunConfig`,
`sprinklerConfig`, `stickyConfig` — leaving `Projectile.ts`,
`projCollide`, `projRemote`, `projStuck`, `sweep`, `types`, `index` at
the top. Import sites are mostly `projectiles/index.ts` itself plus a
few direct config imports; the index barrel hides the move.

### 3. `entities/player*.ts` → `entities/player/` (exists, ~20 files)

`playerAnim`, `playerClipSurgery`, `playerClips`, `playerCollider`,
`playerCtor`, `playerDistal`, `playerEmit`, `playerGibs`, `playerGun`,
`playerImpulse`, `playerLoadout`, `playerMats`, `playerModelLod`,
`playerPose`, `playerRead`, `playerStatus`, `playerUal`, plus
`Player.ts`, `PlayerModel.ts`, `PlayerVisuals.ts` — the folder is the
single biggest file pile in src (~45 files). The already-existing
`entities/player/` subdir becomes the canonical home; caller churn is
wide but purely mechanical (one sed-able import rewrite).

### 4. `game/deploy*.ts` + deployables → `game/deploy/` (4 files)

`deployAdopt`, `deployRockets`, `deployables`, `remoteDeployables`.
Entity-side `entities/Deploy*.ts`/`deploy*.ts` (7 files) could join a
matching `entities/deployables/` in the same sweep.

### 5. `game/flag*.ts` → `game/flags/` (3 files)

`ctfFlags`, `flagFx`, `flagRun`. Small, self-contained.

### 6. `entities/creatures` → `entities/species/` (~15 files)

`Baneling`, `Crawler`, `Gnat`, `Grub`, `Mine`, `Overlord`, `Rakk`,
`Roller`, `Scarab`, `Seeker`, `Snake`, `Strifer`, `Totem`,
`Turretter`, `Tumbleweed` — mirrors `game/species/`. Highest import
churn (species files are imported across `game/`); do last.

### 7. `demo/playback*.ts` → `demo/playback/` (5 files)

`playbackCreatures`, `playbackDeployables`, `playbackMarkers`,
`playbackReconstruction`, `playbackTargets`. Nice-to-have; demo dir is
already cohesive enough to skip.

## `shared/` — strongest cluster in the repo (~50 files)

### 1. `shared/bot*.ts` → `shared/bot/` (~20 files)

`botBrain`, `botClasses`, `botDisposition`, `botEscape`, `botGoals`,
`botGraph`, `botHunt`, `botLines`, `botLoadouts`, `botLos`, `botMoves`,
`botNames`, `botRand`, `botSheep`, `botSkill`, `botSteer`, `botTaunts`,
`botTuning`, `botVec`, `botWeaponHooks` — the single biggest win
available; mirrors `client/src/game/bots/` exactly. Both client and
server import from it, so the barrel matters.

### 2. `shared/creature*.ts` → `shared/creature/` (7 files)

`creatureBaneling`, `creatureCore`, `creatureFlyer`, `creatureRoller`,
`creatureSim`, `creatureSlither`, `creatureTotem`.

### 3. physics/sims → `shared/sim/` (~7 files)

`ballSim`, `ballCollide`, `movement`, `projSim`, `solidWorld`,
`heightfield`, `fieldSurface` — the deterministic-physics layer,
imported by both ends' sims.

### 4. wire layer → `shared/net/` (5 files, optional)

`wire`, `protocol`, `worldModel`, `netchannel`, `stateHash`. Nice
grouping but `worldModel.ts` is referenced constantly — the short path
earns its keep; skip if it feels fussy.

Note: `bun --watch` does NOT hot-reload `shared/` regardless, so a
folder rename costs nothing in dev workflow.

## `server_bun/src` (~77 files)

### 1. `bot*.ts` + `ServerBots`/`superBot` → `bots/` (~10 files)

`botArsenal`, `botBeam`, `botCommand`, `botDrive`, `botMobility`,
`botRoster`, `botRouting`, `botSheep`, `superBot`, `ServerBots`.

### 2. `Room*.ts` + `room*.ts` → `room/` (~13 files)

`Room`, `RoomArena`, `RoomDeployables`, `RoomFlags`, `RoomMoveSim`,
`RoomPickups`, `RoomProjectiles`, `roomEvents`, `roomFactory`,
`roomFlagPlacer`, `roomMatch`, `roomScore`, `roomStructures`,
`roomSwitch`. `Room.ts` is imported everywhere — either it leads the
folder (all imports go `../room/Room.js`) or it stays top-level as the
entry point; leading is more consistent.

### 3. `combat*.ts` + adjudication → `combat/` (~7 files)

`CombatHandler`, `combatAoe`, `combatBlast`, `combatCharge`,
`envClaims`, `hitLedger`, `killFeed` — everything behind the damage
funnel in one place.

### 4. claims/judge → `claims/` (5 files)

`claimLedger`, `moveClaims`, `moveJudge`, `rewind`, `validation` —
the movement-claim adjudication surface.

### 5. transports → `net/` (~7 files)

`ConnectionManager`, `MessageHandler`, `RtcRelay`, `RtcServer`,
`WtServer`, `wire`, `SessionManager`.

### 6. `tick*.ts` → `tick/` (4 files)

`TickLoop`, `tickHelpers`, `tickRecords`, `simClock`.

### Optional / skip

- `server{Attacks,Ops,Parties,Routes}` → `ops/` — a real group but
  server-ops routes are already prefixed; low payoff.
- `BallSim`/`CreatureSim`/`creatureBrain`/`creatureSpawn` → `sim/` —
  Room* sims stay under `room/` anyway; splitting sims across two
  folders is worse than leaving these flat.
- `fleet`/`fleetDir`, `deployTicks`, `mapCatalog`, `spawnPicker`,
  `statusPage`, `weaponstatsPage` — pairs/singles, fine flat.

Caveat: server import churn is wider than client (`Room.ts` reaches
into tests, harness, roomFactory). Do `shared/` first — the barrel
hides most of the rename — then `server_bun/src` per group.

## Not worth it

- `lobby.ts`/`lobbyPanel.ts`, `vgs.ts`/`vgsTree.ts` — pairs are fine flat.
- `demo/demo*.ts` — the prefix IS the folder; splitting further is churn.
- `*.ts.old` files — soft-delete convention, untouched.
- `weapons.ts`, `main.ts`, `*dump.ts` (aodump/posedump/sfxdump/vmdump) —
  dev entrypoints at root, fine where they are.

## Mechanics per move

1. `git mv` the cluster into its folder (keeps history).
2. Barrel: folder `index.ts` re-exports the public surface; keep the
   exported names identical — only paths change.
3. Rewrite imports repo-wide (`grep -l` the old paths first; relative
   `../foo` inside the folder becomes `./foo` — watch for imports
   *between* moved files).
4. Verify: `./node_modules/.bin/tsc --noEmit`, `./node_modules/.bin/vitest run`,
   `npx -y oxlint src`.
5. One commit per folder group — separate topics, don't batch.
