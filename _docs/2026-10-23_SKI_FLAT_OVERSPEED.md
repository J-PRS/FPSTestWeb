# Ski flat-ground overspeed — current behavior audit

Measured 2026-10-23 against `shared/movement.ts` on a flat surface.
Probe: `server_bun/tests/scenarios/_skiheavy.ts` — run with
`bun tests/scenarios/_skiheavy.ts` from `server_bun/`.

## Symptom

Pressing ski while walking on flat ground grants a speed increase of
roughly one class-scaled `groundAccelerate` step in a single tick, then
locks it in forever — "friction toggle only, no artificial accel"
(`MOVEMENT_CONFIG` comment) is not what ships.

## Measured numbers (flat, 60Hz fixed step)

| Class  | Walk cap | Walk (4 s) | Ski +1 step | Ski held 4 s | Standstill+ski 1.5 s |
|--------|----------|------------|-------------|--------------|----------------------|
| Light  | 14.0     | 14.00      | 14.00 (+0)  | 14.00        | 15.56                |
| Medium | 11.0     | 11.00      | 23.22 (+12.2) | 23.22      | 12.22                |
| Heavy  | 8.0      | 8.00       | 16.89 (+8.9) | 16.89       | 17.78                |

Releasing forward while skiing: speed holds (momentum preserved — by
design). Releasing ski: traction bleeds to 0 — correct.

Light doesn't overspeed from walking only because its cap (14) already
exceeds the unscaled gate (12), so `applyGround` never runs. It still
overshoots its own cap on the standstill push-off (15.56 > 14).

## Root cause — two constants, both wrong

`applyGround` ski branch (`shared/movement.ts` ~659):

```ts
if (this.input.skiHeld && dirLen > 0) {
  ... s.vel.x += sx * MOVEMENT_CONFIG.groundAccelerate * this.speedScale * dt;
}
```

1. **No cap on the push-off.** `groundAccelerate × speedScale` is
   533–933 m/s² — one 60 Hz step adds 8.9 m/s (heavy), 12.2 (medium),
   13.3 (light). Whatever gap exists to the threshold is crossed in one
   step, always overshooting.
2. **The skip-gate uses the unscaled constant.** `applyMovement`
   (~487) runs `applyGround` whenever
   `!(skiHeld && hSpeed > MOVEMENT_CONFIG.maxVelocityGround)` — a flat
   12, not `maxVelocityGround × speedScale` (the class cap: 14/11/8).
   So every class gets pumped until hSpeed > 12 regardless of its own
   walk cap, and once past 12 ground physics is skipped entirely, which
   also freezes the overspeed (no traction while skiing = nothing ever
   bleeds it).

The branch exists for a real reason (comment: "a stationary skier still
needs a push-off or he never gets moving") — the intent is a slow-ski
push-off converging to walk speed. What ships is a speed purchase.

## Secondary observation

A skier between the class cap and 12 (e.g. heavy at 10 m/s from a real
downhill) still runs `applyGround` — the accel branch is the only risk
there; the slope redirect + band logic is unchanged either way.

## Resolution — applied 2026-10-23

The exploit is gone; ski is now honestly a friction toggle:

- `applyGround` push-off replaced by a bounded converge-to-wish force
  (`groundTractionAccel`-scale) that only runs while below the
  class-scaled cap — legs keep working under skis, but can never buy
  speed past the walk cap. Stopped skiers get going; moving skiers
  hold momentum.
- The `applyMovement` skip-gate now compares against
  `maxVelocityGround × speedScale` — skiers above their class cap get
  no ground physics at all (true friction-off), below it they get
  legs. (The unscaled-12 gate also ate ground physics for light skiers
  at 12–14 m/s and froze them mid-converge.)
- New perk **Jumpstart** (`shared/perks.ts` → `MoveSim.jumpstart`):
  one-shot +6 m/s on the ski-held *edge*, gated `hSpeed ≤ walk cap` —
  max payout is **cap + 6**, pressing at pace buys nothing. Fires once
  per press; the snapshot carries the edge so client prediction and
  server shadow agree.

Measured after fix (flat, 60Hz):

| Class  | Walk cap | Ski press at cap | Standstill+ski 1.5 s | Jumpstart edge | Jumpstart at cap | Jumpstart at 30 m/s |
|--------|----------|------------------|----------------------|----------------|------------------|---------------------|
| Light  | 14.0     | 14.00 (+0)       | 14.00                | 6.00 → 14.00   | 20.00 (cap+6)    | 30.00 (no boost)    |
| Medium | 11.0     | 11.00 (+0)       | 11.00                | 6.00 → 11.00   | 17.00 (cap+6)    | 30.00 (no boost)    |
| Heavy  | 8.0      | 8.00 (+0)        | 8.00                 | 6.00 → 8.00    | 14.00 (cap+6)    | 30.00 (no boost)    |

Bots hold `skiHeld` permanently (MPC plans ski-always), so pure
friction-off with no legs stalled capper bots from standstill — the
bounded converge was kept for that reason. With it, all three
real-terrain capper scenarios (peaks/dunes/katabatic) pass again;
peaks seed 9001 still dies at the stand (defender fire), seed 9002
caps — the `bestOf` seed spread the test already tolerates.

Pinned by `roomMoveSim.test.ts` ("a stopped skier pushes off at walk
speed — never past the cap", "Jumpstart fires once on the ski edge,
only below walk cap") and `_skiheavy.ts`.
