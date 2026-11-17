# HSTS Preload Evaluation — anabatic.gg

2026-11-16 · sources: hstspreload.org, scotthelme.co.uk, Chromium preload-removal tracker, TechTarget

## Question

With `anabatic.gg` live on Cloudflare Workers Static Assets (Always-HTTPS,
`Strict-Transport-Security: max-age=31536000` via `client/public/_headers`),
should we add `includeSubDomains; preload` and submit to the browser preload
list?

## What preload buys

HSTS closes the HTTP→HTTPS downgrade hole *after a browser has seen the
header once*. Preload bakes the domain into Chrome/Firefox/Safari/Edge so
even the **first-ever visit** is HTTPS-only — no port-80 request to
intercept (SSL-strip). That is the entire benefit: one request per user,
ever.

## What it costs

`includeSubDomains` is mandatory for preload — **no exceptions, no
exclusions**. Every hostname under the apex must serve valid HTTPS forever:

- A subdomain with an expired/self-signed cert gets *no click-through*;
  the browser hard-refuses.
- An HTTP-only subdomain (internal tool, vendor vanity host, test box)
  is unreachable by name until the policy expires or removal propagates.
- Removal is 6–12 weeks for Chrome, longer elsewhere — and the domain
  must **keep serving valid HTTPS** while the removal is pending.
  "Cannot really be undone" per hstspreload.org.

## The regret corpus (Chromium removal tracker + Helme)

Every removal request is the same failure: `includeSubDomains` hit an
HTTP-only host nobody remembered.

- uber.com — contractor-maintained subdomains
- ssa.gov / socialsecurity.gov — HTTP intranet rollout
- sixt.{ch,com,de,co.uk,com.br} — "set without thinking"
- mpac.ca, 2e-systems.com — internal/VPN sites sharing the apex
- apiomat.com — internal subs, no HTTPS budget
- truweight.in, macaque.io — third-party vanity platforms (Unbounce,
  Campaign Monitor) that only serve HTTP on custom hostnames
- One operator moved to Wix — no custom-domain HTTPS, site dead for months

## The benefit is shrinking

hstspreload.org itself now states: *"Chrome and Safari automatically
upgrade all HTTP navigations to HTTPS… The benefits provided by HSTS
preloading are minimal compared to the benefits provided by HSTS. While
HSTS is recommended, HSTS preloading is not recommended."*

Modern browsers already rewrite `http://` navigations to `https://` for
every site, so preload only covers the residual case of an active
network attacker on a brand-new visitor's first request.

## anabatic.gg risk profile

Low but nonzero:

- + All current subdomains are Cloudflare custom domains (auto TLS).
- + Domain is dedicated to this site; no intranet/internal use.
- − Game traffic already lives off-apex at `play.jprice.app` — but any
  future `*.anabatic.gg` pointing at the OCI box (e.g. `api.anabatic.gg`)
  would need a working cert there; Caddy handles this today, still a
  coupling to remember.
- − `.gg` registry quirks and any future host move must keep HTTPS
  working on apex + www indefinitely.

## Decision

**Skip preload. Keep `max-age=31536000` without `includeSubDomains`.**

The protection delta is one first-visit HTTP hop (already shrunk by
browser auto-upgrade); the cost is a permanent, hard-to-reverse HTTPS
mandate over all future subdomains. Revisit if the domain stays
Cloudflare-only for a year — by then the subdomain surface is a known
quantity and submission is a two-minute job.

## Zone optimization pass (same day)

Settings audit for the anabatic.gg zone serving Workers static assets;
each item evaluated against a script-heavy game client, not a blog.
Applied via `cf zones settings edit` + `client/public/_headers`.

**Enabled:**

- **Early Hints** (`early_hints=on`) + `Link: </game.js>; rel=preload;
  as=script` and `</game.css>` in `_headers` — edge emits `103` hints so
  the 3MB bundle and stylesheet start fetching before the HTML response
  completes. Early Hints only fires on extensionless/.html requests, so
  the Link on other responses is inert.
- **0-RTT** (`0rtt=on`) — TLS resumption for repeat visits; safe because
  the zone only serves idempotent GETs.
- **Speed Brain** (`speed_brain=on`) — Speculation-Rules prefetch on
  likely navigations; off by default on this zone despite docs claiming
  otherwise. Harmless — it never prefetches routes that invoke a Worker,
  and ours never runs code.

**Already on, verified:** Brotli, HTTP/3, IPv6, WebSockets zone flag,
Always-HTTPS, automatic HTTPS rewrites, opportunistic encryption.

**Deliberately skipped:**

- **Rocket Loader** — rewrites/defers all scripts; a module-worker
  Three.js game is the exact shape it breaks.
- **Auto Minify** — deprecated by Cloudflare; Vite output is already
  minified.
- **Bot Fight Mode** — challenges headless e2e clients (decided earlier).
- **WAF / rate limiting** — no forms or dynamic endpoints on the zone;
  nothing to protect beyond static files.
- **Cache Reserve / Argo / Polish / Mirage** — paid; edge cache +
  immutable hashed `/assets/*` already cover the win.
- **`includeSubDomains`/`preload` on HSTS** — per the decision above.
