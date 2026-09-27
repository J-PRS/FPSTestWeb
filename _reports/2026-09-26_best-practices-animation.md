# Procedural weapon/animation — best practices applied in KRIBES

## The core pattern: damped spring impulse, not tweens
Industry standard for FPS recoil (UE camera-shake docs, procedural-animation writeups): apply an impulse, let stiffness/damping/mass ring it back. ViewModel does exactly this — `kickAmount` decays via `exp(-dt * decay)`, position lerps toward the kicked pose. Never tween positions frame-by-frame for fire feedback.

Why springs win:
- **Re-triggerable + additive**: fire again mid-ring and the new impulse stacks — full-auto "climb and buzz" emerges for free, no special-casing.
- **Fire-rate independent**: same code handles taps and held trigger.
- 3 params (stiffness/damping/mass) define the whole feel.

Hand-authored curves only for signature/hero moments where you need exact shape.

## What's layered in ViewModel.update()
- **Sway**: weapon lags behind look delta (mouse-lag) — `SWAY_AMOUNT`.
- **Velocity offset**: world velocity in camera space dips the gun — `VEL_AMOUNT`.
- **Bob**: two layered sines (cheap perlin) — `BOB_*`.
- **Landing dip**: vel.y delta kicks the gun down — `FALL_*`.
- **Fire kick**: the spring — `kickAmount` decays, `kickX` sideways jitter decays faster.
- **Throw dip / switch dip**: timed lower-raise sequences, share the same pose math.

## Per-weapon feel
`KICK_TUNE[WeaponType]` = [decay, jitter, flashColor, flashScale, flashLife]: mortar slow+heavy (7), railgun fast snap cyan (18), flak shudder (jitter 0.09), plasma light green tap, disc short snappy travel. Same spring, different impulse shape — one table entry per weapon, no per-weapon code.

## Key rules
- Kick amount is an impulse, not a position — decay it, don't tween it.
- Sideways jitter decays faster than the main shove (jitter ≠ travel).
- Muzzle flash: additive quad(s) at the bore, ~70ms life, sqrt-decay opacity, random roll/scale per shot so it never looks identical. Position per-weapon (`MUZZLE_Z`), color per-weapon.
- Belt items (disc throw, grenade) use a dip-and-release sequence; melee uses a fist jab, not a gun kick.
