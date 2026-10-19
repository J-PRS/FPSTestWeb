# Netcode Deep Dive #7 — Deployment, transport internals, DST methodology, reclaim-path audit

Round 7. Prior reports hardened the tick pipeline; this round went outward
(deployment for "friends online") and sideways (DST methodology + a fresh audit
that found a genuine attack on the reclaim path).

## 1. Deployment reality check (the original motivation)

**VPS is the answer; PaaS can't carry WebTransport.** Arbitrary UDP inbound:
Hetzner ✅, DigitalOcean ✅, OVH ✅ (+ always-on anti-DDoS, best hobby option),
Oracle free-tier ARM ✅. Railway/Render/Vercel/CF Workers ❌ (TCP-only). Fly.io
works but UDP needs a ~$2-5 dedicated IPv4 and binds to `fly-global-services`.
~$4-6/mo CX22-class box, `bun --smol`, systemd `Restart=always`,
`LimitNOFILE=65536`, `MemoryMax=512M` as leak guard. Logs → journald, done.

**WebTransport cert rules (Chrome, verified against Chromium source):**
- Non-localhost: publicly trusted cert required. mkcert/private CA fails
  (`ERR_QUIC_CERT_ROOT_NOT_KNOWN`) — Chrome needs a *public* root.
- `serverCertificateHashes` escape hatch: ECDSA only (RSA rejected), total cert
  validity ≤14 days, hash over leaf DER, lowercase "sha-256". Means a DIY
  rotation script: cron makes a 13-day cert, `GET /wt-cert-hash` serves the
  hash. ~10 lines, no standard tooling exists.
- Friends who'll run `--webtransport-developer-mode` skip all of it.
- **Staleness flag**: researcher claims Bun's native WT is still PR-stage
  (`webtransport:` handler = datagrams only, streams unimplemented). We run WT
  via our own adapter today — verify what our Bun 1.3.14 build actually does
  before planning a VPS migration around it.

**CGNAT home hosting:** Cloudflare Tunnel = WS yes, WT no (UDP inside
cloudflared is Zero-Trust private access only). Tailscale Funnel same. Real
Tailscale (friends install it) carries UDP/QUIC fine + solves certs via
`*.ts.net` Let's Encrypt — arguably the *best* friends-only option: no public
IP = no DDoS problem at all.

**DDoS:** CF Spectrum for arbitrary UDP = Enterprise (~$30k/yr). Out. The real
strategy for ~24 friends is "don't publicize the IP" + OVH's free scrubbing.
Cheap extra: iptables drops non-QUIC UDP — QUIC Initials are ≥1200B so
`udp length < 1200 drop` kills most floods.

**Ping geography for a 20Hz game:** US coast-to-coast 65-80ms; central
(Dallas/Chicago) equalizes ~35-55ms. Transatlantic 75-110ms floor.
Hetzner is coastal-only US (Hillsboro/Ashburn); OVH Vint Hill is east.
At ≥100ms RTT, jitter matters more than ±20ms of geography — pick clean
peering over marginal location.

## 2. Transport internals — corrected mental model

**Bun ≠ uWebSockets.js.** Bun embeds its own fork of uSockets + a Zig WS impl.
Different defaults, different `send()` semantics:

| Knob | uWS.js | Bun | Ours |
|---|---|---|---|
| permessage-deflate | DISABLED default | `false` default | unset ✅ correct |
| maxPayloadLength | 16KB | 16MB | 1MB set |
| backpressureLimit | 64KB route default | **16MB** | we use our own 256KB tick cap + 4MB drown |
| send() return | 1 ok / 0 buffered / 2 dropped | ≥1 ok / -1 backpressure / 0 dropped | we check ✅ |

- **Compression: stay off.** zlib on ~100B frames at 20Hz×8 = worse bytes AND
  CPU. Note `server.publish()` compresses by default *if* perMessageDeflate is
  on — irrelevant since ours is off.
- **`ws.send()` auto-corks** each individual send (1 syscall per send already);
  per-socket `ws.cork()` only helps when >1 message goes to the same socket per
  tick — our fanout is 1 frame/socket so the earlier "cork the fanout" idea was
  correctly skipped.
- **`server.publish(roomTopic, frame)`** exists and drains once per subscriber
  — a one-line migration from our per-socket loop if we ever want it. Minor.
- Chrome sets TCP_NODELAY on all client sockets; usockets disables Nagle
  server-side. Nagle is a non-issue. SO_SNDBUF not exposed for TCP (OS-level
  `net.ipv4.tcp_wmem` only).
