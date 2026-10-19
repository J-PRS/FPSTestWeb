# Netcode Deep Dive #5 — Wire Economics, GC/Execution, RTC Verdict, Anti-Cheat, Interest Mgmt

2026-10-18. Fifth pass: the layer below and above everything covered so far —
serialization economics, allocation/GC behavior on the tick path, whether the
RTC tier earns its keep, anti-cheat theory for our authority model, and
interest-management arcana. Research threads: wire-format literature (Q3/Source/
Gaffer/Overwatch/Tribes), RTC/NAT production data (fippo/IETF MAPRG/libjingle),
GC+WASM execution reality (V8 Orinoco / JSC Riptide), interest+anti-cheat+replay,
plus a fresh census of our own tick-path allocations.

## 0. What changed since dive #4

Landed: deadline-compensated tick loop (tickLag +11ms → -0.06ms), `shared/dmath.ts`
(bit-identical deterministic math — sealed the JSC/V8 ulp gap: native atan2
diverged on **22%** of inputs), event-loop-delay + tick-duration + bufferedMax
gauges on /metrics, LoAF observer, interp underrun/extCap counters,
WorkerTransport maxPending/lagMsMax into clientStats. So the #4 headline
(JSC/V8 determinism gap) is already closed — this report finds the *next* layer.

## 1. Wire economics — the honest audit

### 1.1 Where we actually stand (measured from the tree)

`shared/wire.ts` WIRE_TICK_V4: 15B header + per-player records —
**15B masked-minimum, 30B full** per player (pos i32@4cm, vel i16@0.1m/s,
yaw u16, pitch i16, delta-masked field groups, basis ring depth 3, forced-full
staggered every 15 ticks). Near-tier frame ≈ **~315B → ~50kbps/client** at 20Hz;
far tiers get fewer records via distance-tiered fanout (`tickRecords.ts:316-350`:
<150m every tick, <400m half, <600m third, beyond 1/8; `force` flag bypasses
tiers during hit/knockback windows). Records encode **once** against shared
delta basis `room.v4Last`; per-recipient frames concatenate into one shared
`frameArena` — only the per-recipient ackSeq/inputAck headers differ.

**Verdict: the two "essential" techniques from the literature — field-level
delta compression vs baseline + quantization — are already shipped.** The
remaining literature machinery mostly doesn't pay at our scale:

| Technique | Literature verdict | Our scale |
|---|---|---|
| Field-level delta vs acked baseline | essential (Q3/Source) | ✅ already shipped (v4 delta masks + basis ring) |
| Fixed-point + yaw/pitch quantization | essential (Gaffer) | ✅ already shipped (i32@4cm pos, u16 yaw) |
| Binary events (1-byte tag) | worth it | ⚠️ events still JSON; kill/pickup rates are sparse — JSON.parse server-side ~30-60KB/s = negligible. Cold lanes stay JSON |
| Columnar/SoA state layout | worth it (layout only) | partially — records path still object-per-record |
| zstd-dict / rANS per-tick | skip until >32p/>30Hz | ❌ absolute savings ~1-2KB/s of a 50kbps budget |
| XOR/RS FEC groups | skip | ❌ ticks already latest-wins; datagram lane demoted to fallback |
| Prior-tick piggyback on datagrams | 80/20 if datagrams primary | ❌ datagram lane is fallback-only after stream-2 won |
| `sendMany`/vectored fanout | free win, minor | n/a — WS sessions, not UDP sockets |

Budget context from the literature: Tribes targeted **2KB/s** on 28.8k modems
for 128 players; Q3's hard ceiling ~30KB/s; Source typical ~20-30KB/s at
66-tick. We sit at ~50kbps (~6KB/s) per client — comfortably low-end.

**Stagnant comment bug found:** `shared/wire.ts:538-539` still claims "pos(6)…
full record 24B" — pos went i32 (12B) a while ago; real sizes are 15B min / 30B
full. Harmless but misleading for future budgeting.

### 1.2 The fanout cork gap

16 `ws.send()` calls per tick per room (one per player + per spectator), plus
co-tick event sends — each an independent flush into uWS. `ws.cork` already
exists and is used for the reclaim replay burst (`ConnectionManager.ts:172-182`)
but **not** around `fanoutRecords`' recipient loop. One cork per tick merges
16+ sends into a single syscall flush. ~3 lines.

