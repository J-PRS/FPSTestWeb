# Netcode heuristic audit — "every guess needs a way to unbrick itself"

Rule applied: any magic number or heuristic that can *guess wrong* must have a
measured feedback path that corrects it — otherwise a bad guess bricks the
remote into a permanent failure mode (perpetual DR, oscillation, snap loops).
Graded per site:

- **A** — self-correcting: measured input, bounded output, recovery observable.
- **B** — mostly self-correcting but has a brickable edge.
- **C** — can guess wrong AND stay wrong; no closed loop.

## Client — remoteSnapshots.ts (interp delay / render clock)

| Heuristic | Value | Grade | Unbrick path |
|---|---|---|---|
| `BASE_INTERP_DELAY` | 100ms | A | Only a seed — `interpDelay` slews toward measured `cadenceFloor`. |
| `MAX_INTERP_DELAY` | 600ms | B | Hard ceiling can under-cover a >600ms-cadence stream → permanent atCap. Mitigation exists (coast+converge), but delay can never *meet* the truth. Should track: if atCap persists >N s, raise cap or treat cadence as the delay. **Fix: derive cap from `starveMs` instead of a static.** |
| `MAX_EXTRAPOLATE` | 0.4s (floor of cap) | B | Cap is `min(0.9, max(0.4, arrivalInterval))` — measured, good. But the coast itself is a guess; unbrick is the newest-truth converge (added). OK as long as converge never chases coast again. |
| `cadenceFloor` margin | `max(80, interval)` | B | Derived from measured cadence — correct pattern. Edge: if `arrivalInterval` EMA is polluted by micro-gaps it under-floors → atCap oscillation returns. **Unbrick: if atCap% over a window stays high, bump margin toward p95 gap.** |
| `rateScale` (EMA scale) | `gap/50` | A | Measured per-push. |
| `delayTarget` EMA | 0.08×rateScale, cap 0.5 | A | Converges in ~1-2s regardless of cadence. |
| `interpDelay` slew | +8×rateScale up, −10 down | B | Downward slew is a fixed 10ms/push — on sparse streams that deflates slowly (fine), but a wrong-inflate takes ~30 pushes to undo. Minor. |
| `MAX_RENDER_REWIND` | 80ms | B | A real server rewind >80ms gets pinned → remote never re-seats → permanent forward drift until next push. **Unbrick: if rewind-pin holds >2 intervals, accept the rewind (truth beats smoothness).** |
| `fwd` chase | `min(dt×1.35, 100)` | A | Bounded catch-up; can't run away. |
| `err>200 → snap desired` | 200ms | A | Resync path exists and is bounded. |
| snapshot retention | `max(1000, interval×4)` | B | Under long starve the buffer drops below needed history → renderTime falls off the *old* end (oldest pin) — different failure than atCap. Edge case but real on >1s gaps. |
| `starveMs` | `max(250, p90+interval)` | A | Measured p90+interval — correct pattern. |
| `wire-vel-sane` cap | 300 m/s | A | Sanity bound, not a guess — keeps Hermite from exploding. |
| `wire-jump → teleported` | `max(8, span×90+4)` | B | 90 m/s×span is a decent reach bound, but a legit stacked-impulse >90m/s could false-positive → `net.clear()` + snap (the "moves far then back" oscillation user saw). **Unbrick: require N consecutive wire jumps, or treat single huge jump as suspect-only until next push confirms.** |

## Client — remoteInterp.ts (DR / converge / predict)

