# Netcode SOTA — plan & progress

Target: CS / Overwatch / Midair grade. "Unbreakable" = every failure mode
has a test that proves the recovery path, and "observable" = every silent
divergence has a counter that makes it visible.

Architecture being validated: server-authoritative + client prediction +
corrections with input journal replay, exactly-once claim ledger,
journaled event stream with offset-cursor reclaim.

## Proven (green, CI-gated)

| Property | Harness | File |
|---|---|---|
| Prediction convergence under loss/dup/reorder/jitter | runBridge: real RoomMoveSim vs real MoveSim over ChaosLink; post-replay residual vs live authority <2m in all 6 profiles | tests/net/bridge.ts, predictionChaos.test.ts |
| Server-driven input heal | inputSync gap counter → journal resend; 15% uplink loss recovers | predictionChaos.test.ts |
| Exactly-once claims | retransmitted nonces register once, tombstones on destroy, deferred binds on outraced spawns, per-kind slots | tests/net/claimChaos.test.ts |
| Journal reclaim | replayTo restores exactly missed evs, only/exclude addressing, volatile TTL, eviction counted not silent | tests/net/wireChaos.test.ts |
| Backpressure / drown | ≥4MB mark → skip → close 1011; tick frames shed at 256KB while reliable queue | wireChaos.test.ts |
| Mid-flight reconnect | dropMs/outageMs kills socket mid-match; reclaim restores durable frames exactly once (ev-cursor dedup), prediction heals | bridge.ts + predictionChaos |
| Multi-client interference | runBridgeN: 4 predicted clients on heterogeneous links vs ONE authority + ONE ConnectionManager; per-socket cursors independent, shared journal exactly-once, one client reconnects while others stream | tests/net/bridgeN.ts, multiBridge.test.ts |
| gameState reseed fidelity | mirror test: JOINER's snapshot == live truth (pos <0.01, team, health, flags) | scenarios/joinerBootstrap.test.ts |
| Adversarial ingress | wireFuzz: 400 seeded mutations/type — null/NaN/Inf/wrong-type/garbage reject, never throw | tests/net/wireFuzz.test.ts |
| Session lifecycle | grace reclaim, token dedup, join guards, room-hop seq reset | tests/scenarios/reconnect.test.ts + netbot suite |
| Real-socket lane | tests/netbot/* — real Bun.serve + real WS (+RTC lane), jittered claims all resolve, observer state agreement, deploy broadcasts, CTF flag wire path | tests/netbot/ |
| Invariant soak | finite pos/vel, energy bounds, health bounds, isDead↔health, flag ledger coherence every sampled tick | scenarios/invariants.ts + invariantSoak.test.ts |
| Determinism | 600-tick lockstep zero divergence (detTrace per-tick per-sim hash diff) | scenarios/detTrace.ts |

| Tick-rate degradation | authority at 15Hz, 2s mid-run stall, back-to-back stalls, degraded+lossy combined: inputs queue, gap-counter resends heal, post-stall corrections converge (tail <15m, postErr p95 <4-5m) | tests/net/tickDegradation.test.ts |
| Convergence metrics report | measured numbers not just bounds: corr/min, time-to-converge (<5m steady), err p50/p95/p99, pre/postErr p95, resend% per profile. clean: 0 corr/min (sims don't diverge), lossy: 15/min, adverse: 84/min, p99 err <5m | tests/net/netMetrics.test.ts |

## Open lanes (priority order)

1. ~~Tick-rate degradation~~ — DONE, all 4 green first pass.
2. ~~Convergence metrics as regressible report~~ — DONE, netMetrics emits
   the numbers and gates them.
3. **Long-session soak** — reconnects cycling for minutes, journal
   eviction under sustained traffic, watermark wrap-around, memory
   growth in the ledger/journal over time.
4. **Snapshot reseed convergence under chaos** — joiner on a lossy link
   reseeding from gameState and converging to authority hash (partially
   covered by joinerBootstrap on clean link).
5. **Clock-skew tolerance** — client clockHint drift vs server wall;
   reconcile grace windows under skewed reporters.

## Cross-cutting observability (on-demand, zero hot-path cost)

- detTrace: two-room lockstep diff — first divergent tick + field-level
  diff is the bug report (Factorio CRC technique).
- ChaosLink is seeded + deterministic — every chaos test reproducible.
- Ledger/journal eviction and reclaim gaps are COUNTED, never silent.
- netMetrics: correction rate, converge time, err percentiles per profile
  — the dashboard, not just gates.

## Suite speed

bun test is single-process — `bun tests/ptest.ts` shards files across
cores/2 workers (greedy LPT, WEIGHTS table; all socket tests use
ephemeral port:0). 804 tests: ~214s → ~58s wall.
