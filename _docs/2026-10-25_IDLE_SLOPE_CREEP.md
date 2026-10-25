# Idle slope creep — traction runs before gravity, one step's slide escapes

Written 2026-10-25 against `shared/movement.ts`. Change verified by
`bun test` (server_bun) — 3 pre-existing failures unchanged with and
without the patch; no new failures.

## Symptom

Standing still on a slope with no input, the body slides downhill at a
slow constant rate — traction should hold an idle walker (T1 model:
traction drains the slope pump every contact tick), but a residue
survives every step and integrates into visible creep.

## Root cause — step ordering

`applyMovement` runs these in sequence each STEP (1/60):

1. `applyGround` → the T1 traction block converges **tangential**
   velocity toward wish velocity (0 when idle), bounded at
   `groundTractionAccel * speedScale * dt` per step.
2. `s.vel.y += GRAVITY * dt` (GRAVITY = -28) — applied unconditionally,
   T1-style, grounded or not.
3. `collideTerrain` kills the into-slope (`vel·n < 0`) component only.

Step 2's gravity vector decomposes on a slope: the normal part dies in
step 3, but the **tangential part survives untouched** — traction for
this step already ran. Next step traction drains it, but position has
already integrated it, and step 2 injects a fresh one.

Net: a permanent residue of `|g|·dt·sinθ` of tangential velocity per
step, which is also the effective creep speed:

| Slope θ | Creep |
|---|---|
| 20° | ~0.16 m/s |
| 30° | ~0.23 m/s |
| 45° | ~0.33 m/s |

Small per-step, constant forever — reads as "the floor gently pushes me
downhill".

## Fix — anticipate the drip on idle ticks only

Inside the existing traction block (`applyGround`, contact-gated by
`bandDist <= 0.1`), when `dirLen === 0` the converge now reads the
velocity gravity is *about* to leave behind:

```ts
const gravY = dirLen === 0 ? s.vel.y + GRAVITY * dt : s.vel.y;
const vdn = s.vel.x * n.x + gravY * n.y + s.vel.z * n.z;
...
const tx = s.vel.x - n.x * keep, ty = gravY - n.y * keep, tz = ...;
```

For an idle body `vdn < 0` → `keep = 0`, the full anticipated tangential
(including the pending `g·dt·sinθ`) is inside the converge delta, and at
≤0.47·sinθ m/s it's far under the ~2·speedScale m/s force cap — so it's
fully zeroed in-step. Post-collision tangential velocity ends at 0.

## Non-regression surface (why nothing else moves)

- **`dirLen > 0`**: `gravY = s.vel.y` — the original expression
  bit-for-bit. Walkers steering on slopes are untouched.
- **Skiing**: `skiHeld` skips the whole traction block except the
  `skiPushOff` case, which requires `dirLen > 0` — also untouched.
- **Deceleration on key release**: same bounded force, same per-step
  drain. A fast body still bleeds at `groundTractionAccel`; the delta
  just additionally contains the ≤0.47 m/s residue, so the slide ends
  with a *complete* stop instead of stop-then-creep.
- **Airborne / jet / bandDist > 0.1 / water**: none reach this branch.
- **Determinism**: shared sim — client prediction and server authority
  compute the identical value; no wire, schema, or config change.

## Residual watch

- An idle body standing where the surface normal changes mid-step (a
  sharp crest) still gets one step of the *new* slope's residue —
  inherent to sampling `getNormal` at the current position; not worse
  than before.
- Bots that release walk on a face now hold position instead of
  drifting — botMoves already assumes "walk key released, friction
  holds the slide" (line 41), so this makes the sim match the bots'
  model rather than breaking it.
