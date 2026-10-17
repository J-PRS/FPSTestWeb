# Tribes 1 physics vs KRIBES MoveSim — updated 2026-10-15

Cross-check of `shared/movement.ts` against the floodyberry T1 physics series
(parts 1-4 in this folder) and the installed T2 datablocks
(`D:\[Games]\Tribes2\GameData\base\scripts.vl2\scripts\player.cs`).
Mechanism-level comparison; numbers are tuned per armor class.

## Matches the documented model

- **Generous jump grace**: T1 allows a jump for 256ms after last ground
  contact ("jump smoothly through little bumps"). Ours: `groundGraceT` +
  `checkGrounded` proximity buffer refill on contact.
- **Jump formula**: T1 `impulse = JUMPIMPULSE/MASS` along `upNormal·(n·up)`
  plus an `orientation` term along move direction. Ours is the same shape
  (`jumpSpeed * surfaceY` + same orientation dot-product branch). Ours is
  now impulse 9.8 @ gravity 28 → apex 1.71m ≈ T1's 8.33 @ 20 → 1.73m —
  same hop arc, same ~0.7-0.8s rhythm.
- **Ground motor = bounded convergence, not a clamp**: T1 `Friction()`
  converges tangential velocity toward the input wish (`WALKSPEED`) with
  `GROUNDFORCE/MASS × GROUNDTRACTION ≈ 120 m/s²`, only on contact ticks.
  Ours: `applyGround` converges to `dir × (12 × speedScale)` at
  `groundTractionAccel = 120 × speedScale`. Same force, same number.
  There is no separate ground accel or walk cap in either — the "cap" is
  just the wish speed, so knockback/shoves bleed at 120/s², never clamp.
- **Gravity applies always** (was a divergence — fixed): T1 never turns
  gravity off; contact kills the into-surface component. Ours now applies
  gravity every tick and cancels `vel·n` **before integrating** while
  grounded (the Torque order) — downhill velocity stays slope-parallel so
  the face is followed by motion, not by a position pull.
- **Contact redirects velocity, never teleports position** (fixed):
  T1 `UpdatePosition` moves the body only by velocity — on contact it
  kills `v·n` and re-moves from the original position. Ours clamps only
  on real penetration (`dist < 0`); the in-band pull-down `pos.y = groundY`
  was removed — it was the velcro jolt the T1 writeup explicitly warns
  about, and it visibly snapped every hop landing.
- **Landing while holding a takeoff input is a landing** (fixed): T1 arms
  the next jump whenever contact happens. Ours gated "rising" on the
  input alone, so a held jump could never re-arm — hop once, slide
  forever. Now `velDotN > 0` is required for a takeoff to read as rising.
- **Walk up any terrain**: T1 has no slope limiter — `JUMPSURFACE_MINDOT`
  only gates which surfaces refresh `lastJumpableNormal`. Ours same;
  launch detection is `velDotN` (leaving the face), never world-up vel.y —
  steep-face walkers stay grounded at 100%.
- **Bounce is near-zero**: T1 `ELASTICITY = 0.001`; ours kills `v·n` on
  contact — equally dead.
- **Collision damage = -v·n over threshold** (part 3): T1 charges
  `(impactDot - MINDAMAGESPEED) × DAMAGESCALE` per contact kill —
  `MoveSim.landingImpact` records the pre-kill `-v·n` on every terrain +
  solid contact; callers pay `(impact − 25) × 0.005 × maxHealth` at
  T1-light values (`MOVEMENT_CONFIG.fallDamage*`). Downslopes stay free
  for the same reason T1's do.

## Remaining real divergences (impact order)

1. **Knockback power curve** (part 4) — the big one. T1
   `power = d/max(d - minHitboxDim, 1) - d/r` *ramps up* over the smallest
   hitbox dimension then falls off — point-blank blasts are weaker than
   near-range; that asymmetry is what makes disc-jumping strong. We use a
   plain falloff; disc-jump feel will differ until the curve matches.
2. **Ski driver** (parts 2-3): T1 skiing is `currentFriction` decaying
   ×0.6/tick without contact — you ski by being airborne recently, so
   contacts can't brake you; friction *returns* scaled by `n·up`, so flat
   contact re-grips and slope contact stays slippery. Ours is a held-key
   friction exemption plus `skiTargetDistance` reach — slope-agnostic.
   Feel-family equivalent, different driver. Hop-skiing (the T1 style)
   also works: `autoHop` refires jump on contact.
3. **Contact is distance-based, not swept** (part 3): T1 sweeps each move
   in ~1m slices and detects contact mid-step. Ours integrates then
   resolves against a heightfield — "contact" is a proximity band +
   time-grace. This is the honest port given no swept query; it is also
   why the code has more branches than T1's 30-line UpdatePosition.
4. **Tribes' "move anyway" quirk** (part 3): T1 recomputes position from
   post-collision velocity — the slight bounce-away "fluid" feel. Ours
   clamps to the contact point. Now that position is never snapped down,
   the residual difference is sub-millimeter.
5. **Side/back walk speed**: T1 `sideSpeed = WALKSPEED - 1`; T2
   forward 15/12/7 vs side/back 13/10/5. Ours is direction-blind.
6. **Side-jet blending** (part 2): T1 side jets engage after 256ms
   airborne and fade side power toward JETFORWARD 22 m/s. Ours is
   constant up+lateral with a forward-cap component drop-out.
7. **Ski-bug note**: T1 zeroed velocity past max collision bumps — the
   dreaded ski bug. Ours can't reproduce (no slice loop).

## Constants reference

T1 light: WALKSPEED 11 · JUMP 8.33 · gravity -20 · traction 120 ·
JETFORCE ≈26 m/s² · JETFORWARD 22 · MAXENERGY 60 · drain 25 ·
tick 0.032s · MAXJUMPTICKS ~256ms.

T2 (installed player.cs): walk fwd L15 / M12 / H7 · side/back L13 M10 H5 ·
mass L90 M130 H180.

Ours: walk target L14 / M11 / H8 (speedScale × base 12) · jump 9.8 ·
gravity -28 · traction 120×scale · jet up 35 / side 10 · maxEnergy 60 ·
drain 15 · charge 8. Heavier gravity+jump, tighter class spread than T2
(heavy kept at 8 not 7 — heavies also run cap routes here).
