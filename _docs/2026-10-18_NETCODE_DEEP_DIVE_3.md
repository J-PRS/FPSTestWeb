# Netcode Deep Dive #3 — the full stack: browser internals, three.js, Bun/uWS, middleboxes

Round three goes *under* the netcode canon: the browser event loop, the
WebSocket/uWS machinery our server actually runs on, three.js render
pipeline, and the internet middleboxes between us and a friend's laptop.
Companion to `_docs/2026-10-18_NETCODE_OVERHAUL.md` (round 1) and
`_docs/2026-10-18_NETCODE_DEEP_DIVE_2.md` (round 2 — canon mapping).

## Part 1 — Findings, by layer

### 1. THE SILENT KILLER WE FOUND IN OUR OWN CODE: `ws.send` return codes

uWS `send()` returns **1 = sent, 0 = buffered, 2 = DROPPED**. It drops
when per-socket `maxBackpressure` (default **64 KB**) is exceeded.
Every `ws.send()` in `ConnectionManager.ts` ignores the return —
including `sendToPlayer` (reliable JSON events: `pickupSpawn`,
`playerHit`, `yourHealth`, `buff`, roster messages) and
`broadcastBinaryReliable` (ball segments!).

Mechanism for "damage not read / pickups missing": a client that stalls
(render hitch, GC pause, tab jank) accumulates 64KB of buffered bytes in
~0.3s of tick+event traffic; uWS then **silently discards every reliable
event** until the socket drains. The client never disconnects, the
journal only replays on *reclaim* (reconnect) — a connected-but-stalled
client permanently loses event edges. Ball segments dropped this way
free-run blind for ~1.2s = the rubberband pattern.

**Fix (small):** check `send() === 2` on the reliable lane → count it
(`metrics.reliableDropped`), and escalate: a reliable drop means the
socket can't be trusted → kick with a reason code so the client reclaims
+ journal-replays. For the tick lane it's already intentional shed.

Also verify whether Bun exposes `maxBackpressure` in `Bun.serve`'s
websocket options (uWS.js does; Bun may not) — if it does, raise it for
the reliable lane or keep 64KB and treat any drop as fatal-for-session.

### 2. Middlebox idle timeouts — "drops every minute" on the REAL internet

Dormant-connection kill timers on the path to friends' browsers:

| Middlebox | Idle kill |
|---|---|
| Cloudflare proxy/tunnel | **100 s** (Enterprise-only config) |
| AWS ALB | **60 s** default |
| nginx `proxy_read_timeout` | **60 s** default |
| uWS `idleTimeout` | **120 s** default (ours: `FPS_IDLE_TIMEOUT_S`, 120) |

Our 20Hz tick fanout means the socket is never dormant *in game*, so
these fire only in lobbies/menus where fanout stops — exactly when a
friend is "setting up". Two free mitigations:
- `sendPingsAutomatically` (Bun WS option, default true) already sends
  protocol-level ping frames — **browser JS can't see or send protocol
  pings** (spec deliberately hides them; the UA auto-pongs), so the
  server must initiate. Verify it's on; it resets every middlebox's idle
  clock without any client work.
- Our app-level `ping`/`pong`/`srvPing` also counts as traffic.

Note: an idle WS behind Cloudflare dies *silently* — no close frame —
which reads exactly like "connection drops every minute" if any path
segment goes quiet.

### 3. Hidden-tab throttling is worse than "resync handles it"

Chrome's stages: rAF stops instantly; timers clamp to 1Hz after ~10s;
**intensive throttling** after 5 min hidden suspends chained timers
almost entirely (minutes between firings). Exemptions: audible audio,
and (per Chromium team) *active WebSocket connections* — but devs report
WS doesn't reliably exempt in practice; playing audio does.

For us this means: hidden player stops sending position → server sees a
ghost → moveJudge may kick; their client-side `ping` chain freezes → any
proxy idle timer can fire; on return they get a giant burst + resync.
Already mitigated: hidden>3s → drop volatile state + `resync`. What we
don't do: **tell the server we're hidden** — a `clientState:{hidden}`
message could let the room stop metering them (sheep/ping) and
grace-period their liveness instead of judging a frozen socket.

### 4. The event loop is the network: WS messages are *tasks*

Blink priority table (from the scheduling-apis explainer): discrete
input > starving-render > `user-blocking` postTask > everything else —
**networking (including WS onmessage) is Normal priority, same as
setTimeout**. So a 40ms render task delays WS delivery 40ms *per task*,
and our worker coalescing sees bursts. Observed: 159ms max delivery lag
pre-GL-fix, 18ms after.

Tools that exist:
- `scheduler.postTask(cb, {priority:'user-blocking'})` — can schedule
  *above* Normal networking tasks; works in workers too.
