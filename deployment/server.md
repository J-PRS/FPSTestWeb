# Game server on the A1: run, endpoints, redeploy

Scope: running `server_bun` on the A1, its environment, endpoints, and how to ship code changes.
Status and index: `readme.md`. HTTPS: `dns-https.md`. WebTransport: `webtransport.md`.

## Runtime

- Code on the box: `~/kribes/server_bun` (includes `node_modules`, about 90 MB),
  `~/kribes/shared`, `~/kribes/client/src/demo`, `~/kribes/maps` (rimrock only).
- Bun 1.4.4 at `~/.bun/bin/bun`. No build step: Bun transpiles TypeScript at load time.
  Trade-off: a change is a copy and a restart. Type checking happens on the laptop
  (`tsc` and `bun test`), not on the box.
- Measured idle RSS: about 43 MB.
- Env file: `~/kribes/.env` is what `deploy_server.sh` sources (`set -a; . ~/kribes/.env`).
  `~/kribes/server.env` is the older name kept around with the same keys — keep both
  in sync when adding vars. Keys: `FPS_PORT`, `FPS_ADMIN_TOKEN`,
  `FPS_PUBLIC_BETA`, `FPS_WT_CERT`, `FPS_WT_KEY`, `FPS_WT_ADVERTISE_PORT=443`,
  `FPS_UDP_PORT=9898` (2026-10-27 — volatile datagram lane for the native shell;
  NSG `anabatic-sl` carries the UDP 9898 ingress),
  `FPS_CLIENT_ROOMS=0` (2026-11-02 — untrusted joins may only seat existing
  rooms; minting stays with the admin key). Never print values.
- Log: `~/kribes/server.log`.
- Content gates: balls and creatures are OFF by default (PvP server). `FPS_ALLOW_BALLS=1` and
  `FPS_ALLOW_CREATURES=1` in `server.env` let clients request them again (for coop or offline-style play later).
  The gate is enforced in `roomFactory.ts` `roomFor`, so client flags can only tighten it.
  Deployed 2026-10-24; the new flags are not yet in `server.env`, so the default applies.

## Start and stop

Start (survives the SSH session):
```
cd ~/kribes/server_bun && setsid nohup bash -c 'set -a; . ~/kribes/server.env; set +a; exec ~/.bun/bin/bun src/server.ts' > ~/kribes/server.log 2>&1 < /dev/null &
```

Stop: find the PID with `pgrep -fa "^/home/opc/.bun/bin/bun src/server.ts"` and kill that PID.
Do not use `pkill -f "bun src/server.ts"` from an SSH command: the pattern matches the SSH
shell's own command line and kills the session.

One process only. A second start fails with "Is port 8000 in use?".

## Endpoints

| URL | Purpose |
|-----|---------|
| `https://play.jprice.app/health` | version, players, tick rate |
| `https://play.jprice.app/ping` | `{"pong":true}` |
| `https://play.jprice.app/wthash` | WT port (443) and cert SHA-256 pin |
| `wss://play.jprice.app/ws` | game WebSocket |
| `wss://play.jprice.app/rtc?room=CODE` | RTC relay (WebSocket) |
| UDP `play.jprice.app:443` | WebTransport (forwarded to the local listener on 9443) |

Plain HTTP on the direct IP exposes traffic and any token sent in a query string. Use
the HTTPS name for anything shared.

## Redeploy

The box runs whatever was synced. Laptop edits do nothing until copied and restarted.
`bash _tools/deploy_server.sh` does the whole push: refuses on uncommitted
server/shared changes, stamps `server_bun/build.txt` with the commit hash
(`/health` reports it), syncs, restarts, verifies. Env: `FPS_DEPLOY_HOST`,
`FPS_SSH_KEY`.

1. Copy the changed files (keep the same relative paths), for example:
   ```
   scp -i C:/Users/JPrice/.ssh/oci_anabatic server_bun/src/serverRoutes.ts opc@92.5.61.55:/home/opc/kribes/server_bun/src/
   ```
   For a full sync, package only `server_bun` (minus `node_modules`), `shared`,
   `client/src/demo`, `maps/rimrock.json`, `maps/rimrock.bin`. Do not overwrite
   `node_modules/crates/native/` or the WT prebuilds; they hold the WebTransport addon.
2. Restart: stop the PID, then start as above.
3. Verify:
   - `grep -c "/ping" ~/kribes/server_bun/src/serverRoutes.ts` on the box matches the laptop.
   - `pgrep -fa "^/home/opc/.bun/bin/bun src/server.ts"` shows exactly one process.
   - `grep -ci "failed to start" ~/kribes/server.log` returns 0.
   - `curl -s https://play.jprice.app/health` and `/ping` respond.

Restarting drops every connected player. Check the `/health` player count first and
restart between matches when possible.

## Bun: raw TypeScript vs compiled

- Current: raw TypeScript. Fastest iteration, no build step, and a restart applies a change.
- Option: `bun build --compile --target=bun-linux-arm64` produces one executable with the
  runtime and code bundled. Faster startup, no source on the box. Needs a rebuild per
  change and a test that the native WebTransport addon still loads from the compiled binary.
- Not benchmarked on this box. Measure before switching.

## Known operational gotchas

- Players disconnect on every restart (see Redeploy).
- The admin token is a query parameter on admin routes. Over plain HTTP it is readable on the network.
- `FPS_WT_CERT` and `FPS_WT_KEY` must both be set, or WebTransport stays off and WS and RTC still run.
- The server imports `../../client/src/demo/types.ts`. A tar without `client/src/demo/` crashes at boot.
- `bun` is not on the Windows PATH. In shell sessions, prefix with `export PATH="$HOME/.bun/bin:$PATH"`.

## History

- 2026-10-24: server deployed on the A1 (Bun 1.4.4, v0.1.20). Fixed missing demo imports.
  Headhunt token changes and WT advertise port synced. `/ping` added.
- 2026-10-27: build `7a91d370` deployed. UDP volatile lane live: `FPS_UDP_PORT=9898`
  (both `.env` and `server.env`), NSG `anabatic-sl` gained UDP 9898 ingress, lane
  verified — `gameState.udp` returns `{token, port}` on join. `deploy_server.sh`
  env vars: `FPS_DEPLOY_HOST=opc@92.5.61.55`, `FPS_SSH_KEY` = key with owner-only ACL
  (OpenSSH rejects group-readable keys).
