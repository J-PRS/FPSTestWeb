# Netcode Deep Dive #9 — Client Prediction Audit, Wire Byte Budget, WT/QUIC 2026, Replay Engineering, Worker Boundary Economics

2026-10-19. Ninth round. Five parallel threads: a first-hand audit of the
*client* prediction/reconciliation stack (every previous audit was
server-side), a measured per-tick byte budget from the actual encoders,
the state of WebTransport/QUIC as it exists today, deterministic
replay/synctest methodology (now feasible — seeded LCG + save/restore
landed in round 7), and worker-boundary economics to decide the deferred
netWorker-decode question.

---

## 1. The audit — client prediction/reconciliation

Three P1s, all in reconnect/session-boundary state — the recurring shape
of our bugs is *state outliving the epoch it was minted in*.

### 🔴-ish P1s (all small fixes, all test-covered surface)

1. **Stall-watchdog reconnect drops `resolveUrl`.**
   `NetworkManager.ts:380` — `checkStall()` reconnects with
   `connect(url, lastFactory)` but not the `resolveUrl` saved at connect
   time. In a fleet deployment the resolver is the matchmaker that steers
   the reconnect to a live worker; `lastUrl` is the *dead* worker's direct
   address. Silence-triggered reconnect loops against the dead endpoint —
   the wedge the resolver exists to prevent. One line + a stored field.

2. **Input journal survives room epochs — wrong-room inputs replay into
   corrections.** `inputStream.ts` `dropJournal()` is only called from
   `sendResync`. Disconnect mid-room A → reconnect/room-hop →
   `localPlayerState.inputSeq` is the new room's small seq →
   `inputsAfter()` prunes only `<=` it → up to 128 *old-room* inputs
   replay through `movement.update` → the "restore" converges to garbage
   and corrections rubber-band it back. Root cause: the journal's epoch
   boundary isn't the same as the seq watermarks' (those reset correctly
   in `resetForReconnect`/`handleGameState`). Fix: `dropJournal()` at the
   same boundary — `resetForReconnect` or `onDisconnect`.

3. **Held-input state goes stale across a dead lane → server shadow runs
   phantom input.** `sendInputMove` early-returns on `!isConnected()`
   *before* `InputStream.sendMove` records the change. Release/repress a
   key during the flap → `held()` in `sendPosition` keeps reporting
   pre-flap bits and the change-only `inputMove` filter may skip the
   correcting edge → server replays wrong held input → repeat corrections
   until any key edge. Fix: `InputStream.reset()` clearing
   lastSent/lastState on disconnect/gameState.

### P2s

4. **Claim-ledger sweeps only run while the perf HUD is visible** —
   `gameLoop.ts:869` calls `bandwidth()` inside `perf.end`'s callback,
   which early-returns when the HUD is hidden. `pendingHits` grows all
   session; `unconfirmed` desync telemetry never fires — the counters
   built to catch "exploded on his model, no damage" are inert in normal
   play. Fix: sweep from `sendPosition`/`tickArrived` (always-ticking).

5. **`tickUpdate.count` trusted over `updates.length`** — a JSON-path
   frame with `count > updates.length` throws on `undefined.playerId`,
   swallowing the rest of the frame. `Math.min` both.

6. **`wireIds.add` doesn't clear the v4 decode baseline** for a reissued
   id (`remove` does). If the server ever re-adds without remove, deltas
   decode against the departed owner's retained state. Same asymmetry in
   `WireIdRoster.feed`.

7. **Partial v4 frame mutates the decode baseline before failing** —
   `decodeTickFrame` writes each record into `pool.byId` as it goes; a
   truncated frame returns null *after* earlier records applied. On the
   unordered/corruptible lanes that's a baseline-corruption vector. Fix:
   decode to scratch, commit on success.

8. **Queued `respawn`/`switchRoom`/`throwFlag` replay into the next
   session** — `pendingCmds` flushes on the *next* `onConnect`; a respawn
   pressed during a dead-lane window self-kills seconds later. Drop
   them from `QUEUEABLE` or timestamp-expire entries.