- lsquic CC: default is adaptive (Cubic if RTT≤1.5ms else BBRv1); upstream
  flipped to Cubic default because event-loop-paced engines poisoned BBR's
  first RTT sample. Whether Bun exposes `lsquic_engine_settings` or server-side
  conn stats: no documented API. Our 33% datagram loss lives behind this wall —
  browser-side `getStats()` remains our only honest ruler.

**HoL on one WS connection is real:** a lost segment stalls ticks AND events;
an event queued ahead of a tick delays the tick. Options: second WS for ticks
(cheap, same-process, removes inter-lane HoL) or WT datagrams for ticks + WS
for events (better but needs the cert story above). **Two-WS split is the lazy
P2 win** — no new transport, no cert problem, just a second handshake bound to
the same session token.

## 3. DST methodology — what FoundationDB would do here

We now have the hard parts (seeded `lcg32` with save/restore/draws, journals,
per-tick `computeStateHash`). What the FDB/AoE/GGPO lineage adds:

1. **Per-consumer stream derivation is the one thing to copy**: derive each
   fault/input stream via `hash(masterSeed, label)` — NOT one shared stream,
   or adding a fault site re-phases every prior reproducer. We already enforce
   this principle between simRand/botRand; extend it to test harness faults.
2. **BUGGIFY-style biased faults**: uniform random drops rarely hit the
   compound conditions (disconnect *during* burst, fault *at* checkpoint
   boundary). Two seeded gates per site: activation (~25%, once) + firing
   (~25%, per hit).
