# KRIBES — State of the Game (2026-09-28)

Full audit: what exists, how healthy it is, what's next, and what a real game still needs.
Companion to ROADMAP.md (the living manifesto); this is the snapshot.

## Stack at a glance

| Layer | Tech | Size |
|---|---|---|
| Client | Three.js + TS + Vite (`client/src`) | ~14k LOC game/net/ui core |
| Server | Bun + native `Bun.serve` WS (`server_bun/src`) | ~40 modules |
| Shared | `shared/` — protocol, wire codec, weapons, movement sim, botBrain, teams, status | single source of truth |
| Maps | `maps/*.json` spec DSL (structures/spawns/arena/mode) + optional `.bin` heightfield | 11 maps |
| Tests | 171 `bun test` (server/shared) + 48 vitest (client) | green |

## What's built — by system

### Netcode v2 (landed this cycle — flagship)
- **Three transport tiers**, auto-selected client-side: WebTransport (QUIC datagrams) → WebRTC DataChannels (unreliable/unordered + reliable ctrl lane) → WebSocket/TCP. Parallel probe, `?net=` pins for testing, seamless WS floor.
- `GameTransport` seam — game code never knows which tier it's on; same `send/onMessage/onBinaryMessage` shape everywhere.
- Hardened: line-buffer caps (memory DoS), stale-RTC-peer timeout, offer flood cap, zombie-socket fix, disconnect → re-probe with backoff, reconnect rejoins via session-token grace period.
- Ops: `/metrics` reports per-tier connection counts; `/rtcconfig` serves deployment ICE servers (`FPS_ICE_SERVERS`); `/wthash` serves the cert fingerprint for browser cert-pinning.
- Verified E2E: real Chrome WT handshake over QUIC, real RTC datachannel join with 30Hz ticks, WS unchanged.
- Transport per player rides the join → scoreboard NET column + metrics.

### Combat & gameplay
- 12 weapons incl. Tribes-ish disc/chaingun/mortar/rail + sticky launcher (WeaponType 18: glue to terrain/structures, chain-cook detonations).
- Belt: frag/mortar/sticky deployable mine, cluster/javelin/impact landed this cycle.
- Lag compensation: 400ms rewind buffer, hitscan + AOE validated against rewound targets, muzzle origin rewound by shooter ping, buffer cleared on respawn/teleport.
- Server-validated hit claims (projectileId + airtime + origin radius), per-type rate limits, teleport cap, friendly-fire gate, spawn protection.
- Shared `MoveSim` physics — one code path drives client movement AND a per-player server shadow; >8m divergence = logged cheat signal.
- Killstreak callouts, frag headlines, hit markers, damage numbers (pooled sprites), directional feel pass.

### Modes, matches, rooms
- Modes: CTF, TDM (kill-confirmed dog tags), FFA/DM, nugget-hunt, duel, classic.
- `Room` = match boundary: own BallSim, flags, pickups, bots, map spec, hibernation, disposal; `roomFor(name)` spec fallback.
- Server-owned: CTF flags (touch/drop/cap, own-flag-home rule), nugget pickups (drop→bank, TTL), teams (alpha/bravo, rebalance), match clock + OT + draw, match journal → `logs/matches.jsonl` + `/matches` + `/stats` leaderboard.
- Bots: `shared/botBrain.ts` drives offline AND server bots — roam/chase/flee/collect + flag objectives (grab/cap/return/defend); `botFill` keeps rooms populated, retires for humans.
- Lobby: `/rooms` listing w/ live scores, `/join?mode=` quick-play, map picker + bot count, HOST MATCH flow, `?room=` deep join.
- Admin: `/admin/reload|kick|end|rooms` (FPS_ADMIN_TOKEN), `/maps`, `/serverinfo`, `/client-log` sink.
- Spectate joins (watch-only, full-rate ticks); demo system v3 records remotes + balls, playback freezes live wire.

