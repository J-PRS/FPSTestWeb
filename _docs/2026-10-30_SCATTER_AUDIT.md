# Scatter audit — per-kind tables spread across files

> Audit 2026-10-30. Same lens as the weapon consolidation
> (`2026-10-30_WEAPON_REGISTRATION_PLAN.md`): how many files does adding
> ONE new member of a kind touch? Ranked by cleanup value.

## Verdict table

| Domain | Files/new member | Derived pattern? | Severity |
|---|---|---|---|
| Species | ~8-10 | Half (shared/species.ts + SWARM_SPECS; plumbing literal) | **High** |
| Deployables | ~9-11 | Stats yes; ctor/adopt/tick chains no | **High** |
| Bot weapon/role tables | 3-5 literal tables | Partial | **High** — silent degrade |
| Game modes | ~10 `===` sites | None | Medium (rare adds) |
| Belt items | ~4-5 | Partial | Medium |
| Settings toggles | 3 | Partial | Low-med |
| Skills | 3 | Partial | Low-med |
| VFX recipes | 1 field / 1 branch | Yes | Low |
| Perks | 1 row | Yes | Low — the model domain |
| Keybinds | 1 row | Yes | Low |
| Maps | 1 file | Yes | Low — the target state |

## HIGH: species (~8-10 files/species)

Consolidated half: `shared/species.ts` is a proper Type-Object registry —
one row `{family, speed, health, bite, ...}`, family sims read it. Its
own header says "one row here + a parts entry in SWARM_SPECS".

Scattered half (client):

- `entities/<Species>.ts` — entity class + parts (real work, unavoidable)
- `game/species/registry.ts:26` — `SWARM_SPECS` (the intended registry)
- `game/species/{melee,flyers,siege,ambient}.ts` — hand-written
  per-species arrays + `spawn<Species>` + `capFor('<name>', MAX)` x4+ sites
- `core/config.ts` — `<NAME>_MAX` caps live here, NOT in the row/specs
- `game/entities.ts` — destructure list (L494), ctx type, return-object
  list, per-species exports + gateC wraps — ~4 edits
- `game/netCrawlers.ts` — `speciesOf()` instanceof chain (L36), hitClaim
  assignments x8, SPECIES table (L86) — the pre-consolidation smell
- `demo/types.ts:124` — `DEMO_SPECIES` "Ordered to match" — manual sync
- `demoLifecycle.ts:591`, `gameLoop.ts:253` — `{list, species}` pairs,
  alive counts

**Fix shape:** everything derives `SWARM_SPECS`/`shared/species.ts` key
order — entity lists, DEMO_SPECIES, alive counts, caps folded into the
row. The instanceof chain becomes `spec.classOf` or a marker.

## HIGH: deployables (~9-11 files/kind)

Done: `shared/deployItems.ts` is the single stat table;
`shared/deployables.ts` DERIVES `DEPLOY_KINDS`/`PACK_KINDS`/`DEPLOY_MAX`/
`DEPLOY_HP`. Client `DEPLOY_DEFS` derives. The stats layer is the model.

Scattered: **~5 parallel if-chains in `game/deployables.ts` alone** —
`Pod` interface fields, `throwPod` ctor chain, `updatePod` flying/seated
chains, `attach` adopter dispatch, `plantFor` ctor chain, kind tinting.
Plus `deployAdopt.ts` (new adopt method + hardcoded sfx type), a
`remoteDeployables.ts` spawn chain + base-asset geometry chain,
`RoomDeployables.ts`/`deployTicks.ts` tick chains + arm-delay chain,
`demo/types.ts:166` DEMO_DEPLOY_KINDS manual-sync, `mapSpec.ts:324`
AUTHORED set, `botDisposition.ts` + `bots/index.ts:743` plant whitelist.

**Fix shape:** one registry entry per kind — `{ctor, adopt, tick,
remoteCtor}` — collapsing sites 3-6. (Also found: `beacon` appears
twice in `attach`, second branch is dead code — parallel-chain rot in
the wild.)

## HIGH: bot weapon/role tables (silent degrade)

- `shared/botSkill.ts` `weaponAxis()` — `case WeaponType.X` chains for
  aim axis (snap/track/arcLead/arcJudge). **New weapon → falls to `null`
  → perfect aim, silently.** Marker candidate: `aimAxis` on the row.
- `shared/botLoadouts.ts` — `BOT_ALT_SLOTS` is an index-synced parallel
  array to `BOT_LOADOUTS` (fragile); `WILDCARD_SLOTS` literal pools —
  `belt`/`side` pools could derive from `beltThrow`/`sidearm` markers.
- `server_bun/botRoster.ts` — `slowFar`/`closeNear` weapon Sets, per-role
  injects — weapon sets could be markers; role surgery stays bespoke.
- `shared/flagGoals.ts` — `STRICT_CLASS`/`CLASS_FITNESS`/`ROLE_PRIORITY`/
  `WIRE_ROLES` per-role tables — a new role is ~5 tables.