- `scheduler.yield()` — splits long tasks, BUT measured reality (three.js
  forum): it resumes at user-blocking and can starve timers entirely;
  `MessageChannel` yield is the cheaper option.
- **`WebSocketStream`** (Chrome-only, experimental): WS with real
  streams backpressure — `readable.getReader()` applies backpressure the
  classic API can't express. Non-standard, Chrome-only, but our worker
  could feature-detect it; gives readable-side flow control today.
- The real fix we already did: coalesce + drop stale at the worker
  boundary so bursts are harmless. The missing half is *main-thread
  discipline* — any task >16ms IS network jitter.

### 5. three.js render stalls → network symptoms (the loop we broke)

- `KHR_parallel_shader_compile` + `compileAsync`: our warmup uses it
  (good), but mid-match *lazy* compiles (new elite/tracer/terrain preset)
  block the main thread ~50–300ms each on the first `getProgramParameter`
  — every one is a tick-burst + potential dropped event. The GL error
  storm we killed was the same class of stall at every frame.
- `renderer.debug.checkShaderErrors = false` already set — good; it's a
  per-frame sync stall otherwise.
- Arcane but real: `EffectComposer`/HDR-target programs have *different
  program keys* than screen-target compiles — warming with the wrong
  render target compiles everything twice (documented 1.4s→16.7s
  disaster case). Our composer path should warmup against the post
  pipeline's actual target.
- **OffscreenCanvas + worker rendering** exists and three ships an
  example; moving the whole renderer off the main thread is the nuclear
  option — realistically out of scope, but knowing `pmndrs/
  react-three-offscreen` exists means it's been done.
- GC: structured-clone `postMessage` per tick frame (worker→main) is
  ~1.4MB/s of GC pressure at our sizes; **SharedArrayBuffer ring**
  (requires COOP/COEP `crossOriginIsolated` headers on the Vite server —
  two headers) is the zero-copy upgrade for tick frames specifically.
  SPSC ring + Atomics = no clone, no task hop. Medium effort, real win
  for jank.

### 6. Server internals worth knowing (uWS/Bun)

- `drain(ws)` handler exists in our config — the correct place to resume
  sending after backpressure; we only use it to log. It should also
  clear a per-player `drowning` flag and flush any held reliable
  resends.
- Corking: uWS corks sends inside handlers automatically; our tick
  fanout is a `setInterval`, NOT a socket callback — **sends during
  fanout may be uncorked** = a syscall+TLS record per message per player.
  `ws.cork(() => broadcastAll())` around fanout is a free throughput win
  (fewer TCP segments = fewer ACKs = less Nagle/delayed-ACK interplay).
  Verify Bun exposes `ws.cork` (uWS.js does).
- Nagle/delayed-ACK: Bun sets TCP_NODELAY on uWS sockets (uWS does by
  default) — the 40ms Nagle stall mainly bites the *client→server*
  direction where we can't control the socket... except browser WS
  stacks send small frames immediately anyway; the real killer is an
  intermediate proxy buffering.
