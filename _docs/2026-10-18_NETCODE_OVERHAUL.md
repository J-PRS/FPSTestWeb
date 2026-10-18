# Netcode Overhaul — 2026-10-18

Goal: multiplayer playable with friends over the internet. Current state
(localhost!): drops ~every minute, warps, rubberbanding, damage not
reading, pickups missing. This doc maps every symptom to a root cause
found in the code, then phases the fix.

## The one-line diagnosis

The transport ladder (WT→RTC→WS) silently collapses to WebSocket+TCP,
and everything else amplifies that single failure.

## Symptom → root cause map

### 1. Everything rides one ordered TCP stream (the big one)

`tickUpdate` binary frames (volatile, superseded every 50ms) share the
SAME TCP connection as reliable JSON events (hits, kills, pickups,
corrections). TCP's guarantee is ordered reliable delivery: one
lost/delayed segment stalls EVERYTHING behind it (head-of-line
blocking). What the player sees:

- a TCP retransmit (~200-400ms on real internet, every minute or two on
  a mediocre link) → a burst of stale tick frames lands at once →
  remotes warp/rubberband through the catch-up. Client-side coalescing
  (`WorkerTransport.coalesceTickFrames`, the `coal:` counter in Alt+Q)
  proves it: `coal: 35` = 35 superseded frames had piled up.
- reliable events (damage echos, pickup spawns) queue behind the tick
  flood → "damage not read", "pickups missing" for seconds at a time.
- backpressure: Bun/uWS buffers a stalled reader; the server-side
  "drowned client drain" (`ConnectionManager`) closes the socket when
  the buffer crosses its bound → disconnect → reconnect = "drops every
  minute".

On localhost TCP doesn't lose packets, but the same stream still
serializes: a render hitch or GC pause on either end buffers a burst
that arrives as a flood, and the drain thresholds still apply.

### 2. The ladder collapses because the WT cert expired

`tier: WebTransport` is implemented end-to-end (client
`tiersWebTransport.ts` + `WtServer.ts`) with the CORRECT split already:
binary tick frames → QUIC datagrams (unreliable), JSON → reliable
stream. But:

- `server_bun/certs/dev.crt`: notAfter = **Oct 12 2026**. Today is Oct
  18. Chrome's `serverCertificateHashes` pinning only honors certs that
  are valid AND have ≤14-day total validity; an expired cert →
  `ERR_QUIC_PROTOCOL_ERROR.QUIC_TLS_CERTIFICATE_UNKNOWN` → probe fails
  → 30s miss-cache → WS.
- The RTC tier then also failed in testing (probe misses → cached),
  leaving WS as the only survivor.

So locally we're running the worst tier. Over the internet, WS over
TCP on a lossy path is strictly worse — every symptom gets amplified.

### 3. 20Hz tick + phase-0 command drain = ~50ms floor on localhost

- `CONFIG.tickRate = 20`. Client inputs park in `room.commandBuf` and
  are only drained at tick phase 0 (`Room.drainCommands`) — up to 50ms
  of queueing before the server even looks at an input.
- Ping reads 48-63ms on loopback. Loopback RTT is <2ms; the difference
  is tick-phase queueing + worker hops. That baseline delay is baked
  into every hit-reg/pickup/shot feel even before the network does
  anything.
- Interest tiers compound it: >400m remotes update at 10Hz, >600m at
  2.5Hz — remote shells extrapolate between records, and the dump's
  `renderΔ=5-9m` shows the predicted render position is meters off the
  wire position even at rest.

### 4. "Damage not read" — adjudication latency + parity gaps

- Combat claims are refused on dedicated (`claimsAccepted=false`); the
  server adjudicates from intents + its own sim. A hit you saw is only
  real when the tick echo comes back — input drain + tick + return trip
  ≈ 100-150ms of invisible adjudication at 20Hz even with zero packet
  loss, worse when HoL stalls hit.
- The parity ledger already names the residual mismatches:
  `parity-dmg-echo` (server damage we never predicted), `parity-nugrest`
  (nugget rest positions diverged), `parity-kb-unpredicted` (knockback
  applied without prediction stamp). These aren't transport bugs —
  they're predicted-vs-authoritative gaps that *read* as "my damage
  didn't count" / "that pickup isn't there".

### 5. "Drops every minute" — candidate chain

Ordered by likelihood on localhost:
a. Drown drain (`ConnectionManager`): tick frames shed at 256KB, but a
   reader that backs up on reliable frames gets closed → reconnect.
b. Stall watchdog (4s silence → teardown + reprobe): any ≥4s main-loop
   stall (GC, shader compile, log flood) forces reconnect. The earlier
   `hidden 15.2s — dropped 223 remote shells` resync is the same shape.
c. Room tick error quarantine (~10 consecutive throws → drain room):
   players get kicked en masse; would show in server log.