### P3s (bookkeeping/allocs)

- `stateHistory` map: written every position send, never read — delete or
  comment as reserve.
- `rowPatch` allocates per remote per tick — apply declared fields into
  the row directly (the in-place intent is already documented).
- Ledger stamps for unsent claims inflate `lost/unconfirmed` phantom
  counts; `inputsAfter` returns the live journal array (fragile alias);
  `restoreLocalPlayer` hardcodes `onGround: true`.
- `remoteProjectiles`/`world.projectiles` grow unbounded on unique
  `projectileCreated` ids — server-trusted, but a flooding server allocates
  unbounded replicas (note only).

**Verified clean (long list, worth keeping as the "don't re-audit"
set):** seq watermark resets, protocol-version reload budget + final
disconnect, v4 baseline hygiene (`byId.clear` on gameState, stale-drop
pre-decode, `tickNack` throttle), worker receive-edge liveness, 8ms drain,
transport-death funneling, early-connect queue bounds, roster
mutate-in-place, correction finite-gates + speed-scaled ignore band,
remote interp teleport gate + DR takeover, SnapshotBuffer anchoring/
underrun telemetry, pointer-lock `clearAll`, claim dedup.

---

## 2. Wire byte budget (measured from the encoders)

Frame = **15B header** (`magic u8 + type u8 + ackSeq u32 + tickSeq u32 +
inputAck u32 + count u8`) + Σ records. Even an all-suppressed tick ships a
15B frame — **300B/s floor per client**.

| v4 record piece | bytes |
|---|---|
| wireId u16 + mask u8 + pos i32×3 (q=0.04) | **15** (always) |
| vel i16×3 @0.1m/s | +6 |
| rot yaw u16 + pitch i16 | +4 |
| hp u16 + ping u8 | +3 |
| flags + sheep/jet u8s | +2 |
| full record | **30** |

(Doc comment at wire.ts:538 is stale — says 24B/9B from the i16-pos era;
real = 30B/15B.)

Overheads already paid: staggered fulls every 750ms (≈1.33 full/s
amortized), 20-tick intro windows, 3-deep basis echo (one-tick blip =
3× group retransmit), suppression heartbeats at 4Hz (parked) / 0.5Hz
(>5s silent socket — the "250ms" is the suppression window, not a
heartbeat constant).

**24-player room, per-recipient budget:**

| mix | frame | down/client | fanout ×24 |
|---|---|---|---|
| all moving, all near, all delta | ~597B | ~95kbps | 2.3Mbps |
| realistic tier mix | ~340B | ~54kbps | ~1.3Mbps |
| all-idle | ~75B avg | ~1.5KB/s | ~36KB/s |

**Join burst: 12–40KB** — gameState roster ~6KB + wireIds 0.4KB +
localPlayerState + the map echo (5–30KB+ wildcard) + 20 ticks of intro
fulls (~14KB). The `INTRO_DRAIN_FLOOR = 32KB` gate is sized exactly for
this — confirmed correct, not arbitrary.

**Uplink: ~0.8KB/s** — 37B position claims ×20Hz + ~150B events/10s.
Cheap; not the constraint.

**Top byte wins remaining** (ranked):
1. **pos i32×3 → i24** (±335km in 9B) or per-wireId pos delta i16 — −3..6B
   per record (10–24% of a delta). Medium risk — this field burned a
   ±1310m desync before; i24 needs a wire version bump.
2. **wireId u16 → u8** — −1B/record. Live seats can't exceed ~255;
   retired-id quiet window handles reuse. Cheap.
3. **Far-tier sparse records** — drop vel/rot on 2.5Hz targets (client
   dead-reckons them anyway): far record 15B vs 25–30B → ~40% off the
   class that dominates sparse maps.

Already done, don't re-suggest: bit-packed bools, sheep+jet shared byte,
k-basis masking, tiered cadence, suppression, JSON-on-edges-only.

---

## 3. WebTransport/QUIC — the 2026 state changed everything

