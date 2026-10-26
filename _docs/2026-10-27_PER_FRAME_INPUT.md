# Per-Frame Input Streaming — anti-cheat value vs real cost

Date: 2026-10-27 — analysis for "would exact per-frame input recording help
anti-cheat later, and what does it cost?"

## What the wire carries TODAY

| Stream | Rate | Bytes/frame | B/s per client |
|---|---|---|---|
| `position` (MAGIC/WIRE_POSITION) | 20 Hz | ~37 (pos,vel,rot,seq,ping,inputSeq,+3B held input) | ~740 |
| `inputMove` edges | change-only (~1–4/s) | 11 (+8 piggybacked `prev`) | ~40 |
| **Total volatile upstream** | | | **~780 B/s ≈ 6 kbps** |

Held state already piggybacks every position frame (+3B: fwd,right,
jump|ski|jet) — a dropped frame self-heals next send. `inputMove` adds
the *edges* (key transitions) with a `prev` copy for loss redundancy.
What does NOT cross the wire: the per-sim-step input journal the client
keeps for prediction replay (`InputStream`) — it stays local.

## Cost of streaming the full journal

An input record ≈ 8–12B (seq u32 + fwd i8 + right i8 + flags u8 +
status u8 [+ yaw/pitch 4B]). Client sim-step rate is NOT fixed — it
tracks render/sim rate (~60Hz typical, up to 144Hz on high-refresh):

| Clients | @60Hz | @144Hz |
|---|---|---|
| 1 | +720 B/s | +1.7 kB/s |
| 32 | +23 kB/s (~190 kbps) | +55 kB/s (~450 kbps) |

**Bandwidth verdict: irrelevant.** +90% on the volatile upstream of a
game that spends ~6 kbps up — the server sees <0.5 Mbps added for a
full 32-seat room. Nobody should argue against this on wire cost.

## The real costs are elsewhere

1. **Server CPU.** Replaying input frames to *verify* positions means
   stepping moveSim at the client's step rate — up to 7× the current
   20Hz integration on the hot path. Folding N inputs per tick is cheap;
   true per-step replay for 32 clients is the price.
2. **Variable cadence.** Input "frames" aren't fixed-rate — they're
   sim-step events tied to the player's render rate (144Hz → 144/s,
   parked tab → 0). A per-frame stream must carry dt/step-count or the
   server can't reconstruct the timeline it claims to verify.
3. **Bounded anti-cheat value.** A cheat producing *legal* inputs
   (aimbot with smoothed aim, scripted b-hop) yields a clean journal —
   streaming catches macro/turbo/inhuman-timing classes, not the
   sophisticated kind. Honest ceiling.

## What it WOULD buy

- **Input-attestation**: "prove these positions came from real inputs" —
  server replays the journal, divergent paths = tampered movement or
  injected position writes. Currently server verifies positions are
  *plausible*; it cannot verify the *input path* was human.
- **Behavioral AC**: timing-rhythm analysis (inhuman edge spacing,
  perfect-repeat b-hop chains) — needs the dense edge stream.
- Aim-snap detection: mostly already covered — yaw/pitch ride every
  20Hz position frame.

## Verdict — journal-on-demand beats journal-always

The client ALREADY journals inputs for prediction replay. The 90%
solution: the server asks for windows on demand —

- on a movement-claim divergence ("audit: ship inputs 3000–3100")
- on a demo/recording audit pass
- on a flagged-player sampling policy

Steady-state cost ≈ 0, audit path gets the full-fidelity stream exactly
when suspicion exists. Reserve always-on per-frame streaming for a
"pro/competitive client" tier (the native shell — a signed binary
attesting its journal is the actual endgame for serious AC anyway).

Skipped: no dt-encoding format designed (needs a +2B step field or
step-count header when/if implemented); no measurement of client
journal window size limits for audit pulls.
