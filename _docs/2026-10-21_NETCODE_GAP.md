# Netcode Gap Analysis — vs. production browser shooters + reference netcode

2026-10-21. Honest inventory of what the wire layer does today, measured against
the published architectures it competes with.

> **2026-10-22 status update** — landed since this report:
>
> - **Binary `inputMove` on the fast lane** (WIRE_INPUTMOVE): edges+status now
>   ride the ~7ms binary lane instead of the ~60ms JSON lane; 11-19B vs ~140B.
> - **`WIRE_JSON` fast lane for combat claims**: all claim/intent types can
>   ride the binary lane through the same validation path (~50ms earlier
>   arrival at the server vs the JSON lane).
> - **Sub-tick claim ordering** (the Gap-1 fix): `drainCommands` sorts by
>   clamped `fireAt` — forged deep-past stamps clamp to `arrival−(2×transit+100)`;
>   `cmdOrder.test.ts` pins it.
> - **Dead-writer starvation fixed (the dual-demo catch)**: `WtServer.pumpBin`
>   could exit (throw or lane death) leaving `binWriter` non-null → every tick
>   wrote into a dead stream while the JSON lane still trickled keepalives —
>   the "inbound lane dead 26605ms, only inputSync trickles" window measured
>   live as worst-seat mean 181m / p95 347m replica divergence. `write()`
>   rejections now drop the writer (both ends) so the next frame reroutes to
>   the datagram/JSON fallback; client `tiersWebTransport` mirrors it.
>   **Post-fix dualDiff: PASS — worst mean 5.7m, p95 19.7m** (7 seats).
> - **Parity rate rollup**: kb-echo / nugrest / dmg-echo now show
>   misses-per-stamp percentages in Alt+Q, not raw counts.
> - **Direct-hit blast bloom parity**: server now applies
>   `directHitAoeBonus` (×1.5 radius on body hits) — was the systematic
>   annulus mismatch behind most `parity-kb-echo`/`nugrest` noise
>   (`blastBloom.test.ts`).
> - Report corrections: the `TickLoop` lead, the deadline-aware scheduler,
>   and `seg-div` were all *already correct/already shipped* — misreads fixed
>   inline below.
>
> Residual fixes (2026-10-22, second pass): `seg-div` now suppresses
> predicted-impulse windows (`lastPredImpulseMs` on the net bag) — the
> residual was predicted-vs-server impulse disagreement, not replay drift.
> `remote-buried` gates on `fieldD < -0.4` (wire under the sim's own
> field) — rendered-chord comparisons fired on every gully rest. `kb-echo`
> rim class reduced at the source: `predictLocalShove` evaluates at the
> rewound self pos (ping/2+50ms) — the position the server shadow actually
> sees — instead of the live pos. `WtServer` raises the addon's
> `backpressureTimeoutMs` (5s→30s) and `idleTimeoutMs` (60s→180s) — the
> QUIC-level empty-reason teardown on slow-draining clients was the
> plausible `session.closed` root; our own watchdogs own real death now.
>
> Remaining open: the seg-div replay-drift tail (1 event/45s at boot on
> the last soak — likely join-window), the deeper QUIC-level
> `session.closed` cause inside the native addon (bounded by the
> backpressure raise + dead-writer fix; root is below our layer), and
> `check.sh`/Git-Bash not yet run on this box.
>
> Residual fixes (2026-10-22, third pass — remote render truth):
>
> - **Remote knockback prediction REMOVED** — supersedes line ~132 below
>   ("remote players get predicted knockback on observed blasts"). A wrong
>   estimate launched bodies where the wire never went (sling-then-warp);
>   blast + DiscPull client prediction on remote victims is off, wire
>   shoves arrive in ~4 ticks via `forceSend` (`blastShove` observer-wire
>   scenario test). Local player's own shove prediction is unchanged.
> - **Lag comp is now FULL view-epoch rewind** — supersedes the `0.7
>   shooter's advantage` factor (lines ~77, ~218). Client reports actual
>   sample staleness (`interp.viewLagMs`, extrapolation-aware); server
>   rewinds to that literal epoch in `combatBlast`/`beamSweep`/
>   `projContact`/`CombatHandler`. `fireAt`/`combatAoe`/fire mirrored
>   origins dropped the +1.6 eye offset — muzzle IS the eye.
> - **`clampWireGap` was generating the warp it guarded against**: on
>   reconnect it teleported the body inside the leash; now rate-limits
>   the pull to reachable speed capped at `REACH_CAP` (a real-wire run
>   caught a 616 m/s teleport-seeded converge velocity). `silencePeakMs`
>   preserves the earned silence budget across reconnect.
> - **`projectileCreated` echoes carry server wall-ms `t`** — replica
>   epoch = `age + (serverNow − t)`, echo transit measured not guessed.
> - **liveMonitor.ts** — opt-in invariant recorder (wire-gap,
>   render-drift, impossible-motion, dup-hit, parity echoes) readable via
>   `__monitor.dump()`. First real-wire 30s run: 184 shove events
>   (12–27 m/s) all delivered, zero sling events; residual = converge-mode
>   ~1–2 m cap pokes + respawn teleports.
>
> Still open from this pass: converge slightly exceeding `wireGapCap`
> (~1–2 m pokes), one residual `impossible-motion` class, `dup-hit`/
> `dmg-echo srvAt:none` spam (likely ledger noise, not motion).



