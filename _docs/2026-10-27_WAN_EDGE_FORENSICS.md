# WAN edge forensics — UDP lane + silent WT death (2026-10-27)

What it took to make the WAN edge actually work, and the two failure
classes that only surfaced by probing every layer separately. Nothing
here was broken loudly — every layer failed silently and degraded to
"still playable, wrong tier."

---

## 1. The inbound firewall has THREE gates, not two

UDP 9898 to `play.jprice.app` must pass:

```
internet ── OCI NSG (anabatic-sl) ── host firewalld ── Bun socket
              cloud edge               nftables            0.0.0.0:9898
```

- **OCI NSG** is the cloud-side gate — `oci network security-list update`
  must resend the **full** rule set or it overwrites. UDP/443 (WT) was
  already there; `9898` added 2026-10-27.
- **firewalld** runs on the Oracle Linux box itself — `iptables -L`
  showed an empty INPUT chain while firewalld's nftables backend was the
  real filter. `sudo firewall-cmd --list-all` is the truth, not iptables.
  The public zone had `dhcpv6-client http https ssh` + a `443/udp→9443`
  forward-port only; 9898 needed `--add-port=9898/udp --permanent`.
- **tcpdump is the decider**: it taps the NIC *before* netfilter. Zero
  packets at `tcpdump -n udp port N` = dropped upstream (NSG or transit),
  never a host-firewall question.

## 2. Production WT was silently dead since the Caddy move

The client (`tiersWebTransport.ts`) refuses WT when the page origin is
:443 but `/wthash` advertises a different port — a deliberate guard
against forward proxies that can't carry QUIC:

```ts
if (basePort === '443' && String(info.port) !== '443') {return null;}
```

The box's `.env` lacked `FPS_WT_ADVERTISE_PORT`, so `wtAdvertisePort`
defaulted to the local bind `9443` → every WAN client refused → every
session ran on `ws`. No error, no log, just a silently worse tier.

- Fix: `FPS_WT_ADVERTISE_PORT=443` in `~/kribes/.env` (and the legacy
  `server.env` sibling). `/wthash` then advertises 443, matching the
  firewalld `443/udp→9443` forward-port, and real QUIC handshakes land.
- Verified: headless Chrome `WebTransport('https://play.jprice.app:443',
  {serverCertificateHashes})` → `ready` resolves over the real WAN.

The doc (`deployment/server.md`) listed the var correctly — the *box*
didn't have it. Config docs describe intent; only probing the live
endpoint proves it.

## 3. Bare restarts drop the environment — no warning anywhere

`bun src/server.ts` does NOT auto-load `~/kribes/.env` (cwd is
`server_bun/`, and Bun only auto-loads `.env` in the cwd). The deploy
script + documented restart both do `set -a; . ~/kribes/.env; set +a`
first. A bare `nohup bun ...` restart silently loses every env var —
`FPS_UDP_PORT` vanished mid-session and only `ss -uln` showed it. Health
stayed green; the box looked healthy while running config-less.

Rule: remote restart =

```bash
kill <pid>; sleep 3
cd ~/kribes/server_bun && set -a && . ~/kribes/.env && set +a \
  && nohup ~/.bun/bin/bun src/server.ts > ~/kribes/server.log 2>&1 &
```

## 4. My ISP drops arbitrary outbound UDP — and that's normal

Discriminating experiment matrix from this machine (all with tcpdump
watching `enp0s6` on the box):

| Probe | Arrived? |
|---|---|
| QUIC handshake → :443 (real WebTransport) | ✅ `WT_READY` |
| NTP → 1.1.1.1:123 / Cloudflare :123 | ✅ reply |
| raw UDP → :443 | ❌ |
| raw UDP → :80 | ❌ |
| raw UDP → :3478 (STUN) | ❌ |
| raw UDP → :9898 | ❌ |

QUIC/443 passes because it's a *session-shaped* flow on a universally
whitelisted port. Arbitrary datagrams to any non-well-known destination
port die between the NIC and the OCI edge — classic residential
anti-amplification egress filtering (Windows Firewall is clean,
AllowOutbound; LAN and loopback UDP work).

**Design consequence**: the raw-UDP volatile lane is an optimization
that silently does nothing on filtered consumer networks. WT's QUIC
datagrams (UDP/443) are the UDP path that survives everywhere — a
`wt`-tier client already gets datagram volatile traffic without the raw
lane. Scoreboard tier strings decode the live reality:

- `wt` — session + volatile on QUIC datagrams (works anywhere QUIC does)
- `wt+udp` — volatile also on raw :9898 (unfiltered networks only)
- `ws+udp` / `ws` — TCP session ± raw lane

## 5. WAN netbot battery — the harness must adapt to a persistent server

`FPS_SOAK=1 NETBOT_URL=wss://play.jprice.app/ws bun test tests/netbot/`
drives the same scenarios at the live box. Three remote-only wrinkles:

- **Seats persist across test files** — `nb_0` stays claimed while the
  grace window runs, so the next file's `nb_0` gets "claimed playerId,
  bad token". Fix: per-harness nonce in the id (`nb_<nonce>_<i>`).
- **`/rtcs` isn't Caddy-proxied** (only `/rtc`, `/rtc/*`), and ICE needs
  bidirectional UDP anyway — ws-only transports remotely.
- `rttProbe` reads `env().gs` internals — local-only by nature.
- `Shot: shooter dead` is a legal reject under jitter (fire races the
  death edge) — excluded from the zero-rejects invariant.

Battery green on WAN: ctfFlag, deploy, rejoin, roomHop, wsFight,
harshWan (6 real-socket scenarios over live `wss`).

## Files / scripts touched

- `server_bun/src/config.ts` — `wtAdvertisePort` default chain
  (`FPS_WT_ADVERTISE_PORT` → `FPS_WT_PORT` → `FPS_PORT+1443`)
- `client/src/networking/tiersWebTransport.ts` — the 443-origin guard
- `server_bun/tests/netbot/helpers.ts` — nonce'd ids under `NETBOT_URL`
- `deployment/server.md` — env-file truth + restart command
- Box state: `.env` + `server.env` gained `FPS_WT_ADVERTISE_PORT=443`,
  `FPS_UDP_PORT=9898`; NSG `anabatic-sl` has UDP/9898; firewalld has
  `9898/udp` permanent
