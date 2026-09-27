# Ballistic solving — lob math patterns

Two solvers, used everywhere enemies launch themselves or projectiles.
Both are honest ballistics: after launch, real gravity integrates, no
steering, no correction. Aim at where the player *was predicted* to be —
whiff if they moved.

## Fixed flight time (bodies)

```
T = fixed flight time (hop 1.6s, pounce ~0.9s)
vel.xz = Δxz / T
vel.y  = (Δy + ½·|g|·T²) / T
```

Speed is a *consequence* — far hop = fast launch. Correct for bodies
(turret hop, crawler pounce): the fantasy is that they arrive. Solve at
`pos + vel × T × lead` (lead factor ~0.5–0.7, not 1.0 — perfect lead makes
dodging pointless).

## Fixed muzzle speed (projectiles)

```
Given v, horizontal distance R, height Δy:
sin(2θ) = gR / v²        (low arc: θ = ½·asin, high arc: 90° − θ)
vel.xz = v·cosθ · dirXZ
vel.y  = v·sinθ
```

Classic range equation. Use the **low arc** when reachable (`gR ≤ v²`),
fall back to **45°** when not — the lob honestly falls short at range
instead of silently boosting speed. This is the "60 m/s projectile simple
as that" fix: muzzle speed is the contract, elevation is the variable.

At 60 m/s, g=28: max flat range ≈ 128m. Turret range gate (65m) is always
inside physics reach — the lob stays shallow (~15°) and dodgeable by
design (~1.1s flight at max range).

## Terrain-clearance checking

Before firing, march the solved arc: sample `pos + vel·t + ½g·t²` at ~12
points over the flight, compare Y against `terrain.getHeight(x,z)` minus a
clearance (0.3m). Blocked arc → don't fire; for the turret, that triggers
the reposition hop instead.

Don't sample from the origin — the planted base is buried by design; skip
the first segment (~0.1s) or the launch's own dirt reads as obstruction.

## Where

- `Turretter.solveBolt()` / `solveHop()` — `client/src/entities/Turretter.ts`
- `Crawler` pounce — same fixed-T solve
- Server validation — `shared/combat.ts` `validateHitClaim` uses the same
  reach math, so claims can't exceed physics