## The bar, as actually published

| Reference | Sim cadence | Model | Key tricks |
|---|---|---|---|
| **Overwatch** (Ford, GDC'17) | 16ms cmd frames (60Hz; 7ms esports) | Server-auth + client prediction | Client runs ~RTT/2 + 1 frame *ahead*; deterministic sim shrinks mispredictions; prediction covers movement + abilities + hit-reg; corrections re-cast misapplied actions; only ~3 systems touch netcode |
| **CS2** ("sub-tick") | tick + per-event µs timestamps | Server-auth | Every input carries an exact timestamp; server reconstructs intra-tick ordering and rewinds to the *click instant* — decouples input fidelity from tick rate |
| **Source/CS:GO** | 20-30Hz snapshots | Server-auth | Delta-encoded snapshots + ack numbers; `cl_interp` ~100ms adaptive buffer; ~1s lag-comp rewind ring; client predicts local movement only |
| **Rocket League** (Cone) | 120Hz physics | Deterministic input + rollback | Resim from authored input history; remote inputs decay to hide corrections |
| **Krunker** | ~10Hz server (!) | Server-auth WS | Client prediction, tiny rooms (≤8p). The "feels fine" floor is *very* low |
| **Narrow One** | undisclosed, ~30Hz class | Server-auth WS | Prediction + interp + projectile ballistics, 5v5 |

## What we already have (verified in code)

- **Server-authoritative sim** at 20Hz (`CONFIG.tickRate`), shared deterministic
  `shared/movement.ts` between client predict, server shadow, netbots, offline.
- **Delta-encoded position frames** (30-37B binary): seq + ping + inputSeq +
  held-input supersede stream, last-decoded basis, forced-full ~750ms —
  Source-style acked deltas, self-healing under loss.
- **Input redundancy**: superseding input stream rides every frame; inputSync
  re-emits unconsumed seqs.
- **Client prediction + correction**: input journal, rewind-resim, `corr`/`seg-div`
  telemetry.
- **Lag compensation**: per-victim rewind with shooter-reported `renderLag` map,
  `back = transit + lag − targetTransit` at 0.7 shooter's advantage, ghost-hit
  telemetry (`gd` distance on every credit).
- **Lag-comped projectile bodies**: server-simmed shells (not claimed arcs) +
  swept segment contact, `hitRadiusAt` growth, arming fuses.
- **Claim stamping + exactly-once replay**: `claimSeq` dedupe with verdict replay,
  `shotId` shell nonce, intent journal covering shotFired/deploy/slam with a 10s
  reconnect window, idempotent re-application.
- **Reconnect/reclaim** with room-scoped replay, session tokens, dropsock-tested.
- **Adaptive interp delay** — jitter-tracked, dead-reckon fallback, steering cap.
- **Distance-tiered sends** + edge/committed-snapshot model for non-players.
- **Transport tiering**: WT datagrams → WT reliable → WS, with degradation +
  recover on teardown.
- **Rate limits + validators** per wire type; move-judge cheat ledger; server
  health counters.
- **Test rig**: 64-real-socket fanout soak, replay/reclaim/damage-depth probes,
  deterministic scenario suite (~465).

## Where we sit vs. the bar

Krunker and Narrow One are honestly **already beaten** on paper: 20Hz > 10Hz,
deterministic shared sim, lag comp, prediction, tiered transports, proven
64-socket fanout. What keeps us below *Overwatch/CS2 polish* is not the model —
it's a short list of fidelity and resilience details:

### Gap 1 — Intra-tick ordering (CS2 sub-tick equivalent)
Claims fire at *tick arrival*, not at the click instant. At 20Hz a tick is 50ms —
two shooters within one tick resolve in **packet-arrival order**, not click order.
`fireAt` already rides every claim (bounded ±2s). **Fix:** sort combat claims by
`fireAt` within a tick window before adjudication (clamp to sender's measured
transit); rewind to the stamped instant rather than "this tick". Cheapest CS2
equivalent we can build without a sub-tick frame format.

### Gap 2 — 20Hz sim cadence
Overwatch runs 60Hz; a 50ms quantization window caps hit-reg precision at
±50ms regardless of rewind fidelity. `tickRate` is env-configurable — a
30-40Hz bump halves the worst case; tick frames are already small. Cost:
linear CPU. This is a knob, not a rewrite — worth a measured trial at 30Hz.

### Gap 3 — Edge-loss recovery granularity
Reclaim on drop sends a full gameState; mid-stream lost edges rely on the next
edge or the reclaim storm. Source-style per-recipient edge acks would let the
server resend just the lost edges during a degraded-but-alive session (the
WT-lane partial-loss case). We have `ackSeq` on tick frames — the plumbing
exists for positions; edges don't ride it yet.

### Gap 4 — WT mid-life teardown (closed — headless artifact)
`session.closed` resolved with empty reason at ~72-105s in headless soaks —
QUIC-layer close under headless Chrome. **Headed repro (2026-10-22):** three
consecutive 150s+ headed-Chrome soaks at `net=wt` with real WAN netbots in the
room (cloudflared quick tunnel, ~45-55ms RTT) — `tier=wt` held end-to-end every
run, zero reconnects, zero intent replays. The empty-reason teardown does not
reproduce outside headless CPU-throttled Chrome. Closed as a test-harness
artifact; the degrade→fallback recovery stays as the roam/UDP-block story.

### Gap 5 — Prediction coverage for remote-side shove
We predict the *local* player's blast shove and stamp it; remote players get
predicted knockback only on observed blasts. The residual kb-echo class
(rewind-vs-live at the blast rim) is inherent — bounded by shrinking ghost
error (better interp delay tuning, faster tick). Not a missing feature —
a residual to keep measuring.

### Gap 6 — P2P host path is a second authority model
Dedicated server is the clean path; the P2P host path still fields legacy claim
verdicts and does not run the same adjudication budget. If production stays
dedicated-first this is tolerable; if P2P is the default deploy, the host path
needs the claim fence already used on dedicated.

### Gap 7 — Asymmetric transit measurement
Diag shows `ping 7ms / srvPing 61ms` on WT — the server's uplink estimate runs
~8× the client's measurement on the same session. If systematic, the rewind
window is over-wide by ~50ms and ghost-credit inflation follows. One instrument
(one-way-timestamp on a position frame echo) would tell us if it's real.

## The plan — ordered by value-per-risk

1. **Wire claim ordering by `fireAt`** — sort each tick's combat claims by the
   stamped instant (bounded, transit-clamped). One day, one scenario test,
   closes the "I fired first" class forever at our tick rate.
2. **Tick-rate trial at 30Hz** — `FPS_TICK_HZ=30`, soak 64 clients, measure
   stall rate vs 20Hz baseline; keep if window-stall stays at zero.
3. **Edge acks** — ride `ackSeq` for reliable-edge sequences per recipient;
   resend lost edges inside the same session instead of reclaim.
4. **Transit symmetry probe** — echo a position-frame's server-arrival time back
   on the next tick frame; log asymmetry before changing math.
5. **WT teardown repro in headed Chrome** — confirm scope before touching QUIC.
6. **P2P claim fence** — iff P2P ships as the primary deploy mode.

---

## Deep dive — the non-obvious stuff that actually matters to us

### D1. Cross-engine float determinism — VERIFIED CLOSED (rare, worth recording)

The trap nobody else has: our "shared deterministic sim" runs in **JSC (Bun)
server-side vs V8 (Chrome) client-side**. ECMA-262 explicitly leaves
`Math.sin/cos/atan2/hypot/…` implementation-approximated — documented 1-ulp
differences on real inputs (measured here: atan2 on 22% of inputs, hypot on
41%, sin/cos ~1.5%). Sub-ULP divergence compounds per tick into phantom
corrections.

**Already handled**: `shared/dmath.ts` — Cody-Waite+fdlibm implementations
using only +−×÷ and `Math.sqrt` (correctly-rounded, bit-identical across
conforming engines). `movement.ts` rides `dsin/dcos/dhypot`; a `sharedPurity`
gate bans native `Math.*` in replayed shared files outside a server-only
allowlist. Residual risk: someone adds a divergent call in a replayed path —
the purity gate is the enforcement, keep it loud.

### D2. Input redundancy — we carry 1-back; Quakeworld carries 3

`inputStream.ts` already rides `prev` on every `inputMove` (held state + prev)
plus `inputSeq` supersede plus `inputSync` re-emit on the server's word.
Quakeworld/FTE precedent (`cl_c2sMaxRedundancy`, locked 3 for vanilla) packs
the last 3 input frames per packet — a single drop costs nothing, a 2-3 burst
still heals inside one RTT. We heal on the next frame anyway because held
state is idempotent — the only exposure is a *one-shot edge* (jump-press,
switch) straddling a 2-drop window, and Player.ts already notes the
phantom-rising-edge care taken. **Upgrade only if instrumented**: add a
drop-burst counter; if 2-drop bursts are real on WT datagrams, ride `prev2`.
Not a fire to fix pre-measurement.

### D3. WebTransport production reality (NSDI'25 browser-net paper)

Measured: WT datagrams ≈ DTLS-UDP RTT under loss; WS/TCP pays head-of-line
retransmit latency; WT congestion control is BBRv1 (latency-tuned, not
throughput). Our three-tier stack (WT datagram → WT reliable → WS) is the
browser-optimal shape — better than Krunker (WS only) and matching what any
current browser game can do.

Known real-world edges we should name:
- **QUIC connection migration is not implemented in Chrome's WT** — an IP
  change (WiFi→LTE, VPN flap) *kills the session*; our reclaim/replay path
  is the answer and it's already proven. Likely the class of our
  empty-reason ~72-105s teardown under headless CPU starvation.
- UDP-blocked networks (corp/school) → automatic WS fallback exists; make
  sure the fallback *doesn't* retry WT on a hot loop (cost = a reconnect).
- `session.closed` carrying empty reason is a Chromium artifact — we log it;
  headed-Chrome repro decides whether it's real-user-visible.

### D4. Lag-comp bounds — already at the Source bar

Source caps rewind at `sv_maxunlag` ≈ 1.0s; we cap `lagMap` at 800ms plus
`ghostBack`. Shooter-advantage factor (0.7) ≈ the same "favor the shooter"
trade Source ships. Ghost-hit telemetry (`gd` per credit) already rides the
HUD complaint feed — the diagnostic AAA shops rely on, present.

### D5. Tick-scheduler real-world edge — the bigSoak stall

CORRECTED (second misread): `TickLoop` already deadline-compensates —
`next += tickMs` chases absolute wall deadlines, overruns resync forward
with `ticksDropped` counted, `tickLagMs` metrics ship. The bigSoak
window-3 stall was pure event-loop starvation (no scheduler can tick
while starved) — no fix needed; keep the metric as the canary.

### D6. Real-world seamlessness specifics

- **Corp/school networks**: UDP blocked → WT never opens → WS tier covers it
  (verified: `net=ws` soaks clean). Captive portals break at connect, not
  mid-game.
- **Tab hidden**: `isTabHidden` gate stops spawn/suppresses fire claims —
  rAF stalls are a browser fact, handled.
- **Zombie seat**: `lastLiveRxAt` excludes `inputSync` precisely so a
  dead-inbound session declares dead instead of living on starvation
  keepalives — the lane-liveness tests pin it.
- **CGNAT/mobile roam**: session dies on IP change (D3) — reclaim covers it;
  the cost is a visible ~2-4s reconnect, unavoidable without a relay.

### D7. What CS2's sub-tick *actually* is (for the Gap-1 work)

Not a faster tick — **exact timestamps on each input**, with the server
reconstructing event order inside the tick. `fireAt` already rides every
combat claim (bounded to ±2s of transit). The cheap version: sort each
tick's combat claims by `fireAt` (clamped to the sender's measured transit
window) before adjudicating; rewind targets to the stamped instant rather
than "this tick". Closes "I fired first but lost" at any tick rate.

