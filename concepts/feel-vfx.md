# Feel & VFX philosophy

The rule learned the hard way: **screen-space overlays lie**. Anything
painted on the camera that isn't derived from real world vectors reads as
wallpaper. Every feedback effect anchors to the sim.

## Speed lines — the case study

v1 was camera-locked quads → looked stupid (user verdict: "this is a joke").
v2 is world-space and it's correct:

- Streak quads spawn on a **disc perpendicular to the velocity vector**,
  ahead of the camera, essentially stationary in world — you fly *through*
  them. They converge on the true velocity vanishing point for any direction,
  including strafing
- Cylindrical billboards — long axis pinned to `velDir`, plane normal faces
  camera; never show the flat face
- Speed-gated (in ~30 m/s, full ~85), fast attack / slow release
- `burst()` spikes intensity with `exp(-7t)` decay — Bounce/Dash/Blink all
  fire it so skills read as surges

Research confirmed this is technique #2 of the two real ones (world-space
particles vs radial post-process vignette). The post-process version still
needs to anchor its focal point to the projected velocity vanishing point or
it's the same wallpaper problem.

## Everything else follows the same rule

- **Explosions**: shared `Explosion` blast (shock dome + sparks + ring +
  scorch) scaled by radius, tinted per source — rocket, slam crater, turret
  shell pop all read differently through color/scale, not bespoke systems
- **Trails**: ribbon for weapons (disc/rocket), pooled ember dots for the
  turret bolt — cheaper and matches "dumb lobbed shell"
- **Landing/impact**: dust for body hits, Explosion for detonations — a
  turret hop landing *thumps* (0.4× orange blast), a launch just kicks dust
- **Screen shake**: distance-attenuated `screenShake.blast`, subtle — the
  turret shell pop is 1.8 units of shake, not a seizure
- **Hit feedback**: damage numbers at hit position, hit-marker flash on
  targetable hits, kill = debris burst

## Open questions / candidates

- `dot(camForward, velDir)` opacity modulation on speed lines — pure strafe
  at speed currently draws lines crossing the whole screen; fading at
  |dot|→0 would fix, since the vanishing point is off-screen anyway
- Foot-in-the-air readability: blob shadow fades past ~2m altitude — good,
  keep it
- A subtle screen-edge wind vignette *might* be acceptable if velocity-
  anchored — but the world streaks already cover it
