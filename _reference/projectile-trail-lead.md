# Projectile trail emission lead — why a puff appeared *ahead* of the shell

Status: reference / RCA. Born 2026-10 from "sometimes the smoke trail puff
is in front of the projectile". Fix: `client/src/effects/trailLead.ts`
(+ `QuarksTrail.emitSegment`, `Projectile` host wiring).

## Symptom

A projectile draws three things — the body mesh, a ribbon/line trail, and a
quarks smoke trail. Occasionally the freshest smoke puff is drawn **in
front of** the projectile mesh, most visibly on fast shells.

## Why it is possible at all

A smoke particle cannot outrun the shell. What moves ahead is the **trail
emitter**: the particle trail is a distance-emission quarks system whose
emitter is driven by hand, so `QuarksTrail.emitSegment` was deliberately
parking the emitter *past* the shell to compensate a presumed head gap.

The old lead was:

```ts
const k = Math.min(1, cap / Math.sqrt(mLen)) * 2;   // up to 2×
em.position.x += mdx * k; ...                        // mdx = RENDERED delta
```

i.e. up to **2 render frames of travel in front** of the drawn position.

## Why the compensation overshot (the real RCA)

1. **quarks deposits at the head already.** `ParticleSystem.emit()` →
   `spawn(count, state, emitterMatrix)` places every distance particle at
   the emitter's **current `matrixWorld`**
   (`three.quarks/src/ParticleSystem.ts:1008,1088`). It does *not* distribute
   them along `previousWorldPos → matrixWorld`.
2. **The emitter is fresh before the deposit.** `updateVfx` ticks the trail
   drivers first and calls `batcher.update` after (`vfxRuntime.ts:459-485`),
   and the game loop runs projectile updates in stage 1, fx in stage 2. So
   when quarks spawns, the emitter already sits on the shell's drawn
   position. A lead is therefore only needed to bridge the **30 Hz batcher**
   (`simParity`, every other frame), whose inter-deposit gap is at most one
   frame — not two.
3. **The measured delta was the rendered delta.** The host position is
   `rendered = pos + renderOffset` (`Projectile.ts:293`), and `renderOffset`
   carries a netcode correction blend (and `advanceBy` moves `pos` outright).
   The `×2` multiplied *that*, so a remote/advanced shell's correction motion
   inflated the lead and pushed the puff clearly ahead.

So: a hardcoded `×2` on a pollutable measurement, compensating a gap that is
really ≤1 frame. Net effect is a persistent lead of up to two frames.

## How Unity et al. do it (researched)

- **Unity**: the `ParticleSystem` *is* a component on the GameObject; set
  **Simulation Space = World** for trails and **Rate over Distance** to seed
  by travel. Unity: *"Distance mode is only applied when Simulation Space is
  set to World"* — the parent transform's per-frame delta is the same number
  the emitter uses, in the same tick. No separate clock, no lead.
  <https://docs.unity3d.com/Manual/PartSysEmissionModule.html>
- **Godot**: fixed-FPS particle systems expose an **Interpolate** property —
  *"it blends particle properties between updates so that even a particle
  system running at 10 FPS appears as smooth as running at 60"*. The correct
  way to hide a low sim rate is interpolation, not a positional lead.
  <https://docs.godotengine.org/en/latest/tutorials/3d/particles/properties.html>
- **General fix list** (world space → seed along the path / sub-frame →
  inherit velocity): *"How to Fix Particles Lagging Behind a Fast-Moving
  Emitter"*, <https://bugnet.io/blog/how-to-fix-particle-simulation-space-lagging-behind-moving-emitter>

## The fix applied (cheap, strictly-dominant subset)

`client/src/effects/trailLead.ts`:

- Measure travel from **sim truth** (`host.travelPos` = `Projectile.pos`),
  never the `rendered` anchor → a correction blend cannot inflate the lead.
- Lead by **`TRAIL_LEAD_FRAMES = 0.5`** — half an inter-deposit interval —
  the minimax value. With deposits every other frame the head error is `L`
  on a deposit frame and `L−1` the frame after; `L = 0.5` centres that at
  ±½ frame. The old value was 2 (always ahead by up to two frames).
- Keep a hard overshoot cap (`spd·dt·4 + 3`) so a hitch/teleport frame can't
  cash as a sky-length lead; the jump-cut in `emitSegment` is the second
  line of defence.

`QuarksTrail.emitSegment` now adds this lead on top of the drawn position;
`Projectile` passes `travelPos: this.pos` to the trail host.

## What is *not* fixed

The residual ±½-frame head stutter is inherent to the **30 Hz batcher**. The
fully-correct cures, in order of cost, are:

1. **Sub-frame seeding** — deposit distance particles along the swept
   `previousWorldPos → matrixWorld` segment instead of all at the head
   (Unity's Rate-over-Distance behaviour). This removes the gap entirely,
   but quarks controls spawn placement, so it needs a custom override.
2. **Interpolate / full-rate the trail systems** — the batcher decimation is
   one **global** parity flag (`vfxRuntime.ts:249,466`) driving a single
   `batcher.update(dt*2)`; selectively stepping trails at frame rate means a
   second batcher or per-system cadence, and costs sim time under projectile
   spam (unmeasured).

Neither is worth doing until measurement shows ±½ frame is visible; the cheap
fix removes the reported artefact (a puff *ahead*) with no added cost.

## Verifying a change here

- Unit: `client/src/__tests__/trailLead.test.ts` pins the 0.5 factor, the
  overshoot cap, and the no-travel (first/resync) case.
- Visual: the projectile lab (`client/src/lab`) drives the real visual stack
  (mesh + glow + ribbons + quarks trail); capture fast shells and check the
  trail head against the mesh, not whole-frame diffs.
- Do **not** measure the lead from `rendered` in any new code — that is the
  original bug.
