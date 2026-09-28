# KRIBES — Living Overhaul Plan (Devin's brain)

**Standing order:** continue overhauling the project — server and client — toward a
real game the size of Tribes Ascend / Krunker / Narrow.One. Maximal extensibility,
cleanliness, robustness, performance, low running cost. Massive changes allowed
when research supports them. Commit per settled topic, changelog.txt one line each,
never push.

Read this file first each session. Update it as things land and as better ideas
surface. Detailed research lives in `_reports/`; this file is the current truth.

## North-star architecture

- **shared/ is the game.** Sim, combat math, wire codec, species kits, teams.
  Client renders + predicts; server validates + fans out; P2P host runs the
  same modules embedded. Any logic that exists in two languages/places is debt.
- **Rooms are matches.** (Landed 2026-09-26.) `Room` owns all per-match state;
  `GameServer` dispatches. Lobbies/matchmaking = `roomFor(name)` + a lobby API.
- **Authority split is explicit.** Server: hit claims, health/death, respawns,
  movement plausibility. Client: presentation, prediction, cosmetics.
- **Cheap to run.** Binary wire everywhere hot; delta suppression + interest
  tiers already proven (~6-8Hz effective at 20Hz tick). Every cost decision
  should survive 32 players on a $5 VPS.

## Status board

### Done
- Binary wire codec + position/tick frames, delta suppression, interest tiers
- Server validation layer + per-type rate limits + session-token reconnect
- Grace-period reconnect, idle reaper, force-send windows on knockback
- Offline play end-to-end (localAuthority, bot damage funnel, match restart)
- Modes: nuggets / ctf / dm / classic + 5v5 team bots (shared/teams.ts rules)
- P2P over WebRTC DataChannel w/ server relayed handshake + embedded authority
- Ball sim rubberband fixes: grid-locked replay, closed-form inert legs,
  renderOffset blending, settle threshold, server wall-clock catch-up
- Env-driven server config (FPS_*) + `GET /metrics` (tick lag! per-room stats)
- Room/match model groundwork — verified live (arena2 vs default isolated)
- `?room=` client param → join handshake; chat (T to open, room-scoped
  relay, rate-limited 4/s, 200-char cap, textContent rendering)
- Species instancing, AI LOD, keybinds menu, spectator fly, cloak skill,
  secondary weapons, remote-player anim overhaul, SnapshotBuffer tests
- pvptest E2E harness: --test…--test5, staleprobe, ballreplay

- Persistent identity: playerId claims are HMAC-signed (FPS_SECRET env;
  random per boot if unset). localStorage-backed on the client — names
  survive restarts and can't be stolen by id knowledge alone.
- Lag compensation: per-player 400ms position history; hitscan + AOE
  validated against target rewound by clamped shooter ping (≤250ms).
- Load spot-check: 19 players (16 orbit bots + devs) — tick lag flat at
  ~11ms avg / 29ms max, no degradation vs 3 players. Empty named rooms
  now dispose themselves (ballSim.stop + map delete; 'default' immortal).
- 35-player multi-room load test: 19 in default + 16 in loadb, ~25s
  sustained — tick lag avg 11.2ms (unchanged vs 3 players; it's this
  box's baseline setInterval drift, not load), max 36ms, 0 rejected.
  Second BallSim spun up cleanly per room. `GET /rooms` lobby listing
  + bot `--room=` flag for split-fleet tests.

### Next (audit priority order)
1. ~~Lobby UI~~ — landed: LOBBY button polls /rooms (live scores +
   winAt now shown per row), joins via ?room=NAME reload, create-room
   input, NUGGETS/CTF/DM quick-play buttons → `GET /join?mode=` picks
   the emptiest live match or spins `<mode>-N` (ad-hoc names inherit
   maps/<mode>.json). Next polish: show own room + mode in the panel,
   mid-match room switching without reload.
2. **Movement re-sim** — shared/stepPlayer on server during validation.
   BLOCKED on JP's in-flight Player.ts edits — extract the integrator to
   shared/movement.ts when that file settles.
3. ~~Map format~~ — landed: `maps/<room>.json` (mode, ball population,
   spawn anchors, bases/objectives, bot count — all clamped with
   defaults; examples swarm/duel/nugwar/ctf). Server bots populate
   matches AND play objectives (flagGoal: grab exposed enemy flag, run
   home as carrier, return dropped own flag, defend while flag moves).
   Server-owned CTF flags landed (RoomFlags: touch pickup, drop on
   death, planar capture ring, flagUpdate broadcast); live-verified
   bot flag grabs over the wire. `botFill` spec keeps a room at N total
   bodies — spawns/retires bots as humans come and go (dead bots retire
   first); `teamUpdate` wire msg + bot-only rebalancing on leaver skew.
   Next extensions: species mix. `terrain` ref landed: maps/<file>.bin
   heightfields per room (lazy, cached, shared). Shared brain landed:
   shared/botBrain.ts drives offline GameBots AND server bots — one
   personality, both runtimes.
4. ~~Server-owned teams/score~~ — landed: rooms assign alpha/bravo on
   join (before spawn — team-base spawning), teamScore/matchEnd/
   matchStart broadcast, match journal → logs/matches.jsonl + /matches.
   Server-owned nugget pickups landed: creature kills drop gems
   (RoomPickups, touch-to-bank, TTL 30s) — 'nuggets' scoring is now
   fully server-observed — the {type:'bank'} claim message was removed
   end-to-end (protocol, validation, handler, client sender).
   CTF classic rule: own flag must be home to cap; carrier disconnect
   drops the flag. Spawn protection (2s, breaks on fire), friendly-fire
   gate (damage only — splash still boosts teammates), heal claims in
   team rooms need gem credit, teleport capped 3/s, PROTOCOL_VERSION=4.
   Ops: GET /stats lifetime leaderboard off matches.jsonl; match clock
   + overtime + draw resolution + 60s warning; spectate joins
   (watch-only socket, full-rate ticks).

### Later / research needed
- Client prediction + reconciliation for self (currently trust + correct).
- Replay formalization — record.ts/replay.ts capture live wire streams and
  re-decode them offline (regression + decode-cost benchmarks landed).
  Remaining: replay through full client netHandlers, not just the decoder.
- ~~`ServerSim` registry~~ — landed as `room.sims`; bots/flags tick through
  it. Deployable turrets server-side are the next sim candidate.
- Voice/avatars/monetization — out of scope until core loops land.

## Non-goals
- No engine rewrite, no ECS framework, no server authoritative physics yet.
- Don't touch JP's in-flight client files (check `git status` before edits;
  the file list drifts — speciesKit/context/main/etc. have been hot).

## Working agreements (from JP, painful lessons)
- Verify myself via the E2E harness — never ask JP to confirm a fix.
- Watch `logs/client.log` (POST /client-log) for real client evidence.
- `bun --watch` does NOT reload `shared/` — server restart needed for
  shared changes; check uptime via /metrics before concluding.
- exec cwd doesn't persist — cd inside every exec; bun needs PATH export.
- `.old` soft-delete; comments explain WHY; commit per settled topic.
