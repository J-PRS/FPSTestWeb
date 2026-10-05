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
3. ~~Long-session soak~~ — DONE (soakChaos): 30s wall, 5+ reconnect
   cycles, 156 evs contiguous across every drop, tail-quarter
   prediction p95 3.2m. Debug produced a replay forensics hook
   (per-reclaim ev audit on the bridge). Found: ChaosLink per-frame
   jitter reorders — UDP-faithful, not TCP; the WS downlink must be
   order-preserving in profiles. The underlying reorder-drop IS a
   real hole on datagram transports (client only max()s the ev
   cursor — no gap heal) — see lane 6.
4. ~~Snapshot reseed convergence under chaos~~ — DONE (reseedChaos):
   staged authority simState lands after a 1.5s dark outage + 200ms
   delivery lag; 2.6m pre-seed residual re-centers to tail p95 3.7m.
   Proved the drift was real before the seed (residual gate >0.5m).
5. ~~Clock-skew tolerance~~ — DONE (clockSkew.test): wire carries no
   client timestamps by design; only leak channel is the client's own
   prediction dt. Skewed rAF 0.8x/1.25x drifts stay correction-bounded
   (tail p95 2.2m / 3.5m vs unbounded walk-off). clockHint itself was
   never needed — the trust boundary already excludes client time.
6. **Datagram ev-gap heal** — if a datagram transport (WT/RTC) ever
   carries reliable frames, an out-of-order durable ev is silently
   dropped by the max() cursor; needs a reorder window or NACK-gap
   reclaim. Dead code while production stays WS-only.

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
