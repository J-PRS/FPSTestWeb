# Launch Audit — 2026-11-04

Re-audit of `2026-10-08_BETA_AUDIT.md` against current code. Most of the
Oct-8 list has landed; what's left is one legal item, infra provisioning,
live-verification debt, and thin moderation. Verified by direct code
reads — each finding cites where.

## What landed since Oct 8 (don't re-fix)

- **Dev surfaces gated.** `isDevHost()` (`client/src/core/params.ts:19`)
  returns true only on vite dev / non-https hosts, so a public TLS deploy
  hides: ESC dev row (markup stays hidden, `input.ts:697-712`), DEBUG
  toggle + `?debug` (`urlParams.debug` reads false on https,
  `params.ts:96`), `window.__test`/`__playRec` wiring
  (`main.ts:1408`, `main.ts:1423`), `?dummy`/`?yaw`/`?pitch` hooks
  (`main.ts:1043`), and all `*dump.ts` pages (`posedump.ts:17`,
  `vmdump.ts:7`, `aodump.ts:11`, `sfxdump.ts:10`).
- **Ops dashboards token-gated.** `/metrics`, `/status`,
  `/weaponstats(.html)`, `/wire` all behind `opsAllowed` — bearer token
  or loopback+`?key=` (`serverRoutes.ts:61-66, 118-143`). `/rooms` hides
  the id→name roster from anonymous callers (`serverRoutes.ts:124-128`).
- **Demo upload hardened.** Per-IP 12/min throttle + 16MB cap checked
  twice (content-length + buffered) (`serverRoutes.ts:271-340`); storage
  caps ~100 live clips, evictions gzip to `archive/`
  (`demoStorage.ts:21-25`). `/leaderboard/submit` rides the same budget
  with challenge signing (`KRIBES_SIGN_KEY`, `serverRoutes.ts:277-306`).
- **CORS configurable.** `FPS_CORS_ORIGIN` (`config.ts:120`); still `*`
  by default — must be set on deploy.
- **Player names landed.** `fps-name` setting → join handshake `name`
  (`NetworkManager.ts:557`); server sanitizes — bidi-override and
  zero-width chars stripped (`SessionManager.nameSpec` ~line 415).
- **Client mute landed.** `/mute` `/unmute` `/muted` (`game/chat.ts`).
- **Private rooms landed.** PRIVATE toggle → `unlisted` flag → room
  drops off `/rooms` and quick-join (`lobbyPanel.ts:751`,
  `SessionManager.ts`, `GameServer.ts:546`).
- **Mobile handled.** Coarse-pointer devices auto-route to the `/clips`
  demo feed instead of a broken game page (`feed/feedMode.ts:16-22`);
  `TouchControls` exists for hybrids.
- **Error reporting landed.** `window.onerror` + `unhandledrejection`
  ship to `/client-log` (`core/Logger.ts:286-290`); log shipping +
  rotation server-side (`clientLogs.ts`).
- **T2/T1 asset gating.** `FPS_PUBLIC_BETA=1` drops ported specs and
  404s `maps/t2`/`maps/t1` fetches (`config.ts:154`, `mapCatalog.ts:98`).
- **Domain + supervised box exist.** `play.jprice.app` on OCI behind
  Caddy; browser WT handshake verified READY 2026-10-24
  (`deployment/known-issues.md:38`). Dockerfile + `_oci_deploy.bat` +
  `deployment/` docs in tree.
- **UAS player rigs gone from the tree.** `client/public/assets/models/`
  no longer contains `class_*.glb` — only knight/mannequin/robot packs
  ship. The Oct-8 primary legal blocker is resolved.
- **RTC dropped from the connect ladder** (changelog 2026-10-26): prod
  is WS+WT, so TURN only matters for the P2P-duel path, not the main
  session.

## 1. Announcer audio — RESOLVED 2026-11-04 (was flagged as blocker)

