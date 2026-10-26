# Transport tiers — WS + WT, RTC out of the auto ladder

2026-10-26 · decided live on the OCI deploy

## The ladder

`connectGameTransport` (`client/src/networking/tiers.ts`) probes best-first:

```
WebTransport (QUIC datagrams, tier='wt')
  → WebSocket (TCP floor, tier='ws', always available)
```

`?net=wt|rtc|ws` pins a single tier for tests/netbots. `?net=auto`
(default) is now WT probe → WS; the RTC datachannel probe was removed
from the raced set on 2026-10-26.

## Why RTC left the ladder

1. **It never worked on the deploy anyway.** `/rtcconfig` returns
   `iceServers:[]` — `FPS_ICE_SERVERS` unset. Without STUN a WAN
   RTCPeerConnection gathers no routable candidate; every WAN client
   silently fell to WS. Verified live: netbots over
   `wss://play.jprice.app` reported `0 rtc` across every connect.
2. **It never ran for real clients at all.** `RTCPeerConnection` does
   not exist in the net worker — `tryWebRTC` early-outed there, so the
   browser game landed WS/WT regardless. The auto probe only fired for
   non-worker contexts (netbots, tests).
3. **Cost per connect.** The probe burned a `/rtcconfig` fetch, a
   PeerConnection, up to ~2.5s ICE gather + 8s cap — muted or not, that
   work happened on every connect attempt.
4. **Research agrees.** NSDI'25 ("Evaluating Browser-Based Networking
   for Real-Time Multiplayer Games") + the bevy/rpc and Kengin engine
   writeups: WebTransport is the right client↔server realtime tier —
   QUIC datagrams, latency-tuned congestion control, no ICE/DTLS/SCTP
   stack pretending to be a media peer. RTC's real advantage is NAT
   traversal for **peer-to-peer** — a problem a public game server does
   not have.

## What still uses WebRTC

- **`?net=rtc` pinned joins** — netbots/tests over `netLink.connectRtc`
  (server-side RtcServer + `/rtcs` answer stays live; LAN works without
  ICE config).
- **P2P friend hosting** (`?p2p=host|join|quick`) — browser↔browser
  DataChannel via `/rtc` signaling; uses its own hardcoded
  `stun.l.google.com:19302` in `p2p/signalling.ts`, not `/rtcconfig`.
  Independent of the server tier and unaffected.

## Caveats

- **WT is Baseline now (March 2026)** — Firefox ≥125 supports the full
  spec incl. `serverCertificateHashes` (fixed in Mozilla bug 1873263),
  Safari 26 added it; older browsers fall to WS. The earlier "Firefox
  has no WT" concern is stale — every current browser can ride UDP-tier
  where the QUIC edge is open.
- **WS remains the universal floor.** No client should ever be unable to
  connect; the 4s WT cap exists so a non-QUIC edge doesn't starve joins.
- **P2P is the only surface where ICE still matters** — if friend
  hosting moves to production, its own STUN/TURN story is the review
  point, not the server tier.

## Provenance

- Live probe: `bun tools/netBot.ts --url wss://play.jprice.app/ws`
  → `0 rtc` (all WS) on 2026-10-26.
- `/rtcconfig` on OCI: `{"iceServers":[]}`.
- NSDI'25: aaron.gember-jacobson.com/docs/nsdi2025browser-networking.pdf
- Dev blogs: metabrew.com (bevy rollback), kengin.games dev blog.