### 1.3 Allocation census on the tick path (fresh audit)

The hot path is already heavily pooled (record pool, frameArena, scratch arrays).
Remaining steady-state churn, ranked by count:

1. **Eager `inv()` ctx objects — the dumbest leak.** `tickRecords.ts:141/146/151`
   and `RoomMoveSim.ts:561-562/621-622` build 3 diagnostic-context object
   literals *per record/shadow* for invariants that essentially never fire —
   ~120+ objects/tick of pure waste (one site even calls `toFixed` inside the
   never-read ctx). Fix: make `inv` take `ctx?: () => {...}` — lazy lambda
   allocates only on the failure path.
2. **`WireTickPlayer` literal per record** (`tickRecords.ts:201-222`) — ~15/tick;
   hoist into the pooled `TickRecord`.
3. **`RoomMoveSim.tick` per-tick structures** — `[...bodySource()]` spread
   (`:498`), fresh broadphase `Map`+cell arrays (`:506-511`), `{jetHeld}`
   per shadow (`:564`), `Object.assign({}, e.input…)` per edge (`:601`).
4. **Client side: `applyTickPlayerUpdate`** (`wireIn.ts:386`) — `rowPatch` +
   `Object.assign({})` = 2 objects × ~15 records × 20Hz ≈ **600 allocs/sec**
   that `upsertRemotePlayer` immediately destructures. Pass fields directly.
5. `noteRx(JSON.stringify(data).length)` (`wireIn.ts:113`) — re-stringifies
   every JSON event to count bytes; events are sparse but free alternative exists.
6. `new DataView` per binary message for the stale-drop peek (`wireIn.ts:179`).

None of these are GC-critical — see §2 — but they're all sub-30-line wins and
the eager-ctx fix is a pure deletion of work.

## 2. GC & execution reality (V8 Orinoco vs JSC Riptide)

- **Chrome/V8:** minor Scavenger <1ms when objects die young; major GC marks in
  <5ms slices concurrently. A 20Hz loop churning 50-200KB/tick scavenges every
  ~0.5-2s — survivable; the real risk is **promotion** (records surviving two
  scavenges land in old space and inflate major-GC frequency). Our pooling
  already targets exactly this.
- **Bun/JSC Riptide:** concurrent marking, ~1ms worst-case pauses — *lower*
  pause floor than V8, but higher throughput tax on churn (write barriers +
  non-moving GC bookkeeping). JSC also **permanently tiers down** a function
  after repeated deopts — a megamorphic call site can strand a hot function in
  DFG forever. Discipline: fixed property order, no `delete`, no field-type
  transitions, keep try/catch out of inner loops (already hoisted to
  `tickRoomGuarded` — good pattern).
- **Bun footgun:** RSS ratchets under churn even when heap is flat (libpas/
  mimalloc caches retain freed backing stores post-`Bun.gc`) — if the server
  ever looks "leaky" on RSS while `heapUsed` is flat, that's the mechanism.
- **Profiling tools we haven't wired:** `bun:jsc` `heapStats()` (per-type live
  census) + `generateHeapSnapshot` (V8-format, loads in Chrome DevTools) —
  trivial soak addition for GC attribution. Chrome: DevTools "Allocation
  instrumentation on timeline" or `performance.memory` at ~100ms granularity
  (could feed Alt+Q).
- **SAB ring for worker transport:** saves ~0.3ms/frame + kills postMessage
  task-hop jitter, but needs COOP/COEP headers (Vite has none — breaks
  third-party embeds). Our ArrayBuffer **transfer** is already zero-copy at
  tick-frame sizes near the ~10KB crossover; our frames are 300-700B where
  transfer dominates clone. Marginal — skip.
- **WASM sim port: not worth it.** ~100 entities @20Hz is ~50µs/entity budget —
  trivial for JIT'd JS. Wasm f32/f64 arithmetic *is* bit-deterministic across
  engines (IEEE exact), but so is the JS arithmetic `dmath` now uses — wasm
  buys determinism we already sealed, plus NaN-payload nondeterminism footguns.
  Revisit at ≥10³ entities or >5ms/tick sim cost; if ever: strict SIMD only,
  NaN guards, one call/tick, never call-per-entity.
- **`botMpc` Worker:** Bun's web-style `Worker` is experimental and can drop
  early messages under top-level await; `node:worker_threads` has delivery
  guarantees. Small correctness migration, worth doing.
