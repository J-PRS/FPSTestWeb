# Turretter — Ballistic Re-engaging Turret

An enemy that alternates between two modes: a **planted artillery turret** and
an **inert ballistic body** in flight. The tension is built into the loop —
repositioning makes it dangerous later, but while it's airborne it's a free,
readable, bonus-damage airshot.

## The loop

```
PLANTED ──(player >75m, dwell ≥3s)──> LAUNCHED ──(lands)──> PLANTED
   │                                     │
   │ lobs 60 m/s shells                  │ inert, no steering
   │ armored: takes 0.5× damage          │ vulnerable: takes 2.0× damage
   │ aims head in tilted local frame     │ hot-orange glow = "shoot me now"
   └──────(terrain blocks arc)───────────┘ relaunch to a better seat
```

- **Launch is a solved arc** — fixed flight time (`TURRET_HOP_T`), velocity
  solved to land on the player's *predicted* position (`pos + vel·t·0.7`).
  Dynamic speed is correct here: it's a body, not a bullet, and the fantasy is
  that it always arrives.
- **Bolts are honest projectiles** — fixed 60 m/s muzzle speed, elevation
  solved via the range equation (`sin 2θ = gR/v²`), low arc when reachable,
  45° lob when not. Dodgeable by construction: ~0.25s at close range, ~1.1s
  at max. Flat-ground range at g=28 is ~128m, so the 65m fire range is never
  the physics — it's the visibility.
- **No ping-pong by geometry**: a hop lands it *near* you, inside its fire
  range, so it plants and shoots. `TURRET_MIN_DWELL` is only a safeguard for
  whiffed landings (ridge, depression, no LOS).

## Terrain-aware firing

Before each shot the solved arc is sampled (12 points over the up-and-down
flight) against `terrain.getHeight`. A shot that would clip dirt is never
spawned — instead:

- settled (dwell ≥ `TURRET_MIN_DWELL`) → **relaunch to a better seat**
- recently landed → wait 0.4s and re-check (no hop spam)

The hop arc is itself a lob onto the player, so repositioning genuinely
clears the obstruction rather than hoping.

## Terrain seating (footprint conforming)

The naive seat — `y = getHeight(center)` — leaves the downhill edge of the
2.6m base floating on any slope. The shipped solution is the standard
technique (Cities: Skylines 2 building lots, RTS placement):

1. **Tilt** the whole mount to `terrain.getNormal` — works on any incline.
   The head owns all aiming; the base owns only tilt (baking yaw into the
   base double-rotates the head's `atan2` — this bug shipped once).
2. **Sink the base bottom a constant shallow burrow** (0.18m) under
   *center* ground — never chases lowest samples. Lowest-sample seating was
   tried and removed: on slopes the "lowest dirt" is meters down and the
   turret visibly squashes into the ground.
3. **`meshYOffset` decouples visual from physics** — `pos` stays the honest
   gameplay position (bolts, blast checks, health bars); only the rendered
   mesh sinks. Reset to 0 on launch so the tumble rides the body.
4. **The draped skirt owns the gap** — a 3-ring annulus where the hem is
   literally terrain height per-vertex and the shoulder ring rises to the
   base rim (`topY` override). Ground contact is a geometric guarantee on
   any relief; no height constant can fail.

Escalation paths if gaps ever reappear: a terrain-conforming dirt skirt
(`TerrainRing` already drapes rings onto heightfields — same trick RTS games
use for building foundations), or lowest-sample seating's failure mode on
crest landings (half-buried look) is fixed by the skirt, not more burial.

## Design knobs

| Constant | Meaning |
|---|---|
| `TURRET_RANGE` 65m | fire range; also the "too close to hop" bound |
| `TURRET_RELAUNCH` 75m | beyond this + settled → hop at player |
| `TURRET_MIN_DWELL` 3s | anti-brick / anti-spam floor on hops |
| `TURRET_HOP_T` 1.6s | hop flight time (arc height, hang time) |
| `TURRET_REFIRE` 1.6s | shell cadence |
| `TURRET_BOLT_SPEED` 60 m/s | honest muzzle speed, elevation solved |
| `TURRET_BURROW` 0.12m | sink below lowest footprint sample |
| `FOOT_R` 1.35m | footprint sample ring radius |
| `MAX_SINK` 1.1m | burial cap — crest landings won't swallow it |

Damage model is asymmetric on purpose: planted = 0.5× (6 effective hits ≈ 12),
airborne = 2.0× (3 hits). The mid-air kill is the reward for reading the arc —
the same shot the rest of the game trains you for.
