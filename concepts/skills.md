# Skills — one slot, all on Q

Loadout has a single skill slot — you can only carry one. The ESC menu's
SKILL chip cycles: **Bounce → Blink → Dash → Slam**. All bind to Q.

The point is forcing a *style* choice, not a toolkit: each skill answers
"what do I do with momentum" differently.

## Bounce — redirect

Hold Q airborne → next terrain touch redirects `vel` along the crosshair,
exact magnitude preserved. A 60 m/s dive becomes a 60 m/s launch wherever
you're looking.

- Arms once per airborne stint; holding through the landing = one redirect
- No speed cap on purpose — redirecting a full dive-bomb IS the skill
  expression. If it degenerates, tax `speed × 0.9` per bounce rather than
  adding a cooldown
- Composes with skiing: downhill touch → look at horizon → keep everything

## Blink — relocate

Press Q → velocity suspended and saved, position smoothstep-lerps up to 20m
along the crosshair over 0.16s, velocity restored exactly on exit.

- Terrain-safe: ray marches in 0.5m steps, truncates at last clear point —
  can't blink into a hillside. Aiming into a wall fizzles, no cooldown burned
- 1.2s cooldown — Tracer-ish cadence
- Preserves momentum: ski 60 → blink → still 60. That's the whole point
- Risk: a server correction mid-blink rubber-bands. Invisible on LAN;
  reconciliation-aware blink is the fix if it ever shows up on lossy links

## Dash — inject

Press Q → `vel += aimDir × 25 m/s`. Pure additive impulse — stacks with
existing momentum instead of replacing or redirecting it.

- The momentum *builder*. Ground dash on a downhill = rocketless boost
- 0.9s cooldown, shortest of the four
- If it feels weak as an escape vs Blink's guaranteed 20m, bump to 30 —
  don't add mechanics, add speed

## Slam — dive-bomb

Q airborne → `vel.y = -55`, horizontal preserved → land → detonate
(`weaponType 8`: 35 dmg / 7m / 40 knockback, resolved server-side through
`getWeaponStats` — no special-case netcode).

- Airborne-only, 1.4s cooldown — no point-blank cratering
- Horizontal momentum survives the landing, so slam-onto-slope = explode AND
  ski out at pace. Mobility tool that happens to hurt people
- The missing half of Bounce conceptually: Bounce converts downward speed
  into direction; Slam *creates* downward speed on demand

## Candidates not built

- **Glide** — hold Q: gravity reduced, no lift. Free-airtime alternative to
  jetpack energy. Probably next.
- **Grapple** — raycast + rope pull + release-at-apex slingshot. Marquee
  skill, biggest build (~100 lines + rope physics).
- **Phase dash** — Dash + brief no-collide. Escape tool.
- **Slam storage** — store landing energy, release as boosted jump. Overlaps
  Bounce too much.
- **Wall-kick** — terrain is a smooth heightfield, no real walls. Skip.
