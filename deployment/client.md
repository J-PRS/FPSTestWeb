# Client: connecting to the server

Scope: how the browser client picks a server, and the URLs to use.
Status and index: `readme.md`.

## Default: /quickjoin

Friends open **`https://play.jprice.app/quickjoin`**. It asks the server's matchmaker for a seat
(`/join?humans=1`), then rewrites the URL to `/pub/<room>` and connects over WebTransport.
Verified 2026-10-24 in a browser: tier WebTransport, connected to `arena-1`.

`/quickplay` is NOT a route. The client ignores it and starts an offline solo match, which has
balls and creatures. Do not share `/quickplay` links.

Local development: `http://localhost:5400/quickjoin` uses the same default from `server.json`.

The default lives in `client/public/server.json`:
```json
{ "server": "https://play.jprice.app", "servers": { "jp": "ws://localhost:8000" } }
```
- `server` is the default host. It is tracked in git. Keep it on the public host.
- `servers` holds runtime aliases. Personal hosts go here, not in the source tree.

Resolution order (`client/src/networking/endpoints.ts`):
1. `?server=` URL parameter
2. The path alias, e.g. `/pub/rimrock-1` or `/jp/rimrock-1`
3. The saved `fps-server` setting
4. `server.json`
5. `localhost:8000`

## Path aliases

- `NAMED_SERVERS` in `endpoints.ts`: `pub` maps to `https://play.jprice.app`.
- `http://localhost:5400/pub/rimrock-1` joins a room on the public server.
- `http://localhost:5400/jp/rimrock-1` is for a personal box, once `servers.jp` is set in `server.json`.
- A `/s/<room>` link opened on a remote server is rewritten to `/pub/<room>` (`main.ts`),
  so refresh keeps the server.

## Explicit URLs (rarely needed)

- `?server=https://play.jprice.app` becomes `wss://play.jprice.app/ws` and `https://play.jprice.app`.
- Direct IP on port 8000 no longer works (closed 2026-10-24). Use the HTTPS name.
- A bare host with no scheme is treated as TLS, so always include `ws://` or `https://`
  for IPs or non-TLS hosts.

## WebTransport over HTTPS

The client only dials WebTransport on an HTTPS origin when `/wthash` advertises port 443.
The server advertises 443 (`FPS_WT_ADVERTISE_PORT`), and the forward from UDP 443 to 9443
makes that reachable. See `webtransport.md`.

## Testing

- Diagnostics show `tier: wt`, `tier: ws` or `tier: rtc`. WebTransport working means `tier: wt`.
- Shared links: send `/pub/<room>` or `/?server=https://play.jprice.app`. Do not send
  `localhost` links, because they point at the recipient's own machine.

## Static hosting (Cloudflare Pages)

The game page lives on **https://jetpack-fps.pages.dev** — `dist/` deployed to the
`jetpack-fps` Pages project (account `2e14e1304c4503b43cdc3d38ad68f03f`). The OCI
box stays API/game traffic only; Pages is the unmetered CDN for the bundle.

```bash
cd client && npm run build
npx wrangler pages deploy dist --project-name jetpack-fps --branch main --commit-dirty=true
```

- `--branch main` is required — the project's production branch is `main`; an
  unbranched upload lands as a `*.pages.dev` preview alias only.
- `public/_redirects` (`/* /index.html 200`) keeps client routes working:
  `/quickjoin`, `/pub/<room>`, `/s/<room>` all serve the app.
- `server.json` in `public/` points the deploy at `https://play.jprice.app`; any
  remote host (any source) resolves through `/join` first since `eefbb9a4` + the
  server.json/named-path follow-up.

Verified 2026-10-29: headless Chrome loaded the Pages URL, seated into w1's
headhunt-1 as `player_bzy1hov3q` in under 5s.

## History

- 2026-10-24: default moved from the direct IP (`ws://92.5.61.55:8000`) to `https://play.jprice.app`.
  `/pub` alias updated to match.
