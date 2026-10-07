# Workflow: Public beta launch

Spec for taking the game from locked-down dev build to a public beta on a
real domain. Runs once (per region); its checkpoints are JP's go-live
decisions.

## Trigger

**Event**: JP says go (or asks for launch-readiness status).

## Current state

- Deploy path exists: `FPS_PUBLIC_BETA=1`, `_clean_deploy.bat`,
  `Dockerfile`, `_docs/DEPLOY_BETA.md`.
- Hosting decided: Hetzner CX43 EU (~€10/mo) — see
  `_docs/2026-10-01_HOSTING_COSTS.md`. Vertical scaling first; room
  sharding past ~2-3k CCU.
- Dev surfaces gated: `isDevHost()` + `FPS_PUBLIC_BETA`.
- Ops routes (`/status`, `/weaponstats.html`): token-gated when
  `FPS_ADMIN_TOKEN` set.
- Netcode: 150ms RTT soak proven (§2.134); 300ms bounded.
- CORS restricted to allowlisted origins.
- Rate limits + caps: join throttle, seat/spec budgets, hop cooldown,
  upload caps, chat flood mute.
- Server authoritative on every outcome; lag comp capped at 250ms.

## Run

1. **Pre-flight audit** — all green before any DNS moves:
   verify loop + `bun _tools/e2e/all.ts` + latency soak.
2. **Provision** — Hetzner CX43 EU; Docker build + run with env:
   `FPS_PUBLIC_BETA=1`, `FPS_ADMIN_TOKEN`, `FPS_ALLOWED_ORIGINS`,
   `FPS_ICE_SERVERS` (if TURN used).
3. **Edge** — domain on Cloudflare: site proxied (TLS+DDoS), game socket
   on a DNS-only subdomain (CF proxy can't carry UDP/WebTransport).
4. **TURN** — Cloudflare Realtime TURN (decided 2026-10-01): free
   1,000 GB/mo, anycast, zero daemons; mint key id/token via the Calls
   API → `FPS_ICE_SERVERS`. Fills the ~15-20% symmetric-NAT gap.
5. **Soak** — real-socket smoke from outside the LAN; watch `/status`.
6. **Go-live** — announce; monitor `/status` + error archive
   (`logs/OLD/`) + `/client-log` intake.

## Checkpoints (JP decisions — push right: everything else done first)

- **Domain**: buy ~$10/yr + Cloudflare account. Needed for WSS/TLS
  and `isDevHost()` https gate.
- **Box**: order the CX43 (~€10/mo, hourly billing — can destroy/recreate).
- **TURN**: DECIDED — Cloudflare Realtime free tier; still needs the
  key id/token minted once CF account exists.
- **FPS_ADMIN_TOKEN** value — JP picks the secret.
- **MAX_DEMOS / seat caps** — current defaults stand unless JP wants
  tighter at launch.
- **Go/no-go** after pre-flight audit.

## Brief at the checkpoint

One message: what's deployed where, what env is set, what the audit
showed, and the exact decisions still open — never a raw dump.

## Future ideas (parked)

- **Shot of the Day**: /demos upload lane already IS global storage post-deploy. Missing piece: server-side daily pin (pick previous-day max lifetime, keep shot-of-day.demo + meta exempt from the ~100-clip eviction) + a menu tile that plays it. Small job, defer until after launch.
- **TikTok-style swipeable best-shots feed (mobile)**: vertical-swipe full-screen replay of /demos clips over DemoPlayer - NO game UI (no HUD/scoreboard/comments); only a minimal clip overlay (weapon - dist - airtime + who/when). Swipe up/down (wheel/arrows on desktop) = next/prev, auto-advance at clip end. ~1 build slice; playback+list already exist.
