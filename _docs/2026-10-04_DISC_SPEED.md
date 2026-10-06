# 2026-10-04 — Disc (Spinfusor) Projectile Speeds: KRIBES vs the Tribes Series

Reference for tuning `shared/weaponTable.ts` projectile `speed` values.

## Our value

`weaponTable.ts` — `WeaponType.Disc` and `WeaponType.DiscPull` (belt implosion disc):

- **speed: 80.0 m/s** (both)
- **50% shooter-velocity inheritance** (comment: "before 50% player-velocity
  inheritance"; enforced by `INHERITANCE_MARGIN = 0.6` in `shared/combat.ts`)
- `knockbackForce: 45.0` — strongest launcher shove (rocket=40, MRV=45)

## Series comparison

| Game | Disc speed | Inheritance | Notes |
|---|---|---|---|
| KRIBES | **80 m/s** | 50% | DiscPull belt disc is also 80 |
| Starsiege: Tribes (1998) | ~90 m/s-class | 50% (75% in early builds per community lore) | "Disk Launcher"; exact stock value not cleanly documented — same Torque `dryVelocity` scale family as T2 |
| Tribes 2 (2001) | **90 m/s** | 50% (Classic mod: 75%) | Actual datablock: `LinearProjectileData(DiscProjectile) { dryVelocity = 90; velInheritFactor = 0.5; lifetimeMS = 5000; }` |
| Tribes: Vengeance (2004) | `projectileVelocity = 2600` UU (~26–52 m/s by unit scale) | 50% | Infamously slow disc; competitive **tmod** raised it to 6850 UU (~68 m/s) to restore classic feel |
| Tribes: Ascend (2012) | **78.4 m/s** all fusor variants | 50%, capped at 160 m/s total | Belt Spinfusor Disc (thrown): 76.4 m/s — slightly slower than fired |
| Tribes 3: Rivals (2024) | not officially published; broadly Ascend-tuned (~78-class) | 50% | |

Sources: Tribes Depot / theexiled wikis (Ascend stat cards), TribesNEXT
forum datablock dump (T2), UnCodeX T:V script source (Spinfusor
defaultproperties + tmod overrides).

## Analysis

- Our 80 m/s is **functionally identical to Ascend** (78.4) and ~11% slower
  than the classic T1/T2 disc (90).
- Relative to player speed our disc is *hotter* than classic: T1 skiers
  routinely hit 60–80 m/s; our movement ceiling is lower, so the disc
  outruns everything it would have merely paced in T1.
- Ascend nerfs we did NOT copy: belt-thrown disc was 76.4 vs 78.4 fired —
  ours launches and throws at the same 80.
- T:V is the cautionary tale: halving disc speed (~26 m/s at UE 100 UU/m
  scale) is what made its duels feel floaty; the community fixed it in a
  mod rather than live with it.
- One-line T2 homage: `WeaponType.Disc` speed 80 → 90.
