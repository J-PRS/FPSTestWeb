# UDP vs TCP + WebTransport landscape (2026-09-26)

Research pass on whether transport is worth revisiting. Companion to
`2026-09-26_TRANSPORTS_DEEP_DIVE.md` — this one is about *what's actually
shippable today*.

## What the successful web shooters use

| Game | Transport | Encoding | Source |
|------|-----------|----------|--------|
| Krunker.io | WebSocket (TCP) | msgpack positional arrays (`["k", ...]`) | third-party packet inspectors + krunker_packet_core crate |
| Narrow One | WebSocket (TCP) | CSV→JSON for skins, binary-ish hot path | Pelican Party devlogs |
| **testfps (us)** | WebSocket (TCP) | ~39 B/player binary wire + tiers + suppression | shared/wire.ts |

Both make WebSocket work because browsers have no UDP. That's it —
"modern multiplayer runs on UDP" is a *native* engine statement
(Quake/UDP, RakNet, ENet, KCP). In the browser your choices are:

- **WebSocket** — TCP. Ordered, retransmits, head-of-line blocking.
- **WebRTC DataChannel** — has unreliable/unordered mode (UDP-ish), but
  DTLS handshake pain and no Bun server story.
- **WebTransport** — real datagrams + streams over QUIC/HTTP3.
  Chrome 97+, Firefox 114+ (maturity shaky), Safari essentially absent.

## The real cost of TCP for us

HOL blocking: one lost packet freezes the stream ~1 RTT until retransmit.
At clean-connection pings (30–60ms) it's sub-frame — irrelevant. It bites
at 100ms+ or >1% loss (school/hotel wifi — coincidentally the target
audience's environment). Krunker lives with it because a lost position
update is superseded by the next one anyway; a stall only costs you
*within* a single-RTT window. Our burst moments (an AOE hitting 8
players) are the vulnerable spots, but our wire is small enough that
retransmit usually beats the next render.

Verdict: WebSocket is correct *now*. The upgrade worth keeping warm is
WebTransport behind the `INetworkAdapter` seam — not WebRTC.

## WebTransport server landscape — what's actually shippable

### Tier 1 — mature plumbing

- **quic-go/webtransport-go (Go)** — oldest, most battle-tested. Boring-
  correct serious path: a Go sidecar terminates QUIC, proxies to the Bun
  game logic. Ugly but proven.
- **Rust `wtransport`** — the library nearly everything else wraps.

### Tier 2 — new but real

- **`@webtransport-bun/webtransport`** — napi-rs wrapper around Rust
  `wtransport`. Claims **Bun ≥1.3.9 + Node + Deno**, prebuilds for
  mac/linux/win-x64. Datagrams + streams. This is the interesting one:
  means *no Node swap needed*. Caveat: ~70 weekly downloads, young,
  single maintainer — promising experiment, not prod infra.
- **`rwebtransport`** — Node client+server bound to **Cloudflare quiche**
  (the engine behind a large slice of real-world HTTP/3). Standard
  browser `WebTransport` API surface, WHATWG streams. Prebuilt for
  Node 24/26 on linux x64/arm64 + macOS arm64. Most "prod" Node option.
- **`@moq/web-transport`** — Node polyfill from the moq.dev
  media-over-QUIC crew (kixelated). quiche-family stack, W3C API,
  `install()` sets it as global `WebTransport`.

### Tier 3 — clever bridge

- **moq `qmux`** — implements the WebTransport API surface *over
  TCP/WebSocket* with wire compat. Code against `WebTransport` today on
  the existing WS server; swap the wire underneath later. Adapter
  without a rewrite.

### Go frameworks

- **rarebek/wt** — Gin-style framework over webtransport-go: routing,
  middleware, rooms, stream multiplexing + datagrams. If the Go sidecar
  path is ever taken this is the friendly API.
- **propagamap/webtransport-server** — lightweight WT-over-HTTP/3 in Go.

## The verdict

There is no "boring production" answer — even Go is "prod-grade library,
you build the ops." For this stack the standout is **`@webtransport-bun`**:
if it works, datagrams land in the existing Bun server for the cost of
one dependency — no rewrite, no Node port, no sidecar. The cheap test:
bind server, datagrams flow, browser client connects over https.

If that smoke test impresses, the next step is a **parallel WT probe**
behind `INetworkAdapter` — keep WS as the transport of record, run WT
on a second port for Chrome clients, A/B latency on a live session.
Only after that earns its keep would a port/sidecar be discussed.

## Practical caveats

- QUIC needs a real TLS cert (self-signed → Chrome flags; prod needs
  LetsEncrypt or similar on the game domain).
- WT is Chrome-first: Firefox has it but flaky at edges, Safari absent.
  WS fallback is mandatory — dual transport is the permanent shape.
- Datagrams are fire-and-forget: hot path (positions) datagrams,
  events (shots/damage/join) stay on reliable streams. Same split the
  binary/JSON boundary already implies.