The `announce_*.ogg` files are the **WARLORD announcer pack** by
VoiceBosch (OpenGameArt, CC BY-SA 4.0 —
https://opengameart.org/content/warlord-video-game-announcer). Tracklist
matches the shipped files exactly. Legal to ship commercially; the only
obligations are attribution + keeping the clips under BY-SA. Canonical
license record: `LICENSES.md` at repo root; player-facing credit ships
as `client/public/ATTRIBUTION.txt` (inside dist). The old `.gitignore`
"ripped for playtest only" comment was wrong and has been corrected —
the `.ogg`s are tracked on purpose; only the `.wav` masters stay local.

## 2. Infra — provisioning, not code

- **TURN still unprovisioned.** Decision made (Cloudflare Realtime free
  tier, `_docs/workflows/beta-launch.md:36-38`) but needs the CF account
  + key/token mint → `FPS_ICE_SERVERS`. Only affects p2p duels now that
  the main ladder is WS+WT (~15-20% symmetric-NAT pairs can't duel).
- **Client CDN path unscripted.** Public client is still the local
  `:5500` preview tunneled out (per AGENTS.md). Surge deploy works but
  the stated direction is unmetered CDN — pick + script it.
- **Env checklist for the box** — verify all set at go-live:
  `FPS_PUBLIC_BETA=1`, `FPS_ADMIN_TOKEN`, `FPS_SECRET`,
  `FPS_CORS_ORIGIN`, `FPS_ICE_SERVERS`, `KRIBES_SIGN_KEY` (leaderboard).
- **Quick-tunnel dependence.** Any path still using trycloudflare rots
  URLs on restart; confirm the canonical deploy uses the domain only.

## 3. Unverified-live debt (fixes in code, never confirmed in a match)

From `deployment/known-issues.md` — each needs one live soak to close:

- Session-reject WT bench fix — code landed, unverified live.
- Headhunt token launch-from-corpse — deployed, unconfirmed.
- Death-desync mitigation (`deadConfirmedByWire`) — unconfirmed;
  `[StateHash] DESYNC` still logs on death edges.
- **Remote ghost offset on WebTransport** — `ghosts.max` hit 51m on
  fast movers; the only open netcode defect with a number on it.

## 4. Test debt

- 3 scenario tests failing on clean HEAD (blast knockback catapult,
  capper run on peaks.bin, capper on real T2 Katabatic) —
  `deployment/known-issues.md:42-45`.
- 1 deterministic vitest failure: `workerTransportDrain` "still
  dispatches when ticks coalesce" — pre-existing, uninvestigated.

## 5. UX gaps that survive to launch

- **Onboarding card never built.** `fps-onboarded` setting exists
  (`settings.ts:61`) but nothing reads it — a stranger still lands on
  JOIN with no controls hint. Smallest version: one dismissible card,
  set the flag.
- **Moderation floor is mute-only.** No report, no room-owner kick,
  no profanity filter. Mute + admin-token kick may suffice for beta;
  say so deliberately rather than discovering it.
- **Room social gaps**: no match-full UX, quick-join still picks
  "emptiest" which may not be what a group wants.

## 6. Hygiene leftovers (non-blocking)

- ~13 stale root test pages + `.devin_*` probes — gitignored, dead
  weight only.
- `gunlab.ts`/`maplab.ts` carry no `isDevHost` gate (comments say
  player-facing on purpose); not build inputs so unreachable in dist —
  confirm the ESC menu doesn't show dead buttons for them in prod.
- `maps/t1/` is gitignored but `maps/<name>_t1.json` specs are tracked —
  T1-derived content has the same redistribution question as T2;
  `FPS_PUBLIC_BETA` covers it (`mapCatalog.ts:98`), just keep the flag
  on.

## Suggested order

1. ~~Resolve `announce_*.ogg`~~ — done: WARLORD pack, CC BY-SA 4.0,
   attribution added. No remaining "can't ship as-is" items.
2. Env + TURN + CDN: one provisioning session closes §2.
3. Live soak to close §3 (one WAN match exercises all four items).
4. Onboarding card + decide moderation floor explicitly.
5. Fix or quarantine the 4 failing tests — a red suite at launch hides
   real regressions.

Sources: `_docs/2026-10-08_BETA_AUDIT.md` (baseline),
`deployment/known-issues.md`, `_docs/workflows/beta-launch.md`,
`_docs/2026-10-07_DEPLOY_BETA.md`, code reads cited inline.
