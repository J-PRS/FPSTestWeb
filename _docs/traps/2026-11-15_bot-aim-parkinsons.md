# Trap: server bots' aim renders the error model — reads as Parkinson's

Symptom: server-hosted bots visibly tremor — heads whipping between
headings, gun shaking — while offline (non-hosted) bots look smooth.
Reported on both `localhost:8000` and the OCI box, so latency/interp
is NOT the variable: it's the wire-facing aim pipeline vs the local one.

## The mechanism

Two bot hosts apply the *same* skill model in different places:

**Offline** (`client/src/game/bots/botBrain.ts:741`):
the rendered yaw/pitch tracks `lastAim` — the point the bot last fired
at, refreshed only on trigger pulls (~1.5s staleness) — or the live
hunt spot. Miss chance is applied *inside* `resolveShot`'s skill roll —
invisible in the facing. Gun looks steady because it IS.

**Server** (`server_bun/src/botDrive.ts:90` → `botArsenal.aimPoint`):
the rendered yaw/pitch tracks `tr.aim` — the live ballistic solution,
recomputed every 20Hz tick as:

```
tr.aim = tr.lag(pursuit, 0.85/tick chase) + tr.err(OU wander) + lead
```

(`botArsenal.ts:290-292`). `tr.err` is an Ornstein-Uhlenbeck wander —
decay −2.5/s, noise amp `1.6·sig·√dt` per tick, scaled up to ~1.65× by
target unpredictability (`tr.diff`) and ×0.35 for beams — deliberately
*biased along the target's motion axis* so the crosshair overshoots
ahead then lags behind like real tracking error.

That wander IS the miss model: it's what makes bots miss fairly. The
server renders it 1:1 in the head/gun direction because shots launch
along `p.rotation` — the facing can't be smoothed without desyncing the
tracers from the barrel.

A second amplifier: `botSlew`'s settling noise only decays while
`wantYaw` is stable; a live `tr.aim` never sits still, so the slew
noise runs at full amplitude permanently.

The WASD-chord quantization (`botDrive.ts:125-126`) exists in BOTH
paths — same `Math.round(d·fwd)` decomposition — so it does not explain
the difference; the aim look-point does.

## Why it reads wrong

A human's spread is a cone applied at projectile spawn — the viewmodel
stays still, tracers fan out. The server bot's spread is modeled as
"the entire gun wobbles," so a fair miss renders as a 20Hz tremor.

## Fix (proposed, not yet applied)

Give `driveMove` a **look point** (`tr.lag` — clean pursuit, or the
live target pos) for `wantYaw`/`wantPitch` while shots keep `tr.aim`
(pursuit + err + lead) as the fire direction. Gun renders smooth,
tracers spread around it like a human spray — strictly more honest,
not less. One caveat to verify: `tr.aim` feeds `discharge`, so the
fire dir must keep using it; only the *facing* decouples.

Alternative if the divergence reads badly: slow `tr.err`'s OU time
constant (−2.5 → ~−1.0) and shrink amp ~30% — same hit envelope,
tremor becomes a drift.

## Bisect path

- User observation eliminated the whole netcode class: noisy on
  localhost AND OCI, smooth offline → wire/latency/interp innocent.
- `RemotePlayer` rotation IS interpolated through the same snapshot
  buffer as position (`remoteSnapshots.sample`) — the samples are
  smooth; the *source* yaw is noisy.
- Source inspection: `botDrive.driveMove` reads `arsenal.aimPoint()`,
  which returns `tr.aim` (error-inclusive) vs the offline host's
  `lastAim` (error-free). `botArsenal.ts:290-292` is the smoking line.
