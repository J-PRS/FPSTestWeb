# Projectile velocity inheritance

`vel = dir × muzzleSpeed + playerVel × 0.5`

Half the shooter's velocity is added to every projectile at spawn —
Tribes: Ascend's number, kept deliberately.

## Why it's load-bearing

- **Moving shots feel dead without it.** At ski speeds a 0%-inheritance
  rocket falls behind its own shooter visually — you literally outrun your
  muzzle velocity sideways. 50% keeps shots moving *with* the play at speed.
- **It creates real lead behavior**: a strafe-shot curves, a downhill shot
  arrives faster, backpedal shots lag. Skilled players exploit this
  unconsciously; it's why Tribes disc-jumps chain.

## The cheat surface it creates

Inheritance means the server's hit validation can't assume pure
`dir × speed` launches. `validateHitClaim`/`validateAoeClaim` in
`shared/combat.ts` recompute the trajectory from the *reported* origin and
velocity — the server never re-derives velocity, it validates that the
claimed hit is reachable within the tracked airtime. A cheater can't claim
impossible arcs because reach is bounded by `maxSpeed × airtime + gravity`.

## The rule

Any new projectile sets inheritance through `playerVel` at the
`Projectile` constructor — don't bake it into per-weapon speed. Body launches
(turret hops, crawler pounces) deliberately do NOT inherit: they're solved
arcs that must land exactly, and inheritance would needlessly complicate
the solve.

## Numbers

- Inheritance: `0.5` (Ascend lineage)
- Rocket/disc inherit; chaingun pellets too (fast bullets + skier = yes)
- Hit validation tolerance lives in shared combat — keep single-sourced
