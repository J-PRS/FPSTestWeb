# Weapon registration consolidation plan

> Status 2026-10-30: steps 1-5 + registration-site dedup shipped (see
> bottom). Trigger: adding the
> universal Rocket Launcher (wid appended, WeaponType 44) required ~14
> file edits for "bolt launcher minus gravity". This doc is the cleanup
> plan. Companion: `2026-10-29_WEAPON_ARCHITECTURE.md` (system state).

## Problem: the blast radius

A new weapon today touches, in order:

| # | File | What it holds |
|---|------|---------------|
| 1 | `shared/weaponTable.ts` | `WeaponType` enum entry |
| 2 | `shared/weaponRows.ts` | `WEAPONS[type]` stat row |
| 3 | `shared/weapons.ts` | `GIB_WEAPONS`, `AIRTIME_SCALED`, `directHitAoeBonus`, `WEAPON_FIRE_INTERVAL_S` — 4 hand-maintained tables |
| 4 | `shared/botClasses.ts` | `HEAVY/MEDIUM/LIGHT_ONLY_WEAPONS` tier sets |
| 5 | `shared/botLoadouts.ts` + `botSkill.ts` | bot loadout pools, aim-style `case` |
| 6 | `client/src/weapons.ts` | `SLOT_DEFS` def line + fire-rate import |
| 7 | `client/src/projectiles/<w>Config.ts` | ~60-80 field `ProjectileConfig` — biggest per-weapon blob |
| 8 | `client/src/projectiles/index.ts` | import + export + `WEAPON_CONFIGS` entry — 3 edits for 1 registration |
| 9 | `client/src/entities/viewmodel/weaponsGeo.ts` | viewmodel mesh map |
| 10 | `client/src/entities/viewmodel/weaponVisual.ts` | muzzleZ/recoil/flash row |
| 11 | `client/src/core/sfx/weapons.ts` | 3 tables (layered samples, SHOT_SAMPLES, SYNTH_SHOTS) + `layerJitter` special-cases |
| 12 | `client/src/core/sfx/explosions.ts` | explosion sfx row |
| 13 | `client/src/entities/ViewModel.ts` | per-type anim special-cases (crossbow/drum fakes) |
| 14 | `client/src/entities/playerLoadout.ts` | tier-locked wid lists (SLOT indices, comments) |

Observed cost of the type-44 addition (verified live): enum + row +
config + 11 wiring edits. Most of those edits are the same sentence
written in different files: "this gun is like the bolt launcher."

## The codebase already solved this once

`beltThrow` and `fireInterval` are **marker fields on `WeaponStats`**;
`BELT_THROW_WEAPONS` and `_autoFireIntervals` are **derived by scanning
`WEAPONS`** — the row is the single declaration, every set is generated:

```ts
export const BELT_THROW_WEAPONS = new Set<number>([
  ...Object.entries(WEAPONS)
    .filter(([, w]) => w.beltThrow === true)
    .map(([wt]) => Number(wt)),
]);
```

The fix is to graduate the remaining classification tables to the same
scheme — not to invent a new one.

## Plan

### 1. Marker fields on `WeaponStats` for every classification set

Add to `WeaponStats` (`shared/weaponTable.ts`):

```ts
/** Marker fields — derived sets in weapons.ts scan these; a new weapon
 *  declares itself entirely in its row. */
tier?: 'light' | 'medium' | 'heavy';  // class lock (exact-class for medium — see botClasses)
gib?: boolean;         // direct kill bursts the body (GIB_WEAPONS)
airtimeScale?: boolean; // direct damage × min(CAP, 1+airtime) (AIRTIME_SCALED)
aoeBonus?: boolean;    // directHitAoeBonus ×1.5 club
sfxKey?: string;       // sound/visual family alias (§4) — default = weaponType
```

Then `shared/weapons.ts` replaces the literal Sets:

```ts
export const GIB_WEAPONS = derive(w => w.gib);
export const AIRTIME_SCALED = derive(w => w.airtimeScale);
export const directHitAoeBonus = (t) =>
  WEAPONS[t]?.aoeBonus ? DIRECT_HIT_AOE_BONUS : 1;
```

Tier sets in `botClasses.ts` derive the same way (`tier === 'heavy'` →
`HEAVY_ONLY_WEAPONS`). `playerLoadout.HEAVY_ONLY` already reads wid
indices — it must stay a **post-`SLOT_DEFS` derivation** (it maps
weaponType → wid via `widOf()`), not a literal `[3,6,11,18,19,24]` —
that's exactly the stale-index class of bug the comment there already
warns about. Deriving it from markers + `widOf` removes both the
hardcoded wids AND the hand-synced comments.

`WEAPON_FIRE_INTERVAL_S` keeps its explicit rows for any gun whose
cadence ISN'T the `fireInterval` row marker — the `..._autoFireIntervals`
spread already merges; move remaining literals to `fireInterval` markers
in the rows and the whole table becomes derived.

### 2. One registration site instead of two files

Today a gun registers in `index.ts` (import/export/array) AND
`weapons.ts` (import/def). Options, smallest first:

- `SLOT_DEFS` generated from `WEAPON_CONFIGS`: configs get an optional
  `slot?: { rate: number; zoomFov?: number; auto?: boolean; sidearm?: boolean; pellets?... }`
  field; `SLOT_DEFS = WEAPON_CONFIGS.filter(c => c.slot).toSorted(append order)`.
  **wid must stay append-only** — the slot index is wire identity, so
  the sort key needs an explicit `slotOrder` counter or the array's
  literal order stays the authority. Safer variant: keep the `def()`
  list in weapons.ts (it IS the order) but read `config` from
  `WEAPON_CONFIGS` by weaponType — kills the index.ts triple-edit.