| Heuristic | Value | Grade | Unbrick path |
|---|---|---|---|
| `drThreshold` | `clamp(350, interval×2.5, 1500)` | A | Scales with measured cadence. |
| `starveMs` arming DR | buffer-derived | A | DR arms on measured starvation. |
| `ACCEL_CAP` | 80 | B | Fixed cap: fine for closing, but if a remote legitimately accelerates harder (stacked impulse) converge can never catch → treadmill then >40m snap. **Unbrick: if convergeTimer re-arms >K times with gap still growing, escalate to snap (truth) instead of eternal chase.** Currently re-arms forever — see below. |
| converge re-arm (my fix) | re-arm from current gap | B | Fixed the 40-70m snap, but now converge can chase forever against a diverging target (`rg` max 69.6 in latest dump). **Needs a total-budget ceiling: after ~2-3s still-not-close, snap to latestPos — honest jump beats endless wrongness.** |
| `horizon` | `clamp(0.18, dist×0.04, 0.6)` | A | Scales with the gap it must close. |
| `convergeBudget` | chaseVel/80+horizon, cap 1.4s | B | 1.4s cap + re-arm = effectively unbounded now. Same ceiling fix as above. |
| `gap > 40 → instant snap` | 40m | B | Correct unbrick instinct (honest snap for garbage state) but fires during starve-exit — a large-but-recoverable gap gets teleported. **Unbrick: snap only if sample is inside buffer (truth); if gap>40 came from a coasted sample, converge to latestPos instead.** |
| `stepBudget` | `min(1, max(0.5, vel·dt·3+0.25))` | A | Bounded per-frame absorb — can't overshoot. |
| `REACH_CAP` | 150 m/s | A | Physics sanity bound (terminal fall ~100). |
| `predictionTimer` (now vestigial) | 150-600ms window | C→B | `predict()` no longer fabricates motion, but `predictionTimer` still gates `onUpdate` converge arming (line 261) — a knockback that coincides with the window keeps the body free-running on stale vel. Since predict no longer sets it, only harmless. **Cleanup: delete the window entirely.** |
| `silencePeakMs` leash | derived | A | Measured gap duration → DR time earned. |
| `dbgWatch` budget | `vel·dt·2.5+2` | A | Diagnostic only. |
| `p90` in `starveMs` | ring of 32 gaps | B | 32-sample ring can lag a regime change; acceptable, it re-derives. |
| `freshSeed` snap | flag | A | Explicit teleport path — correct. |
| `wireGapLogAt`/driftLog throttles | 500ms | A | Logging only. |

## Client — WorkerTransport.ts (drain / coalescing)

| Heuristic | Value | Grade | Unbrick path |
|---|---|---|---|
| `coalesceTickFrames` backlog>3 | 3 frames | B | Correct direction (preserve small batches), but the threshold itself is a guess: on a chronically bursty lane every burst >3 coalesces → the burst→pop pattern. **Unbrick: coalesce only frames whose tickAge > 1 interval — derive from arrival cadence, not a fixed 3.** Also: coal is *recorded* but nothing consumes it to adapt. |
| drain deadline | 8ms / every-64 yield | B | If dispatch ever exceeds it systematically, drain falls behind → `lagMs` grows → same starvation symptoms, invisible in the number. `drainMsMax` is recorded — wire it to shrink batch or page more often when >8. |
| `SEND_QUEUE_MAX` | 64 | B | Fixed drop bound; a burst >64 loses inputs silently (claims resent path covers movement, partially). |
| wt flap bench | 30s | B | A flap-damper guess — if wt is healthy but flapped once spuriously, the seat eats 30s of ws. **Unbrick: halve bench on clean reconnect (exponential decay).** |
| reconnect backoff | 12s base | B | Fixed damp — long but recoverable. |

## Server — tickRecords.ts

| Heuristic | Value | Grade | Unbrick path |
|---|---|---|---|
| distance tiers | 150/400/600m | B | Static geometry — a map with different engagement ranges inherits wrong cadences. Mitigated by speedTier now. Could derive from map bounds/diag. |
| speedTier | `floor(5/spd/tickDt)` | A | Fully measured — spd is the truth, 5m is the explicit visibility bound. This is the pattern to copy. |
| hysteresis | 15% past boundary | B | Fixed % guess — a remote orbiting at exactly the boundary still flaps. Minor. |
| fast-mover floor | spd>30 → tier≤3 | B→(superseded by speedTier, now a no-op) — dead heuristic, delete. |

## Top fixes worth doing (priority order)

1. **Converge total-budget ceiling** — re-arm must have a cumulative cap (~2-3s); past it, snap to `latestPos`. Kills the treadmill-forever mode visible as `rg` 60-70m tail.
2. **`MAX_INTERP_DELAY` derived** — cap becomes `max(600, starveMs)` so the delay can always reach cadence+margin on pathological streams.
3. **`gap>40` snap gated on truth** — only snap when the sample is interpolated (inside buffer); coasted samples converge to `latestPos` regardless of size.
4. **Rewind-pin expiry** — `MAX_RENDER_REWIND` pin expires after ~2 arrival intervals; truth wins over smoothness.
5. **Coalesce threshold derived** — drop only frames older than the measured arrival interval, not "more than 3".
6. **Delete dead knobs** — `predictionTimer` (vestigial), server `spd>30→tier3` (superseded by speedTier).

## What already follows the rule

`arrivalInterval` EMA, `p90gap`, `starveMs`, `rateScale`, `drThreshold`,
`convergeBudget` scaling, `speedTier`, `latestPos` converge clamp —
these all read measured input and re-derive, so a wrong first guess
self-corrects within a second or two. The C/B-graded items above are
the ones whose wrong guess persists with no feedback loop.
