# Movement — the actual game

Tribes-clone means movement IS the content. Weapons, enemies, and skills
exist to create moments *for* a skier at speed.

## Core loop we're protecting

```
ski downhill (frictionless) → jet uphill (energy-limited) → repeat
```

- **Ski** (held): frictionless surface contact, gravity does the work.
  Momentum compounds downhill.
- **Jet** (held): thrust with energy drain. Upward conversion, terrain-
  following lines.
- **Explosive impulse**: rocket/disc jumps add real velocity — knockback is
  physics, not scripting.
- **Skills on Q** slot into the loop: Bounce redirects on landing, Dash adds
  impulse, Blink repositions mid-line, Slam converts a line into a crater.

## Non-negotiables (learned)

- **Momentum is sacred.** Nothing replaces or zeroes `vel` silently. Bounce
  preserves magnitude exactly; Blink saves and restores exactly; Dash adds.
  The only speed caps are per-skill design choices, never accidents.
- **Terrain is the track.** Heightfield + `getNormal` everywhere — camera
  clamps above surface, entities seat by footprint, turret arcs sample it.
  Any new feature must answer "how does this behave on a 40° slope."
- **Prediction must survive.** Everything writing to player pos/vel goes
  through `movement.setState` so server reconciliation composes cleanly.
  Direct `pos` mutation outside physics is a bug waiting to ship.

## Speed feel numbers (current)

| Thing | Value |
|---|---|
| Speed lines in / full | ~30 / ~85 m/s |
| Bounce/Dash/Blink flare | 0.4s burst, exp(-7t) |
| Dash impulse | +25 m/s |
| Blink range / time | 20m / 0.16s |
| Slam dive | vel.y = -55 |

## Unbuilt ideas

- **Disc-ski**: riding your own disc explosion for absurd speed — the Tribes
  endgame skill. Probably already emergent from knockback; worth a test.
- **Momentum ramp surfaces**: terrain features that read as launch ramps.
- **Body-blocking**: players colliding mid-air exchanging momentum — fun,
  probably griefy.
- **Route ghosts**: demo playback of your best ski line as a translucent
  ghost to race against. Demo system already records everything needed.