### D8. Higher tick rate — what it buys and what it doesn't

At 20Hz: ±50ms quantization on *arrival ordering* (fixed by D7 without a
rate change), ghost-freshness at snapshot granularity (improves with rate),
and linear CPU cost. 30Hz halves the worst residual; 60Hz is marginal
further. **Knob, not rewrite** — the trial is an env var + a soak.

### D9. The deterministic-replay determinism chain

Room RNG is seeded; sims step on measured sim-time (never wall); `hmChord`
and field surfaces are shared. The known residual: `bot*` files keep native
`Math.*` (server-only, allowed — they never compare bits). If a bot input
ever replays client-side (demo-mode bot film), that exception needs a dmath
pass first.

### D10. The one thing the references do that we don't

**Deterministic correction cost accounting.** Overwatch's model prices a
misprediction (re-cast ability, re-fire weapon) as a designed event with
cost. Ours is movement-correct: a predicted shot that the server rejects
costs the *aim* — the muzzle flash fired, the target didn't drop. The
worst-case the user named — "client predicts damage, server rejects it" —
is the same class, now covered by `expectDamageEcho` stamps + the replay
dedupe. What we lack is a **per-claim prediction-ledger health metric**:
each claim kind's mispredict-rate in telemetry, so a climbing phantom-hit
rate reads as a regression before a player reports "the disc through him".
The instrumentation hooks exist (`parityMiss` already counts) — the missing
piece is a per-kind rollup in the Alt+Q dump + a scenario test bound.

