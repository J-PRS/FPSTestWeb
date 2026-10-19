# Netcode deep dive #6 — replay/forensics, friends-online, anti-cheat depth, production observability

Research round 6. This one covers the four remaining pillars the earlier dives
flagged but didn't mine: match replay & desync bisection, the actual path to
"play with friends over the internet" (the original motivation), server-side
anti-cheat depth, and production observability/WAN testing.

---

## Part 1 — Replay & forensics (the missing pillar, now designed)

### What we already have

- `computeStateHash` per room over player state + a replica-parity test that
  rehashes a spectator's decoded wire state vs room truth.
- Seeded RNG (`room.rng()`), per-tick `tickSeq`, per-player `inputSeq` watermark.
- A 1024-frame reliable-event journal per room (reclaim replay) — *events*, not
  inputs.
- A whole client-side `demo/` recording cluster (demoClip/demoEvents/
  demoExtract/coolShots) → `DemoStorage` server-side store of uploaded clips.
  Client-authored highlights, not match truth.
- Deterministic sims bit-identical across JSC/V8 (dmath round).

The gap: no server-side match recording, no sim save/restore, no desync
bisection, no replay corpus for CI.

### What the industry actually does

Two pure strategies (research confirms both):

- **Input-only** (deterministic games): Doom `.lmp` = 4B/player/tick @35Hz
  ≈576KB/player-hour; SC2 replays = sparse command events (~43KB for a whole
  match). Playback re-simulates. Fragile across builds.
- **Snapshot-stream** (server-auth games): Quake `.dem` dumps the server's own
  outgoing stream; CS:GO/Dota `CDemoPacket` deltas + `CDemoFullPacket` every
  ~1800 ticks for seeking. 100–1000× bigger than input demos. **Overwatch
  (GDC 2017): the server records its own outgoing snapshots to a "reel" and
  kill-cam playback streams them back through the client's NORMAL netcode
  path — the key lesson: playback should reuse the live wire path.**

**Our hybrid is better than either**: our sims are deterministic, so
input-journal replay works and is tiny (~8 input fields ≈ 8–16B/tick →
0.5–1.5MB per 20-min 16-bot match after edge-delta+zstd); but we should ALSO
record sparse state keyframes every ~400 ticks (20s) for seeking and resync
anchors — the CS:GO FullPacket pattern.

### The minimal synctest we can actually build

GGPO synctest = every frame: save → advance → rollback → resim → compare
checksum. We have 90% of it; the missing piece is `serializeSim`/`deserializeSim`
(+ RNG save/restore — needs a rewindable RNG, e.g. mulberry32 with
`.save()/.restore()` as one integer). With that:

