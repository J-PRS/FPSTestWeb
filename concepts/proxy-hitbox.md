# Proxy hitbox — the growing wake

Two concentric hit thresholds per projectile:

1. **Core** — `targetRadius + bodyRadius`. The real collision.
2. **Wake** — `targetRadius + hitRadius(t)`, where `hitRadius` grows from
   `hitMin` to `hitMax` over `hitGrow` seconds (per-weapon, in
   `shared/weapons.ts`).

The wake is a **forgiveness layer**: a near-miss that grazes a target's
airspace counts, because at 60 m/s ski speeds pixel-perfect cores would make
most shots impossible. This is the "I swear that hit" problem, solved by
giving air a memory.

## The correctness problem

A naive "distance < wake radius" check fires on *approach* — the projectile
hits the target's wake sphere before reaching the core, and every shot
becomes a proxy hit. The fix (`Projectile.ts`):

- **Track min-distance per target** across the projectile's life
- **Wake hit only when distance is increasing** — the projectile passed its
  closest approach (`passedCenter`, recomputed per swept step) AND
  `d > prevMin`. It must be *leaving* the target to trigger.
- Core always takes precedence within the same sweep.

So the wake is only legal in the target's *rear hemisphere of history* —
literally a wake behind the projectile's path through its space.

## Shared math is the anti-cheat

`hitRadiusAt(weaponType, airtime)` lives in `shared/combat.ts`. The server
validates hit claims by recomputing the exact same expanding radius from
the claimed airtime — client and server can't disagree about what
constituted a hit because it's one function.

## Numbers

Disc: wake grows ~0 → ~1.4m over ~1s (check `shared/weapons.ts` `hitMin`/
`hitMax`/`hitGrow` per weapon). Bigger weapons = more generous wakes.
The feel target: a skilled direct hit beats a lucky graze (direct hits deal
`directDamage`, wakes deal AOE-only).
