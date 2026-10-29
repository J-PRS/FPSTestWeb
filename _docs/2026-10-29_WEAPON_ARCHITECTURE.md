# 2026-10-29 — Weapon Architecture State

What the weapon system looks like after the Blaster/HealBeam additions and
the registration-consolidation pass: where truth lives, what the two ammo
economies cost, what actually broke, and the checklist for the next weapon.

## The layers (and who owns what)

| Layer | File(s) | Owns |
|---|---|---|
| Wire law | `shared/weaponTable.ts` (enum + WeaponStats), `shared/weaponRows.ts` | Damage, ballistics, marker flags — the single source both ends validate against |
| Derived sets | `shared/weapons.ts` | `SERVER_SIMMED_WEAPONS` (all WEAPONS keys), `BELT_THROW_WEAPONS`, `SIDEARM_WEAPONS`, `WEAPON_FIRE_INTERVAL_S` (explicit table + `..._autoFireIntervals` spread), `payShotCost`, `scaledDirectDamage`, `directHitAoeBonus` |
| Server authority | `server_bun/src/CombatHandler.ts` (`handleShotFired`), `RoomProjectiles` | Intent → authoritative shell: dedupe, class lock, flood, cadence, belt charge, `payShotCost`, spawn |
| Bot fire | `server_bun/src/botArsenal.ts`, `ServerBots` | Bots bypass `handleShotFired` — spawn via `room.projectiles.spawn`; gates duplicated through shared helpers |
| Client prediction | `client/src/game/combat/fire.ts` | `fireWeapon` dispatch by def kind; `payShotCost` keeps the predicted bill identical to the server's |
| Slot registry | `client/src/weapons.ts` (`SLOT_DEFS`) | wid space — index IS identity; `def()` derives rate from `fireInterval`, sidearm from the marker |
| Presentation | `client/src/entities/viewmodel/weaponVisual.ts` + `weaponsGeo*` + `sfx/weapons.ts` | muzzleZ/recoil/flash in one row; geometry builders; sound layers |
| Loadout | `client/src/entities/playerLoadout.ts` (`SIDEARM` table → `SidearmId`), `ui/loadoutMenu.ts` (derives options) | Human picks |

Counts (provenance: `grep "= \d+," shared/weaponTable.ts`, `grep "def(WeaponType" client/src/weapons.ts`):
- **42 wire weapon types** (enum 0–41).
- **23 slot defs** (wids 0–22) — primaries + sidearms + HealBeam.
- **6 sidearms**: pistol, revolver, shotgun, repair, lance, blaster.
- ~16 belt throws (marker-derived `BELT_THROW_WEAPONS` + legacy fallback list).

## The two ammo economies

**Belt charges** (`beltCharges`, `BELT_THROW_COST`, `beltThrowCost`): nugget
pool shared by all throws + pack deploys. Server debits in the intent gate;
client gates on the same cost. `SatchelCharge` costs 2 via the override map.

**Jet energy** (`WeaponStats.energyCost` → `payShotCost`): introduced with
Blaster (10/shot). One shared formula — `payShotCost(wt, id, energyOf, drainEnergy)`
— called by the server intent gate, both `botArsenal` branches, and client
prediction. HealBeam predates it but uses the same `energyOf`/`drainEnergy`
deps with its own `HEALBEAM_ENERGY` constant (beam tick, not per-shot —
different shape, intentionally not folded in).

## Today's commits

- `9862dd1a` — Blaster sidearm (wt 41, wid 21): 35 dmg, 10 energy/pull, 0.3s cadence.
- `302ad04d` — registration consolidation: `sidearm` marker → derived sets,
  `SIDEARM` table → `SidearmId`, `weaponVisual.ts`, `def()` rate from row.
- `1ce008fc` — `payShotCost` shared ammo gate (3 callers, one formula).
- `10c35152` — HealBeam (wt 30, wid 22): teammate heal, 6 energy/tick
  (another agent's work, same window).
- Uncommitted fix in flight: `SIDEARM.blaster.wid` hardcoded 23 → equipped
  HealBeam; now derives via `widOf(WeaponType.Blaster)` = 21.

## The bug the exercise caught

`SIDEARM_WIDS` hardcoded slot indices. HealBeam appended to `SLOT_DEFS`
during the same session and `blaster: 23` silently pointed at it — menu
pick "Blaster" would have equipped the heal beam. Fix: `widOf(wt)` derives
all six wids from `SLOT_DEFS`; nothing hardcodes a slot index anymore.
Provenance: `grep "def(WeaponType" client/src/weapons.ts` → 23 defs,
`Blaster` at position 21.

## Remaining seams (ranked)

1. **`handleShotFired` if-ladder** — Repair, HealBeam, belt, energy, cadence,
   lance, spawn. `BEAM_INTENT_WEAPONS` half-tables it. A per-weapon
   intent-handler registry pays off at ~8+ special branches; at 4 it's
   premature. Revisit when a third beam lands.
2. **Generic `SHOT_COST` row field** — `{belt: n, energy: n}` → one debit
   path. Right move *when a third ammo type lands*; today it serves two.
3. **`botSkill.weaponAxis`** — unlisted weapons get neutral 1× (safe), but
   nothing warns. A `default:` log or stats-derived default is cosmetic.
4. **`WILDCARD_SLOTS` near/mid/far bands** — tuned role picks, not stat-
   derivable. Correct as-is.
5. **wid vs weaponType dual space** — inherent and documented; `widOf`/
   `weaponDef` are the bridge. A rename pass is pure churn.
6. **SFX stays its own registry** — `[sound, vol, rate, filter, delay]`
   layers are already one table; moving into `weaponVisual` relocates
   without gaining anything.

## Adding a weapon now

1. `shared/weaponTable.ts` — enum id (never reuse) + any new marker field.
2. `shared/weaponRows.ts` — stats row (`fireInterval`, `sidearm`, `energyCost`, `beltThrow` markers).
3. `client/src/projectiles/<x>Config.ts` + barrel line in `index.ts`.
4. `client/src/weapons.ts` — one `def()` (rate derives from the row).
5. `weaponVisual.ts` — one row (muzzleZ + recoil + flash).
6. Geometry builder in `weaponsGeo*.ts` + `MODEL_BUILDERS` (else generic prop).
7. `sfx/weapons.ts` — sound layers.
8. Sidearm only: one `SIDEARM` entry — menu/keys/pool/type all derive.
9. New *mechanic* (not a stat): own it in the shared gate, the bot path, and client prediction — `payShotCost` is the pattern.

Standard weapon: ~4-6 files. A new ammo type still costs its own gate work —
that's the irreducible part.

## Gates (this pass)

- `cd client && node_modules/.bin/tsc --noEmit` — clean.
- `cd server_bun && bunx tsc --noEmit` — clean.
- `cd server_bun && bun test` — exit 0.
- `cd client && npx vitest run src/__tests__/weaponTables.test.ts` — 8/8.
- `bun test tests/scenarios/shotFired.test.ts` — 5/5.
