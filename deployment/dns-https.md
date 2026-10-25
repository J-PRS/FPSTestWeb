# DNS, HTTPS and secrets

Scope: the `jprice.app` domain at Porkbun, the Caddy HTTPS front on the A1, and where secrets live.
Status and index: `readme.md`.

## Domain (Porkbun)

- Domain `jprice.app`, registered at Porkbun, nameservers `curitiba/fortaleza/maceio/salvador.ns.porkbun.com`.
- Existing records: an ALIAS on the apex, a wildcard `*.jprice.app` CNAME to
  `pixie.porkbun.com`, and NS records. An explicit record beats the wildcard.
- Our record: `A play.jprice.app -> 92.5.61.55`, TTL 600, Porkbun record id `597645681`,
  created 2026-10-24 through the API.
- API access is enabled for this domain (Porkbun keeps it off by default). The key has `full` scope.

## Secrets

- Porkbun key and secret: `C:\TEMP\_WEB\FPSWebTest\.env.pork`, keys `key=` and `secret=`.
  Git ignores it through the `.env.*` rule. Never print its values.
- **The secret was pasted into the chat transcript. Treat it as compromised.**
  Rotate it at https://porkbun.com/account/api, update `.env.pork`, then run the ping check below.
- Server admin token: `FPS_ADMIN_TOKEN` in `~/kribes/server.env` on the box (mode 600).
  Admin routes take it as `?key=`. Use SSH to reach admin routes. Do not call them over
  plain HTTP from a public network, because the query string is readable on the path.
- The public IP and the domain name are not secrets. DNS and Certificate Transparency
  logs expose them. Protection comes from closing unused ports, keeping admin routes off
  the public network, and keeping the tokens private.

## Porkbun API

Auth: JSON body `{"apikey": "...", "secretapikey": "..."}`, or the `X-API-Key` /
`X-Secret-API-Key` headers.

- Check the key: `POST https://api.porkbun.com/api/json/v3/ping`. Valid key returns
  `"credentialsValid":true`.
- List: `POST .../dns/retrieve/jprice.app`.
- Create: `POST .../dns/create/jprice.app` with `name`, `type`, `content`, `ttl`. Send an
  `Idempotency-Key` header with each write.
- Edit and delete: `POST .../dns/edit/jprice.app/{id}` and `.../dns/delete/jprice.app/{id}`.
- Check the authoritative answer after a change:
  `nslookup play.jprice.app curitiba.porkbun.com`. Public resolvers (8.8.8.8) cache
  old answers for a few minutes.

## Porkbun MCP (not installed)

- Porkbun publishes `@porkbunllc/mcp-server` (repo `oborseth/Porkbun-MCP`).
- Not installed. The latest release (0.52.0, 2026-10-18) is under the 7-day vetting window.
  The newest release older than 7 days is 0.51.1. An install attempt in `~/.porkbun-mcp`
  left an empty directory and printed a 30-vulnerability audit. The repo was not changed.
- Decision: use the REST API directly.
- If the MCP is wanted later: install 0.51.1 with `--save-exact` in an isolated folder and
  read the audit before using it. Delete `~/.porkbun-mcp` if it stays unused.

## Caddy (HTTPS front)

- Binary: `/usr/local/bin/caddy`, Caddy 2.11.7, static build for linux arm64.
- Service: `caddy.service`, runs as `opc`, capability `CAP_NET_BIND_SERVICE` only,
  `Restart=on-failure`.
- Config `/etc/caddy/Caddyfile` (2026-10-24, serves the static client and proxies the API):
  ```
  {
  	servers {
  		protocols h1 h2
  	}
  }

  play.jprice.app {
  	encode zstd gzip

  	@api path /ws /rtc /rtc/* /health /ping /join /join/* /rooms /rooms/* /maps /maps/* /matches /metrics /serverinfo /stats /status /weaponstats /wire /wthash /rtcconfig /demos /demos/* /admin/* /dev/*
  	handle @api {
  		reverse_proxy localhost:8000
  	}

  	handle {
  		root * /home/opc/anabatic-client
  		try_files {path} /index.html
  		file_server
  	}
  }
  ```
- Security headers are set in the same site block: `Strict-Transport-Security`,
  `X-Content-Type-Options nosniff`, `Referrer-Policy no-referrer`, and `-Server`.
  Previous config saved at `/etc/caddy/Caddyfile.bak` on the box.
- Static client: `~/anabatic-client` (the `client/dist` build). To update the client:
  ```
  cd client && npm run build
  ssh ... opc@92.5.61.55 'rm -rf ~/anabatic-client && mkdir -p ~/anabatic-client'
  scp -r -i ... dist/. opc@92.5.61.55:/home/opc/anabatic-client/
  ```
  No Caddy restart is needed; files are served directly.
- `protocols h1 h2` turns HTTP/3 off. That frees UDP 443 for WebTransport. Do not turn HTTP/3 back on.
- Certificates: Caddy obtains and renews the Let's Encrypt cert itself, using http-01 on port 80.
  State is in `/home/opc/.local/share/caddy`. Back that directory up. Reinstalling without it can
  hit Let's Encrypt rate limits.

Operations:
- Status and logs: `sudo systemctl status caddy`, `sudo journalctl -u caddy -n 50`.
- Change the config, then:
  `sudo /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile` and `sudo systemctl reload caddy`.
- Upgrade: replace `/usr/local/bin/caddy` with a new static binary (from caddyserver.com's
  download page), then `sudo systemctl restart caddy`.

## Verify HTTPS

```
curl -s https://play.jprice.app/health
curl -s https://play.jprice.app/ping              # {"pong":true}
curl -s -o /dev/null -w "%{http_code}\n" http://play.jprice.app/   # 308 redirect to https
```

WebSocket upgrade returns 101 on `/ws`. Verified 2026-10-24.

## Backups (2026-10-24)

- Local copy: `C:\Users\JPrice\anabatic-backup\20261024-2345\` (outside the repo). Contains
  `caddy-data/` (Let's Encrypt account and cert for play.jprice.app), `server.env` (admin
  token) and `certs/` (WebTransport self-signed cert and key). It holds private keys.
- Not backed up: the Porkbun secret (still local in `.env.pork`; rotate it, then re-copy only
  `.env.pork` into the backup folder if you keep one).
- Restore Caddy: stop caddy, copy `caddy-data` back to `/home/opc/.local/share/caddy`, start caddy.

## History

- 2026-10-24: `play` A record created via API. Caddy installed and certified (first attempt).
  Ports 80 and 443 opened at both layers. HTTP/3 disabled and UDP 443 forwarded to 9443 for WT.
