# Architecture audit — path to a Tribes: Ascend successor

Scope: what in the current architecture blocks "serious game" scale, ordered by
severity. Excludes content wishes (more weapons/maps) — this is structure only.

## Verdict

The *runtime* architecture is genuinely good — shared/ sim, binary wire codec,
interest-tiered ticks, instanced species, transport-agnostic networking, offline
authority, P2P handshake. Those were the hard parts and they're done.

What's missing is the *game-around-the-game*: matches, players, maps, and
operational scale. Every blocker below is additive — none require ripping out
what exists.

## Blockers, ordered

### 1. One global room per server — no match model (hard blocker)
`GameServer` hosts a single world; every connecting client joins the same
fight. Tribes needs N concurrent matches per box. RtcRelay already proves the
rooms pattern (`rooms: Map<room, Set<ws>>`) — the lift is parameterizing
GameServer over a `Match` object (own PlayerManager/BallSim/tick loop) with a
router at `server.ts` that assigns joins to a match by id.

### 2. No persistence — identity lives in sessionStorage (hard blocker)
No accounts, stats, unlocks, or even durable names. `fps-player-id` in
sessionStorage is anonymous and forgeable. Ascend-successor needs at minimum:
persistent player id + profile (wins, kills, playtime), served by the same Bun
process (SQLite via `bun:sqlite` is one dependency-free step).

### 3. No lobby/matchmaking/team assignment (hard blocker for MP modes)
Modes are URL params; teams are assigned client-side by mode init. For MP CTF
the server must own team assignment and score — the wire already carries the
data (`shared/teams.ts`), it just isn't authoritative. This blocks ranked
anything, and blocks "join a CTF match" as a user-facing flow.

### 4. Movement trust is plausibility-checked, not simulated (soft cap)
Hit claims, AOE claims, rate limits, idle reaping, grace reconnects — all
validated server-side and probe-tested. But position is trusted-with-
correction, not re-simulated. Fine for friend/community play; a competitive
mode wants server-side movement replay (the shared sim makes this *possible*
— run the same movement code the client runs, on the tick inputs).
This is the classic "authoritative vs. cheat-sensitive" line: cross it only
when there's an actual competitive surface.

### 5. Single procedural map (content-scale blocker)
One terrain generator, one arena. Tribes lives on map variety — bases, flag
stands, terrain that matters. The heightfield + entities are map-agnostic
already (deployables, flag zones at ±70 are mode constants). Needs a map
definition format (seed/params + base layouts + objective anchors).

### 6. No lag compensation for hitscan (competitive feel)
Lightning/railgun hit claims are validated for plausibility but resolve against
*current* server positions — on a 100ms link you shoot ghosts. Real fix is
server-side rewind (keep ~250ms of position history — the stateHistory pattern
already exists client-side). Cheap to add: PlayerManager keeps a ring buffer.

### 7. Operational surface is thin
- No health/metrics export beyond `getHealthStatus()` — a fleet needs
  Prometheus-style scrape or at least a `/metrics` endpoint.
- No structured logging aggregation — client WARNs go to `/client-log` (good)
  but there's no per-match audit trail.
- No config/env system — CONFIG is compiled-in. Region, tick rate, caps should
  be env-driven per deployment.

### 8. Art/asset pipeline is procedural-only (scaling limit)
Weapon models are code-baked (vmdump pipeline), creatures procedural — fast to
iterate but a "serious" look needs a real GLTF/texture pipeline. The bake
infrastructure exists; what's missing is a convention (asset dir → optimized
GLB → manifest) so non-code art can land.

### 9. Social/chat — absent
No chat at all (not even text). Even a one-channel text chat is a wire message
type + HUD widget; without it multiplayer feels like a tech demo.

### 10. Client scale headroom is unproven past ~8 players
Interest-tier phasing and binary frames exist, but soak-tested only to 4-5
concurrent clients. Ascend ran 32+; first real load test should target
16-24 bots to find the cliff (likely suspects: tick record encode cost,
per-frame remotePlayer Maps, ball segment fan-out).

## Non-blockers (already fine)
- Ball sim: server-authoritative, binary segments, cadence ~10.5/s/ball.
- Transports: WS + loopback + P2P DataChannel behind one GameTransport iface.
- Mode/rules: `shared/teams.ts` is the right seam; server just needs to adopt it.
- AI: species funnel + GameBot give usable PvE/PvP filler at any player count.
- Demos/replay: DemoManager + server DemoStorage — rare infra to already have.

## Suggested order
1. Match model (1) + lobby/team authority (3) — unlocks real multiplayer games.
2. Persistence (2) + `/metrics` (7) — unlocks "people come back".
3. Text chat (9) — one day, outsized feel.
4. 16-bot load test (10) — find the cliff before players do.
5. Lag-comp rewind (6) — when a competitive mode ships.
6. Map format (5) + art pipeline (8) — the long content tail.