- Or: `def()` scans `WEAPON_CONFIGS` — `def(WeaponType.RocketLauncher, BOLT_FIRE_RATE, 1)`
  with no config arg; the config lookup is by `weaponType`.

Either way: index.ts becomes pure re-export plumbing, one place.

### 3. Preset-recipe `ProjectileConfig`s

The 60-80 field configs are ~90% family boilerplate: the bolt recipe,
the 80 m/s gravity-arc family (cannon/gonne/basilisk already copy each
other), the belt throws, the plasma family. `rocketConfig.ts` (the
type-44 addition) is `boltConfig.ts` with 5 fields changed — proof.

Provide factories, not inheritance:

```ts
export const mkBoltFamily = (over: Partial<ProjectileConfig>): ProjectileConfig =>
  Object.assign({}, BOLT_BASE, over);
export const mkArc80 = (over: Partial<ProjectileConfig>): ProjectileConfig =>
  Object.assign({}, ARC80_BASE, over);
```

- Presets for the **3-4 real families** (bolt, arc80, belt-throw,
  plasma); oddballs (sprinkler, lightning, MRV) stay free-form full
  rows. Do NOT build a config class hierarchy.
- Migrating existing configs to factories is its own diff; new weapons
  use factories immediately.

### 4. sfx/viewmodel: a key, not N tables

`sfxKey` on the row (or a `soundFamily` on the ProjectileConfig) aliases
all presentation maps: `SHOT_SAMPLES[type] = SHOT_SAMPLES[sfxKey ?? type]`
shape — i.e., lookups go `SHOTS[sfxKeyOf(type)]`, so a new gun inherits
the bolt sound by writing `sfxKey: 'bolt'` once, instead of copying
entries into layered/samples/synth + the `layerJitter` branch +
explosion table + viewmodel geo + weaponVisual row.

Same for viewmodel: `vm: 'bolt' | 'rpg' | 'mortar' | ...` →
`weaponsGeo`/`weaponVisual`/`ViewModel` special-cases read the family
key, so `RocketLauncher → 'bolt'` is one field, not four file edits.

### What stays

- `Record<WeaponType, WeaponStats>` + derived sets — the right shape.
  No Weapon classes, no methods-on-data; client prediction and server
  authority read identical rows and can't drift. That is the feature
  this design protects.
- `SLOT_DEFS` append-only — wid is wire identity.
- Per-family sfx/visual maps — they just get a family key.

## Migration order (each commit independently green)

1. `tier`/`gib`/`airtimeScale`/`aoeBonus` markers + derived sets;
   delete the 4 literal tables. Pure mechanical, test-pinned.
2. `playerLoadout` tier-wid derivation via `widOf` (removes hardcoded
   `[3,6,11,18,19,24]`).
3. `fireInterval` migration of the remaining `WEAPON_FIRE_INTERVAL_S`
   literals into rows.
4. `sfxKey`/`vm` family indirection (aliasing layer first, then dedupe).
5. Config factories for bolt + arc80 families; new weapons only.
6. Single registration site (config-by-type lookup in `def()`).

## Risks / rules

- **Grep-ability:** derived sets hide membership — keep marker names
  boring (`gib`, `tier`, `fireInterval`) and ALL derivation in
  `weapons.ts` so `grep "tier"` still lands the table.
- **Don't over-abstract configs:** factories for families with ≥3
  members only; a one-off preset is worse than a clear full row.
- **Test pins exist:** net-parity tests replay weapon behavior — the
  derived sets must produce byte-identical membership or the pins fire.
  Verify by snapshotting each derived set before/after (assert
  `new Set([...oldLiteral])` deep-equals the scan on commit-1).
- **Don't break wid order** — every SLOT_DEFS refactor keeps the
  literal array order as the authority.

## Target blast radius after

New weapon = **enum line + stat row (markers inline) + ≤15-line config
via family factory + one `def()` line**. From ~14 files to ~4, and the
row says "like a bolt but flat" once, in one place.

## Shipped (commits e80dc237..)

- **Markers live on `WeaponStats`**: `tier` (light/medium = exact-class,
  heavy = floor), `gib`, `airtimeScale`, `aoeBonus`, `fireInterval`,
  `sfxKey`, `vmKey` (presentation family aliases, resolved via
  `sfxTypeOf`/`vmTypeOf` in shared/weapons.ts).
- **Derived everywhere it was literal**: GIB_WEAPONS, AIRTIME_SCALED,
  directHitAoeBonus, tier sets in botClasses, playerLoadout tier wids
  (now `widOf`-derived — no more hardcoded `[3,6,11,18,19,24]`),
  WEAPON_FIRE_INTERVAL_S (all literals except LANCE_CADENCE_S migrated).
- **Registration**: `SLOT_DEFS.def()` resolves config by weaponType from
  `WEAPON_CONFIGS` — index.ts is the single registry; weapons.ts has
  zero config imports.
- **Factory**: `mkBoltLike(type, overrides)` in boltConfig.ts — the
  rocket (44) is a ~20-line config instead of a 67-line copy.
- **Split**: weaponRows.ts → A+B (Object.assign on export) at the
  900-line sizeWatch ceiling; append new rows in B.
- **Open**: arc80/belt-throw config factories (migrate on next weapon of
  that family); botLoadouts pools are still literal type lists.