---

## Deep dive part 2 — the lane asymmetry findings + real-world numbers

### D11. The lane-asymmetry discovery (from our own diagnostics)

`ping 7ms / srvPing 61ms` in a live Alt+Q dump is not noise — it's the
**two lanes measured honestly**:

- **Datagram lane** (positions): `rttMs` from binary position frames,
  ~7ms. `clientTransitEma`.
- **Reliable lane** (claims, ping/pong, events): server ping/pong RTT,
  ~61ms. `serverTransitEma` — and `syncTransit()` lets the server
  channel **own** the estimate once it exists.

Consequence chain — CORRECTED after code review (initial read was wrong):
- `TickLoop`'s `lead = transitOf/2000` is **correct as written**: the lead
  compensates the shadow's *uplink staleness* (inputs land ~60ms late on
  the reliable lane), not the observer's downlink. Leading by ~30ms
  re-centers the systematic lag. No fix needed — the report's earlier
  "ghosts lead ~1m too far" claim was a misread.
- The real asymmetry: **held input already rides position frames at ~7ms**
  (the 3B superseding slot, `moveClaims.handlePosition:75-80`), but
  **inputMove edges + status bits ride the ~60ms JSON lane** — rising-edge
  skill antes and edge ordering lag the held-state shadow by ~50ms.
  Fix: binary inputMove on the fast lane (Task in progress).