**The blockers resolved:** Safari 26.4 (Mar 2026) shipped WebTransport on
macOS+iOS *with automatic WT-over-HTTP/2 fallback when UDP is blocked* —
the last holdout. caniuse global support ~91.6%; W3C Candidate
Recommendation July 2026; IETF drafts in last call. The wire format is
frozen.

**What didn't change:** Chrome's QUIC connection migration is off by
default and WT sessions die on wifi→cellular. **Session-token reclaim +
snapshot resync stays mandatory** — migration is upside, not a feature.
`serverCertificateHashes` still demands ECDSA ≤14-day certs (dev/LAN
only); production = real Web-PKI cert, no debate.

**Server-side reality:** production WT servers are Rust
(quinn/wtransport) or Go (quic-go + webtransport-go). The JS tiers:
`@fails-components/webtransport` (self-described "duct tape"), Deno
unstable, **Bun's server-WT PR #29796 (Apr–Jun 2026) is newest and least
proven — we're riding it**. No CDN proxies H3 to origin (Cloudflare
explicitly edge-only) — UDP must hit the VPS directly. At our scale,
fine.

**Verdict for us: promote WT to primary, keep WS fallback permanently,
demote RTC to serverless-P2P only.** That matches where we already are —
the architecture is right; the ranking can flip in docs/tier order.

---

## 4. Replay/synctest — now buildable, and how the industry does it

The keystone pieces landed this month (seeded `lcg32` with save/restore,
per-room `rngSeed`, lockstep canary). What's left is engineering, and the
industry has a mature recipe:

**GGPO synctest** (~50 lines): run N ticks → save state+hash → rewind
via save/restore → replay same inputs → assert identical hash. Slides a
`checkDistance` window forward continuously. Catches *internal*
nondeterminism (RNG leaks, wall-clock, iteration order). Our
`replayDeterminism` already does the two-room version; the save/restore
version is a half-day.

**Journal format — the Factorio/openbw recipe:**
- Header: map/seed/build/roster.
- Per-tick: **applied inputs** (move dir + buttons + quantized aim ≈
  8–20B/player/tick) + events that enter the sim + per-tick CRC32.
- **Snapshots every 20–100 ticks** for bisection start points.
- Journal the *adjudicated* inputs (what the server executed), not client
  claims — claims aren't sim inputs; rejections/corrections go in as
  events because they change state.

Cost: ~7.2KB/s raw for 24 players → **<150KB/min gzipped**, +snapshots →
~1–4MB per 10-min match. Record every match; the desync's forensic data
already exists when a report lands.

**Desync forensics:** hash whole-state every tick (cheap) → on mismatch,
replay the bad window with per-entity/subsystem hashing → the divergent
field names itself (Factorio's tagged-save diff; openbw found desyncs
were *logic* bugs — unordered iteration, divergent limits — not FP
noise).

**JS determinism audit (why dmath must exist):**
- Deterministic across all engines: `+ - * / % **`, all int/bitwise ops,
  `Math.imul/clz32/fround`, typed arrays, `Number.prototype.toString`
  (spec-mandated shortest-round-trip — JSON.stringify is byte-identical
  cross-engine), `Array.sort` (stable since ES2019), Map/Set insertion
  order (given deterministic insertion), `Math.sqrt` (hardware sqrtsd).
- **Implementation-approximated — must stay inside dmath:** all
  transcendentals (`atan2/cos/sin/exp/hypot/pow/log/...`). ECMA-262
  doesn't bound them; Safari/Firefox have demonstrably differed in last
  ulp. This is the one real cross-engine hazard and it's already handled
  — the remaining risk is *leaks*: `Math.random`, `Date.now`, and any
  transcendental that bypasses dmath.
- Nonissue: no FMA exists in JS so contraction can't happen; no
  x87-80-bit escape hatch exists.

**Cross-engine CI leg:** replay the same journal under V8 (client path)
and JSC (Bun server) — the cheapest real cross-engine test, two legs of
what production actually runs.

---

## 5. Worker boundary — mostly "do nothing", with corrections

Important correction to our own assumption: **`JSON.parse` already runs
in the worker** (`netWorker.ts` owns the TieredTransport). What crosses
the boundary is parsed objects via structured clone + transferable
binaries. So the "decode in worker" P2 is *already done* — the deferred
work item should be removed from the plan.