3. **Synctest (GGPO's sync_test.cpp)**: ring buffer of (state, inputs, hash);
   every N ticks restore M ticks back, resim, compare hash. ~50 lines, catches
   in-process nondeterminism AND save/restore bugs simultaneously. This is now
   implementable — `lcg32.save()/restore()` exists.
4. **Hierarchical hashes** (Spring RTS model): entity → kind → world,
   XOR-composed; a root mismatch localizes top-down. **Include the LCG state
   in the hash** (OpenBW does this first — catches RNG-consumption-order bugs
   instantly). Our `rngStream.draws` is exactly this data point.
5. **Two-pass desync tooling** (tickwise): pass 1 = per-tick hash + input
   record always on; divergence tick found by file diff offline. Pass 2 =
   replay to that tick, state-dump, structural diff. No live binary search.
6. **Swarm testing (Groce et al. ISSTA'12)**: randomizing which fault classes
   are enabled per run beat everything-on by **42% more distinct crashers** —
   features suppress each other's bugs. Our fuzzKit already chaos-drains lanes;
   swarming = randomize enabled-faults/probabilities/player-count per run.
7. **Remaining JS nondeterminism after Math.random/Date.now bans**: -0 vs 0
   hash asymmetry, NaN!==NaN breaking comparisons, JSON.stringify key-order
   (use canonical serialization for hashing, never raw stringify of arbitrary
   objects), `localeCompare`/`Intl` (ICU differs JSC↔V8!), Map insertion order
   derived from async arrival order, Promise/microtask interleaving reaching
   into tick order. `dmath.ts` sealed transcendentals; this list is the rest.

## 4. Reclaim/spectator audit — the real finds of this round

🔴 **R1 — session tokens are deterministic + immortal + a kick lever.**
`SessionManager.ts:73` `tokenFor() = HMAC(playerId, secret)` — same value
forever, no TTL/rotation/nonce. The reclaim checks the token BEFORE the
connected check — a leaked token evicts a *live* player repeatedly. Tokens sit
in localStorage AND committed test fixtures (`duel.rec`). Fix: per-reclaim
counter/rotation, or at minimum cap `protectedUntil` re-arms per seat (every
reclaim grants 2.5s invulnerability — a deliberate flap chains invuln windows).

🟡 **R3 — `room.introSeq` is room-global.** One rejoiner forces full unmasked
records for the ENTIRE room for ~1s (`tickRecords.ts:195`), and N rejoiners
stack N bursts. Built per-room, needed per-joiner. Fix: per-recipient intro
map in tickRecords (sits next to `tierMem`, same sweep discipline).

🟡 **R4 — `replayTo` bypasses backpressure.** `ConnectionManager.ts:191` sends
up to ~1024 journaled frames via raw `ws.send` — no drownCheck, no return-status
check, no reliableDropped accounting. A drowning client gets re-flooded and the
drops are metric-silent. Route through the same `drownCheck`+`sendReliable`
path everything else uses.

🟡 **S1/S2 — spectator path is a drifting parallel impl.** Spectators get the
full record set every tick, no interest tiers (`tickRecords.ts:400`), and
`GameServer.ts:232` drops ALL spectator JSON — specs can't `pong` (no RTT),
can't `resync`/`snapshotRequest` (permanent desync on any gap), can't hop
rooms. Allowlist those verbs.

🟡 **P1 — protocol mismatch = silent frozen client.** After 2 reload attempts
`wireIn.ts` just `return`s — socket stays open, remotes freeze forever. Either
close the socket on budget exhaustion (one line) or put a version in `join` and
reject at handshake.

🟡 **W1 — pre-join CPU DoS.** `JSON.parse` runs before the type check; a socket
can send unlimited 1MB JSON frames pre-join (`maxPayloadLength` applies but is
1MB per frame). Rate-limit or cap message size pre-seat.

🟢 R2 note: `chargeBank` is lost on any disconnect (`CombatHandler.ts:292`) —
visible gameplay loss for flapping players. Decide if intended.
🟢 E1: ~60 e2e probes are dead code, ungated; fixture `.rec`s pin protocol v11.
🟢 W4 unverified: chat text length cap server-side — worth a grep.

## 5. Latency budgeting — where the ms actually hide

Honest input→remote-photon budget at 20Hz: input delay 0-8ms + avg tick-wait
**25ms** (biggest systematic server-side delay — inputs sit until next tick) +
tick/fanout few ms + RTT/2 + interp dwell 50-150ms + frame + present ~10-25ms
→ **~120-200ms** is the honest floor. That's fine — prediction exists to hide
it for the local player; the remote-view path is what interp pays.

Measurables we don't have yet:
- **NTP-style offset on the existing ping** (t0/t1/t2/t3) → per-hop estimates
  from the client's stamp vs server arrival spacing (the clockProbe data is
  already collected — just split the components).
- `performance.now()` is 100µs-grained post-Spectre unless COOP+COEP
  cross-origin isolation restores 5µs — and COI also unlocks SAB +
  `measureUserAgentSpecificMemory()`. Two headers in the Vite config, worth it.
- `scheduler.yield()` (Chrome 129+) > setTimeout(0) for breaking up big
  message-handler batches — continuations preempt before new tasks.
- `bun --cpu-prof` shipped in Bun 1.3.2 → `.cpuprofile` → speedscope. We
  haven't profiled the tick loop once with a real sampler. Do it on the next
  soak.
- CDP `HeapProfiler.startSampling` in a puppeteer soak attributes allocation
  churn headlessly — set `includeObjectsCollectedByMajorGC` or it misses
  transient allocations (the GC-pressure driver).

## 6. Plan table

| Pri | Item | Size | Payoff |
|---|---|---|---|
| P0 | Close socket on protocol-version budget exhaustion (wireIn) | 1 line + test | kills silent-frozen-client class |
| P0 | `replayTo` through drownCheck/sendReliable (R4) | ~10 lines | reclaim flooding becomes measured |
| P0 | `bun --cpu-prof` one soak → speedscope the tick | 30 min | first real sampler profile ever |
| P1 | Per-recipient introSeq (R3) | ~30 lines | join bursts stop amplifying room-wide |
| P1 | Spectator verb allowlist (S2) | ~10 lines | specs can resync/probe |
| P1 | Session-token rotation or protectedUntil flap cap (R1) | ~30 lines | kills permanent kick-lever |
| P1 | Pre-join JSON throttle (W1) | ~15 lines | kills free CPU DoS |
| P1 | LCG state + subsystem hashes in the world hash | ~40 lines | desync bisection, RNG-order bugs |
| P2 | GGPO-style synctest harness | ~50 lines | in-process nondeterminism canary |
| P2 | Second-WS tick lane (interim WT substitute) | ~half day | kills inter-lane HoL |
| P2 | Swarm config for fuzzKit (seeded fault subsets) | ~30 lines | 42%-more-bugs methodology |
| P2 | COOP+COEP headers | 2 lines | 5µs clocks + SAB + real memory API |
| P3 | WT `serverCertificateHashes` rotation script + VPS migration doc | half day | the actual "friends online" path |
| P3 | `server.publish` room-topic fanout | ~10 lines | marginal |
| P3 | e2e probe graveyard cleanup + compile gate | half day | test-debt hygiene |

Skipped this round: didn't verify chat length cap (W4), didn't confirm which
WT API surface Bun 1.3.14 actually ships, no WAN soak run. The auth-secret
question (is `identitySecret`/`HMAC secret` checked in anywhere) needs a grep
before treating R1 severity as final.
