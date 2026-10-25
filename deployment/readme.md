# anabatic-server: deployment index

A real-internet game server on Oracle Cloud Always Free, serving WebSocket, RTC relay and
WebTransport for `rimrock` matches. HTTPS via `https://play.jprice.app`.
**Everything runs on free-tier resources. Do not upgrade shapes or the account.**

Last updated: 2026-10-24.

## Start here

| File | Covers |
|------|--------|
| `oracle.md` | Oracle account, hosts, free-tier limits, security list, host firewall, OCI CLI, SSH |
| `dns-https.md` | Porkbun domain and API, secrets, Caddy HTTPS front, Let's Encrypt |
| `server.md` | Running `server_bun` on the A1, endpoints, redeploy, Bun notes |
| `webtransport.md` | Building the arm64 WebTransport addon, the self-signed cert, UDP 443 forward |
| `client.md` | Connecting the browser client: `/quickjoin`, path aliases, `server.json` |
| `known-issues.md` | Open issues, verification status, uncommitted repo changes, pre-commit steps |

## Current state

| Thing | State |
|-------|-------|
| Game server | running on the A1 (`92.5.61.55`), Bun 1.4.4, server v0.1.20, 12 players at last check |
| HTTPS | `https://play.jprice.app` with a Let's Encrypt cert, verified |
| `/ping` | deployed, `{"pong":true}` |
| WebSocket | `wss://play.jprice.app/ws` (port 8000 closed 2026-10-24) |
| WebTransport | `play.jprice.app:443/udp` (forwarded to 9443). Browser handshake verified with 9443 closed |
| Headhunt token changes | deployed, not verified in a live round |
| Friend URL | `https://play.jprice.app/quickjoin` (verified). `/quickplay` is NOT a route |
| Static client | served by Caddy from `~/anabatic-client` on the box (see `dns-https.md`) |
| Porkbun secret | pasted into chat. **Rotate it.** |
| Micro `92.5.63.91` | running, spare. WebTransport cannot load there |
| Terminated A1 | still listed in OCI. Delete when convenient |

## Deadlines

- **WebTransport cert expires 2026-11-06.** Renewal is manual and needs a server restart
  (see `webtransport.md`). Do it in a quiet window before that date, and check
  `openssl x509 -in ~/kribes/certs/cert.pem -noout -enddate` on the box.
- Let's Encrypt cert for `play.jprice.app` auto-renews by Caddy; current expiry 2027-01-22.

## Audit 2026-10-24 (latest)

- External TCP: 22, 80, 443 open. 8000, 9443, 111 closed. UDP 443 for WebTransport.
- Server log: no errors since the last restart. Memory: ~140 MB RSS with ~27 players.
- Caddy headers added: HSTS (1 year), nosniff, no-referrer, and the `Server` banner removed.
- fail2ban active on SSH; rpcbind disabled.
- Static client and API both verified on `https://play.jprice.app`.

## Next steps

1. Rotate the Porkbun secret and update `.env.pork`. Verify with the `ping` call in `dns-https.md`.
2. Live test on `play.jprice.app`: headhunt tokens arc and fall, and a session reject no longer benches WT (see `known-issues.md`).
3. Run the full `bun test` and `check.sh`, then commit (`known-issues.md` has the list).
4. Done 2026-10-24: port 8000 closed at both layers. HTTPS, WS and WT re-verified.
5. (Done 2026-10-24: 9443 closed, WT re-verified.) Delete the terminated A1 instance and the unused `~/.porkbun-mcp` folder.
6. Decide whether to keep the Micro as a spare or delete it.
7. Settle the `deployment/` vs `DEPLOYMENT/` folder casing.
8. Back up `/home/opc/.local/share/caddy` once the cert is stable.

## Rule for future docs

Put new facts in the topic file they belong to, and add one line to the History section of
that file with the date. Keep this index's table and state current.