- **Claims ride `send()` → JSON reliable stream → ~61ms intent transit.**
  They're ~100B, carry `claimSeq` + verdict dedupe (retransmit-safe by
  construction), and claimAck gives exactly-once. Moving combat claims
  onto the fast lane is the single largest perceived-latency win
  available short of raising tick rate.

### D12. Peeker's advantage — quantified for us

Formula (Valorant's published model, TG'26 paper concurs):
`advantage ≈ peeker uplink + server frame + defender downlink + interp delay
+ defender frame time`

Our terms: uplink ~7-60ms (lane-dependent), **server frame = 50ms at
20Hz** (vs Valorant's 7.8ms at 128Hz), downlink ~7ms, adaptive interp
~50-150ms, client frame 8-16ms.

The **50ms tick frame is the largest controllable term** — the honest
case for a 30-40Hz trial (shrinks it 17-30ms). TG'26's caveat worth
repeating: client *framerate* is the dominant measured factor — our
per-frame budget discipline (the perf ledger in the dump) matters more
for fair fights than the last Hz of tick.

### D13. Real-world UDP/QUIC numbers (Google-scale measurement)

From Google's QUIC deployment data and the YouTube-over-QUIC middlebox
study:

- **UDP impaired for ~5% of users**: 0.3% rate-limited, 0.2% blocked at
  access border, 4.5% blocked near the user. Our WS fallback covers it —
  requirement is *automatic, non-flapping* degradation.
- **NAT UDP timeouts**: median ~3min, minimum ~30s idle — our 20Hz tick
  stream keeps the flow permanently warm, a non-issue.
- **Blind QUIC↔TCP racing hurt YouTube QoE in 70% of fallback events** —
  the lesson: once we degrade WT→WS, stay degraded for the session
  (don't re-race on every hiccup). Check the tier-degrade hysteresis —
  a flap is worse than either lane alone.
- **Connection racing at connect** is what Chrome does for HTTP/3 —
  our tier probe already races WT first; keep the WS path warm enough
  that fallback costs <1 tick of visible stall (already proven by the
  reclaim tests).

### D14. Client clock precision for sub-tick ordering

`performance.now` is **0.1ms coarsened** in non-cross-origin-isolated
contexts (Chrome), ~**1ms on Firefox/Safari** — Spectre-era mitigations.
`fireAt` inherits that. For intra-tick ordering (D7) 0.1-1ms is more
than enough — transit uncertainty is ~10ms, 100× coarser. Not a gap;
noted so nobody burns a COOP/COEP header for no benefit. (COEP
`require-corp` would also break third-party asset embeds.)

### D15. What Overwatch does that we can steal cheaply

Two specifics from the Ford talk beyond the model:
- **"Undo" over correction**: when a prediction proves wrong, they
  re-cast the ability at the corrected instant so the player keeps the
  *intent* — our claim journal + replay is the same idea at the transport
  level. Movement-side, corrections already replay journaled inputs —
  matched.
- **Only three systems touch netcode** (movement, weapon, state) — our
  analog is the shared/* + game/net/* boundary; worth keeping hard.
  The netcode-surface rule: anything that predicts or claims goes through
  the journal or the stamp ledger — the `parityMiss` canaries are the
  enforcement, and they're working.

### D16. The residual diagnostics, ranked by what they'd tell a player

- `seg-div` — CORRECTED after tracing `stepBall`: inputs are already
  symmetric by design (server replays the *committed* target snapshot —
  `BallSim.ts:353` — teleport/spawn map to `hard` and skip the probe).
  The residual is inherent epoch asymmetry: the client's predicted ball
  shove computes `dir` at the client's ball position; the server
  computes it at the server's ball position — transit × ball speed of
  positional disagreement on every blast-hit, plus BallCombat's clamp
  the client doesn't mirror. Segments already carry resolved pos/vel.
  Verdict: bounded, classified, cosmetic-vs-gameplay (ball is ambient,
  not a player); a wire-carried impulse would only improve telemetry.
- `teleport-above-ground` ~0.8m under — spawn/teleport landing edge;
  widen the grace or clamp landing to `groundY + 0.1` server-side.
- `teleport` claim trust — declared teleports honored rate-limited;
  under speed-hack pressure they're a teleport-anywhere lever — the
  moveJudge already catches jumps via repJump counters; keep.
- `parity-nugrest`/`kb-echo` — bloom fix landed; residual is ghost-band.
- WT empty-reason teardown — D3/D11 context: likely QUIC-layer under
  headless starvation or migration-adjacent; headed repro pending.

## Updated plan — ordered by value-per-risk

1. ~~**Binary inputMove**~~ — LANDED: `WIRE_INPUTMOVE` + `sendInputMsg`;
   edges/status ride the position lane; unordered-lane reorders cancel
   their own misses via `pendingMissed`/`reorderCancels`.
2. ~~**Claim ordering by `fireAt`**~~ — LANDED: `drainCommands` sorts
   clamped stamps; `cmdOrder.test.ts` pins it (incl. forged-past clamp).
3. ~~**Claims on datagrams**~~ — LANDED: `FAST_LANE` claims ride the
   binary lane as `WIRE_JSON` (same parse/validate/dispatch server-side);
   shotFired/deploy/slam journal + `replayFireIntents` on re-seat;
   `seenShots`/`claimVerdicts` give exactly-once. Plus **ack-driven
   resend** (claimLedger): unacked stamped claims resend verbatim up to
   2× at ~2×RTT — the in-session edge recovery reclaim couldn't cover.
4. ~~**Tick-rate trial at 30Hz**~~ — LANDED: `FPS_TICK_HZ=30` netbot soak
   green (64-client bigSoak ~28-31Hz delivered, 0 rejects); 30Hz is proven
   viable. Default stays 20Hz — flipping is a deployment decision.
5. ~~**Edge acks**~~ — mostly LANDED via item 3's resend; JSON-stream
   edges still ride the ordered reliable lane (loss there = lane death =
   reclaim), so per-recipient edge seqs are only needed if edges ever
   move to datagrams.
6. ~~Deadline-aware tick scheduler~~ (D5-corrected) — already shipped.
7. **seg-div input broadcast** (D16) — one wire field, kills the residual.
   Deferred deliberately: classified cosmetic-vs-gameplay (ball is
   ambient), the impulse wire-field only improves telemetry.
8. ~~**Mispredict-rate rollup**~~ — LANDED: `parityStamp`/`parityMiss`
   print misses/stamps as rates per kind in the Alt+Q dump.
9. ~~**WT headed repro**~~ (Gap 4) — DONE: headed+WAN soak ×3, no teardown.
10. **P2P claim fence** — if P2P ships as primary.

## Landed since this doc — WAN soak results (2026-10-22)

- **cloudflared quick-tunnel soak**: 8 netbots over real `wss://` WAN
  (~45-55ms RTT), 479 shots / 105 hits / 8 kills / 0 rejects / 0 corrections.
- **Headed mixed soak** (`_tools/e2e/_wtsoak.ts`): headed Chrome on `net=wt`
  + 6 WAN netbots in one room; per-remote interp counters polled live.
- **interpDelay oscillation fix** (remoteSnapshots): the delay target now
  rides a slow EMA and BOTH inflate/deflate slew — WAN jitter had been
  breathing the render window ±100ms, rendering as remote lurch despite a
  full snapshot buffer. Speed cap still clamps the output.
- **soak `--net ws|rtc|mixed`**: random per-bot transport assignment
  (rtc needs node-datachannel; degrades to ws with a warning).

## What we are deliberately NOT doing

- Full rollback/GGPO on remote entities — costs client CPU + complicates every
  interaction for benefit our lobby sizes don't need (Overwatch agrees: remotes
  stay interpolated).
- >60Hz default tick — cost linear, benefit near-zero under interp+lag comp.
  Esports-tier 7ms frames are a deployment knob, not a baseline.
- Trusting client timestamps — every `fireAt` is clamped to measured transit;
  ordering-only, never authority.

## Status of residual diagnostics (for the ledger)

- `parity-nugrest`/`kb-echo` — systematic annulus source **fixed** (direct-hit
  bloom now mirrored server-side, `blastBloom.test.ts` pins it). Rim residual
  = ghost-error band, shrinks with Gap 1/2 work.
- `seg-div` — ball replay input-side drift; separate mechanism, diagnostic only.
- `teleport-above-ground` at ~0.8m under — threshold-edge cosmetic.
- WT empty-reason teardown — Gap 4.
