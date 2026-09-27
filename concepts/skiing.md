# Skiing & jetpack — the movement core

The Tribes formula, stripped to physics:

## Ski (hold)

Frictionless ground contact. On a slope, the terrain normal tilts gravity's
contribution — downhill accelerates you *along the surface*, flat ground
keeps momentum, uphill bleeds it. No magic speed: the heightfield is the
engine. All speed in this game was earned by terrain.

Implementation detail: ski removes ground friction only — gravity, normal
projection, and step-integration are unchanged. The skiing "feel" is a
product of the terrain mesh, not a special force.

## Jet (hold)

Thrust along view/up axis with energy drain. Converts horizontal into
vertical, or fights gravity uphill. Energy is the pace governor — unlimited
jet = quake with a fly cheat.

## The loop

```
dive (gain speed) → ski out (keep speed) → jet or rocket-jump to crest
(repeat, spending energy where terrain can't give it)
```

## Composition rules (hard-won)

- **Momentum is sacred**: nothing writes `pos`/`vel` outside the physics
  step except skills that explicitly preserve it (Bounce = redirect at same
  magnitude, Blink = save/suspend/restore, Dash = add).
- **Everything through `movement.setState`** — server reconciliation needs a
  single writer. Direct mutation desyncs prediction.
- **Air control stays weak** — steering in air would break the "commit to a
  line" skill test. Enemies that hop (Turretter, Crawler) are inert in
  flight for the same reason.
- **Camera never under terrain** — clamp to `getHeight + 0.25`, or steep
  slopes put the eye inside the mesh.

## Explosive movement

Rocket/disc knockback is real impulse — a point-blank floor rocket is a
rocket jump by physics, not a flag. Blast falloff (`shared/combat.ts`
`falloffAt`) is shared so server damage and client self-knockback agree.
