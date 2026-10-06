# Tribes 1 physics vs KRIBES MoveSim — 2026-10-04

Cross-check of `shared/movement.ts` against the floodyberry T1 physics series
(parts 1-4 in this folder). Mechanism-level comparison; constants are tuned per
armor class so numbers differ deliberately.

## Matches the documented model

- **Generous jump grace**: T1 allows a jump for 256ms after last ground
  contact ("jump smoothly through little bumps"). We go one better — the
  stick-band keeps `onGround` through bumps outright (cf21a95b+565d33b1), so
  both jump and anim survive them.
- **Jump formula**: T1 `impulse = JUMPIMPULSE/MASS`, applied along
  `upNormal * (surfaceNormal·up)` plus an `orientation` term when moving away
  from the surface. Ours is the same shape (`jumpSpeed * surfaceY` + the same
  orientation dot-product branch).
- **Contact-gated friction**: T1 applies Friction only when
  `collisionLastTick` — friction is a contact property, not an air property.
  Ours applies ground accel/friction only while `onGround`.
- **Walk up any terrain**: confirmed. T1 has no slope limiter either — steep
  faces resolve through the step-up path; `JUMPSURFACE_MINDOT = 0.2` (~78°)
  only gates which surfaces *refresh* `lastJumpableNormal`, not which are
  walkable. Our 80° test matches that behavior.
- **Bounce is near-zero**: T1 `ELASTICITY = 0.001`. Ours kills the
  into-normal component on contact — equally dead, no trampoline.

## Real divergences (worth knowing, in impact order)

1. **Knockback power curve** (part 4) — the big one. T1 uses
   `power = d/max(d - minHitboxDim, 1) - d/r`: it *ramps up* over the smallest
   hitbox dimension then falls off, so point-blank blasts are weaker than
   near-range ones — that asymmetry is what makes disc-jumping strong. We use
   a plain falloff; disc-jump feel will differ until the curve matches.
2. **Ski mechanism** (parts 2-3): T1 skiing is `currentFriction` decaying
   ×0.6 per tick without contact — you "ski" by being airborne recently so
   ground contacts can't brake you; it is explicitly not a friction toggle.
   Ours is a held-key flag that preserves 98% of into-slope velocity instead
   of killing it. Same feel family, different driver — ours is intentional
   ("skiing: friction toggle only" per config comment) but the T1 model also
   explains why jump→contact transitions matter: their friction *returns* on
   contact scaled by the surface normal, so flat contact re-grips fast and
   slope contact stays slippery. Our ski grip is slope-agnostic.
3. **Gravity while grounded** (part 2): T1 applies gravity constantly,
   letting contact + friction cancel it; ours skips gravity while onGround.
   Same net hold on gentle slopes; on near-vertical faces T1 still pulls the
   body down while friction fights it — ours hangs until the cap normalizes.
4. **Side/back walk speed**: T1 `sideSpeed = WALKSPEED - 1` (slower strafing/
   backpedal). Ours is uniform all directions.
5. **Side-jet blending** (part 2): T1 side jets engage only after 256ms off
   ground and fade side power as forward speed approaches JETFORWARD (22 m/s),
   shifting force to pure up. Ours is a constant up+lateral force with no
   speed-aware blend.
6. **Tribes' "move anyway" collision quirk** (part 3): T1 recomputes position
   from post-collision velocity, producing the slight bounce-away "fluid"
   feel; the mathematically-correct way (ours: clamp to contact) reads
   "velcroish" by comparison. Feel-level difference, not a bug.
7. **Ski-bug note** (part 3): T1 zeroed velocity when the translation loop
   exceeded max bumps — the dreaded ski bug. Ours can't reproduce (no
   translation-slice loop); ignore-on-overflow is the documented better answer
   anyway.

## Constants reference (T1 light armor)

WALKSPEED 11 · JUMPIMPULSE 75 (÷9 = 8.33 m/s) · GROUNDFORCE 9*40 ·
GROUNDTRACTION 3 · JETFORCE 236 (÷9 ≈ 26 m/s²) · JETSIDEFORCE 0.8 ·
JETFORWARD 22 · gravity -20 · MAXENERGY 60 · drain 25 · charge 8(+3) ·
tick 0.032s · JUMPSURFACE_MINDOT 0.2 · MINDAMAGESPEED 25 · DAMAGESCALE 0.005

Ours: walk 7 (class-scaled) · jump 7 · gravity -28 · jet up 35 / side 10 ·
maxEnergy 60 · drain 15 · charge 8. Same family, heavier gravity/jet feel.
