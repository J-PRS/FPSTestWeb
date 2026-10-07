# Pre-Beta Audit — 2026-10-08

What stands between the current build and "post a link, real strangers
play it". Ranked: **blockers first**, then dev-surface leaks, then
missing features, then polish.

## 1. Legal blockers — can't ship as-is

- **Unity Asset Store player models are served publicly.**
  `client/public/assets/models/class_{light,cyber,medium,heavy}.glb`
  ride `public/` into every dist and are loaded by playerClips.ts.
  `.gitignore` already flags them "licensed, not owned; do not
  redistribute" — serving them on a public URL IS redistribution.
  Options: replace with owned/Kenney-style CC0 rigs, or buy/check
  redistribution terms per asset.
- **Extracted Tribes 2 content is served at runtime.** `maps/t2/` is
  gitignored for the same reason, but `mapBinRoute` serves
  `/maps/t2/dif/*.glb` + t2 textures/sky to anyone who hits the server.
  A public beta broadcasting Tribes 2 assets is the riskiest item in
  this document. T2 map support needs to be localhost-gated
  (`if isPublicServer → 404 for t2/` or a build-time allowlist).

## 2. Deploy story is ad-hoc — needs a real one

- Today = `_surge_deploy.bat` (static client to surge.sh) + a
  trycloudflare **quick tunnel** for the Bun server. Quick tunnels
  have ephemeral URLs — every server restart changes the address, so
  `server.json`/favs/links rot immediately. Fine for playtests, not
  for "the link".
- No Dockerfile / fly.toml / systemd unit / process manager for
  `server_bun`. A crash = the game is down until someone restarts it.
  Minimum: bun process under a supervisor on one VPS + a real domain
  (wss:// behind Caddy/nginx or fly.io TLS).
- **P2P has no TURN server.** `signalling.ts` hardcodes Google STUN
  only (`FPS_ICE_SERVERS` defaults empty) — symmetric-NAT pairs
  (~15-20% of home connections) can't hole-punch and silently fail.
  Need a coturn instance (or Cloudflare Calls TURN) in
  `FPS_ICE_SERVERS`.
- `server.json` baked per deploy is workable but brittle — a real
  domain makes `?server=` unnecessary for the canonical instance.

## 3. Dev-only surfaces shipped to prod

- **ESC menu dev row**: SIM LAB, GUN LAB, SPAWNS: SCRIPTED/RANDOM,
  DEBUG — all visible to every user. `SPAWNS` changes gameplay
  (scripted vs random spawn selection) — that's a dev/test aid, not a
  player toggle. Gate the whole row behind `?debug`/`fps-debug` or
  `import.meta.env.DEV`.
- **GUN LAB is a dead button in prod** — `gunlab.html` isn't a rollup
  build input, so it 404s in dist anyway.
- **`?debug` + DEBUG toggle wire the full toolkit in prod**:
  `wireDebugTools` runs on `urlParams.debug` or the fps:set event —
  it publishes `window.__test` (live player/scene/networkManager
  handles) and `window.__playRec`. Any tester who flips DEBUG gets a
  scriptable game handle. Should be `import.meta.env.DEV`-only in
  release builds (or a build flag).
- **`?dummy`, `?yaw`, `?pitch` headless hooks** (applyDebugHooks) are
  unconditional in prod — cheat/aimbot-shaped API surface for anyone
  who reads the bundle.
- **Ops dashboards are public**: `/status` and `/weaponstats.html`
  serve live tick-lag, per-room CPU, and client latency tails to
  anyone — an attacker gets a free "when is the server weakest"
  meter. Gate behind the admin token or drop from public deploys.
  Same for `/metrics`, `/stats`, `/matches` — decide which are
  deliberately public.
- **13 stale test pages** at client root (aodump, vmdump, skytest,
  posedump, *_test.html…) — they don't reach dist (not build inputs)
  but they're dead weight/confusion. Soft-delete `.old` candidates.
- **`.devin_*.ts` probe scripts (~30) at repo root** — session scratch
  from earlier rounds; not shipped, but should be `.old`'d or moved
  under `_tools/` for hygiene.

## 4. Unauthenticated write surfaces

- **`POST /demos/upload` — anyone can push 16MB demos, and
  DemoStorage has no cap or pruning.** Unbounded disk-fill vector on a
  public server. Needs: per-IP throttle (joinIps-style), max demos
  (prune oldest), or auth. Until then it's a script away from filling
  the disk.
- **`/client-log`** accepts 512KB bodies, IP-throttled — OK, but the
  logs land in `logs/` with no rotation seen; a persistent spammer
  (multiple IPs) still grows it.
- **CORS is `*` on everything**, including `/admin` (bearer-gated —
  fine cryptographically but sloppy) and `/demos/upload`. Should be
  an allowlist once the client lives at a real domain.

## 5. Missing features real testers will hit in the first minute

- **No player names.** Everyone is `player_k3j9d` — scoreboard, chat,
  and killfeed are unreadable for strangers. Minimum viable: a NAME
  field on the JOIN/host panel (validated server-side, sanitized,
  uniqueness-suffixed), shown instead of the raw id. The id/token
  identity underneath can stay.
- **No moderation surface for players.** Server flood-control + admin
  kick exist, but there's no client mute/block, no report, no
  profanity filter, no room owner controls (a host can't kick from
  their own match). For a small beta: client-side mute +
  admin-token kick may suffice, but at least mute.
- **No private matches.** Every room is in `/rooms` for anyone.
  Friends-only testing wants a hidden/private flag on HOST (unlisted
  room, join-by-name only) — small change since join-by-name exists.
- **No first-run onboarding.** A stranger lands on the JOIN tab, an
  empty room list, and no controls hint. Needs: a one-screen "WASD /
  space-jet / LMB" card on first boot (fps-seen-onboard flag), and/or
  a default SOLO match as the landing experience.
- **Mobile is unsupported but unannounced.** Pointer-lock only —
  phones/tablets get a broken page, not a message. Cheap: a
  touch-device gate ("desktop required") so beta shares don't bounce
  mobile users confusingly.
- **No error reporting.** `/client-log` only ships warn+ manually
  posted lines; there's no automatic exception/telemetry capture for
  the real-user failure modes you'll actually see in beta (GPU/driver
  quirks, WSS blocked, WebGL context loss). Even a dumb
  window.onerror → /client-log would pay for itself on day one.