- **Room sharding:** `TickLoop` iterates all rooms on one event loop. At
  16-player rooms a single process handles ~10³ rooms before CPU — sharding is
  a >hundreds-of-concurrent-players problem; shape would be room-affinity
  workers (one room = one thread's loop), not SAB shared state. Park it.

## 3. RTC tier — the verdict after real research

**Conclusion: RTC earns its keep only for P2P/LAN scenarios, not as a
client-server transport tier.** The research kills the "RTC everywhere" idea:

- **Setup latency:** ICE+DTLS+SCTP cookie (2 in-band RTTs "useless here where
  the channel is secured by DTLS") + DCEP ≈ **200ms-2s** to first byte vs ~1
  RTT for WS/WT. For instant join, fatal.
- **Overhead:** ~80-120B/packet (DTLS record + AEAD + SCTP headers) vs QUIC's
  ~17B and plain UDP's ~28-48B. On our 300-700B frames it's ~15-30%.
- **The failure cases overlap:** networks that block QUIC/UDP-443 also block
  ICE/UDP — RTC doesn't unlock a population WS+WT can't reach; you'd fall back
  to WS anyway.
- **HoL/quirks:** Chrome never enabled RFC 8260 message interleaving — one
  large message on any channel stalls all others (keep ≤16KB, we send ≤1KB).
  PMTUD footgun: over-MTU packets **silently permanently stall** — `send()`
  succeeds, bufferedAmount climbs, nothing arrives, no error.
- **Migration:** none — ICE restart on network change costs 0.5-2s degraded +
  5-15s detection lag via STUN consent timeouts. QUIC migration is built-in
  (sub-RTT on address change); WS is a hard cut but predictable. **WT > RTC >
  WS for roaming, not close.**
- **Where it wins:** the *only* path for browser↔browser direct connections
  (listen-server, LAN co-op, private duels) — ICE success ~75-90% host-to-host,
  10-25% need TURN (~€4/mo Hetzner covers ~440k relayed player-hours), 0.5-4%
  unconnectable. And ~1.15-2.5× lower RTT than WS on last-mile-friendly pairs.
- **LAN WebTransport alternative:** `serverCertificateHashes` (already
  implemented — client pins SHA-256 of a ≤14-day self-signed ECDSA cert) is
  Chrome's designed no-install LAN path. Caveat: W3C issue #623 (Mar 2025)
  discusses *removing* it; fine for dev, don't build a 5-year plan on it.

**So:** keep the existing RTC tier for its real niche (P2P hosts, LAN), but
stop treating it as a third coequal transport for client-server — WT
stream-2 now covers the reliable+HoL-isolated niche RTC was competing for.
If we ever productize P2P: TURN on 443/TLS + 3478/udp on a cheap VPS,
trickle ICE early (10s/interface stall on multi-NIC Windows otherwise),
`maxRetransmits:0,ordered:false` tick channel + reliable event channel,
bufferedAmount watermark ~1MB, proactive `restartIce` on
`navigator.connection` change (Chrome gives no event — must detect via
getStats flatline or connection API).

## 4. Anti-cheat — what our model actually prevents

Our claims/intents + shadow-sim architecture already kills the biggest cheat
classes **by construction**: teleport, position/speed hacking, ammo/cooldown/
fire-rate spoofing, item forgery — the server never accepts state, only
intents. What remains, in order of exploitability:

1. **Wallhack/ESP — information-theoretic.** If the server sends it, the
   client can render it. The *only* defense is server-side relevancy filtering:
   don't send entities the player couldn't see. Our distance tiers already
   cap far-field detail at 1/8 rate; the real wallhack lever is **heightfield
   LOS culling** — raycast eye→target against the heightmap, cull entities
   behind ridges. With 16 players × 15 targets = 240 LOS tests/tick, a
   ~20m-stepped terrain line-sample is ~1-2ms/tick — affordable. Even
   delaying info by 200-500ms degrades radar hacks; CS:GO did exactly this
   (PVS-adjacent updates only). This is §5's item too — LOS culling is
   *security* wearing a bandwidth costume.
2. **Aim assist/triggerbots — input-side.** Client aims for the human within
   plausible-input bounds. Defenses: (a) **input timestamp drift** — a 1.2×
   speedhack produces declared-tick vs arrival-rate drift outside ±5% over
   10s windows, detectable from data we already collect (inputMove seq +
   arrival); (b) **statistical yaw/pitch analysis** — XGUARDIAN-class (USENIX
   Sec '26) detects aim assist from *only the aim stream we already log*;
   Hawk-class systems run offline on replays. Post-hoc flagging + review is
   the honest ceiling in a browser (no kernel driver possible).
3. **Input forgery/macros** (perfect ski curves, jitter-free aim): input-
   entropy heuristics — angular-delta smoothness, inhuman periodicity. Arms
   race; at our player scale flag-for-review beats auto-kick.
4. **Client tamper:** browser reality — everything inspectable/hookable.
   Krunker.io's documented arms race ended with WASM-verified checks and
   cheaters pivoting to evasion. Obfuscation raises entry cost only. The
   server-side layers above are the real defense; light function-hook/stack-
   trace checks are cheap deterrence, nothing more.

**The replay-anti-cheat synergy:** input journals + per-tick state hashes are
simultaneously our desync debugger *and* the training data for behavioral
detection — §6.

## 5. Interest management — what's worth adding

Audit verdict: distance tiers + hysteresis-worthy thresholds + force-bypass
already exist and are well-tuned (600m far-field at 1/8 rate where a skiing
bot is a speck). At 16 players full-state broadcast would only cost ~15KB/s
anyway — our tiers are already bonus. What's *actually* missing:

- **Priority accumulation** (Overwatch GDC model): score each (entity, client)
  pair per tick — distance, recency-of-last-send, force events — drain a
  per-client byte budget in priority order; unsent entities accumulate
  priority guaranteeing starvation-freedom. Replaces rigid tiers with a
  graceful degradation curve under burst load (event floods already crowd
  tick frames — the shed we measured). Medium effort, real robustness win.
- **Heightfield LOS culling** as wallhack defense (above) — not bandwidth.
- **Hysteresis on tier boundaries** — verify current code handles a player
  orbiting the 150m/400m/600m lines without cadence flapping (a bot crossing
  the boundary tick-to-tick flips rate; a ±10% enter/exit band fixes it).
- **Skip:** PVS (wrong tool — needs BSP occlusion structure, we have open
  heightfield); strict frustum culling of players (snap-turns in <100ms
  need state before it's visible); GPU occlusion-readback transport filters
  (research-stage only).

## 6. Replay infrastructure — the missing pillar

All four dives keep circling "journal replay exists" but it's the *event*
journal for reconnect — there's no deterministic-resim harness yet:

- **Journal format (the hybrid canon):** input journal for determinism
  (StarCraft/GGPO: seed + per-tick inputs ≈ **14MB/hr** at 16p/20Hz, ~4-6MB
  compressed — a 20min match is ~2MB) + sparse full-state keyframes every
  ~20s for seeking + per-tick state hash. We have `computeStateHash`,
  seeded rng, `step(dt)` — the plumbing exists.
- **Desync hunting (Riot/Widelands/tickwise pattern):** per-tick hash scan
  finds first divergence linearly; checkpoint every ~50 ticks → replay
  forward O(K) not O(T); per-entity hash tree localizes the diverging system;
  structural key-value diff on changed-fields-only pins the code path (raw
  checksums can't localize — Riot's exact finding).
- **GGPO synctest:** rollback+resimulate+journal-compare in-process — ~50
  lines over our journal, turns any soak into a determinism canary (still
  the top unimplemented item from dive #4).
- **CI corpus:** recorded journals + expected hashes → replay asserts catch
  determinism regressions (a `Math.random`/`Date.now`/iteration-order slip)
  before ship — this is the harness that would have caught the JSC/V8 ulp
  gap *before* it lived in production for months.

## 7. Ranked plan

| Pri | Item | Effort | Why |
|---|---|---|---|
| P0 | Lazy `inv()` ctx (tickRecords + RoomMoveSim ~120 allocs/tick) | ~15 lines | pure waste deletion |
| P0 | Cork the fanout loop in `tickRecords.fanoutRecords` | ~3 lines | 16 sends → 1 syscall flush |
| P0 | GGPO synctest harness (rollback+resim on journal) | ~50 lines | determinism canary that would've caught the ulp gap |
| P1 | Input-journal + per-tick hash recording + sparse keyframes | ~day | desync bisection + anti-cheat data + CI replay corpus, all from one artifact |
| P1 | Input timestamp drift detection (speedhack) | ~30 lines | closes the biggest remaining cheat class from existing data |
| P1 | Client-side patch alloc (`wireIn` rowPatch×Object.assign, ~600/s) | ~20 lines | biggest client tick-path churn |
| P1 | `bun:jsc heapStats` in soak tooling + `performance.memory` into Alt+Q diag | ~20 lines | GC attribution when RSS drifts |
| P2 | Heightfield LOS culling as relevancy filter (wallhack defense) | ~half day | the only real wallhack mitigation; ~1-2ms/tick |
| P2 | Priority-accumulation send budget over rigid tiers | ~half day | graceful burst degradation (the shed mechanism we measured) |
| P2 | `botMpc` Worker → `node:worker_threads` | ~15 lines | correctness (Bun experimental Worker drops early msgs) |
| P2 | Tier-boundary hysteresis audit | ~20 lines | cadence flapping at 150/400/600m orbits |
| P3 | WT `getStats()` key probe + `datagrams.incomingMaxAge` | ~20 lines | carried from #4; honest datagram ruler |
| P3 | yaw/pitch statistical aim-assist flagging | research | needs match volume to tune |
| Skip | WASM sims, SAB worker ring, zstd-dict/rANS, FEC groups, RTC-as-third-tier, room sharding, PVS, frustum culling | — | all verified-unnecessary at 16p/20Hz |

## 8. Open verifications

- [ ] Does `ws.cork` around `fanoutRecords` actually coalesce 16 sends? (probe
      syscall count or Bun source; Bun may auto-cork inside tick callbacks)
- [ ] Tier-boundary flap: does `fanoutRecords` hysteresis exist today? (the
      `tier = seq % tier` selection is instant — a boundary orbiter flips
      20Hz↔10Hz tick-to-tick; measure whether interpolation absorbs it)
- [ ] Do scenario-test socket mocks implement `cork`? (guarded call pattern
      already established in `replayTo`)
- [ ] `botMpcWorker` — is it on `new Worker` or `node:worker_threads` today?
- [ ] Bun `ws.send` on WT stream — does stream-2 send respect backpressure
      semantics the same way (bufMax gauge covers it?)

## 9. Research receipts (selective)

- Q3 delta machinery: ioq3 `sv_snapshot.c`/`MSG_WriteDeltaStruct`; F. Sanglard
  Q3 network review; Tribes notify protocol ~3B/ack overhead (Tribes
  networking paper); Gaffer snapshot compression (smallest-three quats,
  4096-vals/m when quantized state feeds back into sim).
- Budgets: Tribes 2KB/s/128p on 28.8k; Q3 ~30KB/s ceiling @sv_fps 20; Source
  ~20-30KB/s @66-tick; our ~6KB/s @20Hz.
- FEC reality: WebRTC ULPFEC (RFC 5109); Meta→Reed-Solomon because XOR
  recovery degrades exponentially with group size; FEC worsens congestion-
  caused loss (RFC 8854 §8).
- RTC data: ~92% EIM NATs, ~8.7% symmetric (TKK Helsinki); ~25% sessions need
  TURN (IETF-96 MAPRG); appear.in production ~12% TURN-selected pairs, ~0.5%
  ICE failure; SCTP usrsctp default rwnd 256KiB → ~8Mbit/s @80ms; Chrome
  dcSCTP kMaxSafeMTUSize 1191B, 16MiB bufferedAmount cap, RFC 8260
  interleaving still not shipped; STUN consent ~5s checks.
- GC: V8 Orinoco scavenger <1ms / incremental slices <5ms; JSC Riptide ~1ms
  pauses concurrent marking + permanent tier-down on deopt storms; Bun GC
  timer 1s→30s backoff; libpas RSS-ratchet post-gc.
- Anti-cheat: XGUARDIAN (USENIX Sec '26, yaw/pitch-only detection), Hawk
  (arXiv 2409.14830, offline replay analysis), Krunker's documented browser
  arms race, CS:GO PVS-adjacent info restriction as the canonical wallhack
  mitigation.
- Replay: GGPO sync.h SavedFrame{buf,frame,checksum} + SyncTestBackend;
  StarCraft inputs-only (~14MB/hr here); Source dem_packet deltas + full
  keyframes ~1/min (skadi wiki); Riot changed-fields-only structural diff;
  tickwise two-pass (hash scan → targeted replay).
