# Netcode Deep Dive #2 — literature → this codebase, gap analysis, plan

Round two. The first doc (`2026-10-18_NETCODE_OVERHAUL.md`) diagnosed the
transport collapse and the render-stall loop. This one maps the published
netcode canon onto the code we actually have now (post fast-path, post
shadow-map fix), and finds the remaining gaps are smaller — and more
specific — than "rethink everything".

## Sources

| Work | What it contributes |
|---|---|
| Frohnmayer & Gift, *The TRIBES Engine Networking Model* (GDC '99, [PDF](https://www.gamedevs.org/uploads/tribes-networking-model.pdf)) | The reference architecture for THIS game. Five stream managers with distinct delivery guarantees: Event (reliable, ordered), Ghost (partial state, eventual consistency), Move (input, newest-wins), Datablock, String. Packet-delivery *notification* (piggybacked acks) instead of per-packet reliability. |
| SnapNet, *Netcode Architectures Pt.4: Tribes* ([link](https://www.snapnet.dev/blog/netcode-architectures-part-4-tribes/)) | Ghost = client replica, eventual consistency. Control object gets guaranteed latest-state + last-consumed-move seq per update → rewind+replay reconciliation. |
| jfedor.org *Quake 3 Network Protocol* ([link](https://www.jfedor.org/quake3/)) + Sanglard's review | One UDP pipe; snapshots delta-compressed against last-acked baseline; reliable commands ride INSIDE unreliable packets and re-include until acked. "Information not received on first transmission is not worth sending again." |
| Valve, *Source Multiplayer Networking* ([PDF](https://radwan92.github.io/assets/pdfs/Source%20Multiplayer%20Networking%20-%20Valve%20Developer%20Community.pdf)) | cl_interp 100ms render delay; buffer survives one lost snapshot; extrapolation capped at 250ms; server-side lag compensation rewinds by ping + interp delay — the client does NOT send "I hit X", the server replays history. |
| Gaffer on Games: state sync, snapshot interpolation, snapshot compression | Jitter buffer is mandatory (packets clump); delta compression needs ack baselines; input redundancy; "never send snapshots over TCP". |
| Mirror `SnapshotInterpolation.cs` + docs | Adaptive bufferTime = sendInterval + jitter·k; timescale catch-up/slow-down instead of hard snaps; dynamic delay from jitter *standard deviation*, not arrival gaps. |
| Overwatch netcode (Ford, GDC '16 + dev updates) | "Favor the shooter"; high-frequency ring-buffer sim states; 20.8→63Hz "high bandwidth" mode — tick rate is a bandwidth/latency dial, not a religion. |
| W3C WebTransport explainer + Chrome docs | Streams = independent reliable FIFOs (no cross-stream HOLB); datagrams = unreliable unordered, congestion-controlled "UDP with consent". |
| RTCDataChannel reliability model (MDN, webrtc.smnandre.dev) | `ordered:false, maxRetransmits:0` = UDP-like; `maxPacketLifeTime`/`maxRetransmits` = partial reliability — a third lane WS can't express. `bufferedAmount` + `bufferedamountlow` = the only send-side backpressure API. |
| NSDI'25 browser-networking paper (from round 1) | Measured: WS≈TCP behavior under loss; WT datagrams preserve freshness; RTC DC sits between. |

## What we already have — mapped to canon

The audit found this codebase is *not* naive; most of the canon is already
here under different names:

| Canon piece | Ours | Where |
|---|---|---|
| Tribes Ghost manager (eventual-consistency replicas) | Non-player objects stream state **edges** + both ends replay shared sims | `ballSegment`, `shared/stepBall`, prey `knock` edges |
| Tribes Move manager (input journal + last-consumed seq + reconcile) | input journal, `inputSeq` ack in tick frame, CFWK rewind+replay on `correction` | `playerInput.ts`, `net/players.ts onCorrection` |
| GGPO-style input redundancy | `inputMove.prev` piggybacks the previous edge | `shared/protocol.ts` |
| Source snapshot interpolation (100ms + jitter) | `SnapshotBuffer`: adaptive delay, Hermite-on-wire-velocities, 250ms extrapolation cap, server-time timeline (not arrival time — right) | `entities/remoteSnapshots.ts` |
| Mirror dynamic delay | `arrivalJitter` EMA + `arrivalInterval`-aware delay + slew-limited deflate | `remoteSnapshots.ts` |
| Quake "latest wins" superseding stream | `WorkerTransport.coalesceTickFrames` drops stale seq'd tick frames client-side | `WorkerTransport.ts` |
| Quake reliable-in-unreliable | Reliable events journaled server-side, replayed on `resumeSeq` reclaim | `ConnectionManager` journal |
| Valve lag compensation | `pushRewindSample` per-player history, `REWIND_MS` covers ping + interp delay | `rewind.ts`, `moveClaims.ts` |
| Overwatch "favor the shooter" | Server-simmed projectiles + claim adjudication + `claimAck` verdicts | `CombatHandler`, `claimLedger` |
| Socket.IO state recovery | Session tokens, grace reclaim, `gameState` reseed | `SessionManager`, `NetworkManager` |
| Ingest vs tick-drain | Telemetry + `position`/`inputMove`/`teleport` now fast-path at ingest (loopback RTT 65→2ms measured) | `GameServer.handleGameMessage` |
| Interest management (DynFilter) | Distance-tiered send suppression + `atExtCap`→DR handoff | tick records interest tiers |

## The remaining gaps, ranked

### G1 — The "47% WT datagram loss" measurement is almost certainly wrong

`sendBinaryToPlayer`'s own comment: tick frames were moved to the reliable
lane on ALL transports because "measured WT datagram loss on loopback was
~47%". But the loss metric counts *tick-sequence cadence gaps* — the same
metric that reports 3–7% "loss" on TCP loopback, where transport loss is
provably zero. A 47% reading on loopback QUIC is not plausible; the likely
real causes were arrival batching (readable queue draining in bursts) or
seq-gap-as-loss semantics identical to the TCP artifact.

**Why it matters:** this is THE friends-online fix. On WT, tick frames on
datagrams + events on a reliable stream is exactly the Quake3/Tribes lane
split — superseding state can't be held hostage by a retransmitted event.
If real datagram loss is ~0% on loopback, the reliable-lane decision was
made on a broken ruler.

**Action:** re-measure honestly — N datagrams with real seq counters, count
received/lost/out-of-order, across loopback and (if possible) a lossy
profile. `_tools/pvptest/` already has harsh-WAN profiles for netbots;
add a WT-datagram variant probe before touching the send path. If loss is
low, gate `sendBinaryToPlayer`'s lane by transport kind: datagrams on WT,
reliable on WS/RTC-reliable. `coalesceTickFrames` already tolerates loss
by design (it was built for exactly this).

### G2 — TCP's structural ceiling on WS is *send-side*, and ours is blunt

On WS everything is one ordered stream. Client-side coalescing heals the
*receive* burst, but the server can't retract bytes already in the kernel
buffer — a stalled reader replays up to `MAX_TICK_BACKLOG` (256KB ≈
several seconds) of stale ticks interleaved with events before the drown
clock fires. For remote friends this is the "slow-motion replay then
disconnect" pattern.

**Cheaper than a rewrite:** shed at a much lower watermark on the *tick*
lane (e.g. 64KB) and make the drown verdict escalate: sustained shed →
send a `resync`-equivalent kick or close with an explicit reason code
(we already send close reasons — add "drowned"), so the client reseeds
instead of slow-motion replaying. The journal already covers event
replay; nothing correctness-critical is lost by shedding ticks harder.

### G3 — `loss`/`lag` telemetry conflates four different things

Current `loss` = tick-seq cadence gaps (fires on arrival clumping,
suppression tiers, AND genuine loss). For diagnosis we need the split:
- `seqGap` — tick seq jumps on the superseding stream (true wire loss
  on datagram tiers; on TCP it means *server shed* or *starved drain*)
- `shed` — server already counts `tickFramesDropped`; surface it in the
  tick ack or `clientStats` reply so "loss" has a named cause
- `deliveryLag` — worker→main delay (already measured, max 159→18ms
  after the GL fix — keep it separate from wire loss)
- `coal` — coalesced count (already reported)

Cheap change, big diagnostic win: the HUD/`clientStats` stop crying
"packet loss" for arrival jitter.

### G4 — Combat claims still park in the tick command buffer

Right call for ordering (claims adjudicate against sim state), but it
means a hit claim lands 0–50ms later than it could. Research consensus
(Overwatch "favor the shooter", Valve) says the *claim timestamp* is what
matters — adjudication should use the claim's `fireAt`/arrival time +
rewind, not arrival-phase ordering. Since rewind exists, claims can also
fast-path at ingest — the sim state they read is identical between
arrival and phase-0 drain anyway (single-threaded; nothing mutates
mid-window except earlier commands, which fast-path preserves in arrival
order). The one subtlety: a fast-pathed claim sees the newest positions
rather than wire-order positions — with rewind-by-timestamp that's
strictly *more* correct. Worth doing behind a flag + scenario test.

### G5 — 20Hz tick is a dial, not a constant

Overwatch shipped 20.8Hz then raised to 63 for high-bandwidth rooms.
20Hz costs us: 50ms server-side granularity on movement sim, and (now
that ingest is fast-pathed) the remaining quantization is mostly in the
*fanout* cadence — remote updates arrive at 50ms spacing minimum. A 30Hz
tick is a 1-line config change (`CONFIG.tickRate`) with ~1.5× BW+CPU —
worth an A/B soak, not a default. Defer until G1 lands; datagrams make
the cadence cheaper anyway.

### G6 — RTC middle tier is unverified

`?net=rtc` exists as the middle rung. For internet play it's genuinely
useful: SCTP channels support `ordered:false, maxRetransmits:0`
(UDP-like superseding lane) *plus* `maxPacketLifeTime` partial
reliability — a third delivery class WS can't express and Tribes' Event
manager would have used for "important but staling" data. Probe it the
same way `_wtprobe.ts` does before relying on it.

### G7 — Lag-comp window vs adaptive interp delay

`remoteSnapshots` adapts render delay up to 800ms on bad links;
`REWIND_MS` is sized to cover "clampPing(~400) + adaptive render lag
(~800)". The shooter's *actual* interp delay is reported via
`clientStats`/`interpDelay` — verify the claim path uses the reported
per-remote delay, not the fixed buffer worst-case, or deep-adapted
clients will hit-reg past the rewind window.

### G8 — The headhunt/pickup schema churn needs an E2E, not unit tests

`val`/`held`/`beltAcc`/armor-on-`yourHealth` are new wire fields mid-flight.
Every interactive outcome must round-trip: spawn→roster→collect→death-
scatter→reconnect-reclaim→gameState reseed. One scenario test +
`_hhsoak` is the right shape; tsc errors there are the user's in-flight
work, not netcode.

## Proposed phase order

1. **P0 — Re-measure WT datagram loss honestly** (seq counters, not
   cadence). If <5%: tick frames → datagram lane on WT only. Flag-gated.
   *This is the single highest-value change for real internet play.*
2. **P1 — Telemetry split** (`seqGap`/`shed`/`deliveryLag`/`coal`) so all
   later measurements are honest. Small.
3. **P2 — WS send-side policy**: lower tick shed watermark, drown →
   explicit close reason → client treats as resync, not death.
4. **P3 — Combat-claim ingest fast-path** behind flag + scenario test
   (uses `fireAt` + existing rewind).
5. **P4 — RTC tier probe + verify** (`?net=rtc`), same harness as WT.
6. **P5 — 30Hz tick A/B** behind `FPS_TICKRATE` env, soak both.
7. **P6 — Lag-comp window uses reported interpDelay** (per-victim).
8. **P7 — Pickup/held/damage reconnect-reclaim scenario tests** once the
   user's headhunt edits settle.

## Non-goals / rejected

- **Snapshot delta compression (Quake3 baselines)**: our tick frames are
  already small masked-field records; full delta-vs-ack machinery buys
  bandwidth we don't lack at ≤16 players. Revisit only if rooms scale up.
- **Full reliable-in-unreliable event channel on datagrams**: Quake3
  re-includes unacked commands inside every packet. On WT we get this
  free via a second QUIC stream — don't rebuild it in-app.
- **Raising send rate per-remote**: interest tiers already do distance-
  adaptive rates; keep them.
- **Deterministic lockstep / rollback netcode**: wrong genre — server-
  authoritative with prediction is correct for Tribes-style physics.

## Verification

- `bun _tools/pvptest/soakreport.ts <room> 120 4 1` — fleet WS soak
- `_tools/e2e/_wssoak.ts` — real-browser telemetry (ping/coal/lag/glitch)
- `_tools/e2e/_wtprobe.ts` — tier selection; extend for a datagram
  seq-loss measurement (P0)
- `cd server_bun && bun test` + `tests/scenarios/` — claim/resync paths
- `bash _tools/check.sh` — definition of done