d. `IDLE_KICK_MS`/grace expiry: only if input goes silent — unlikely
   mid-match but real for menu-sitters.

### 6. Resync is a sledgehammer

`hidden Ns → dropped N remote shells + world-state replay` discards all
remote interpolation state and replays. Necessary sometimes, but as the
primary recovery path it converts every stall into a full-world pop.

## What the research says (the standard we should hit)

- **Gambetta / Valve Source model**: authoritative server, client
  prediction for self, *interpolation* (render ~100ms in the past) for
  remote entities, lag compensation on the server for hit validation.
  Our prediction is good; our remote render path extrapolates where it
  should interpolate — that's the "warps" half.
- **Snapshots over unreliable transport** (Quake/Source/Overwatch):
  volatile state on datagrams, reliable channel only for events that
  must land. That's exactly what the WT tier was designed to do — it
  just has to actually connect.
- **NSDI 2025 browser-transport study**: WebTransport datagrams (QUIC,
  BBR) ≈ UDP+DTLS for game traffic; WebRTC datachannels work but carry
  SCTP overhead; WebSocket/TCP is the clear loser under any loss.
- **Tribes-specific**: `_docs/UPHEAVAL/midair-netcode-analysis` and the
  tribes-ascend lagcomp writeup — Tribes' ski speeds make extrapolation
  error huge, so interp delay + server rewind matters more here than
  in slower shooters.

## The plan (phased, smallest-first)

### Phase 0 — make the good transport actually connect (NOW)

1. Regenerate `server_bun/certs/dev.{crt,key}` — ≤14-day validity is a
   HARD Chrome requirement, so the regen step itself must be documented
   (or scripted) since the cert self-expires every two weeks.
   Better: add `_tools/genwtdevcert` + a startup check that warns/auto-
   regens when the checked-in cert is within 48h of notAfter, else this
   bug silently returns fortnightly.
2. Verify `?net=wt` connects on localhost and tick frames ride
   datagrams (probe `tier: WebTransport` + coal counter stays ~0).
3. Same for `?net=rtc` — keep as the middle rung (works over the
   internet without a cert treadmill, needs STUN/TURN for strangers).

### Phase 1 — stop HoL damage on the WS floor too

Even on WS, we can stop feeding the jam:
1. Route tick frames and reliable JSON on the same socket they are
   today, but cap the damage: server already sheds frames at 256KB —
   make the drown drain prefer dropping TICK frames over reliable
   events instead of closing the socket (check current policy).
2. Client already coalesces superseded ticks; extend the same drop-oldest
   policy to `stateHistory`/interp so a 300ms hole doesn't replay as a
   rubberband storm.

### Phase 2 — kill the 50ms floor

1. Raise `FPS_TICK_HZ` 20→30 (or keep 20Hz broadcast but drain inputs
   per-sub-tick). Halves the input-queue ceiling; server CPU cost is
   the tradeoff — measure `tickLagMsMax` at 30Hz first.
2. Ping display: report worker RTT separately from sim RTT so users
   don't read queue-time as network ping.

### Phase 3 — remote render: interpolate, don't extrapolate

1. Remote shells currently predict forward (`renderΔ=5-9m` in dumps).
   Move to a Source-style render delay: buffer ~2 tick intervals,
   render remotes ~100-150ms in the past, interpolate bracketed states.
   Warps turn into at-worst slight lag — a strict upgrade at ski speeds.
2. Rewind already exists server-side (moveJudge/rewind) — hit-reg then
   works on the same delayed view the shooter saw.

### Phase 4 — close the parity gaps

1. `dmg-echo`: predict the damage echo client-side where the local
   claim is the obvious cause, reconcile on the edge.
2. `nugrest`: nugget rest settles are deterministic — audit why client
   and server disagree (likely heightfield sample or settle order).
3. `kb-unpredicted`: stamp knockback claims so the client predicts them.

### Phase 5 — resync as repair, not default

- Replace full-shell drop with: keep last-known remote state, mark
  stale, re-request only deltas needed. The resync path stays as the
  catastrophic fallback.

## Verification loop for each phase

- `_tools/pvptest` + `_netbots.bat` for real multiplayer load locally.
- Alt+Q dump: `coal`, `lagMs`, `loss`, `renderΔ`, `parity` counters are
  the objective scoreboard — "unplayable" must become measurable deltas.
- `?net=wt` vs `?net=ws` A/B on the same netbots soak = the before/after
  for transport value.
- Simulated impairment: `clumsy`/network throttling on the WS/WT port to
  reproduce "internet" conditions locally before shipping to friends.

## Explicitly NOT doing

- No lockstep/rollback rewrite — prediction+reconciliation is already
  the right model; the failures are transport + recovery, not the model.
- No protocol redesign — v4 delta records, wireIds, interest tiers are
  sound; the wire format isn't why it's unplayable.
- No engine swap. The ladder exists; we're making the top rungs climbable.