### Client architecture
- `netHandlers` split into `game/net/` domain modules on `NetCtx`; every big switch is a dispatch table.
- HUD DOM built by `createHudDom()` element map; stylesheets extracted to `ui/hud/hud.css` + `ui/chrome.css` (Vite imports).
- Scoreboard: team sections, dead dims, ping + **NET** column.
- Death overlay w/ live respawn countdown; match clock; flag chips; cloak/shield/mend status FX.
- Species instancing + AI LOD + spawn amortization; value-gated DOM writes; scratch vectors in hot loops.

### Performance posture (load-tested)
- 35 players across 2 rooms, ~25s sustained: tick lag ~11ms avg (box baseline), no rejects.
- Tick fanout: in-place record reuse, rolling-FNV state hash, distance-tiered updates (~6–8Hz effective at 20Hz), binary wire everywhere hot.
- Server hibernates empty rooms; O(1) player→room index; global player cap.

## Where it's weak / known debt

1. **Movement authority is shadow-mode only.** Server simulates but trusts reported position. Flip to server-authoritative + client prediction/reconciliation is THE next structural change — biggest cheat surface remaining.
2. **WebRTC NAT traversal.** RTC tier works on friendly networks; hostile NATs need TURN relay (ops config exists, no TURN server deployed). WT needs a real CA cert in production (self-signed + hash pinning is dev-only).
3. **Wire protocol versioning drift.** PROTOCOL_VERSION exists but there's no compat gate/migration path — fine at this stage, will bite at real deployments.
4. **Factory functions still long** (createGameLoop/createCombat/createRemotes, 150+ lines) — cohesive composition roots, but they centralize dep wiring; a DI-lite container would help future features.
5. **No player accounts/progression** — HMAC pseudo-identity only; no MMR, no persistence beyond match journal.
6. **Map tech is spec-JSON only** — no real heightmap terrain pipeline yet (heightfield .bin support exists but unused in shipped maps), no map editor, no navmesh for bots (bots roam by waypoint, no terrain-aware pathing).
7. **Anti-cheat is signal-only** — divergence logged, not enforced; no rate-of-fire validation per weapon, no server-side LOS checks for reported hits beyond range/airtime.
8. **Replay is decode-level** — records wire streams but doesn't re-run full client netHandlers; not yet a regression harness.
9. **Monetization/social** — out of scope by design: no chat beyond room-scoped, no friends/party, no voice.

## Next-up plan (priority order)

1. **Server-authoritative movement flip** — shared sim already shadows; add client prediction ring buffer + server correction + snap/smooth reconcile. Tribes-forgiving: velocity agreement matters more than position on slopes.
2. **Transport-bench fleet** — headless bots riding real transports (WS today; RTC via node-datachannel, WT via webtransport-bun client) for mixed-tier load tests + scoreboard verification.
3. **Heightmap terrain pipeline** — .bin heightfields exist; build one showcase map with real Tribes terrain + structure bases to prove the path (terrain is the biggest netcode/render differentiator for the genre).
4. **Production netcode ops** — TURN server config, CA cert for WT, deploy doc.
5. **Combat feel pass 2** — directional damage indicators, spawn-protection UI, weapon swap snappiness, energy/jetpack readability.
6. **Map roster** — 1–2 more CTF (terrain+structures, classic Tribes layout) + 1 more small duel.
7. **Bot pathing lite** — obstacle-aware waypoint steering so bots don't hug walls (cheap steering, not navmesh).

## Future (parked)

- **Vehicles** — explicitly deferred until combat/base gameplay is excellent.
- **Auth + accounts + ranked** — needs real identity; HMAC identity is the seam.
- **Server browser** — /serverinfo card already exists; needs a lobby UI page.
- **Base assets/inventory stations** — structures support physics already; deployable turrets are the next `room.sims` candidate.
- **Full replay-as-regression** — extend demo v3 playback through real netHandlers.
- **Cost model** — WS ≈ cheapest; WT ≈ +50% CPU; RTC ≈ 2–4x + TURN egress (see prior rundown).

## Verdict

The project is past prototype: it has a real netcode stack with modern fallbacks, server-validated combat, real match infrastructure (rooms/modes/bots/lobby/admin/telemetry/demos), and clean seams (shared/, GameTransport, dispatch tables, species state tables). The gap between "very good tech demo" and "game" is now **authority (movement), terrain, and content depth** — all three are unblocked and sequenced above.