Measured economics at our volume:
- Transferable ArrayBuffer: ~0.08ms flat, any size — our 2KB ticks are
  optimal already.
- Structured clone: ~1µs/object-node; a ServerMessage clones in single
  µs. postMessage fixed overhead 5–30µs/message — a 1000-event reclaim
  burst is ~5–30ms of *worker-side* send time, spread across the drain.
- Message-rate ceiling ~35K msgs/s (Chrome): ~1000× headroom.
- **Batching `ev` posts** (accumulate → one post per macrotask) is the
  only real optimization left — ~20 lines, helps the reclaim-burst edge,
  costs 0–4ms latency unless deadline-flushed. Worth it *if* profiling
  shows the burst stutters; measure a `performance.measure` around drain
  first.

**SAB ring buffer:** per-item cost → nanoseconds, but needs
`crossOriginIsolated` (we have the headers now) and solves a problem we
don't have at current volume — deferred, revisit at >5K events/s.

**OffscreenCanvas render-in-worker: don't.** It moves render onto the
same thread as decode+dispatch — recreates the problem while adding
input-forwarding latency. It wins when main-thread *layout/framework*
jank starves render; our profile shows render is the main workload by
design. Also Safari 16.4–16.6 shipped a 2D-only OffscreenCanvas that
passes feature detection — real landmine (WebKit 253431).

**Binary event channel: no.** At KB/s the win is µs/event; FlatBuffers
earns its keep at snapshot scale, not event trickle, and costs schema
drift + debuggability. The DataView tick path is already where the bytes
are.

---

## Plan

### P0 — do now (all one-liners, all test-covered)
- Store + pass `lastResolveUrl` in `checkStall` reconnect (audit #1).
- `dropJournal()` at the reconnect/gameState epoch boundary (audit #2).
- `InputStream.reset()` on disconnect/gameState — kills phantom held
  input (audit #3).
- Sweep claim ledger from `sendPosition`, not the perf-HUD callback
  (audit #4) — unconfirmed-desync telemetry is inert in normal play.

### P1 — this week
- `Math.min(count, updates.length)` on the JSON tickUpdate path.
- `wireIds.add` clears `pool.byId[id]` (and `WireIdRoster.feed`).
- Drop `respawn`/`switchRoom`/`throwFlag` from the reconnect queue (or
  expire entries by wall time).
- Update the stale wire.ts doc comment (24B/9B → 30B/15B).
- Remove "decode in worker" from deferred plans — already done.

### P2 — next milestone
- Decode-to-scratch-then-commit for v4 frames (baseline corruption on
  truncated datagram-lane frames).
- **Match journal v1:** header (map/seed/build/roster) + per-tick applied
  inputs + events + per-tick CRC32 + snapshot every 50 ticks. ~1–4MB/match,
  unlocks offline desync bisection. The biggest remaining infrastructure
  gap and now unblocked.
- **GGPO-style synctest:** save/restore/replay hash assert around
  existing lockstep — half a day.
- Worker `ev` post batching (only if measured drain stutters).

### P3 — horizon
- Wire: pos i32→i24 / wireId u16→u8 / far-tier sparse records (~15–40%
  bandwidth cuts; needs a wire version bump — bundle when it next bumps).
- WT primary ranking in docs/tier order (WS permanent fallback, RTC for
  serverless P2P only) — architecture already right; ranking is
  documentation.
- Cross-engine replay CI leg (V8 + JSC).
- SAB ring buffer >5K events/s; OffscreenCanvas never (wrong fit).

### Explicitly not doing (with reasons)
- Decode-in-worker: already done (parse happens in netWorker).
- OffscreenCanvas render: collocates render+decode, adds input latency.
- Binary event channel: wrong lever at KB/s.
- QUIC migration reliance: Chrome doesn't reliably migrate WT; keep
  session-token reclaim.
- Full GGPO/rollback runtime: synctest harness yes, runtime rollback no —
  same as every prior round's verdict.
