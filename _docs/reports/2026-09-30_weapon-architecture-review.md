# Weapon system architecture review — 2026-09-30

## Current shape

- `shared/weapons.ts` — WeaponType enum (wire u8) + `WEAPONS` stats table. Single source of truth for damage/ballistics; server validation (`validateHitClaim`/`validateAoeClaim`/`checkFlightLegality`) and client configs both derive from it. **This is the good part — keep it.**
- `client/src/projectiles/*Config.ts` — render/ballistics per weapon (`ProjectileConfig`), collected into `WEAPON_CONFIGS` (find-by-weaponType) and `SLOT_WEAPONS` (positional = slot order).
- `Player.ts` — `WEAPON_RATES` (positional fire rates), `widToWeaponType` (slot index → wire enum), `loadout[4]` of slot ids, `onFire/onDisc/...` per-weapon callback fields, positional fire-callback table.
- `fire.ts` — `createFire` returns ~16 handlers, nearly all `kick(x); spawnProjectile(CONFIG)`.
- `ViewModel.ts` + `viewmodel/weaponsGeo.ts` — geo map keyed by WeaponType, `MUZZLE_Z` + `KICK_TUNE` keyed by WeaponType.
- `core/sfx/weapons.ts` + `explosions.ts` — shot/boom maps keyed by WeaponType.
- Belt items: `BELT_ITEMS` ids → `BELT_THROWS` config map (good pattern — declarative).

## The core problem: two parallel ID spaces + scattered per-weapon tables

Every weapon lives in **two namespaces** that must be hand-kept in lockstep:

| Space | Meaning | Tables that must stay aligned |
|---|---|---|
| `wid` | loadout slot index (position in WEAPON_RATES / SLOT_WEAPONS / fire-table) | WEAPON_RATES, fire-callback table, SLOT_WEAPONS, widToWeaponType |
| `WeaponType` | wire/demo/server enum | WEAPONS, WEAPON_CONFIGS, viewmodel geo map, MUZZLE_Z, KICK_TUNE, SHOT_SAMPLES/LAYERS, BOOM_SAMPLES |

Adding a weapon today touches **7+ files/arrays**, and several are positional — order is the contract, and nothing enforces it. This already shipped two real bugs this week:

- **Sticky launcher (wid 14)** had a rate + slot entry but no fire-callback entry → silently fell back to `onFire` and shot rockets.
- **blastForce.ts** indexed `WEAPON_CONFIGS[weaponType]` positionally past the alignment point → wrong visuals.

Both are the same failure class: *implicit positional coupling*. The enum can't be compacted either — `Grenade=2`, `Slam=8`, `Melee=10` are wire-stable ids forever.

## Best-practice target: one declarative weapon registry

Industry pattern for this (Quake `bg_` weapon tables, Source `WeaponData`, and every modern ECS shooter): a single `Record<WeaponType, WeaponDef>` where the def carries everything that currently lives in scattered maps:

```ts
interface WeaponDef {
  weaponType: WeaponType;
  name: string;                 // HUD/menu label
  rate: number;                 // fire cadence (today: WEAPON_RATES)
  config?: ProjectileConfig;    // present ⇒ kind 'projectile'
  kind: 'projectile' | 'hitscan' | 'melee' | 'belt';
  kick: number;                 // viewmodel kick strength
  muzzleZ: number;
  geo?: WeaponType /* geo group key */;  // or geo factory
  burst?: { delay: number; range: number }; // rayBurst promotion
  slot?: number;                // default loadout slot (or unslotted = belt/hold-out class)
}
```

Then everything positional becomes derived:

- `WEAPON_RATES` = `SLOTTED.map(d => d.rate)`
- `widToWeaponType` = `SLOTTED[wid].weaponType` — impossible to desync
- fire dispatch = `switch (def.kind)` — projectile weapons need no per-weapon handler at all (kick + spawnProjectile are data, not code). Only melee/LG/belt remain special-cased, and they already are conceptually different kinds.
- Loadout menu iterates `SLOTTED`; HUD icon/name come from the def.
- `WEAPON_CONFIGS` stays for render lookups (it's already find-by-id, correct), but gets *built* from the registry rather than hand-listed.

Net effect: adding a weapon = one def entry + one geo + (optional) sfx voices. Dropping/renaming a weapon = delete the entry; the type system forces every consumer to acknowledge it because the enum is the key, not a position.

## Secondary observations

- **Fire-callback fallback is dangerous.** `[table][wid] ?? this.onFire` means any table/ordering drift fires a rocket. A registry removes the table entirely.
- **fire.ts `spawnProjectile` is doing too much** (sfx + spawn + tracking + demo record + network + now rayBurst FX). Fine for now, but as weapon kinds grow (beam, lobbed, burst, channeled) it wants a `spawn(e, def)` dispatcher keyed on `kind` rather than more flags.
- **Belt vs weapon vs skill** is actually clean — `BELT_ITEMS`/`BELT_THROWS` is the right declarative pattern; the weapon side should copy it.
- **Server never needs wid.** Loadout is client-only state today. If bots/inventory go server-authoritative later, put the registry in `shared/` with a `render` sub-object the server ignores — stats already live there, so it's a small move.
- **Ray-burst proved the right extension pattern** (config flag → generic behavior in `updateAlive`). Cluster, sticks, bounces, armTime, rayBurst are all data-driven lifecycle hooks now; next weapons (beam-charge, bouncing betty, detcord) should extend that list rather than new classes.

## Recommendation

Do the registry consolidation **before** adding more weapons — every future weapon pays the 7-file tax otherwise, and wid↔enum desync is the class of bug that keeps biting. Estimated scope: one focused session. The refactor is mechanical: build `weaponDefs.ts`, derive the 4 positional tables, delete `widToWeaponType`, replace the fire-callback table with `kind` dispatch, fold `MUZZLE_Z`/`KICK_TUNE`/`SHOT_*`/`BOOM_SAMPLES` lookups to read `def` fields.