- **Bufferbloat is the friend-connection wildcard**: a saturating
  upload (their roommate's stream, their own OBS) queues seconds of
  buffer → our "ping" reads 1–3s and TCP retransmits into the queue.
  Nothing server-side fixes it; what helps is keeping tick frames
  superseding (done) and small (done) so bursts drain fast.

### 7. The interesting libs/prior art (don't adopt, mine)

- **geckos.io** — WebRTC DataChannels to a Node server via
  `node-datachannel`; ships the "UDP for browsers" model, incl. the
  three-channel split Construct uses: `unordered+maxRetransmits:0`
  (state), `unordered reliable` (events that commute), `ordered
  reliable` (chat/loadout). Our RTC tier could do exactly this split —
  it maps 1:1 onto our tick/event/telemetry lanes.
- **nengi.js** — browser-game netcode engine, millions of plays: binary
  snapshot schemas, `interp` per-property flags, `predictionError`
  frames (server diffs client's predicted state and sends only the
  errors — a lighter correction than our full-state snap).
- **Tribes paper** (round 2): Event/Ghost/Move/Datablock/String
  managers — we're ~80% there; the missing manager semantics is
  "partial reliability" (maxPacketLifeTime), which only RTC/WT can
  express.
- **Aetheris/liteship-style SAB triple-worker** clients — sim worker +
  render worker + main, SAB double-buffer between. Extreme but proves
  the topology.

### 8. QUIC/WebTransport arcana that matters to us

- Datagrams ARE congestion-controlled (they consume cc window; they're
  just never retransmitted) — so a datagram flood can starve the
  reliable stream's window. Send-order/priority: on WT, write reliable
  events before tick datagrams each tick.
- **Connection migration**: QUIC CID survives NAT rebinding and
  wifi↔cellular switches — on WS the same switch is a guaranteed
  disconnect+reclaim. This is a *free* robustness win for laptop
  friends on flaky home NATs (idle NAT rebinds mid-match are common).
- 0-RTT resumption exists in QUIC; our reclaim+`resumeSeq` covers the
  app-level equivalent — skip.
- WT `sendOrder` on streams sets stream priority — events stream can be
  prioritized over a (hypothetical) second stream.

## Part 2 — Plan, merged with rounds 1+2

| # | Item | Effort | Why now |
|---|---|---|---|
| F1 | **Check `ws.send()` return on reliable lane; on `2` → metric + kick-to-reclaim** | S | Closes the silent "pickup/damage lost" hole — probably THE missing-pickup mechanism |
| F2 | Re-measure WT datagram loss honestly (seq counters); if <5%, tick frames → datagrams on WT | S–M | Kills HOLB for internet play; previous "47%" was a cadence artifact |
| F3 | `ws.cork` the tick fanout (if Bun exposes it) | S | Syscall batching, fewer TCP segments |
| F4 | uWS `sendPingsAutomatically` verify-on + document | XS | Middlebox idle kills |
| F5 | Hidden-tab signal to server (`clientState.hidden`) → don't meter/kick frozen sockets | S | Cheap fairness fix |
| F6 | Telemetry split: `seqGap`/`shed`/`reliableDropped`/`deliveryLag` | S | Honest instrumentation for everything above |
| F7 | SAB ring for worker→main tick frames (needs COOP/COEP on Vite) | M | Kills per-tick structured-clone GC pressure + task hop |
| F8 | RTC tier: verify `?net=rtc`, then split channels `unordered/unreliable` + `ordered/reliable` | M | UDP-class lane without the WT cert treadmill; also survives corporate proxies QUIC can't |
| F9 | `predictionError`-style correction diffs (nengi pattern) | M | Lighter corrections = fewer felt warps |
| F10 | WebSocketStream feature-detect for readable backpressure | XS | Chrome-only, experimental — free if present |

Deferred/rejected: OffscreenCanvas renderer-in-worker (rewrite-scale),
delta compression (bandwidth is fine at ≤16 players), 0-RTT QUIC resume
(reclaim covers it), raising tick rate above 30Hz A/B.

## Part 3 — Open verifications → ANSWERED (2026-10-18 evening)

1. ~~Does Bun expose `maxBackpressure`?~~ **Yes — `backpressureLimit`,
   default 16MB** (not uWS's 64KB). `closeOnBackpressureLimit`,
   `perMessageDeflate` (off), `sendPings` (default true), `idleTimeout`
   (120s) all exposed.
2. ~~`sendPingsAutomatically`?~~ **Yes — `sendPings`, default true.** F4
   resolved free.
3. ~~Fanout corked?~~ Handlers are corked; tick fanout is a timer (not a
   handler) — `ws.cork` exists and replayTo now corks its burst.
4. ~~The 47% WT datagram number~~ **REAL, not a cadence artifact.**
   Honest seq-gap measurement (GPU soak): ~33% sustained loopback loss,
   one run pinned at 100% when the binLane stream silently never opened.
   QUIC datagrams are congestion-controlled — dropped past cwnd, never
   retransmitted. Conclusion: datagrams are unfit as the primary state
   lane; **tick frames now ride stream-2 (reliable, HoL-isolated)** on
   WT, datagrams only pre-handshake fallback. Post-change soak: seq loss
   40% → ~3%.
5. Hidden-tab: position pump (which carries the app ping) dies with rAF
   → 60s silence → idle reap. Fixed: the 1s watchdog interval now sends
   the liveness ping while hidden; if intensive throttling suspends
   timers, the silence is real and the reap is right.

## Part 4 — What shipped from this doc

- **F1** `sendReliable` — checks `ws.send()` status on every reliable
  send; `0` = transport dropped it → count `reliableDropped` /
  `healthBump('reliableDrop')`, close `1011 'reliable drop'` so the
  client reclaims + journal-replays instead of silently losing events.
- **F3** `replayTo` corks the reclaim burst (one flush vs ~1024
  syscalls); guarded for test mocks without `cork`.
- **F5** hidden-tab liveness ping in the stall watchdog.
- **F6** telemetry split: `loss` = real tickSeq gaps (server shed /
  datagram drops) vs `gap` = arrival-cadence gaps (coalescing). New
  `clientStats.gap` field rides the uplink; server stores it.
  Side-discovery: WS also sheds ticks during event bursts — `loss ~27%`
  on loopback is real server shed at the 256KB cap, previously
  invisible.
- **F2** WT routing flip: ticks prefer stream-2; found+fixed the
  shared-`binScratch` torn-prefix race that wedged the peer's
  carry-parser permanently, and the hung-`createBidirectionalStream`/
  no-retry path that left sessions on the datagram lane forever
  (2s timeout + 500ms reopen retry).
