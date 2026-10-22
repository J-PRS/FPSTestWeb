# Beta deploy

Two surfaces ship: the static client bundle and the game server. The
client must never upload rights-restricted assets; the server must not
serve them either.

## Client (static host)

Use `_clean_deploy.bat <backend-host> <domain>` — same as `_surge_deploy`
but deletes `assets/models/class_*.glb`, the class anim bakes
(`cybersoldier/scifisoldier/vexa/polyart` under `assets/anims/`), and
`maps/t2/` from `dist` before the surge upload.

Missing class rigs degrade at runtime: heavy renders as `knight`, the
other classes as `mannequin` (they already default there). If you later
replace the Unity rigs with clean ones, drop them under
`assets/models/class_*.glb` and nothing else changes.

Any static host works (surge, Cloudflare Pages, S3+CDN) — the bundle only
needs `server.json` pointing at the backend and `version.txt` for the
auto-reload poll.

## Server

`Dockerfile` at repo root:

```
docker build -t fps .
docker run -p 8000:8000 -p 9443:9443/udp \
  -e FPS_SECRET=<random> \
  -e FPS_PUBLIC_BETA=1 \
  -e FPS_ADMIN_TOKEN=<token> \
  -e FPS_CORS_ORIGIN=https://<client-domain> \
  -e FPS_ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:<turn-host>","username":"<u>","credential":"<p>"}]' \
  fps
```

- `FPS_PUBLIC_BETA=1` — drops every `_t2` map spec from the catalog and
  404s `maps/t2/*` fetches. The `.dockerignore` also excludes `maps/t2`
  from the image entirely.
- `FPS_ADMIN_TOKEN` — required to keep `/metrics`, `/status`,
  `/weaponstats*` and `/admin/*` behind the token on a public box.
- `FPS_CORS_ORIGIN` — set to the client origin; the dev `*` leaks the API
  to any site embedding the game.
- `FPS_SECRET` — persists player-identity HMACs across restarts.
- `FPS_ICE_SERVERS` — p2p duel ICE list. Without a TURN entry ~15–20% of
  NATted pairs can't connect; provision coturn/metered.ca and drop the
  creds here (the client fetches them via `/rtcconfig`, nothing to edit
  client-side).
- `FPS_WT_PORT` — WebTransport/QUIC tier needs real certs
  (`FPS_WT_CERT`/`FPS_WT_KEY`); behind a TLS-terminating LB with no UDP
  pass-through, set `FPS_WT_PORT=0` and the client falls back RTC→WS.

## Still open before public listing

- Replace the Unity `class_*` rigs (see `_docs/2026-10-08_BETA_AUDIT.md`)
  or keep shipping the clean bundle indefinitely — heavies just render as
  knights.
- A real domain + TLS in front of the backend (the client already assumes
  wss:// over https). Surge + trycloudflare works for a weekend beta but
  the tunnel URL changes every restart.
