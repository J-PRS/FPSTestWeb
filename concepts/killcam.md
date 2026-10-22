# Killcam (dead-spectate)

What plays between "YOU DIED" and respawn. Informational closure — you
see who got you — not intel for the next life.

## Phases

| Phase | ms | What |
|---|---|---|
| Dwell | 0–900 (`KILLCAM_HOLD_MS`) | Camera holds on your corpse spot. Registers the death. |
| Blend | 900–1550 (`KILLCAM_BLEND_MS`) | Orbit pivot glides corpse → killer's live pos on a **smootherstep** (`6t⁵−15t⁴+10t³`). Zero velocity AND curvature at both ends — soft leave, soft land, punchy mid-sweep. |
| Track | 1550–4000 | Free orbit around the killer at `SPECTATE_DIST` (7m, wider than the inspect cam). A spectate press or the timeout drops to the normal teammate cycle / ghost flight. |

## Why these choices

- **Constant-time blend, not constant-speed.** Fixed duration +
  smoothstep is the standard timed-transition shape: guaranteed finish
  regardless of frame rate or distance. Distant kills read as a fast
  swoosh, near kills a drift — intentional travel either way. If
  cross-map kills ever feel blurry, distance-scale the duration:
  `clamp(650, 400 + dist*10, 1400)`.
- **Smootherstep over smoothstep.** Both zero the end velocities;
  smootherstep also zeroes the end *curvature*, so the camera doesn't
  snap through the last 10% when the pivot is still converging on a
  running target.
- **Corpse dwell.** Skipping straight to the killer reads as a glitch
  teleport; the ~1s hold is the "I died" beat Battlefield/CoD burn in
  before the reveal.
- **Orbit pivot, not camera lerp.** We lerp `deadSpectateAnchor` (the
  orbit pivot) so the 7m boom sweeps along for free and free-look stays
  live through the whole sequence.

## Where

- `client/src/game/net/playerKill.ts` — `ownDeath()` stamps
  `spectateAnchor` (killer replica), `spectateAnchorUntil` (4s window),
  `spectateAnchorFrom` (corpse pos), `spectateAnchorStart`.
- `client/src/entities/Player.ts` — `update()` runs the dwell/blend/track
  math; `KILLCAM_HOLD_MS`/`KILLCAM_BLEND_MS`/`SPECTATE_DIST` are the
  knobs.
- Killer eligibility: `shooterId !== 'environment' && !== targetId` and
  the killer replica must be alive — suicides and environment deaths go
  straight to ghost flight.