- **Room lifecycle social gaps**: no AFK auto-spectate beyond
  idleTimeout kick, no "match full" UX, and quick-join drops you into
  whatever's emptiest — testers' first complaint will be "I got put
  in the wrong match".

## 6. Already OK — verified, don't fix

- Identity/reconnect: fps-player-id + server HMAC session token
  survive F5 and (with FPS_SECRET) restarts; grace-period rejoin works.
- Rate limiting: WS handshake throttle, /join throttle, chat flood
  control with muted echo, claim-level limits all exist.
- Deploy freshness: `version.txt` + deployWatch auto-reloads stale
  clients — covers the classic "old JS vs new server" beta trap.
- Demo upload has a 16MB body cap and size checks; admin API is
  closed when FPS_ADMIN_TOKEN unset; map asset paths are regex-gated.
- `.old` assets are stripped from dist by the vite plugin.
- Soak/chaos: reconnect/journal/drown paths are pinned (robustify
  §2.x) — the netcode itself is in better shape than the surfaces
  above.

## Suggested order

1. Replace or license the player models + gate `maps/t2/` (day-one
   legal).
2. Real host: domain + TLS + supervised bun process (Dockerfile is
   ~20 lines here). Add coturn creds to FPS_ICE_SERVERS.
3. Dev-surface gate: one `fps-dev`/`import.meta.env.DEV` flag hides
   SIM/GUN LAB + SPAWNS + DEBUG + dummy hooks; window.__test behind
   the same.
4. Demo upload: per-IP limit + prune; flip /status + /weaponstats
   behind admin.
5. Names field + client mute + private-room flag — the three UX
   items beta feedback will demand loudest.
6. Onboarding card + mobile notice + window.onerror→/client-log.
