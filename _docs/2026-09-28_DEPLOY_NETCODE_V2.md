# Netcode v2 — deployment guide

How to run the three-tier transport stack (WebTransport → WebRTC → WebSocket)
in production.

## Ports

| Port  | Proto        | Purpose                                    |
|-------|--------------|--------------------------------------------|
| 8080  | TCP          | HTTP + /ws WebSocket + /rtcs RTC signaling |
| 9443  | UDP          | WebTransport (QUIC/HTTP3)                  |
| 3478  | UDP+TCP      | TURN/STUN server (coturn, optional)        |
| 49152-65535 | UDP    | TURN relay range (coturn, optional)        |

## Environment

```
FPS_PORT=8080                 # HTTP/WS listener
FPS_WT_PORT=9443              # QUIC listener (omit to disable WT)
FPS_WT_CERT=certs/server.crt  # TLS cert for QUIC (required for WT)
FPS_WT_KEY=certs/server.key
FPS_ICE_SERVERS=stun:stun.l.google.com:19302,turn:turn.example.com:3478?username=u&credential=p
FPS_SECRET=<random>           # HMAC key for playerId claims — set it!
FPS_ADMIN_TOKEN=<random>      # admin API
FPS_SERVER_NAME=KRIBES-1
FPS_SERVER_REGION=us-east
```

`FPS_ICE_SERVERS` is a comma-separated list served at `/rtcconfig` and fed
straight into `RTCPeerConnection` — accepts `stun:`/`turn:`/`turns:` URLs with
optional `?username=&credential=` suffixes.

## Certificates

- **WT (browser, real internet):** QUIC requires a publicly-trusted cert.
  `serverCertificateHashes` pinning only works for certs ≤14 days — fine for
  dev (`certs/dev.crt`), not production. Point a subdomain at the server, get
  Let's Encrypt via Caddy/certbot, set `FPS_WT_CERT`/`FPS_WT_KEY` to the
  real pair.
- **RTC:** no cert needed — DTLS is internal, ICE handles auth.
- **WS/HTTP:** TLS is NOT required for ws:// on a real deployment (browsers
  allow ws over http), but if you serve the page over HTTPS you must use
  `wss://` — put Caddy/nginx in front terminating TLS → proxy to `FPS_PORT`.

## TURN (coturn) — only for hostile NATs (~10-20% of players)

```bash
apt install coturn
```

`/etc/turnserver.conf`:
```
listening-port=3478
realm=kribes.example.com
user=kribes:<password>
min-port=49152
max-port=65535
fingerprint
lt-cred-mech
# log-file=stdout
```

Then `FPS_ICE_SERVERS=stun:stun.l.google.com:19302,turn:<your-ip>:3478?username=kribes&credential=<password>`.

TURN relays ALL game traffic for relayed peers — budget ~60-100 kbps per
relayed player. Watch `/metrics` `tiers{}` to see how many RTC peers land.

## Health & observability

- `GET /health` — liveness
- `GET /metrics` — uptime, players, rooms, joins/leaves, `tiers{ws,wt,rtc,other}`,
  `tickLagMs{avg,max}` — alert on tickLagMs p95 > 20.
- `GET /rooms`, `GET /serverinfo` — lobby/server browser data.

## Failure behavior

- WT addon fails to load or env missing → tier silently disabled, WS still serves.
- RTC unavailable → probe fails, client falls through to WS automatically.
- Mid-game tier drop → client re-probes WT+RTC and reconnects through whatever
  answers; player state survives via the grace-period token.
