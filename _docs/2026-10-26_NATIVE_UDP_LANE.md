# Native shell + raw-UDP lane — design & spike status

2026-10-26 · Electrobun spike verified, design settled

## What this is

A thin native webview wrapper (no bundled assets — remote URL, updates
ride the client deploy) that additionally gives the web client a **raw
UDP lane** to the server — the pros-only tier below WS/WT:

```
browser page ──ws──> 127.0.0.1:8787 (main proc relay) ──UDP──> server UDP listener
```

The webview just loads the live client URL; the wrapper's main process
runs a ~30-line ws→UDP relay. No RPC bridge, no `__TAURI__`/electrobun
injection — the page talks to a plain loopback WebSocket it already
knows how to drive. Works in ANY webview (and a standalone Node/Bun
proxy for headless testing).

## Wrapper choice: Electrobun (spiked)

| Candidate | Verdict |
|---|---|
| **Electrobun** (blackboard.sh) | **Chosen** — main proc is Bun+TS, `Bun.udpSocket`/`Bun.serve` are the exact APIs `server_bun` already uses; ~1MB shell; CEF option for pinned-Chromium pros |
| Tauri | Fallback — proven remote `__TAURI__`, but the relay moves to Rust |
| Electron | Node `dgram` is trivial, ~200MB shell |
| .NET WebView2 | Windows-only at the light end |

Scaffolded at `native/` (`npx electrobun init`; the npm pkg is a silent
hutch bootstrap — output is empty but the project + `~/.hutch` toolchain
land). Run: `~/.hutch/bin/hutch.exe electrobun dev`, or launch the built
`native/build/dev-win-x64/hello-world-dev/bin/launcher.exe` directly.

### Verified (2026-10-26)

- `src/bun/index.ts`: `BrowserWindow` → `CLIENT_URL` (default
  `localhost:5400`) + `ws://127.0.0.1:8787` ↔ `Bun.udpSocket` relay →
  `UDP_TARGET_HOST:PORT` (default `127.0.0.1:9797`)
- `native/echo.ts` (UDP echo :9797) + `native/test_relay.ts` (ws client)
  proved the full loop: `1,2,3,4,5` round-tripped ws→UDP→echo→UDP→ws,
  binary intact.

## Composite tier — adopt, don't race

UDP is the first tier that **can't carry a whole session**: no ordering,
no reliability, MTU caps. It is a *data lane only* — volatile seq'd
binary (position claims up, tick stream down). Join/match/edges still
need a reliable lane. So the tier model isn't another solo transport
raced in the ladder; it's a **composite**:

```
control lane:  ws://server        (join, match, edges — existing session)
volatile lane: ws://127.0.0.1:8787 → UDP → server :UDP
```

- `UdpLaneTransport` pairs loopback shim + existing ws; `send()` routes
  by message type — the same lane split `ServerRtcTransport` already
  does over its game/ctrl datachannels (tiers.ts).
- **Adopt-don't-race** (NexQuake pattern): the ws session connects
  instantly as today; the shim is warmed alongside; once the loopback
  socket opens, volatile sends flip to it. Fallback = the same ws
  session reconnect path that already exists. No probe-race latency, no
  control-lane interruption ever.
- Shim probe cost: a `ws://127.0.0.1:8787` open with ~500ms cap —
  loopback fails fast when the shell is absent; plain browsers see a
  sub-ms miss and nothing else changes.

## Server side — the real work (~700–900 LOC)

| Piece | Shape |
|---|---|
| UDP listener | `Bun.udpSocket` in-process, new port |
| Session bind | join still opens ws for identity; server issues a session token; first datagram binds addr→session |
| Anti-spoof | addr pinning + seq/replay window per conn |
| Transport adapter | `readyState` 1/3 contract like WtAdapter/RtcSocketAdapter |
| Fanout path | collect→encode→`udp.send` — tickRecords already emit binary |
| Inbound | binary claims → handleGameMessageTrusted (codecs exist) |
| Reap/keepalive + tests | |

The protocol design is the risk, not the volume: spoofed-addr claims,
replay windows, NAT addr migration, MTU.

## Prior art found

- **NexQuake** (quake.nexus) — browser Quake preserving NetQuake UDP
  through a tunnel. Their tunnel "forwards raw datagrams without
  inspecting them" (2-byte routing header) — validates the dumb-relay
  design. Their tier model: WS baseline + WT warmed in background and
  adopted between connections.
- **Xepsa engine** — identical `Transport` interface (send/poll/
  disconnect), UDP substrate in native builds, WS in web builds. Same
  contract shape as our `GameTransport`.
- NSDI'25 browser-networking paper — WS retransmit stalls kill
  positional streams; UDP-family lanes (WT datagrams, SCTP, raw UDP)
  are the right volatile-traffic tier.

## Cost estimate (working vertical slice)

| Side | LOC |
|---|---|
| Electrobun shell + ws→UDP relay (done) | ~60 real code |
| Client `UdpLaneTransport` + lane routing + shim warmer | ~350 |
| Server UDP lane | ~700–900 |
| **Total** | **~1.1–1.3k** |

Production-hardened (rate limits, addr-rebind, telemetry, packet-loss
shaping): ~2–3k.

## Open items / caveats

- The shim is currently a raw pass-through with a fixed target; the real
  design binds it to whatever session the ws join minted (server tells
  the shim its UDP port+token at join time, or the page forwards a
  bind message through the relay).
- Firefox/Safari: WT already covers their UDP-tier; the native lane is
  an additional floor for users who install the shell — pure upgrade,
  never required.
- `native/` is a spike — gitignore state, hutch toolchain under
  `.hutch/`, `build/` artifacts; decide what to commit before it lands.