## MEDIUM: game modes (~10 `mode === 'x'` sites)

Modes are free strings branched at `mapSpec.modesOf`, lobby + lobbyPanel
lists, roomFactory default, Room/roomScore chains, botRouting/
serverSenses, scoreboard sets, main.ts x3. Fix shape: mode descriptor
table `{id, teams, flags, scoring, botRoles, hudBits}` — low urgency
since modes are added yearly, not monthly.

## MEDIUM: belt items (~4-5 files)

`BELT_ITEMS`/`BELT_THROWS`/`BELT_THROW_TIME`/`BELT_LABELS` (loadoutMenu —
duplicates names already in configs) + bot pools. Derivable from markers.

## LOW — already consolidated (leave alone)

- **Perks** — `shared/perks.ts` one row + `perkMods()`; UI derives.
  THE model domain.
- **Maps** — `server_bun/mapCatalog.ts` scans `maps/*.json`; client
  fetches `/maps`. THE target state.
- **Keybinds** — `BIND_DEFS` one table; actions queried semantically.
- **VFX recipes** — `vfx: 'recipe'` marker on the config already.
- **Settings** — 3 sites/toggle; `DEFAULTS` + Schema row + button is
  acceptable until the Schema can self-render the button row.

## Cleanup order

1. **Species plumbing** — derive list/cap/demo/count wiring from
   `SWARM_SPECS` + `shared/species.ts` key order; fold `*_MAX` into rows.
2. **Deployable registry** — `{ctor, adopt, tick, remoteCtor}` per kind,
   one site each side; kills the 5 parallel chains + the dead beacon.
3. **`aimAxis` + belt/side pool markers** — fixes the silent-perfect-aim
   failure mode; pools derive from `beltThrow`/`sidearm`.
4. Mode descriptor table — only when the next mode actually lands.

## Rules that held up in the weapon pass (reuse them)

- Marker fields on the existing stat row; sets derive by scanning —
  never a second literal table.
- Membership must be byte-identical before/after; the net-parity and
  snapshot pins will catch drift.
- Aliases over copies (`sfxKey`/`vmKey`, the `weapons.set(Implodisc,
  get(Disc))` convention already in weaponsGeo).
- One registry site; fallback-by-default on lookup miss (`weaponDef`
  convention) so a forgotten registration can't crash a menu.

## Shipped (after the audit)

- **`aimAxis` marker** (`c5b8c6d1`) — `weaponAxis()` reads the stat row;
  the 30-member switch is gone and unlisted weapons no longer get
  silent perfect aim. Rocket (44) tagged `arcLead`.
- **Species kills 1** (`6c060253`) — `readonly species` field per entity
  class replaces the `speciesOf()` instanceof chain; `DEMO_SPECIES` now
  derives from `SPECIES` key order (wire-stable — do not reorder shipped
  rows).
- **Open species work**: `netCrawlers` SPECIES table (ctx list wiring),
  `entities.ts` destructure/exports, `capFor` `*_MAX` defaults into
  `SpeciesRow`, `gameLoop`/`demoLifecycle` pairs — bespoke plumbing,
  lower value per edit.
- **Open**: deployable ctor/adopt/tick registry, `BOT_ALT_SLOTS`
  index-sync, belt/sidearm pool derivation, mode descriptor table.
- **`f12f62fb`** — `alts` moved onto `BotLoadout` rows; `BOT_ALT_SLOTS`
  is now a derived alias (index-parallel literal removed).
- **`450339c3`** — deployable `SEATED` registry: one {make,adopt} row
  per bolted-down kit; 5 parallel chains + 2 dead beacon branches dead.
- DEMO_DEPLOY_KINDS derived from DEPLOY_KINDS (order was already exact).
- **Remaining**: remoteDeployables spawn chain + server tick chains,
  capFor *_MAX into SpeciesRow, mode descriptor table.
- **`4455e48f`/`d39b0188`** — REMOTE_SPEC + TICK_SPEC registries: remote
  spawn chain (6 generic kinds) and the server's 9-branch tick chain
  both became one-row-per-kind tables. Adding a bolted-down deployable
  = deployItems row + SEATED row + REMOTE_SPEC row + TICK_SPEC row +
  entity class (was ~9-11 scattered edits).
- **`68b00769`** — species alive caps on `SWARM_SPECS[].max`; capFor
  reads it; 14 *_MAX constants deleted from config.ts.
- **`9810f8e0`** — `WIRE_SPECIES` registry: {Klass,ctxKey,state} drives
  the netCrawlers spawn table, hitClaim loop, and playback pairs.
- **Left deliberately**: entities.ts destructure/exports + NetCrawlersCtx
  fields (types must exist anyway; bespoke plumbing, low value-per-edit);
  adopt-methods internals (genuinely different bodies); mode descriptor
  table (~10 sites, rare adds); botDisposition plant whitelist is a
  deliberate subset, not duplication.