1. **Round-trip test**: `hash(sim) → save → load → hash` — catches state living
   outside the save (the #1 desync cause).
2. **Re-sim test**: restore snapshot N ticks ago, resim N ticks with recorded
   inputs, compare hash — catches RNG misuse, iteration order, hidden globals.
3. **Cross-engine check** (our REAL risk): run one input journal through Bun
   (JSC) and Chrome/Node (V8), hash per tick — in-process synctest cannot catch
   this; it's the only gate that covers our actual divergence class.

### Desync bisection — a flat hash says "when", a tuple says "what"

- Factorio FFF-47: CRC the world every tick + tagged human-readable save per
  tick → first mismatch gives two same-tick files to field-diff.
- AoE2: per-subsystem checksums per turn (`Random, WChecksum, Position,
  Actions`) — the log names the subsystem.
- OpenRA SyncReport: per-actor hashes + `SharedRandom.Last` +
  `TotalCount` — a **draw-count mismatch fingerprints "someone consumed an RNG
  the other didn't"**, the classic desync signature.

Concrete: promote `computeStateHash` to a composite
`{rngState, rngDrawCount, hash(players.pos), hash(players.hp/flags),
hash(projectiles), hash(balls/creatures), tickSeq}` logged per tick in the
journal. The existing replica-parity monitor then localizes the subsystem
automatically.

### Replay format (concrete)

```
header: {seed, buildHash, mapId, playerRoster}
per tick: {tickSeq, per-player input delta (1-bit "changed" + struct on change)}
per tick: composite hash tuple
per ~400 ticks: serializeSim keyframe blob
```

~0.5–1.5MB/20-min match → server-side per-match files are free. Recorded
matches become a **CI regression corpus**: replay on any sim change, assert
identical hash log (intentional changes = golden-file update).

Browser playback: OPFS (not IndexedDB — byte-offset random access, append
streaming) for blobs, IDB for the metadata index. Seek = restore nearest
keyframe ≤ target tick + resim forward (headless sim resims minutes in
seconds). Backwards scrub = snapshot ring buffer, GGPO-style.

### Build order (the one-week version)

1. `serializeSim`/`deserializeSim` + RNG save/restore — unlocks everything.
2. In-process synctest (round-trip + restore-N-ago resim) in a debug room.
3. Journal file format above; composite hash.
4. CI replay runner (JSC vs V8 hash-log diff) — the real desync gate.
5. OPFS + seek playback client-side (playback rides the live wire path per
   the Overwatch lesson).

---

## Part 2 — Playing with friends online (the actual deployment path)

### Hosting reality check

**WebTransport = HTTP/3 = inbound UDP** — most PaaS can't take it:

| Provider | UDP? | Price | Verdict |
|---|---|---|---|
| **Hetzner CX22** | ✅ | €3.79/mo, 20TB egress | **Winner** — 2vCPU/4GB runs Bun fine, 20TB covers ~2000 room-hours/mo |
| Vultr/DO/Linode | ✅ | ~$5–6/mo | fine, same shape |
| Fly.io | ✅ quirks | ~$8/mo (needs $2 dedicated IPv4; bind to `fly-global-services`, ~24B MTU shaved) | OK if PaaS preferred |
| Railway/Render | ❌ TCP only | — | WS works, WT dead on arrival |

Note: our QUIC adapter is what needs UDP — whatever serves it needs raw
sockets, so bare VPS it is.

### NAT reality for home-hosting (why not to)

- CGNAT: ~10% of fixed broadband ISPs, >90% of cellular, ~40% of ISPs deploy
  it somewhere → a meaningful minority of friends literally **cannot**
  port-forward (Starlink, mobile, cheap fiber).
- UPnP works in ~2/3 of homes; double-NAT breaks it.
- Valheim's answer was `-crossplay` via PlayFab relays + join codes — zero
  port-forward. Minecraft's answer was a cottage industry of guides.
- Tailscale share-a-game-server: works, but costs **every friend an app
  install + account** — for a browser game whose pitch is "open this URL",
  a €4 VPS is strictly less friend-friction.

### Browser-hosted rooms (listen-server)

Viable via role inversion: host browser runs the sim, clients open
RTCDataChannels via signaling (web-quaker does exactly this with ioquake3 →
WASM). Costs: host uploads ~6KB/s×15 ≈ 90KB/s upstream (fine on broadband,
rough on cellular); ~1-in-5 peer pairs need TURN (callstats: 22% of sessions);
host migration is a week of fragile work — "host left, new code XXXX" is the
pragmatic 90% answer. **Good as an optional LAN-party mode; the dedicated VPS
is the primary path.**

### TURN economics (if we keep the RTC path)

- Cloudflare Realtime TURN: **$0.05/GB, first 1,000GB/mo free** — our
  ~6KB/s×16 ≈ 2.6GB/hour is trivially inside free tier.
- coturn on the same €4 VPS: effectively free, needs `--network=host`.

### Discovery & session robustness

- Room codes: `?room=CODE` join links — Colyseus's `joinById` recipe is ~20
  lines for us (code→room map + unlisted room flag).
- Reconnect token (roomId+playerId+secret in localStorage): auto-reclaim
  instead of re-join — we ALREADY have the reclaim journal; the token path is
  mostly client-side persistence.
- Ping budgets for a fast skiing game @20Hz: <50ms near-LAN, 50–100ms
  playable-casual, 100–150ms mispredicts on physics-coupled collisions (skiing
  hurts more than hitscan here), >150ms rubber-band town. Pick a DC within
  ~1000km of the friend group.

**Recommended path**: Hetzner CX22/CPX11 ~€4/mo near the player majority +
`?room=CODE` links + reconnect token → "send friends a URL". RTC+coturn stays
as optional listen-server mode. Skip host migration.

---

## Part 3 — Anti-cheat depth (what's verifiable vs what's client-trust)

### Lag compensation (the real missing piece)

Canonical Valve model: `Correct = latency + cl_interp`, rewind all non-shooter
players to `CmdTick − Correct` for the trace, clamp `[0, sv_maxunlag]` — CS2
ships **200ms**, Unlagged defaults 80ms. Subtleties from the source:

- Store the *trajectory base* (what was sent), not true origin.
- `sv_lagcompensation_teleport_dist`: no rewind across teleports.
- `sv_client_max_interp_ratio`: cap DECLARED interp server-side — Valve left
  this hole open (issue #816); cheaters claimed huge interp → deep rewind.
- Projectiles generally NOT lag-comped (Overwatch deliberately spawns at
  server time — "favor the shooter" is hitscan-only).

For us at 20Hz: keep ~1s per-player `{pos,vel,yaw}` history keyed by server
tick (16 players × 20/s — cheap), rewind
`min(measuredRTT/2 + min(declaredInterp,150ms), 250ms)` for beam sweeps.
Our `rewind`/`hitLedger` are the right skeleton.

### Speedhack/timescale (already half-built)

Our clock-drift probe (ping-stamp rate vs arrival) IS the two-clock
cross-check the literature prescribes (Ferretti 2008: honest clocks hold
slope, cheaters drift). Recommended additions:

- EWMA `arrivalRate/declaredRate`: flag sustained >1.03 for >5s, hard-reject
  >1.15. Jitter has zero-mean drift; speedhack has positive bias — the
  distinction.
- Fake-lag/backtrack: batched choked commands arrive as N consecutive-seqs in
  one packet — track commands-per-packet distribution; bound ≤4/packet.
- Freshness: strictly-increasing `inputSeq`, monotonic stamps, per-session
  salt — replay rejection.

### Movement sanity for a skiing game (hard, but our shadow sim helps)

Hard speed caps false-positive on ski chains + disc-jumps (T2's own numbers:
`horizMaxSpeed` 52–68 u/s with *resist factors*, not clamps). Instead:

- **Unexplained-energy ledger**: `ΔclaimedEnergy` must be ≤ gravityWork + jets
  + known impulses. Speedhack = positive drift over a window; legit edges
  (knockback, terrain bounce) are explainable events.
- **Claim-vs-shadow divergence bias**: honest divergence is small + unbiased
  (quantization noise); cheat = directional bias (always gaining).
- **Acceleration bound, not speed bound**: `|Δv|/Δt` ≤ plausible impulse
  sources; airborne speed gain without jets/explosion = impossible; ski gain
  ≤ g·sin(maxSlope)·(1−resist) per tick — boundable off our heightfield.

### Wallhack/ESP — the honest picture

Valorant's Fog of War works because peeks are discrete in tight geometry.
Open heightfield + 300m/s skiing = mostly-visible-everything + pop-in
artifacts. Realistic tiers:

1. Distance culling (have it) — most ESP abuse is cross-map.
2. Coarse heightfield LOS for targets inside fog range: 16×16×20Hz ≈ 5k
   rays/s — actually feasible if our heightfield lookup is flat-array; worth
   measuring but the *failure mode* (player crossing visible ground between
   evaluations → pop-in) is the real cost, not CPU.
3. Frustum-gated precision (full precision in view cone, coarse elsewhere).
4. Accept: ESP within visible range is server-unsolvable; stats+reports
   cover the rest.

### Statistical aim detection (hitLedger has the inputs)

- Per-kill features → sequential aggregation (AimDetect ACM'16): kill-level
  classifier + hypothesis test across kills → only act on sustained anomaly.
- Rotation quantization (synthetic aim has clean deltas; mice have hardware
  noise), snap-to-hit correlation, time-from-target-visible (<100ms sustained
  = triggerbot territory), accuracy-under-high-relative-speed — aimbots stand
  out MORE in a skiing game (human tracking on 300u/s targets is near-impossible).
- OSAntiCheat's hard-won rules: calibrate every threshold on YOUR honest
  population first (their first wallhack heuristic flagged ~100% of legit
  players); ship only logic-breach detectors whose honest baseline is exactly
  zero; **log + alert, never auto-ban on stats**.

---

## Part 4 — Production observability & WAN testing

### Metrics pipeline — yes, at our scale it's nearly free

- Our `/metrics` is already 90% of the integration. Prometheus @15s + Grafana
  ≈ 256–512MB total. Skip Thanos/Mimir.
- The split: **Prometheus for bounded-cardinality time series** (tick lag,
  EL delay, bandwidth counters — NEVER a playerId label, cardinality kills the
  TSDB); **logs for high-cardinality per-session events**.
- Tick duration as a histogram, buckets dense around the 50ms budget:
  `le=[10,20,30,40,45,48,50,60]`.
- `node_exporter` — TCP retransmits + disk await predict problems the app
  can't see.

### Adaptive jitter buffer — the NetEQ lesson

Fixed 100ms interp is wrong for 20Hz. NetEQ's actual algorithm: histogram of
packet lateness with ~2s exponential forgetting, target = **~p97 arrival
delay relative to the fastest packet in a recent window** (not raw IAT —
tracks degrading links), plus a peak detector for periodic spikes, plus
**asymmetric playback-rate correction** (stretch/compress the clock ±1–2%
instead of snapping delay).

Our version: `interpDelay = clamp(p97_relative_arrival + 0.5·tickInterval,
[2·tickInterval, 250ms])`, slew ≤10ms/s, step up fast on underruns, decay
slowly (~10x) — classic AGC. Under-buffering causes extrapolation pops (worse
than +50ms latency); over-buffering adds peeker's advantage.

Valorant counterpoint: fixed 7.8ms interp works at 128Hz because the tick
interval IS the jitter floor — at 20Hz we can't copy it; our interval is
already 50ms.

### Per-player QoS uplink design

- Server-side: per-player EMA of loss%/jitter in memory; export room-level
  **distribution histograms + count of players above thresholds** to
  Prometheus (e.g., `players_degraded{bucket="loss>3%"}`) — never per-player
  labels.
- `room_worst_player_loss` vs `room_p95_player_loss` divergence = the "room
  fine, one player's link dying" detector.
- Client→server: quantized buckets only (ping/10ms, loss in
  [0,1,2,5,10,>10]%, jitter/20ms, underrun count capped) — Riot's SRECon
  pattern: pre-aggregate, throttle, filter before the pipeline.
- Degraded thresholds: playable at loss 2–5% or jitter >1 tick interval;
  effectively dead at loss >10% or underruns >5/min.

### Alerting thresholds for a 20Hz server

| Signal | Warn | Page |
|---|---|---|
| tick duration p99 | >40ms 5m | >50ms sustained 5m |
| dropped ticks | any sustained | >1% over 10m |
| effective tick rate | <19Hz 5m | <15Hz 2m |
| event-loop delay p99 | >25ms 5m | >50ms 5m |
| socket buffered max | >256KB | >1MB or drown repeats |
| held/dropped frame rate | >0.5% 10m | >2% 10m |
| rss | >70% limit | >85% |
| scrape freshness | — | >30s (metrics lying while HTTP up is the classic trap) |
| room QoS | p95 player loss >5% | any player >10% 5m or DC storm >50/min |

Page only player-facing, sustained, non-self-healing. `for:` durations eat
transients; cooldown ≥10m.

### WAN emulation done right

- netem egress only — apply both ends or both directions. `delay 100ms 10ms
  25% distribution paretonormal` (real internet is long-tailed; normal isn't).
- Reorder NEEDS a delay clause: `reorder 25% gap 5`.
- Real loss is bursty: `loss gemodel 0.5% 30% 90% 0%` (Gilbert-Elliott) not
  `loss random`.
- `rate` cap ≠ shaped queue — a flat cap never produces bufferbloat; wrap in
  HTB to test queue behavior.
- Flapping: script `loss 100% → 0%` loops for reconnect/reclaim soaks. Delay
  STEP changes (100→300→100ms) break naive jitter buffers — exactly what the
  adaptive-buffer work must survive.
- clumsy on Windows: ~40ms internal floor even at delay=0, loopback packets
  processed twice, user-mode path saturates ~1Gbps — prefer server-side
  impairment or a Linux VM gateway for localhost work.

### Headless load generation for 50+ clients

Don't run real browsers at scale. Three tiers:

1. WS-only headless bots speaking the real wire protocol with realistic
   input cadence, reconnect logic, self-reported clientStats (compare
   bot-reported vs server-reported QoS). Fighters Legacy `bot_swarm`
   reference: `--clients N --ramp-ms`, weighted behavior mixes, 2h soak gates,
   asserts on tick-Hz p99 and KB/s/client.
2. k6/Artillery for connection-storm testing (ramp, handshake p95 <300ms,
   churn — different from steady-state).
3. 3–5 real headless browsers to validate the true client path under the
   generated load.

Run bots through netem from a different host — individually-degraded links
exercise the "one player dying" detector cleanly.

### Crash/session analytics for a self-hosted game

- Minimum viable: `window.onerror` + `unhandledrejection` + game-specific
  breadcrumb ring (tick#, seq, roomId, last 50 messages) shipped over our
  own WS/`sendBeacon` — free.
- Sentry-shaped self-hosted: **GlitchTip** (Sentry-protocol drop-in, one
  container) or Stackpit (single binary + SQLite). Upload .js.map at deploy
  → real stack frames.
- Skip DOM replay for a WebGL game — our game-state input-journal replay
  (Part 1) is strictly more useful.

---

## Consolidated plan

| # | Item | Effort | Why |
|---|---|---|---|
| P0 | `serializeSim`/`deserializeSim` + RNG save/restore | M | unlocks synctest + replay + seek — the keystone for everything in Part 1 |
| P0 | Composite per-subsystem hash tuple (rng count + positions + hp + projectiles…) | S | desync localization is free once recorded; one line of the AoE2/OpenRA playbook |
| P0 | Adaptive interp buffer (p97-relative + AGC slew) | M | fixed 100ms is wrong for 20Hz; we already collect the arrival data |
| P1 | Per-tick input journal + composite hash recording (~1.5MB/match) | S | replay corpus + desync bisector + anti-cheat training data in one file |
| P1 | tickNack → introSeq already suppressed for gated clients; add interp cap server-side (`sv_maxunlag` model) when lag-comp lands | S | closes the Valve hole before it opens |
| P1 | Unexplained-energy ledger in moveJudge | M | the skiing-honest speedhack check — acceleration bound, not speed bound |
| P1 | Friends-online: Hetzner CX22 + `?room=CODE` + reconnect token (localStorage) | S | the original user ask; all pieces already exist except the token |
| P2 | In-process synctest (save→load→hash, restore-N-ago resim) | M | needs serializeSim; catches 80% of desync classes in-process |
| P2 | CI replay runner (JSC vs V8 hash-log diff) | M | the only gate covering our actual divergence class |
| P2 | Prometheus + Grafana on the VPS (tick histograms, room QoS distributions, node_exporter) | M | the /metrics surface is already there; alerting table above |
| P2 | WS-bot swarm load-gen (50+ clients, netem-degraded links) | M | real WAN soak without browser farms |
| P3 | Lag-compensation rewind for beam sweeps (1s history, 250ms cap) | M | needs the per-tick pos history the journal already implies |
| P3 | OPFS replay storage + seek playback (keyframe + resim) | L | after journal format lands |
| P3 | Statistical aim/energy detection (sequential aggregation, log-only) | L | calibrate on honest population first — never auto-ban |
| P3 | Browser-hosted listen-server mode (RTC + signaling + join codes) | L | optional LAN-party mode; skip host migration |
| PARKED | Prometheus per-player labels (cardinality), DOM replay tools, full LOS culling server-side, host migration, TURN paid tiers | — | research says no at this scale |

### Open verifications

1. serializeSim feasibility per room sim — creature/ball/deploy sims may hold
   non-serializable state (maps, closures) — the round-trip test IS the audit.
2. Whether our heightfield LOS raycast is flat-array-cheap enough for 5k/s.
3. Real client-side interp delay today — adaptive buffer needs the current
   `interpDelay` plumbing mapped first.
4. Bun's `WebSocket` client for the bot swarm — confirm it speaks our wire
   shape headlessly (it does — netbots already do).
5. p97-relative-arrival signal quality on real jitter — the NetEQ derivation
   wants minimum-anchored delay, not raw IAT.
